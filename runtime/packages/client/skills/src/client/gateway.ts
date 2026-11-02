/**
 * 技能面板的数据入口。
 *
 * 传输层只把 `<服务名>/<方法名>` 与位置参数送到 Remote 命名空间；这一层负责解包结果信封、
 * 校验返回形状，并把每次调用交给遥测。检索与启停的失败（关键字超限、未知技能、存储写失败）
 * 以带错误码的失败抛出，由界面按码给出宿主原本的说明。
 *
 * 助手名单是辅助来源：它不在组合里时引用一栏显示能力不可用，其他内容照常显示。
 * @module @chatdsh/client-skills/gateway
 */

import { CLIENT_ERROR_CODES } from './state.ts';
import type {
  ActionOutcome,
  AssistantReference,
  PanelTelemetry,
  RemoteEnvelope,
  SkillEntry,
  SkillsGateway,
  SkillSnapshot,
  SkillUiAction,
  SkillsTransport,
  SkillSearchRequest,
} from './types.ts';

/** 一次 Remote 调用失败。 */
export class SkillCallError extends Error {
  /**
   * @param code - 错误码，取自结果信封或客户端自己的失败码。
   * @param message - 面向用户的说明。
   */
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SkillCallError';
  }
}

/** 一个 Remote 命名空间的最小形状。 */
export interface RemoteNamespace {
  readonly [method: string]: ((...args: never[]) => Promise<RemoteEnvelope>) | undefined;
}

/**
 * 从模块加载器给出的命名空间构造传输层。
 * @param namespaceOf - 按名取 Remote 命名空间。
 * @returns 传输层。
 */
export function createRemoteTransport(namespaceOf: (name: string) => RemoteNamespace | undefined): SkillsTransport {
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
  if (!Array.isArray(value)) throw new SkillCallError('gateway/internal', `${what} 的返回形状不符合约定`);
  return value as T[];
}

/** 断言结果是一个对象。 */
function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SkillCallError('gateway/internal', `${what} 的返回形状不符合约定`);
  }
  return value as Record<string, unknown>;
}

/** 读技能目录。 */
function skillsOf(value: unknown): SkillEntry[] {
  const entries = requireArray<Record<string, unknown>>(value, '技能目录');
  return entries.map((entry) => {
    if (typeof entry['id'] !== 'string' || typeof entry['name'] !== 'string') {
      throw new SkillCallError('gateway/internal', '技能条目缺少标识或名称');
    }
    if (typeof entry['enabled'] !== 'boolean') throw new SkillCallError('gateway/internal', '技能条目缺少启用状态');
    return entry as unknown as SkillEntry;
  });
}

/** 读数量统计。 */
function stateOf(value: unknown): { total: number; enabled: number } {
  const record = requireRecord(value, '技能数量统计');
  if (typeof record['total'] !== 'number' || typeof record['enabled'] !== 'number') {
    throw new SkillCallError('gateway/internal', '技能数量统计的返回形状不符合约定');
  }
  return { total: record['total'], enabled: record['enabled'] };
}

/** 读助手名单里与引用有关的部分。 */
function referencesOf(value: unknown): AssistantReference[] {
  return requireArray<Record<string, unknown>>(value, '助手名单').map((entry) => {
    if (typeof entry['id'] !== 'string' || typeof entry['name'] !== 'string') {
      throw new SkillCallError('gateway/internal', '助手条目缺少标识或名称');
    }
    const skills = entry['skills'];
    if (!Array.isArray(skills) || skills.some((item) => typeof item !== 'string')) {
      throw new SkillCallError('gateway/internal', '助手条目的技能引用形状不符合约定');
    }
    return { id: entry['id'], name: entry['name'], skills: skills as string[] };
  });
}

/** 构造数据入口所需的依赖。 */
export interface SkillsGatewayOptions {
  /** 传输层。 */
  readonly transport: SkillsTransport;
  /** 浏览器侧遥测。 */
  readonly telemetry: PanelTelemetry;
}

/**
 * 构造技能面板的数据入口。
 * @param options - 传输层与遥测。
 * @returns 数据入口。
 */
export function createSkillsGateway(options: SkillsGatewayOptions): SkillsGateway {
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
      if (!envelope.ok) {
        throw new SkillCallError(envelope.error?.code ?? 'gateway/internal', envelope.error?.message ?? '调用失败');
      }
      return envelope.value;
    });

  return {
    async load(): Promise<SkillSnapshot> {
      const skills = skillsOf(await call('chatdshSkills/list', []));
      const state = stateOf(await call('chatdshSkills/catalog', []));
      const assistants = await call('chatdshAssistants/list', []).then(
        (value) => referencesOf(value),
        (error: unknown) => {
          telemetry.failure(error);
          return undefined;
        },
      );
      return {
        skills,
        state,
        assistants,
        assistantsFailure: assistants === undefined
          ? new SkillCallError(CLIENT_ERROR_CODES.unavailable, '助手服务不可用，引用一栏无法核对')
          : undefined,
      };
    },

    async search(request: SkillSearchRequest): Promise<readonly SkillEntry[]> {
      return skillsOf(await call('chatdshSkills/search', [request]));
    },

    async toggle(id: string, enabled: boolean): Promise<{ readonly id: string; readonly enabled: boolean }> {
      const record = requireRecord(await call('chatdshSkills/toggle', [id, enabled]), '启用状态');
      if (typeof record['id'] !== 'string' || typeof record['enabled'] !== 'boolean') {
        throw new SkillCallError('gateway/internal', '启用状态的返回形状不符合约定');
      }
      return { id: record['id'], enabled: record['enabled'] };
    },

    noteAction(action: SkillUiAction, outcome: ActionOutcome): void {
      telemetry.action(action, outcome);
    },
  };
}
