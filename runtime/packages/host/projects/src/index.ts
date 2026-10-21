/**
 * 项目：在工作区之上扩展标题、项目说明与默认模型。
 *
 * 记录按工作目录的绝对路径存放，会话创建时把 cwd 作为键读取，因此项目说明只影响
 * 落在该目录下的会话。项目说明经系统提示的上下文席位注入，注入失败不阻断会话。
 * @module @chatdsh/host-projects
 */

import { Remote, storageDomainOf, systemPromptOf, TypertRemoteService, type Context } from '@chatdsh/adapter';
// 引入系统提示服务的类型声明，供 `ctx.systemPrompt` 的解析使用。

import { PROJECTS_DOMAIN, type ProjectRecord } from './domain.ts';

export type { ProjectRecord } from './domain.ts';
export { PROJECTS_DOMAIN, projectSchema } from './domain.ts';

/** 项目运行时使用的服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshProjects';

/** 上下文席位名，整棵运行时内唯一。 */
export const CONTEXT_NAME = 'chatdsh-project:instructions';

/** 上下文席位顺序，先于默认区段出现。 */
export const CONTEXT_ORDER = 10;

/** 写入项目记录的输入。 */
export interface ProjectInput {
  readonly path: string;
  readonly title?: string;
  readonly instructions?: string;
  readonly defaultModel?: string;
  /** 工作区是否共享。 */
  readonly shared?: boolean;
}

/** 只用到四个方法的键值表。 */
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

/**
 * 项目服务。
 *
 * 项目说明是操作上下文，不是模型可见的普通消息：它以「项目说明」段落注入，空缺时不占位置。
 */
export class ChatdshProjectsService extends TypertRemoteService {
  /** 结构化存储与系统提示是本服务的两个依赖。 */
  static inject = ['storageDomain', 'systemPrompt'];

  private projects: Table<ProjectRecord> | undefined;

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

  /** 列出全部项目记录。 */
  @Remote('list')
  list(): ProjectRecord[] {
    if (this.projects === undefined) return [];
    return [...this.projects.entries()].map(([, record]) => record);
  }

  /** 读取一个项目的记录。 */
  @Remote('get')
  get(path: string): ProjectRecord | undefined {
    return this.projects?.get(path);
  }

  /** 写入或更新一个项目。 */
  @Remote('set')
  async set(input: ProjectInput): Promise<ProjectRecord> {
    const projects = this.require();
    const current = projects.get(input.path);
    const record: ProjectRecord = {
      path: input.path,
      title: input.title ?? current?.title ?? '',
      instructions: input.instructions ?? current?.instructions ?? '',
      defaultModel: input.defaultModel ?? current?.defaultModel,
      shared: input.shared ?? current?.shared,
      updatedAt: Date.now(),
    };
    await projects.put(input.path, record);
    return record;
  }

  /** 删除一个项目的记录。 */
  @Remote({ name: 'delete' })
  async remove(path: string): Promise<boolean> {
    return this.require().delete(path);
  }

  /** 会话的 cwd 对应的项目说明；没有记录或说明为空时返回空串。 */
  private instructionsFor(context: AssemblyScope): string {
    const cwd = context.agent?.session?.header?.cwd;
    if (cwd === undefined || this.projects === undefined) return '';
    const record = this.projects.get(cwd);
    if (record === undefined || record.instructions.trim() === '') return '';
    const head = record.title.trim() === '' ? '' : `项目：${record.title}\n`;
    return `${head}${record.instructions}`;
  }

  private require(): Table<ProjectRecord> {
    if (this.projects === undefined) throw new Error('project storage is not ready');
    return this.projects;
  }
}

export default ChatdshProjectsService;
