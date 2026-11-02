/**
 * 项目：在工作区之上扩展标题、项目说明、默认模型与默认助手。
 *
 * 记录按工作目录的规范化绝对路径存放，会话创建时把 cwd 作为键读取，因此项目说明只影响
 * 落在该目录下的会话。项目说明经系统提示的上下文席位注入，注入失败不阻断会话。
 *
 * 写入带 `revision` 比较交换：调用方带上读到的版本，版本落后即返回 `revision-conflict`，
 * 两个界面不会互相覆盖。默认模型按模型目录核对路由，默认助手按预设名册核对该预设可用。
 * 删除只移除配置记录，目录内容与既有会话不受影响。
 * @module @chatdsh/host-projects
 */

import {
  agentPresetsOf,
  llmOf,
  Remote,
  storageDomainOf,
  systemPromptOf,
  telemetryOf,
  TypertRemoteService,
  type Context,
} from '@chatdsh/adapter';
import { ChatdshError, CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';

import { PROJECTS_DOMAIN, type ProjectRecord } from './domain.ts';
import {
  displayTitleOf,
  normalizeProjectPath,
  normalizeTitle,
  parseModelReference,
  pathKindOf,
} from './paths.ts';

export type { ProjectRecord } from './domain.ts';
export { PROJECTS_DOMAIN, projectSchema } from './domain.ts';
export { displayTitleOf, normalizeProjectPath, PROJECT_TITLE_LIMIT } from './paths.ts';

/** 项目运行时使用的服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshProjects';

/** 上下文席位名，整棵运行时内唯一。 */
export const CONTEXT_NAME = 'chatdsh-project:instructions';

/** 上下文席位顺序，先于默认区段出现。 */
export const CONTEXT_ORDER = 10;

/** 写入项目记录的输入。省略的字段表示保持原值，`revision` 省略表示按当前版本写入。 */
export interface ProjectInput {
  /** 工作目录路径；允许末尾带斜杠，写入时规范化。 */
  readonly path: string;
  /** 展示名；留空表示按目录末段显示。 */
  readonly title?: string;
  /** 项目说明，保留完整文本。 */
  readonly instructions?: string;
  /** 默认模型引用，写法为 `provider/model`。 */
  readonly defaultModel?: string;
  /** 默认助手标识，取值是已注册的预设标识。 */
  readonly defaultAssistant?: string;
  /** 调用方读到的版本；与当前版本不同即拒绝写入。 */
  readonly revision?: number;
}

/** 一次写入动作的名字，同时是遥测的属性值。 */
export type ProjectAction = 'create' | 'set' | 'delete';

/** 遥测面：只用到 span、事件与计数器。 */
interface ProjectsTelemetry {
  runSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    body: (span: { setAttribute(key: string, value: unknown): void }) => Promise<T>,
  ): Promise<T>;
  event(name: string, attributes?: Record<string, unknown>): void;
  counter(name: string, options?: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
}

/** 只用到五个方法的键值表。 */
interface Table<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** 会话作用域的径向读取：装配上下文里带着当前 agent 与其会话。 */
interface AssemblyScope {
  readonly agent?: { readonly session?: { readonly header?: { readonly cwd?: string } } };
}

/** 一次写入里被提供的字段。 */
interface ProjectFields {
  readonly title?: string;
  readonly instructions?: string;
  readonly defaultModel?: string;
  readonly defaultAssistant?: string;
}

/**
 * 项目服务。
 *
 * 项目说明是操作上下文，不是模型可见的普通消息：它以「项目说明」段落注入，空缺时不占位置。
 */
export class ChatdshProjectsService extends TypertRemoteService {
  /** 结构化存储、系统提示、模型目录与预设名册是本服务的四个依赖。 */
  static inject = ['storageDomain', 'systemPrompt', 'llm', 'agentPresets'];

  private projects: Table<ProjectRecord> | undefined;

  /** 写入链：读出当前版本、核对版本、落盘三步串行执行，并发写入不会交错。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(ctx: Context) {
    super(ctx, SERVICE_NAME);
  }

  /** 打开存储域并注册上下文席位。 */
  async [TypertRemoteService.init](): Promise<void> {
    const domain = await storageDomainOf(this.ctx).open(PROJECTS_DOMAIN);
    this.projects = domain.table('projects') as unknown as Table<ProjectRecord>;
    systemPromptOf(this.ctx).context({
      name: CONTEXT_NAME,
      order: CONTEXT_ORDER,
      interpolate: false,
      text: (context: unknown) => this.instructionsFor(context as AssemblyScope),
    });
  }

  /** 列出全部项目记录，按路径排序。 */
  @Remote('list')
  list(): ProjectRecord[] {
    if (this.projects === undefined) return [];
    return [...this.projects.entries()]
      .map(([, record]) => record)
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  /** 读取一个项目的记录。 */
  @Remote('get')
  get(path: string): ProjectRecord | undefined {
    const key = normalizeProjectPath(path);
    return this.projects?.get(key);
  }

  /**
   * 新建一个项目。
   *
   * 目录必须已经存在；同一目录已有记录时拒绝，因为项目的身份就是那个目录。
   */
  @Remote('create')
  async create(input: ProjectInput): Promise<ProjectRecord> {
    const path = normalizeProjectPath(input.path);
    const fields = this.normalizeFields(input);
    const kind = pathKindOf(path);
    if (kind !== 'directory') {
      throw new ChatdshError('request-invalid', '项目目录不存在或不是目录', { path, kind });
    }
    return this.write('create', () => this.serialize(async () => {
      const table = this.require();
      if (table.get(path) !== undefined) {
        throw new ChatdshError('request-invalid', '该目录已经有项目记录', { path });
      }
      await this.assertReferences(fields);
      return this.persist(table, path, undefined, fields);
    }));
  }

  /**
   * 写入或更新一个项目。
   *
   * 省略 `revision` 时按当前版本直接写（工具与既有调用方走这条路径）；给出 `revision` 时
   * 与当前版本比较，版本落后即拒绝。
   */
  @Remote('set')
  async set(input: ProjectInput): Promise<ProjectRecord> {
    const path = normalizeProjectPath(input.path);
    const fields = this.normalizeFields(input);
    const expected = this.parseRevision(input.revision);
    return this.write('set', () => this.serialize(async () => {
      const table = this.require();
      await this.assertReferences(fields);
      return this.persist(table, path, expected, fields);
    }));
  }

  /** 删除一个项目的记录。目录内容、既有会话与记忆都不受影响。 */
  @Remote({ name: 'delete' })
  async remove(path: string): Promise<boolean> {
    const key = normalizeProjectPath(path);
    return this.write('delete', () => this.serialize(async () => this.require().delete(key)));
  }

  /** 会话的 cwd 对应的项目上下文；没有记录或说明为空时返回空串。 */
  private instructionsFor(context: AssemblyScope): string {
    const cwd = context.agent?.session?.header?.cwd;
    if (cwd === undefined || this.projects === undefined) return '';
    const record = this.projects.get(cwd);
    if (record === undefined || record.instructions.trim() === '') return '';
    return `项目：${record.displayTitle}\n${record.instructions}`;
  }

  /** 校验并规范化调用方提供的字段。省略的字段不出现在结果里。 */
  private normalizeFields(input: ProjectInput): ProjectFields {
    if (input.instructions !== undefined && typeof input.instructions !== 'string') {
      throw new ChatdshError('request-invalid', '项目说明必须是字符串');
    }
    return {
      ...(input.title === undefined ? {} : { title: normalizeTitle(input.title) }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      ...(input.defaultModel === undefined ? {} : { defaultModel: input.defaultModel.trim() }),
      ...(input.defaultAssistant === undefined ? {} : { defaultAssistant: input.defaultAssistant.trim() }),
    };
  }

  /** 校验 revision 参数。 */
  private parseRevision(revision: number | undefined): number | undefined {
    if (revision === undefined) return undefined;
    if (!Number.isInteger(revision) || revision < 0) {
      throw new ChatdshError('request-invalid', 'revision 必须是非负整数');
    }
    return revision;
  }

  /**
   * 对照模型目录与预设名册校验引用。
   *
   * 模型引用的路由必须在模型目录里注册；预设必须已经装配成功，否则引用它的会话在创建时
   * 就会落在失败的预设上。
   */
  private async assertReferences(fields: ProjectFields): Promise<void> {
    if (fields.defaultModel !== undefined) {
      const { provider } = parseModelReference(fields.defaultModel);
      const registered = llmOf(this.ctx).listProviders().some((info) => info.id === provider);
      if (!registered) {
        throw new ChatdshError('request-invalid', '默认模型的路由没有注册', { provider });
      }
    }
    if (fields.defaultAssistant === undefined) return;
    const agentPreset = fields.defaultAssistant;
    if (agentPreset === '') {
      throw new ChatdshError('request-invalid', '默认助手标识不能为空');
    }
    const resolved = await agentPresetsOf(this.ctx).resolve(agentPreset).catch((error: unknown) => {
      if (projectIsMissingPreset(error)) {
        throw new ChatdshError('request-invalid', '默认助手不是已注册的预设', { agentPreset });
      }
      throw error;
    });
    if (resolved.broken !== undefined) {
      throw new ChatdshError('request-invalid', '默认助手的预设装配失败', { agentPreset });
    }
  }

  /**
   * 写一条记录：没有当前记录时新建并从 1 开始计数，否则合并字段并递增版本。
   * @param table - 项目表。
   * @param path - 规范化后的路径。
   * @param expected - 调用方读到的版本；省略表示不做比较。
   * @param fields - 本次提供的字段。
   * @returns 写入后的记录。
   */
  private async persist(
    table: Table<ProjectRecord>,
    path: string,
    expected: number | undefined,
    fields: ProjectFields,
  ): Promise<ProjectRecord> {
    const current = table.get(path);
    const updatedAt = Date.now();
    if (current === undefined) {
      if (expected !== undefined && expected !== 0) {
        throw new ChatdshError('revision-conflict', '项目记录不存在或已被删除', { revision: 0 });
      }
      const title = fields.title ?? '';
      const record: ProjectRecord = {
        path,
        title,
        displayTitle: displayTitleOf(path, title),
        instructions: fields.instructions ?? '',
        ...(fields.defaultModel === undefined ? {} : { defaultModel: fields.defaultModel }),
        ...(fields.defaultAssistant === undefined ? {} : { defaultAssistant: fields.defaultAssistant }),
        revision: 1,
        updatedAt,
      };
      await table.put(path, record);
      return record;
    }
    if (expected !== undefined && expected !== current.revision) {
      throw new ChatdshError('revision-conflict', '项目记录版本已过期', { revision: current.revision });
    }
    const title = fields.title ?? current.title;
    const defaultModel = fields.defaultModel ?? current.defaultModel;
    const defaultAssistant = fields.defaultAssistant ?? current.defaultAssistant;
    const record: ProjectRecord = {
      path,
      title,
      displayTitle: displayTitleOf(path, title),
      instructions: fields.instructions ?? current.instructions,
      ...(defaultModel === undefined ? {} : { defaultModel }),
      ...(defaultAssistant === undefined ? {} : { defaultAssistant }),
      revision: current.revision + 1,
      updatedAt,
    };
    await table.put(path, record);
    return record;
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
  private async write<T>(action: ProjectAction, body: () => Promise<T>): Promise<T> {
    const telemetry = telemetryOf<ProjectsTelemetry>(this.ctx);
    if (telemetry === undefined) return body();
    const counter = telemetry.counter('chatdsh_runtime_project_writes_total', { description: '项目记录写入次数' });
    return telemetry.runSpan('chatdsh.runtime.project.write', { action }, async (span) => {
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
        telemetry.event('chatdsh.runtime.project.rejected', { action, outcome: 'failed', 'error.type': type, 'error.code': code });
        counter.add(1, { action, outcome: 'failed' });
        throw error;
      }
    });
  }

  private require(): Table<ProjectRecord> {
    if (this.projects === undefined) throw new ChatdshError('internal-error', '项目存储尚未就绪');
    return this.projects;
  }
}

/**
 * 判断一个错误是不是预设名册给出的「没有这个预设」。
 * @param error - 捕获到的错误。
 * @returns 是则该错误可以翻译成输入不合法。
 */
function projectIsMissingPreset(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === 'agent-preset/not-found';
}

export default ChatdshProjectsService;
