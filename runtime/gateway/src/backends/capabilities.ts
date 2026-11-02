/**
 * 后端能力的插件装卸。
 *
 * 两个能力各自独立：聊天取 `hermes` 时挂载 Hermes 聊天宿主，记忆取 `hindsight` 时挂载
 * 记忆宿主，取 `hermes` 的记忆由 Hermes 内置记忆承担，不需要额外插件；关闭能力时把对应
 * 行卸载并等待资源释放，避免留下连接、监听端口与定时器。
 *
 * 地址与凭据只从环境变量读取，凭据只保存变量名；每次装配都重新读取，环境改变后无需重启
 * 控制平面即可生效。会话不在这里创建或重建，装卸插件不打断进行中的回合。
 * @module @chatdsh/gateway/backends/capabilities
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { requiresHermes } from './policy.ts';
import type { BackendSelection } from './policy.ts';

/** 环境变量名。 */
export const BACKEND_PLUGIN_ENV = {
  /** Hermes 凭据所在的环境变量名。 */
  hermesApiKeyEnv: 'CHATDSH_HERMES_API_KEY_ENV',
  /** Hermes 单次请求超时。 */
  hermesRequestTimeoutMs: 'CHATDSH_HERMES_REQUEST_TIMEOUT_MS',
  /** Hermes 审批等待上限。 */
  hermesApprovalTimeoutMs: 'CHATDSH_HERMES_APPROVAL_TIMEOUT_MS',
  /** 写进助手消息的模型标签。 */
  hermesModelLabel: 'CHATDSH_HERMES_MODEL_LABEL',
  /** 请求 Hermes 使用的模型。 */
  hermesModel: 'CHATDSH_HERMES_MODEL',
  /** 历史分页读取条数。 */
  hermesHistoryPageSize: 'CHATDSH_HERMES_HISTORY_PAGE_SIZE',
  /** 停止确认上限。 */
  hermesStopConfirmMs: 'CHATDSH_HERMES_STOP_CONFIRM_MS',
  /** Hindsight 服务地址。 */
  hindsightUrl: 'CHATDSH_HINDSIGHT_URL',
  /** Hindsight 凭据所在的环境变量名。 */
  hindsightApiKeyEnv: 'CHATDSH_HINDSIGHT_API_KEY_ENV',
  /** 单次召回的令牌上限。 */
  hindsightMaxTokens: 'CHATDSH_HINDSIGHT_MAX_TOKENS',
  /** Hindsight 单次请求超时。 */
  hindsightRequestTimeoutMs: 'CHATDSH_HINDSIGHT_REQUEST_TIMEOUT_MS',
} as const;

/** 聊天插件行。 */
export const CHAT_PLUGIN = {
  id: 'chatdsh-chat-hermes',
  module: '@chatdsh/host-chat-hermes',
} as const;

/** 记忆插件行。 */
export const MEMORY_PLUGIN = {
  id: 'chatdsh-memory',
  module: '@chatdsh/host-memory',
} as const;

/** 一条插件行。 */
export interface BackendPluginRow {
  /** 行标识，整个装配里唯一。 */
  readonly id: string;
  /** 模块名。 */
  readonly module: string;
  /** 行配置。 */
  readonly config: Readonly<Record<string, unknown>>;
}

/** 一次挂载持有的资源。 */
export interface BackendPluginResource {
  /** 释放资源；调用方在卸载时等待它完成。 */
  dispose(): Promise<void> | void;
}

/** 插件宿主：把一条行装配成运行中的插件。 */
export interface BackendPluginHost {
  /** 挂载一条行并返回它持有的资源。 */
  mount(row: BackendPluginRow): Promise<BackendPluginResource>;
}

/** 装配期的环境与地址。 */
export interface MountContext {
  /** 进程环境变量。 */
  readonly env: NodeJS.ProcessEnv;
  /** Hermes 服务根地址；未配置时为空串。 */
  readonly hermesUrl: string;
}

/** 一次装卸的结果。 */
export interface MountChange {
  /** 本次新挂载的行标识。 */
  readonly mounted: readonly string[];
  /** 本次卸载的行标识。 */
  readonly unmounted: readonly string[];
  /** 本次因配置变化重新挂载的行标识。 */
  readonly remounted: string[];
}

/** 读取一个整数环境变量。 */
function integerOf(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} 必须是正整数，收到 ${raw}`);
  return value;
}

/** 读取一个非空字符串环境变量。 */
function textOf(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}

/**
 * 按当前配置算出应当挂载的插件行。
 * @param selection - 当前生效的后端配置。
 * @param context - 环境变量与 Hermes 地址。
 * @returns 按行标识排序的插件行。
 */
export function desiredPluginRows(selection: BackendSelection, context: MountContext): readonly BackendPluginRow[] {
  const rows: BackendPluginRow[] = [];
  if (requiresHermes(selection.chatBackend)) {
    if (context.hermesUrl === '') {
      throw new Error('聊天后端取 hermes 时装配需要 Hermes 地址；请设置 CHATDSH_HERMES_URL 或 CHATDSH_HERMES_BIN');
    }
    rows.push({
      id: CHAT_PLUGIN.id,
      module: CHAT_PLUGIN.module,
      config: {
        baseUrl: context.hermesUrl,
        apiKeyEnv: textOf(context.env, BACKEND_PLUGIN_ENV.hermesApiKeyEnv) ?? 'HERMES_API_KEY',
        requestTimeoutMs: integerOf(context.env, BACKEND_PLUGIN_ENV.hermesRequestTimeoutMs, 120_000),
        approvalTimeoutMs: integerOf(context.env, BACKEND_PLUGIN_ENV.hermesApprovalTimeoutMs, 300_000),
        modelLabel: textOf(context.env, BACKEND_PLUGIN_ENV.hermesModelLabel) ?? 'hermes',
        ...(textOf(context.env, BACKEND_PLUGIN_ENV.hermesModel) === undefined
          ? {}
          : { model: textOf(context.env, BACKEND_PLUGIN_ENV.hermesModel) }),
        historyPageSize: integerOf(context.env, BACKEND_PLUGIN_ENV.hermesHistoryPageSize, 200),
        stopConfirmMs: integerOf(context.env, BACKEND_PLUGIN_ENV.hermesStopConfirmMs, 2000),
      },
    });
  }
  if (selection.memoryBackend === 'hindsight') {
    const hindsightUrl = textOf(context.env, BACKEND_PLUGIN_ENV.hindsightUrl);
    rows.push({
      id: MEMORY_PLUGIN.id,
      module: MEMORY_PLUGIN.module,
      config: {
        ...(hindsightUrl === undefined ? {} : { hindsightUrl }),
        apiKeyEnv: textOf(context.env, BACKEND_PLUGIN_ENV.hindsightApiKeyEnv) ?? 'HINDSIGHT_API_KEY',
        maxTokens: integerOf(context.env, BACKEND_PLUGIN_ENV.hindsightMaxTokens, 1024),
        requestTimeoutMs: integerOf(context.env, BACKEND_PLUGIN_ENV.hindsightRequestTimeoutMs, 60_000),
      },
    });
  }
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

/** 已挂载的一行。 */
interface MountedRow {
  readonly row: BackendPluginRow;
  readonly resource: BackendPluginResource;
}

/**
 * 插件装卸表。
 *
 * 每次 `apply` 与当前落位比较：消失的行卸载并等待资源释放，新增的行挂载，配置变化但标识
 * 与模块不变的行先卸载再挂载。装配失败时保留已完成的部分并把错误抛给调用方。
 */
export class BackendCapabilityMounts {
  private readonly mountedRows = new Map<string, MountedRow>();

  constructor(
    private readonly host: BackendPluginHost,
    private readonly telemetry: ChatdshTelemetry,
  ) {}

  /** 当前已挂载的行。 */
  mounted(): readonly BackendPluginRow[] {
    return [...this.mountedRows.values()]
      .map((item) => item.row)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /**
   * 按当前配置装卸插件。
   * @param selection - 当前生效的后端配置。
   * @param context - 环境变量与 Hermes 地址。
   * @returns 本次发生的装卸。
   */
  async apply(selection: BackendSelection, context: MountContext): Promise<MountChange> {
    const desired = new Map(desiredPluginRows(selection, context).map((row) => [row.id, row]));
    const remountIds = new Set<string>();
    const unmounted: string[] = [];
    const mounted: string[] = [];
    const remounted: string[] = [];
    for (const [id, current] of [...this.mountedRows.entries()]) {
      const next = desired.get(id);
      if (next !== undefined && sameRow(current.row, next)) continue;
      await this.unmount(id);
      if (next === undefined) unmounted.push(id);
      else remountIds.add(id);
    }
    for (const [id, row] of desired) {
      if (remountIds.has(id)) {
        await this.mount(row);
        remounted.push(id);
        continue;
      }
      if (this.mountedRows.has(id)) continue;
      await this.mount(row);
      mounted.push(id);
    }
    return { mounted, unmounted, remounted };
  }

  /** 释放全部挂载。 */
  async dispose(): Promise<void> {
    for (const id of [...this.mountedRows.keys()]) {
      await this.unmount(id);
    }
  }

  /** 挂载一条行。 */
  private async mount(row: BackendPluginRow): Promise<void> {
    await this.telemetry.runSpan('chatdsh.runtime.plugin.activate', {
      'plugin.name': row.id,
    }, async (span) => {
      const resource = await this.host.mount(row);
      this.mountedRows.set(row.id, { row, resource });
      span.setAttribute('outcome', 'mounted');
    });
  }

  /** 卸载一条行并等待资源释放。 */
  private async unmount(id: string): Promise<void> {
    const current = this.mountedRows.get(id);
    if (current === undefined) return;
    await this.telemetry.runSpan('chatdsh.runtime.plugin.activate', {
      'plugin.name': id,
    }, async (span) => {
      this.mountedRows.delete(id);
      await current.resource.dispose();
      span.setAttribute('outcome', 'unmounted');
    });
  }
}

/** 两条行是否等价。 */
function sameRow(left: BackendPluginRow, right: BackendPluginRow): boolean {
  return left.module === right.module && JSON.stringify(left.config) === JSON.stringify(right.config);
}

/**
 * 建立一个插件装卸表。
 * @param host - 插件宿主。
 * @param telemetry - 遥测出口。
 * @returns 装卸表。
 */
export function createBackendCapabilityMounts(
  host: BackendPluginHost,
  telemetry: ChatdshTelemetry,
): BackendCapabilityMounts {
  return new BackendCapabilityMounts(host, telemetry);
}
