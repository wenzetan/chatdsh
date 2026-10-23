/**
 * 自定义助手：把助手记录装配成 agent preset，并提供增删改查。
 *
 * 每条助手记录在启动时注册成一个 preset，因此重启后助手仍在；注册失败会留在预设名册的
 * 诊断里，不静默消失。助手只决定指令、工具档位与额外工具行，不引入第二套插件机制。
 *
 * 工具面按档位装配：档位的权威声明在 `@chatdsh/core-contracts` 的 `tool-tiers` 里，
 * 记录上只存档位标识与额外追加的行。全量档带 `tool-presentation` 行，模型看到的是单个
 * `run_code` 与生成的 SDK，工具条目数不再决定请求里的声明长度。
 * @module @chatdsh/host-assistants
 */

import { agentPresetsOf, Service, storageDomainOf, type Context } from '@chatdsh/adapter';
import { DEFAULT_TOOL_TIER, toolTierOf, type ChatdshToolTierId } from '@chatdsh/core-contracts';
import { Remote, TypertRemoteService, type PresetDefinition } from '@chatdsh/adapter';
import { UPSTREAM_AGENT_ROWS, UPSTREAM_ROWS, UPSTREAM_TOOL_ROWS } from '@chatdsh/adapter/upstream';
import { ASSISTANTS_DOMAIN, type AssistantRecord } from './domain.ts';

export type { AssistantRecord } from './domain.ts';
export { ASSISTANTS_DOMAIN, assistantSchema } from './domain.ts';

/** 新建助手时提供的字段。 */
export interface AssistantInput {
  /** 助手标识；省略时按时间生成。 */
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly instructions: string;
  /** 工具档位；省略时用默认档位。 */
  readonly tier?: ChatdshToolTierId;
  /** 在档位之上额外追加的工具行 id；省略表示只挂档位自带的那些。 */
  readonly tools?: readonly string[];
}

/** 助手运行时使用的服务名。 */
export const SERVICE_NAME = 'chatdshAssistants';

/** 助手记录的键值表，只用到其中四个方法。 */
interface AssistantTable {
  get(key: string): AssistantRecord | undefined;
  entries(): IterableIterator<[string, AssistantRecord]>;
  put(key: string, value: AssistantRecord): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/**
 * 当前平台上应当挂载的下游工具行。
 *
 * 命令执行的两行按平台二选一：Windows 上挂 PowerShell，其余平台挂 bash。
 */
function platformRows(rows: readonly string[]): readonly string[] {
  const hidden = process.platform === 'win32' ? 'tool-bash' : 'tool-pwsh';
  return rows.filter((row) => row !== hidden);
}

/** 由行 id 取包名：自建行加 `@chatdsh/` 前缀，上游行查登记表。 */
function packageOfRow(row: string): string {
  if (row.startsWith('chatdsh-')) return `@chatdsh/${row.slice('chatdsh-'.length)}`;
  const upstream = UPSTREAM_TOOL_ROWS[row as keyof typeof UPSTREAM_TOOL_ROWS];
  if (upstream === undefined) throw new Error(`未登记的工具行：${row}`);
  return upstream;
}

/**
 * 助手服务。
 *
 * 记录落在 `chatdsh-assistants` 存储域，preset 由 `agentPresetRegistry` 装配。
 * 启动装配失败会记录在注册表的名册诊断里，读取名册即可看到原因。
 */
export class ChatdshAssistantsService extends TypertRemoteService {
  /** 注册表与结构化存储是本服务的两个依赖。 */
  static inject = ['agentPresets', 'storageDomain'];

  private readonly disposers = new Map<string, () => Promise<void>>();
  private table: AssistantTable | undefined;

  constructor(ctx: Context) {
    super(ctx, SERVICE_NAME);
  }

  /** 打开存储域并注册已有助手。失败按 fiber 启动失败上报，不吞掉。 */
  async [Service.init](): Promise<void> {
    const domain = await storageDomainOf(this.ctx).open(ASSISTANTS_DOMAIN);
    this.table = domain.table('assistants') as unknown as AssistantTable;
    for (const [id, record] of this.table.entries()) {
      await this.mount(id, record);
    }
  }

  /** 列出全部助手。 */
  @Remote('list')
  list(): AssistantRecord[] {
    if (this.table === undefined) return [];
    return [...this.table.entries()].map(([, record]) => record);
  }

  /** 新建一条助手并立即装配。 */
  @Remote('create')
  async create(input: AssistantInput): Promise<AssistantRecord> {
    const now = Date.now();
    const id = input.id ?? `assistant-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const table = this.requireTable();
    if (table.get(id) !== undefined) throw new Error(`assistant ${id} already exists`);
    const record: AssistantRecord = {
      id,
      name: input.name,
      description: input.description ?? '',
      order: 100,
      instructions: input.instructions,
      ...(input.tier === undefined ? {} : { tier: input.tier }),
      tools: input.tools ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await table.put(id, record);
    await this.mount(id, record);
    return record;
  }

  /** 更新一条助手的指令、档位或展示信息，重新装配它的 preset。 */
  @Remote('update')
  async update(id: string, patch: Partial<AssistantInput>): Promise<AssistantRecord> {
    const table = this.requireTable();
    const current = table.get(id);
    if (current === undefined) throw new Error(`assistant ${id} does not exist`);
    const next: AssistantRecord = {
      ...current,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      instructions: patch.instructions ?? current.instructions,
      ...(patch.tier === undefined ? {} : { tier: patch.tier }),
      tools: patch.tools ?? current.tools,
      updatedAt: Date.now(),
    };
    await table.put(id, next);
    await this.unmount(id);
    await this.mount(id, next);
    return next;
  }

  /** 删除一条助手。 */
  @Remote({ name: 'delete' })
  async remove(id: string): Promise<boolean> {
    const table = this.requireTable();
    await this.unmount(id);
    return table.delete(id);
  }

  private requireTable(): AssistantTable {
    if (this.table === undefined) throw new Error('assistant storage is not ready');
    return this.table;
  }

  /** 装配一个 preset 定义。 */
  private async mount(id: string, record: AssistantRecord): Promise<void> {
    const definition: PresetDefinition = {
      id: record.id,
      name: record.name,
      description: record.description,
      order: record.order,
      plugins: this.composePlugins(record),
    };
    const dispose = await agentPresetsOf(this.ctx).register(definition);
    this.disposers.set(id, dispose);
  }

  /** 卸载一条助手的 preset。 */
  private async unmount(id: string): Promise<void> {
    const dispose = this.disposers.get(id);
    if (dispose === undefined) return;
    this.disposers.delete(id);
    await dispose();
  }

  /**
   * 按记录的档位与额外行组装会话级插件行。
   *
   * 公开是为了让装配结果可以直接被测试断言：装配结果决定模型看到哪些工具，
   * 间接验证会漏掉行顺序与呈现声明。
   */
  composePlugins(record: AssistantRecord): PresetDefinition['plugins'] {
    const tier = toolTierOf(record.tier ?? DEFAULT_TOOL_TIER);
    const upstream = platformRows(tier.upstreamRows);
    const additional = platformRows(record.tools);
    const rows: unknown[] = [
      { id: 'persona', name: UPSTREAM_AGENT_ROWS.persona, config: { prefix: record.instructions } },
      { id: 'agent-instructions', name: UPSTREAM_AGENT_ROWS['agent-instructions'], config: { maxBytes: 65536 } },
      { id: 'time-context', name: UPSTREAM_AGENT_ROWS['time-context'] },
    ];
    for (const row of upstream) rows.push({ id: row, name: packageOfRow(row) });
    for (const row of tier.chatdshRows) rows.push({ id: row, name: packageOfRow(row) });
    for (const row of additional) {
      if (upstream.includes(row) || tier.chatdshRows.includes(row)) continue;
      rows.push({ id: row, name: packageOfRow(row) });
    }
    // 全量档以 PTC 形态呈现：模型只看到 run_code 与生成的 SDK，声明列表不随条目数增长。
    if (tier.presentation === 'ptc') {
      rows.push({
        id: 'tool-presentation',
        name: UPSTREAM_ROWS['tool-presentation'],
        config: { mode: 'ptc' },
      });
    }
    return rows as PresetDefinition['plugins'];
  }
}

export default ChatdshAssistantsService;
