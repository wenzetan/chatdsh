/**
 * 运行期后端配置的保存与读取。
 *
 * 配置落在数据根下的 `backends/settings.json`，写入先写同目录临时文件再原子替换，进程
 * 崩溃不会留下半个文件。每次成功保存把修订号加一，写入携带读到的修订号，落后即拒绝并
 * 返回当前修订号，界面据此提示重新读取。
 *
 * 非法组合在写入磁盘之前被拒绝：`memoryBackend` 取 `hermes` 只在聊天取 `hermes` 时成立；
 * 聊天取 `hermes` 而部署没有给出地址与入口时同样拒绝，因为这项能力无从启用。
 * @module @chatdsh/gateway/backends/settings
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import {
  assertCombination,
  BackendSettingsError,
  DEFAULT_BACKEND_SELECTION,
  parseBackendSelection,
  type BackendSelection,
  type ChatBackendId,
  type MemoryBackendId,
} from './policy.ts';

/** 配置目录名。 */
export const BACKEND_SETTINGS_DIRECTORY = 'backends';

/** 配置文件名。 */
export const BACKEND_SETTINGS_FILE = 'settings.json';

/** 一次保存请求。 */
export interface BackendSelectionInput {
  /** 客户端读到的修订号。 */
  readonly revision: number;
  /** 聊天后端标识。 */
  readonly chatBackend: string;
  /** 记忆后端标识。 */
  readonly memoryBackend: string;
}

/** 构造输入。 */
export interface BackendSettingsStoreOptions {
  /** 数据根。 */
  readonly dataRoot: string;
  /** 遥测出口。 */
  readonly telemetry: ChatdshTelemetry;
  /**
   * 报告 Hermes 是否可以启用。
   *
   * 部署既没有给外部地址也没有给托管入口时返回 false，此时把聊天切到 Hermes 被拒绝：
   * 保存一份永远不可达的配置只会让下一次发送降级，界面应显示启用入口。
   */
  readonly hermesConfigured: () => boolean;
}

/**
 * 后端配置存储。
 *
 * 读取发生在构造时，文件损坏直接抛出，不用默认值覆盖现场。
 */
export class BackendSettingsStore {
  private readonly telemetry: ChatdshTelemetry;
  private readonly hermesConfigured: () => boolean;
  private readonly directory: string;
  private readonly file: string;
  private selection: BackendSelection;

  constructor(options: BackendSettingsStoreOptions) {
    this.telemetry = options.telemetry;
    this.hermesConfigured = options.hermesConfigured;
    this.directory = join(options.dataRoot, BACKEND_SETTINGS_DIRECTORY);
    this.file = join(this.directory, BACKEND_SETTINGS_FILE);
    mkdirSync(this.directory, { recursive: true });
    this.selection = this.read();
  }

  /** 当前生效的配置。 */
  current(): BackendSelection {
    return this.selection;
  }

  /** 配置文件路径，供诊断显示。 */
  path(): string {
    return this.file;
  }

  /**
   * 保存一份新配置。
   *
   * 修订号必须与当前值一致；成功之后当前修订号加一。组合不合法、标识未知、部署没有
   * 给出 Hermes 的启用条件时拒绝，磁盘内容保持不变。
   * @param input - 客户端读到的修订号与两个开关。
   * @returns 保存之后生效的配置。
   * @throws {BackendSettingsError} 修订号落后、组合非法或 Hermes 未配置。
   */
  async save(input: BackendSelectionInput): Promise<BackendSelection> {
    return this.telemetry.runSpan('chatdsh.gateway.settings.write', {}, async (span) => {
      try {
        const next = this.validate(input);
        this.write(next);
        this.selection = next;
        span.setAttribute('outcome', 'saved');
        this.telemetry.counter('chatdsh_gateway_settings_writes_total', {
          description: '设置同步写入结果',
        }).add(1, { outcome: 'saved' });
        return next;
      } catch (error) {
        const failure = error instanceof BackendSettingsError
          ? error
          : new BackendSettingsError(
            'settings-write-failed',
            `后端配置无法写入（${this.file}）：${error instanceof Error ? error.message : String(error)}`,
          );
        span.setAttribute('outcome', 'rejected');
        span.setAttribute('error.type', failure.name);
        span.setAttribute('error.code', failure.code);
        this.telemetry.event('chatdsh.gateway.settings.rejected', {
          outcome: 'rejected',
          'error.type': failure.name,
          'error.code': failure.code,
        });
        this.telemetry.counter('chatdsh_gateway_settings_writes_total', {
          description: '设置同步写入结果',
        }).add(1, { outcome: 'rejected' });
        throw failure;
      }
    });
  }

  /** 校验一次保存请求并算出保存之后的配置。 */
  private validate(input: BackendSelectionInput): BackendSelection {
    if (!Number.isInteger(input.revision) || input.revision < 0) {
      throw new BackendSettingsError(
        'invalid-revision',
        `修订号必须是非负整数，收到 ${JSON.stringify(input.revision)}`,
        this.selection.revision,
      );
    }
    if (input.revision !== this.selection.revision) {
      throw new BackendSettingsError(
        'revision-stale',
        `修订号已过期：提交 ${input.revision}，当前 ${this.selection.revision}，请重新读取后用当前修订号提交`,
        this.selection.revision,
      );
    }
    assertCombination(input.chatBackend, input.memoryBackend);
    const chatBackend = input.chatBackend as ChatBackendId;
    const memoryBackend = input.memoryBackend as MemoryBackendId;
    if (chatBackend === 'hermes' && !this.hermesConfigured()) {
      throw new BackendSettingsError(
        'hermes-unconfigured',
        '聊天后端取 hermes 需要部署给出 Hermes 的服务地址（CHATDSH_HERMES_URL）或托管入口（CHATDSH_HERMES_BIN）',
      );
    }
    return { revision: this.selection.revision + 1, chatBackend, memoryBackend };
  }

  /** 原子写入。 */
  private write(selection: BackendSelection): void {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(selection, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
  }

  /** 读磁盘；没有文件时用默认值。 */
  private read(): BackendSelection {
    if (!existsSync(this.file)) return DEFAULT_BACKEND_SELECTION;
    const text = readFileSync(this.file, 'utf8');
    try {
      return parseBackendSelection(JSON.parse(text));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BackendSettingsError('settings-corrupt', `后端配置无法解析（${this.file}）：${detail}`);
    }
  }
}

/**
 * 建立一个后端配置存储。
 * @param options - 数据根、遥测出口与 Hermes 启用条件。
 * @returns 存储。
 */
export function createBackendSettingsStore(options: BackendSettingsStoreOptions): BackendSettingsStore {
  return new BackendSettingsStore(options);
}
