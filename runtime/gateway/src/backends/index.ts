/**
 * 后端运行期分支的组合入口。
 *
 * 把配置保存、依赖托管、插件装卸与发送时的选择串成一个对象：保存一份合法配置会立即按它
 * 装卸插件、启动或回收托管的 Hermes；一次发送按当时的配置选择执行体。会话与回合在这里
 * 不被创建或重启，进行中的回合沿用发出时固定的选择。
 *
 * 地址与凭据从环境变量读取；`CHATDSH_HERMES_URL` 给出外部地址时只记录地址，从不对该进程
 * 发信号；`CHATDSH_HERMES_BIN` 给出托管入口时由控制平面管理单实例。
 * @module @chatdsh/gateway/backends
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import {
  createBackendCapabilityMounts,
  type BackendCapabilityMounts,
  type BackendPluginHost,
  type BackendPluginRow,
} from './capabilities.ts';
import { BackendDiagnostics, type HistoryMode, type SendJudgment } from './diagnostics.ts';
import type { BackendSelection } from './policy.ts';
import { requiresHermes } from './policy.ts';
import { BackendRouter, type BackendDispatchInput, type DshExecutionPort, type HermesChatPort } from './router.ts';
import { createBackendSettingsStore, type BackendSelectionInput, type BackendSettingsStore } from './settings.ts';
import {
  createHermesSupervisor,
  readHermesDependencyConfig,
  type HermesDependencyState,
  type HermesSupervisor,
} from './supervisor.ts';

/** 构造输入。 */
export interface BackendRuntimeOptions {
  /** 控制平面数据根；配置落在它下面的 `backends/settings.json`。 */
  readonly dataRoot: string;
  /** 进程环境变量，提供地址、端口与凭据变量名。 */
  readonly env: NodeJS.ProcessEnv;
  /** 遥测出口。 */
  readonly telemetry: ChatdshTelemetry;
  /** DSH 执行端口，由运行时侧实现。 */
  readonly dsh: DshExecutionPort;
  /** 插件宿主，负责把一条行装配成运行中的插件。 */
  readonly host: BackendPluginHost;
  /** Hermes 聊天端口；未装配时聊天取 hermes 会降级。 */
  readonly hermes?: HermesChatPort;
  /** 托管进程的输出行回调。 */
  readonly onLog?: (line: string) => void;
  /** 会话的完整历史桥接方式变化时的回调，用于持久化到会话元数据。 */
  readonly onHistoryMode?: (sessionId: string, mode: HistoryMode) => void;
}

/** 诊断视图。 */
export interface BackendRuntimeState {
  /** 当前生效的配置。 */
  readonly selection: BackendSelection;
  /** 配置文件路径。 */
  readonly settingsPath: string;
  /** Hermes 依赖状态。 */
  readonly hermes: HermesDependencyState;
  /** 已挂载的插件行。 */
  readonly mounted: readonly BackendPluginRow[];
  /** 最近一次发送的实际判断。 */
  readonly lastSend: SendJudgment | undefined;
}

/**
 * 后端运行期分支。
 */
export class BackendRuntime {
  private readonly env: NodeJS.ProcessEnv;
  private readonly telemetry: ChatdshTelemetry;
  private readonly supervisor: HermesSupervisor;
  private readonly store: BackendSettingsStore;
  private readonly mounts: BackendCapabilityMounts;
  private readonly router: BackendRouter;

  constructor(options: BackendRuntimeOptions) {
    this.env = options.env;
    this.telemetry = options.telemetry;
    this.supervisor = createHermesSupervisor({
      config: readHermesDependencyConfig(options.env),
      telemetry: options.telemetry,
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
    });
    this.store = createBackendSettingsStore({
      dataRoot: options.dataRoot,
      telemetry: options.telemetry,
      hermesConfigured: () => this.supervisor.configured(),
    });
    this.mounts = createBackendCapabilityMounts(options.host, options.telemetry);
    this.router = new BackendRouter({
      settings: { current: () => this.store.current() },
      telemetry: options.telemetry,
      dsh: options.dsh,
      ...(options.hermes === undefined ? {} : { hermes: options.hermes }),
      supervisor: this.supervisor,
      diagnostics: new BackendDiagnostics(),
      ...(options.onHistoryMode === undefined ? {} : { onHistoryMode: options.onHistoryMode }),
    });
  }

  /** 按磁盘上的配置装配一次。 */
  async start(): Promise<void> {
    await this.applyRuntime(this.store.current());
  }

  /** 当前生效的配置。 */
  settings(): BackendSelection {
    return this.store.current();
  }

  /**
   * 保存一份新配置并立即按它装配。
   * @param input - 客户端读到的修订号与两个开关。
   * @returns 保存之后生效的配置。
   * @throws {BackendSettingsError} 修订号落后、组合非法或 Hermes 未配置。
   */
  async save(input: BackendSelectionInput): Promise<BackendSelection> {
    const next = await this.store.save(input);
    await this.applyRuntime(next);
    return next;
  }

  /** 为一次发送选择执行体并执行到受理为止。 */
  async send(input: BackendDispatchInput): Promise<SendJudgment> {
    return this.router.dispatch(input);
  }

  /** 查询一个受理状态不确定的回合。 */
  async resolveUnconfirmed(sessionId: string): Promise<SendJudgment> {
    return this.router.resolveUnconfirmed(sessionId);
  }

  /** 结束一个回合，释放固定选择。 */
  endTurn(sessionId: string, turn: number): boolean {
    return this.router.endTurn(sessionId, turn);
  }

  /** 某个会话的完整历史桥接方式。 */
  historyModeOf(sessionId: string): 'dsh' | 'full' {
    return this.router.historyModeOf(sessionId);
  }

  /** 诊断视图：配置、依赖状态、已挂载插件与最近一次发送的实际判断。 */
  diagnostics(): BackendRuntimeState {
    return {
      selection: this.store.current(),
      settingsPath: this.store.path(),
      hermes: this.supervisor.state(),
      mounted: this.mounts.mounted(),
      lastSend: this.router.record().last(),
    };
  }

  /** 停止托管进程并释放全部挂载；外部地址模式下不触碰外部进程。 */
  async stop(): Promise<void> {
    await this.supervisor.stop();
    await this.mounts.dispose();
  }

  /** 按配置装卸插件并管理托管进程。 */
  private async applyRuntime(selection: BackendSelection): Promise<void> {
    const context = { env: this.env, hermesUrl: this.supervisor.url() };
    if (requiresHermes(selection.chatBackend)) {
      const readiness = await this.supervisor.ensureReady();
      if (!readiness.ready) {
        this.telemetry.log('warn', 'Hermes 未就绪，发送时会降级到 DSH 承载', {
          'error.code': readiness.reason ?? 'unreachable',
        });
      }
      await this.mounts.apply(selection, context);
      return;
    }
    await this.mounts.apply(selection, context);
    await this.supervisor.stop();
  }
}

/**
 * 建立一个后端运行期分支。
 * @param options - 数据根、环境变量、遥测、执行端口与插件宿主。
 * @returns 运行期分支。
 */
export function createBackendRuntime(options: BackendRuntimeOptions): BackendRuntime {
  return new BackendRuntime(options);
}

export { CHAT_PLUGIN, MEMORY_PLUGIN, desiredPluginRows, type BackendPluginHost, type BackendPluginRow } from './capabilities.ts';
export { createBackendDiagnostics, type SendJudgment } from './diagnostics.ts';
export { assertCombination, CHAT_BACKENDS, DEFAULT_BACKEND_SELECTION, LEGAL_COMBINATIONS, MEMORY_BACKENDS, memoryEnabled, requiresHermes, requiresHermesChat, type BackendSelection } from './policy.ts';
export { BackendDispatchError, createBackendRouter, type BackendDispatchInput, type DshExecutionPort, type HermesChatPort } from './router.ts';
export { BACKEND_SETTINGS_FILE, createBackendSettingsStore, type BackendSelectionInput } from './settings.ts';
export { createHermesSupervisor, HERMES_ENV, readHermesDependencyConfig, type HermesDependencyConfig, type HermesDependencyState } from './supervisor.ts';
