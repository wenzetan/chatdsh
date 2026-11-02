/**
 * 助手面板的数据入口。
 *
 * 传输层只把 `<服务名>/<方法名>` 与位置参数送到 Remote 命名空间；这一层负责解包结果信封、
 * 校验返回形状，并把每次调用交给遥测。业务失败（重名、装配失败、版本冲突、记录不存在）以带
 * 错误码的失败抛出，由界面按码给出说明。
 *
 * 装配清单与预设名册来自两个上游命名空间，技能目录来自技能服务的命名空间：三者都可能不在
 * 当前组合里，因此加载时各自记录失败，界面按来源分别显示能力不可用，不把它折算成空目录。
 * @module @chatdsh/client-assistants/gateway
 */

import { CLIENT_ERROR_CODES } from './state.ts';
import type {
  ActionOutcome,
  AssistantInput,
  AssistantPatch,
  AssistantRecord,
  AssistantRemoval,
  AssistantsGateway,
  AssistantsSnapshot,
  AssistantsTransport,
  AssistantUiAction,
  PanelTelemetry,
  PresetEntry,
  PresetGroup,
  PresetRow,
  RemoteEnvelope,
  SkillCatalogState,
  SkillEntry,
} from './types.ts';

/** 一次 Remote 调用失败。 */
export class AssistantCallError extends Error {
  /**
   * @param code - 错误码，取自结果信封或客户端自己的失败码。
   * @param message - 面向用户的说明。
   */
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AssistantCallError';
  }
}

/** 一个 Remote 命名空间的最小形状。 */
export interface RemoteNamespace {
  readonly [method: string]: ((...args: never[]) => Promise<RemoteEnvelope>) | undefined;
}

/**
 * 从模块加载器给出的命名空间构造传输层。
 *
 * 缺命名空间与缺方法按能力不可用返回信封；调用本身的拒绝原样向上抛，由数据入口统一折算成
 * 离线失败。
 * @param namespaceOf - 按名取 Remote 命名空间。
 * @returns 传输层。
 */
export function createRemoteTransport(namespaceOf: (name: string) => RemoteNamespace | undefined): AssistantsTransport {
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
  if (!Array.isArray(value)) throw new AssistantCallError('gateway/internal', `${what} 的返回形状不符合约定`);
  return value as T[];
}

/** 断言结果是一个对象。 */
function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AssistantCallError('gateway/internal', `${what} 的返回形状不符合约定`);
  }
  return value as Record<string, unknown>;
}

/** 断言结果是一个字符串数组。 */
function requireStrings(value: unknown, what: string): string[] {
  const list = requireArray<unknown>(value, what);
  return list.map((item) => {
    if (typeof item !== 'string') throw new AssistantCallError('gateway/internal', `${what} 的元素必须是字符串`);
    return item;
  });
}

/** 读一条助手记录。 */
function recordOf(value: unknown): AssistantRecord {
  const record = requireRecord(value, '助手记录');
  if (typeof record['id'] !== 'string' || typeof record['name'] !== 'string') {
    throw new AssistantCallError('gateway/internal', '助手记录缺少标识或名称');
  }
  if (typeof record['revision'] !== 'number') throw new AssistantCallError('gateway/internal', '助手记录缺少版本号');
  requireStrings(record['tools'], '助手记录的工具行');
  requireStrings(record['skills'], '助手记录的技能引用');
  return value as unknown as AssistantRecord;
}

/** 读预设名册。 */
function rosterOf(value: unknown): PresetEntry[] {
  const record = requireRecord(value, '预设名册');
  return requireArray<PresetEntry>(record['presets'], '预设名册的条目');
}

/** 读装配清单里的行。 */
function rowsOf(value: unknown): PresetRow[] {
  const rows = requireArray<Record<string, unknown>>(value, '装配清单的行');
  return rows.map((row) => {
    if (row['entryId'] !== null && typeof row['entryId'] !== 'string') {
      throw new AssistantCallError('gateway/internal', '装配行的行标识形状不符合约定');
    }
    if (typeof row['moduleName'] !== 'string') {
      throw new AssistantCallError('gateway/internal', '装配行缺少模块名');
    }
    return row as unknown as PresetRow;
  });
}

/** 读装配清单。 */
function presetsOf(value: unknown): PresetGroup[] {
  const record = requireRecord(value, '装配清单');
  const groups = record['agentPresets'];
  if (groups === undefined) return [];
  return requireArray<Record<string, unknown>>(groups, '装配清单的预设').map((group) => {
    if (typeof group['id'] !== 'string') throw new AssistantCallError('gateway/internal', '装配清单的预设缺少标识');
    return { ...group, rows: rowsOf(group['rows']) } as unknown as PresetGroup;
  });
}

/** 读技能目录。 */
function skillsOf(value: unknown): SkillEntry[] {
  return requireArray<SkillEntry>(value, '技能目录');
}

/** 读技能数量统计。 */
function skillStateOf(value: unknown): SkillCatalogState {
  const record = requireRecord(value, '技能数量统计');
  if (typeof record['total'] !== 'number' || typeof record['enabled'] !== 'number') {
    throw new AssistantCallError('gateway/internal', '技能数量统计的返回形状不符合约定');
  }
  return { total: record['total'], enabled: record['enabled'] };
}

/** 构造数据入口所需的依赖。 */
export interface AssistantsGatewayOptions {
  /** 传输层。 */
  readonly transport: AssistantsTransport;
  /** 浏览器侧遥测。 */
  readonly telemetry: PanelTelemetry;
}

/**
 * 构造助手面板的数据入口。
 * @param options - 传输层与遥测。
 * @returns 数据入口。
 */
export function createAssistantsGateway(options: AssistantsGatewayOptions): AssistantsGateway {
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
        throw new AssistantCallError(envelope.error?.code ?? 'gateway/internal', envelope.error?.message ?? '调用失败');
      }
      return envelope.value;
    });

  /** 汇总一次加载：助手列表是必需的，其余三个来源各自记录失败。 */
  const load = async (): Promise<AssistantsSnapshot> => {
    const assistants = requireArray<AssistantRecord>(await call('chatdshAssistants/list', []), '助手列表').map(recordOf);
    const failures: { source: 'roster' | 'presets' | 'skills'; error: unknown }[] = [];
    const [rosterResult, presetsResult, skillsResult] = await Promise.allSettled([
      call('agentPresets/list', []).then(rosterOf),
      call('pluginInventory/list', []).then(presetsOf),
      call('chatdshSkills/list', []).then(skillsOf),
    ]);
    const roster = rosterResult.status === 'fulfilled' ? rosterResult.value : undefined;
    if (rosterResult.status === 'rejected') failures.push({ source: 'roster', error: rosterResult.reason });
    const presets = presetsResult.status === 'fulfilled' ? presetsResult.value : undefined;
    if (presetsResult.status === 'rejected') failures.push({ source: 'presets', error: presetsResult.reason });
    const skills = skillsResult.status === 'fulfilled' ? skillsResult.value : undefined;
    if (skillsResult.status === 'rejected') failures.push({ source: 'skills', error: skillsResult.reason });
    let skillState: SkillCatalogState | undefined;
    if (skills !== undefined) {
      skillState = await call('chatdshSkills/catalog', []).then(skillStateOf).catch((error: unknown) => {
        failures.push({ source: 'skills', error });
        return undefined;
      });
    }
    return { assistants, roster, presets, skills, skillState, failures };
  };

  return {
    load,

    async reload(): Promise<AssistantsSnapshot> {
      return load();
    },

    async roster(): Promise<readonly PresetEntry[]> {
      return rosterOf(await call('agentPresets/list', []));
    },

    async presets(): Promise<readonly PresetGroup[]> {
      return presetsOf(await call('pluginInventory/list', []));
    },

    async skills(): Promise<readonly SkillEntry[]> {
      return skillsOf(await call('chatdshSkills/list', []));
    },

    async skillState(): Promise<SkillCatalogState> {
      return skillStateOf(await call('chatdshSkills/catalog', []));
    },

    async create(input: AssistantInput): Promise<AssistantRecord> {
      return recordOf(await call('chatdshAssistants/create', [input]));
    },

    async update(id: string, patch: AssistantPatch): Promise<AssistantRecord> {
      return recordOf(await call('chatdshAssistants/update', [id, patch]));
    },

    async remove(id: string): Promise<AssistantRemoval> {
      const record = requireRecord(await call('chatdshAssistants/delete', [id]), '删除结果');
      if (typeof record['removed'] !== 'boolean' || typeof record['liveSessions'] !== 'number') {
        throw new AssistantCallError('gateway/internal', '删除结果的返回形状不符合约定');
      }
      return record as unknown as AssistantRemoval;
    },

    noteAction(action: AssistantUiAction, outcome: ActionOutcome): void {
      telemetry.action(action, outcome);
    },
  };
}
