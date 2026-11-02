/**
 * 项目面板的数据入口。
 *
 * 传输层只负责把 `<服务名>/<方法名>` 与位置参数送到 Remote 命名空间；这一层负责解包结果
 * 信封、校验返回形状，并把每次调用交给遥测。业务失败（版本冲突、目录不可读、记录不存在）
 * 以带错误码的失败抛出，由界面按码给出说明。
 * @module @chatdsh/client-projects/gateway
 */

import {
  assistantOptionsOf,
  CLIENT_ERROR_CODES,
  modelOptionsOf,
  type ProjectDraft,
  inputOf,
} from './state.ts';
import type {
  ActionOutcome,
  AssistantOption,
  DirectoryListing,
  ModelProviderRow,
  PanelTelemetry,
  ProjectInput,
  ProjectRecord,
  ProjectsGateway,
  ProjectsTransport,
  ProjectUiAction,
  RemoteEnvelope,
} from './types.ts';

/** 一次 Remote 调用失败。 */
export class ProjectCallError extends Error {
  /**
   * @param code - 错误码，取自结果信封或客户端自己的失败码。
   * @param message - 面向用户的说明。
   */
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ProjectCallError';
  }
}

/** 一个 Remote 命名空间的最小形状。 */
export interface RemoteNamespace {
  readonly [method: string]: ((...args: never[]) => Promise<RemoteEnvelope>) | undefined;
}

/**
 * 从模块加载器给出的命名空间构造传输层。
 *
 * 缺命名空间与缺方法按能力不可用返回信封；调用本身的拒绝原样向上抛，由数据入口统一
 * 折算成离线失败。
 */
export function createRemoteTransport(namespaceOf: (name: string) => RemoteNamespace | undefined): ProjectsTransport {
  return {
    async call(endpoint: string, args: readonly unknown[]): Promise<RemoteEnvelope> {
      const separator = endpoint.indexOf('/');
      const service = endpoint.slice(0, separator);
      const method = endpoint.slice(separator + 1);
      const namespace = namespaceOf(service);
      if (namespace === undefined) {
        return { ok: false, error: { code: CLIENT_ERROR_CODES.unavailable, message: `当前部署没有提供 ${service} 命名空间` } };
      }
      const invoke = namespace[method];
      if (typeof invoke !== 'function') {
        return { ok: false, error: { code: CLIENT_ERROR_CODES.unavailable, message: `${service} 没有 ${method} 方法` } };
      }
      return await (invoke as (...input: unknown[]) => Promise<RemoteEnvelope>)(...args);
    },
  };
}

/** 断言结果是一个数组。 */
function requireArray<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new ProjectCallError('gateway/internal', `${what} 的返回形状不符合约定`);
  return value as T[];
}

/** 断言结果是一个对象。 */
function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new ProjectCallError('gateway/internal', `${what} 的返回形状不符合约定`);
  return value as Record<string, unknown>;
}

/** 构造数据入口所需的依赖。 */
export interface ProjectsGatewayOptions {
  /** 传输层。 */
  readonly transport: ProjectsTransport;
  /** 浏览器侧遥测。 */
  readonly telemetry: PanelTelemetry;
}

/**
 * 构造项目面板的数据入口。
 * @param options - 传输层与遥测。
 * @returns 数据入口。
 */
export function createProjectsGateway(options: ProjectsGatewayOptions): ProjectsGateway {
  const { transport, telemetry } = options;

  /**
   * 发一次调用，把失败信封与传输层拒绝都转成异常。
   * @param endpoint - `<服务名>/<方法名>`。
   * @param args - 位置参数。
   * @returns 成功时的值。
   */
  const call = async (endpoint: string, args: readonly unknown[]): Promise<unknown> =>
    telemetry.run(endpoint, async () => {
      const envelope = await transport.call(endpoint, args).then(
        (value) => value,
        (): RemoteEnvelope => ({
          ok: false,
          error: { code: CLIENT_ERROR_CODES.offline, message: '控制平面不可达，请恢复连接后重新加载' },
        }),
      );
      if (!envelope.ok) throw new ProjectCallError(envelope.error.code, envelope.error.message);
      return envelope.value;
    });

  return {
    async list(): Promise<ProjectRecord[]> {
      return requireArray<ProjectRecord>(await call('chatdshProjects/list', []), '项目列表');
    },

    async get(path: string): Promise<ProjectRecord | undefined> {
      const value = await call('chatdshProjects/get', [path]);
      return value === undefined ? undefined : requireRecord(value, '项目记录') as unknown as ProjectRecord;
    },

    async create(input: ProjectInput): Promise<ProjectRecord> {
      return requireRecord(await call('chatdshProjects/create', [input]), '项目记录') as unknown as ProjectRecord;
    },

    async set(input: ProjectInput): Promise<ProjectRecord> {
      return requireRecord(await call('chatdshProjects/set', [input]), '项目记录') as unknown as ProjectRecord;
    },

    async remove(path: string): Promise<boolean> {
      const value = await call('chatdshProjects/delete', [path]);
      if (typeof value !== 'boolean') throw new ProjectCallError('gateway/internal', '删除结果不符合约定');
      return value;
    },

    async listDirectory(path?: string): Promise<DirectoryListing> {
      const value = requireRecord(await call('directoryPicker/list', path === undefined ? [] : [path]), '目录列举');
      if (typeof value['path'] !== 'string' || typeof value['home'] !== 'string') {
        throw new ProjectCallError('gateway/internal', '目录列举的返回形状不符合约定');
      }
      requireArray<unknown>(value['crumbs'], '目录层级');
      requireArray<unknown>(value['entries'], '目录条目');
      return value as unknown as DirectoryListing;
    },

    async listAssistants(): Promise<readonly AssistantOption[]> {
      const value = requireRecord(await call('agentPresets/list', []), '助手名册');
      return assistantOptionsOf(requireArray<AssistantOption>(value['presets'], '助手名册'));
    },

    async listModels(): Promise<readonly string[]> {
      return modelOptionsOf(requireArray<ModelProviderRow>(await call('chatdshModelProviders/list', []), '模型提供方'));
    },

    noteAction(action: ProjectUiAction, outcome: ActionOutcome): void {
      telemetry.action(action, outcome);
    },
  };
}

/** 把草稿转成写入输入。 */
export function draftInputOf(draft: ProjectDraft, revision?: number): ProjectInput {
  return inputOf(draft, revision) as unknown as ProjectInput;
}
