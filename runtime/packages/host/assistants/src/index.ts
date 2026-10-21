/**
 * 自定义助手：把助手记录装配成 agent preset，并提供增删改查。
 *
 * 每条助手记录在启动时注册成一个 preset，因此重启后助手仍在；注册失败会留在预设名册的
 * 诊断里，不静默消失。助手只决定指令与可用工具，不引入第二套插件机制。
 * @module @chatdsh/host-assistants
 */

import { agentPresetsOf, Service, storageDomainOf, type Context } from '@chatdsh/adapter';
// 引入两个被注入服务的类型声明，供 `ctx` 的服务名解析使用。
import { CHATDSH_TOOL_ROWS } from '@chatdsh/core-contracts';
import { Remote, TypertRemoteService, type PresetDefinition } from '@chatdsh/adapter';
import { UPSTREAM_AGENT_ROWS, UPSTREAM_TOOL_ROWS } from '@chatdsh/adapter/upstream';
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
  /** 允许使用的工具行 id；省略表示沿用默认工具面。 */
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

/** 当前平台上应当挂载的工具行。 */
function platformToolRows(): readonly string[] {
  const hidden = process.platform === 'win32' ? 'tool-bash' : 'tool-pwsh';
  return CHATDSH_TOOL_ROWS.filter((row) => row !== hidden);
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
      tools: input.tools ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await table.put(id, record);
    await this.mount(id, record);
    return record;
  }

  /** 更新一条助手的指令或展示信息，重新装配它的 preset。 */
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

  /** 按记录组装会话级插件行。 */
  private composePlugins(record: AssistantRecord): PresetDefinition['plugins'] {
    const available = platformToolRows();
    const selected = record.tools.length === 0
      ? available
      : available.filter((row) => record.tools.includes(row));
    const rows: unknown[] = [
      { id: 'persona', name: UPSTREAM_AGENT_ROWS.persona, config: { prefix: record.instructions } },
      { id: 'agent-instructions', name: UPSTREAM_AGENT_ROWS['agent-instructions'], config: { maxBytes: 65536 } },
    ];
    for (const row of selected) {
      rows.push({ id: row, name: UPSTREAM_TOOL_ROWS[row as keyof typeof UPSTREAM_TOOL_ROWS] });
    }
    return rows as PresetDefinition['plugins'];
  }
}

export default ChatdshAssistantsService;
