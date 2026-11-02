/**
 * 自定义助手：把助手记录装配成 agent preset，并提供增删改查。
 *
 * 每条助手记录在启动时注册成一个 preset，因此重启后助手仍在。启动时单条记录装不起来会留在
 * 预设名册的诊断里，界面能看到原因再修正或删除；写入路径上的装配失败整笔拒绝，不写记录。
 * 助手只决定指令、工具档位、额外工具行与技能引用，不引入第二套插件机制。
 *
 * 工具面按档位装配：档位的权威声明在 `@chatdsh/core-contracts` 的 `tool-tiers` 里，
 * 记录上只存档位标识与额外追加的行。全量档带 `tool-presentation` 行，模型看到的是单个
 * `run_code` 与生成的 SDK，工具条目数不再决定请求里的声明长度。
 *
 * 写入是「装配后落盘」的两步事务：装配失败或落盘失败都会把原定义装回去，记录保持不变，
 * 因此保存失败不会留下一个装不起来的助手。进行中的会话按创建时的定义运行，删除助手不会
 * 打断它们，删除结果里带上被引用的活动会话数。
 * @module @chatdsh/host-assistants
 */

import {
  agentPresetsOf,
  Remote,
  Service,
  sessionsOf,
  skillsOf,
  storageDomainOf,
  telemetryOf,
  TypertRemoteService,
  type Context,
  type PresetDefinition,
} from '@chatdsh/adapter';
import { UPSTREAM_AGENT_ROWS, UPSTREAM_ROWS } from '@chatdsh/adapter/upstream';
import { ChatdshError, CHATDSH_ERROR_CODES, DEFAULT_TOOL_TIER, toolTierOf, type ChatdshToolTierId } from '@chatdsh/core-contracts';
import {
  ASSISTANT_LIMIT,
  normalizeDescription,
  normalizeInstructions,
  normalizeName,
  normalizeOrder,
  normalizeSkills,
  normalizeTier,
  normalizeTools,
  packageOfRow,
  platformRows,
} from './catalog.ts';
import { ASSISTANTS_DOMAIN, type AssistantRecord } from './domain.ts';

export type { AssistantRecord } from './domain.ts';
export { ASSISTANTS_DOMAIN, assistantSchema } from './domain.ts';
export {
  ASSISTANT_INSTRUCTIONS_LIMIT,
  ASSISTANT_LIMIT,
  ASSISTANT_NAME_LIMIT,
  selectableToolRows,
} from './catalog.ts';

/** 新建助手时提供的字段。 */
export interface AssistantInput {
  /** 助手标识；省略时按时间生成。给出时只允许字母、数字、点、下划线与连字符，1 到 80 个字符。 */
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
  readonly instructions: string;
  /** 工具档位；省略时用默认档位。 */
  readonly tier?: ChatdshToolTierId;
  /** 在档位之上额外追加的工具行 id；省略表示只挂档位自带的那些。 */
  readonly tools?: readonly string[];
  /** 引用的技能标识；每个都要在技能目录里。 */
  readonly skills?: readonly string[];
  /** 预设排序；省略时排在自定义默认位。 */
  readonly order?: number;
}

/** 更新助手时提供的字段。省略的字段保持原值。 */
export interface AssistantPatch {
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly tier?: ChatdshToolTierId;
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly order?: number;
  /** 调用方读到的版本；与当前版本不同即拒绝写入。 */
  readonly revision?: number;
}

/** 删除助手的结果。 */
export interface AssistantRemoval {
  /** 被删除的助手标识。 */
  readonly id: string;
  /** 是否真的删掉了一条记录。 */
  readonly removed: boolean;
  /** 删除时仍在引用该助手的活动会话数。这些会话按创建时的定义继续运行。 */
  readonly liveSessions: number;
}

/** 助手运行时使用的服务名。 */
export const SERVICE_NAME = 'chatdshAssistants';

/** 自定义助手的默认排序位。 */
export const DEFAULT_ASSISTANT_ORDER = 100;

/** 助手标识的写法：字母、数字、点、下划线与连字符，1 到 80 个字符。 */
const ASSISTANT_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

/** 助手记录的键值表，只用到其中四个方法。 */
interface AssistantTable {
  get(key: string): AssistantRecord | undefined;
  entries(): IterableIterator<[string, AssistantRecord]>;
  put(key: string, value: AssistantRecord): Promise<void>;
  delete(key: string): Promise<boolean>;
  readonly size: number;
}

/** 一次写入动作的名字，同时是遥测的属性值。 */
type AssistantAction = 'create' | 'update' | 'delete';

/** 遥测面：只用到 span、事件与计数器。 */
interface AssistantsTelemetry {
  runSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    body: (span: { setAttribute(key: string, value: unknown): void }) => Promise<T>,
  ): Promise<T>;
  event(name: string, attributes?: Record<string, unknown>): void;
  counter(name: string, options?: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
}

/**
 * 助手服务。
 *
 * 记录落在 `chatdsh-assistants` 存储域，preset 由 `agentPresetRegistry` 装配。
 * 启动装配失败会记录在注册表的名册诊断里，读取名册即可看到原因。
 */
export class ChatdshAssistantsService extends TypertRemoteService {
  /** 注册表、结构化存储、技能目录与会话注册表是本服务的四个依赖。 */
  static inject = ['agentPresets', 'storageDomain', 'skills', 'sessions'];

  private readonly disposers = new Map<string, () => Promise<void>>();
  private table: AssistantTable | undefined;

  /** 写入链：读出当前版本、装配、落盘三步串行执行，并发写入不会交错。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(ctx: Context) {
    super(ctx, SERVICE_NAME);
  }

  /** 打开存储域并注册已有助手。失败按 fiber 启动失败上报，不吞掉。 */
  async [Service.init](): Promise<void> {
    const domain = await storageDomainOf(this.ctx).open(ASSISTANTS_DOMAIN);
    this.table = domain.table('assistants') as unknown as AssistantTable;
    for (const [, record] of this.table.entries()) {
      await this.mountStored(record);
    }
  }

  /** 列出全部助手，按排序值与名称排列。 */
  @Remote('list')
  list(): AssistantRecord[] {
    if (this.table === undefined) return [];
    return [...this.table.entries()]
      .map(([, record]) => record)
      .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
  }

  /** 新建一条助手并立即装配。 */
  @Remote('create')
  async create(input: AssistantInput): Promise<AssistantRecord> {
    const name = normalizeName(input.name);
    const instructions = normalizeInstructions(input.instructions);
    const description = normalizeDescription(input.description ?? '');
    const tier = normalizeTier(input.tier);
    const order = input.order === undefined ? DEFAULT_ASSISTANT_ORDER : normalizeOrder(input.order);
    const id = input.id === undefined ? this.newId() : this.parseId(input.id);
    return this.run('create', () => this.serialize(async () => {
      const table = this.requireTable();
      if (table.get(id) !== undefined) {
        throw new ChatdshError('request-invalid', '助手标识已存在', { assistantId: id });
      }
      if (table.size >= ASSISTANT_LIMIT) {
        throw new ChatdshError('request-invalid', '助手数量达到上限', { limit: ASSISTANT_LIMIT });
      }
      const tools = normalizeTools(input.tools) ?? [];
      const skills = await this.resolveSkills(input.skills);      this.assertNameFree(table, name, id);
      const now = Date.now();
      const record: AssistantRecord = {
        id,
        name,
        description,
        order,
        instructions,
        ...(tier === undefined ? {} : { tier }),
        tools,
        skills,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      await this.mount(record);
      try {
        await table.put(id, record);
      } catch (error) {
        await this.unmount(id);
        throw error;
      }
      return record;
    }));
  }

  /** 更新一条助手的指令、档位、额外工具、技能或展示信息，重新装配它的 preset。 */
  @Remote('update')
  async update(id: string, patch: AssistantPatch): Promise<AssistantRecord> {
    const assistantId = this.parseId(id);
    return this.run('update', () => this.serialize(async () => {
      const table = this.requireTable();
      const current = table.get(assistantId);
      if (current === undefined) {
        throw new ChatdshError('object-not-found', '助手不存在', { assistantId });
      }
      if (patch.revision !== undefined && patch.revision !== current.revision) {
        throw new ChatdshError('revision-conflict', '助手版本已过期', { revision: current.revision });
      }
      const name = patch.name === undefined ? current.name : normalizeName(patch.name);
      const instructions = patch.instructions === undefined ? current.instructions : normalizeInstructions(patch.instructions);
      const description = patch.description === undefined ? current.description : normalizeDescription(patch.description);
      const order = patch.order === undefined ? current.order : normalizeOrder(patch.order);
      const tier = patch.tier === undefined ? current.tier : normalizeTier(patch.tier);
      const tools = patch.tools === undefined ? [...current.tools] : normalizeTools(patch.tools) ?? [];
      const skills = patch.skills === undefined ? [...current.skills] : await this.resolveSkills(patch.skills);
      this.assertNameFree(table, name, assistantId);
      const next: AssistantRecord = {
        id: assistantId,
        name,
        description,
        order,
        instructions,
        ...(tier === undefined ? {} : { tier }),
        tools,
        skills,
        revision: current.revision + 1,
        createdAt: current.createdAt,
        updatedAt: Date.now(),
      };
      await this.remount(current, next);
      try {
        await table.put(assistantId, next);
      } catch (error) {
        await this.restore(current);
        throw error;
      }
      return next;
    }));
  }

  /**
   * 删除一条助手。
   *
   * 删除只移除配置与 preset 注册；活动会话保留创建时的定义继续运行，返回的
   * `liveSessions` 记录删除那一刻仍引用它的会话数。
   */
  @Remote({ name: 'delete' })
  async remove(id: string): Promise<AssistantRemoval> {
    const assistantId = this.parseId(id);
    return this.run('delete', () => this.serialize(async () => {
      const table = this.requireTable();
      if (table.get(assistantId) === undefined) {
        throw new ChatdshError('object-not-found', '助手不存在', { assistantId });
      }
      const liveSessions = this.liveSessionCount(assistantId);
      await this.unmount(assistantId);
      const removed = await table.delete(assistantId);
      return { id: assistantId, removed, liveSessions };
    }));
  }

  /**
   * 按记录的档位与额外行组装会话级插件行。
   *
   * 公开是为了让装配结果可以直接被断言：装配结果决定模型看到哪些工具，
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

  /** 校验技能引用：每个标识都要在技能目录里，返回去重后的标识。 */
  private async resolveSkills(skills: readonly string[] | undefined): Promise<string[]> {
    if (skills === undefined || skills.length === 0) return [];
    const summaries = await skillsOf(this.ctx).list();
    const available = new Set(summaries.map((summary) => summary.name));
    return normalizeSkills(skills, available) ?? [];
  }

  /** 统计仍引用该助手的活动会话数。 */
  private liveSessionCount(id: string): number {
    return sessionsOf(this.ctx).list().filter((session) => session.header.agentPreset === id).length;
  }

  /** 校验并规范化调用方给出的标识。 */
  private parseId(id: string): string {
    if (typeof id !== 'string' || !ASSISTANT_ID_PATTERN.test(id)) {
      throw new ChatdshError('request-invalid', '助手标识写法不合法', { assistantId: String(id) });
    }
    return id;
  }

  /** 生成一条新助手的标识。 */
  private newId(): string {
    return `assistant-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  /**
   * 确认名称没有被别的助手占用。名称比较忽略首尾空白与大小写。
   * @param table - 助手表。
   * @param name - 已规范化的名称。
   * @param exceptId - 允许持有该名称的助手标识。
   */
  private assertNameFree(table: AssistantTable, name: string, exceptId: string): void {
    const wanted = name.toLocaleLowerCase();
    for (const [id, record] of table.entries()) {
      if (id === exceptId) continue;
      if (record.name.toLocaleLowerCase() === wanted) {
        throw new ChatdshError('request-invalid', '助手名称已被使用', { assistantId: id });
      }
    }
  }

  private requireTable(): AssistantTable {
    if (this.table === undefined) throw new ChatdshError('internal-error', '助手存储尚未就绪');
    return this.table;
  }

  /**
   * 装配一个 preset 定义。
   *
   * 注册表把挂载失败记在名册诊断里而不是抛给调用方，因此这里再用挂载代确认一次：没有留下
   * 挂载代说明这棵树没装起来，按装配失败处理，并把刚注册的空壳退掉。
   * @param record - 要装配的记录。
   */
  private async mount(record: AssistantRecord): Promise<void> {
    let dispose: () => Promise<void>;
    try {
      dispose = await agentPresetsOf(this.ctx).register(this.definitionOf(record));
    } catch {
      throw new ChatdshError('request-invalid', '助手装配失败，已保留原定义', { assistantId: record.id });
    }
    if (!this.mounted(record.id)) {
      await dispose();
      throw new ChatdshError('request-invalid', '助手装配失败，已保留原定义', { assistantId: record.id });
    }
    this.disposers.set(record.id, dispose);
  }

  /**
   * 启动时装配一条已经保存的记录。
   *
   * 记录已经在存储里，装不起来时把它留在名册诊断里，界面能看到原因再删掉或改好；启动不因
   * 单条记录装不起来而整片失败。标识被别的预设占用属于配置冲突，直接抛出。
   * @param record - 已保存的记录。
   */
  private async mountStored(record: AssistantRecord): Promise<void> {
    const dispose = await agentPresetsOf(this.ctx).register(this.definitionOf(record));
    this.disposers.set(record.id, dispose);
  }

  /** 由记录生成 preset 定义。 */
  private definitionOf(record: AssistantRecord): PresetDefinition {
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      order: record.order,
      plugins: this.composePlugins(record),
    };
  }

  /** 卸载一条助手的 preset。 */
  private async unmount(id: string): Promise<void> {
    const dispose = this.disposers.get(id);
    if (dispose === undefined) return;
    this.disposers.delete(id);
    await dispose();
  }

  /**
   * 换上新的定义：先卸旧定义，再装新定义。新定义装不起来时把旧定义装回去。
   * @param current - 当前记录。
   * @param next - 待写入的记录。
   */
  private async remount(current: AssistantRecord, next: AssistantRecord): Promise<void> {
    await this.unmount(current.id);
    try {
      await this.mount(next);
    } catch (error) {
      await this.mount(current);
      throw error;
    }
  }

  /** 把一条记录的定义装回去，用于落盘失败后的回退。 */
  private async restore(record: AssistantRecord): Promise<void> {
    await this.unmount(record.id);
    await this.mount(record);
  }

  /** 注册表里是否存在这个预设的挂载代。 */
  private mounted(id: string): boolean {
    return agentPresetsOf(this.ctx).inspectCompositions().some((entry) => entry.id === id);
  }

  /** 把一次写入串到写入链上。前一次失败不阻断后一次。 */
  private serialize<T>(body: () => Promise<T>): Promise<T> {
    const run = this.chain.then(body, body);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 跑一次带遥测的动作：成功记 `outcome=ok`，失败先记拒绝事件与错误码再抛出。
   * @param action - 动作名。
   * @param body - 动作本体。
   * @returns 动作结果。
   */
  private async run<T>(action: AssistantAction, body: () => Promise<T>): Promise<T> {
    const telemetry = telemetryOf<AssistantsTelemetry>(this.ctx);
    if (telemetry === undefined) return body();
    const counter = telemetry.counter('chatdsh_runtime_assistant_writes_total', { description: '助手记录写入次数' });
    return telemetry.runSpan('chatdsh.runtime.assistant.write', { action }, async (span) => {
      try {
        const result = await body();
        span.setAttribute('outcome', 'ok');
        counter.add(1, { action, outcome: 'ok' });
        return result;
      } catch (error) {
        const type = error instanceof Error ? error.name : 'Unknown';
        const code = error instanceof ChatdshError ? error.code : CHATDSH_ERROR_CODES.internalError;
        span.setAttribute('outcome', 'failed');
        span.setAttribute('error.type', type);
        span.setAttribute('error.code', code);
        telemetry.event('chatdsh.runtime.assistant.rejected', { action, outcome: 'failed', 'error.type': type, 'error.code': code });
        counter.add(1, { action, outcome: 'failed' });
        throw error;
      }
    });
  }
}

/** 注册助手服务。 */
export function apply(ctx: Context): void {
  ctx.plugin(ChatdshAssistantsService);
}

export default ChatdshAssistantsService;
