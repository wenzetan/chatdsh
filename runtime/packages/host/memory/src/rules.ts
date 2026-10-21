/**
 * 记忆的 bank 规则。
 *
 * 这一层是纯规则：给定会话场景，算出该召回与写入哪些 bank，以及如何合并多路召回结果。
 * 它不依赖运行时，也不发起请求，因此可以单独验证。
 * @module @chatdsh/host-memory/rules
 */

/** 一条召回结果。 */
export interface MemoryHit {
  readonly id: string;
  readonly text: string;
  readonly type: string;
  readonly tags?: readonly string[];
  readonly score?: number;
}

/** 会话场景，决定读写哪些 bank。 */
export interface MemoryScope {
  readonly accountId: string;
  readonly tenantId: string;
  /** 记忆组标识，默认等于工作区标识。 */
  readonly memoryGroupId?: string;
  /** 共享工作区把记忆写进组 bank，私有工作区只写账号 bank。 */
  readonly shared?: boolean;
}

/**
 * 算出一次会话该召回与写入的 bank。
 *
 * 聊天会话没有工作区：只读写账号 bank。有工作区时召回先查组 bank 再查账号 bank；
 * 写入落在账号 bank 还是组 bank，由工作区是否共享决定。
 * @param scope - 会话场景。
 * @returns 召回按顺序的 bank 列表与写入 bank。
 */
export function banksFor(scope: MemoryScope): { recall: string[]; write: string } {
  const accountBank = `acct:${scope.accountId}`;
  if (scope.memoryGroupId === undefined) return { recall: [accountBank], write: accountBank };
  const groupBank = `t:${scope.tenantId}:ws:${scope.memoryGroupId}`;
  return {
    recall: [groupBank, accountBank],
    write: scope.shared === true ? groupBank : accountBank,
  };
}

/**
 * 按文本去重并保序：多路召回按查询顺序拼接，先出现的保留。
 * @param hits - 各路召回的合并结果。
 * @returns 去重后的结果。
 */
export function dedupeHits(hits: readonly MemoryHit[]): MemoryHit[] {
  const seen = new Set<string>();
  const out: MemoryHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.text)) continue;
    seen.add(hit.text);
    out.push(hit);
  }
  return out;
}

/** 一条消息里的文本块。 */
interface TextBlock {
  readonly type?: string;
  readonly text?: string;
}

/**
 * 取最后一条带文本的用户消息。
 * @param messages - 本步接受的用户消息。
 * @returns 文本；没有文本时为空串。
 */
export function lastUserText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { content?: readonly TextBlock[] };
    const text = (message.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join(' ')
      .trim();
    if (text !== '') return text;
  }
  return '';
}

/**
 * 把召回结果渲染成提示里的一段。
 * @param hits - 召回结果。
 * @returns 文本；没有结果时为空串，提示里不会多出空段。
 */
export function renderRecallSection(hits: readonly { readonly text: string }[]): string {
  if (hits.length === 0) return '';
  return `# 相关记忆\n${hits.map((hit) => `- ${hit.text}`).join('\n')}`;
}

/** 一次回合里用于写入记忆的消息。 */
export interface TurnMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/**
 * 把一回合的消息拼成一条待写入的记忆。
 *
 * 这是不依赖模型的规则抽取：保留用户问题与助手结论，去掉工具调用与中间步骤，按上限
 * 截断。模型摘要由上层在可用时替换这条规则的结果，规则结果作为摘要不可用时的兜底。
 * @param messages - 本回合的用户与助手消息。
 * @param limit - 最大字符数，默认 4000。
 * @returns 一条记忆文本；没有内容时为空串。
 */
export function composeTurnMemory(messages: readonly TurnMessage[], limit = 4000): string {
  const user = messages.filter((message) => message.role === 'user').map((message) => message.text.trim()).filter((text) => text !== '');
  const assistant = messages.filter((message) => message.role === 'assistant').map((message) => message.text.trim()).filter((text) => text !== '');
  if (user.length === 0 && assistant.length === 0) return '';
  const parts: string[] = [];
  if (user.length > 0) parts.push(`用户：${user.join('\n')}`);
  if (assistant.length > 0) parts.push(`助手：${assistant.join('\n')}`);
  const text = parts.join('\n');
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** 一次回合写入的计划。 */
export interface TurnWritePlan {
  /** 写入的 bank。 */
  readonly bank: string;
  /** 写入的内容。 */
  readonly content: string;
}

/**
 * 算出一回合记忆写到哪个 bank、写什么内容。
 *
 * 私有工作区写账号 bank，共享工作区写组 bank，聊天会话（没有 cwd）写账号 bank。
 * 内容为空时不产生计划，避免把空回合写成一条空记忆。
 * @param input - 工作目录、共享标记与本回合消息。
 * @returns 写入计划；没有内容时为 `undefined`。
 */
export function planTurnWrite(input: {
  readonly cwd: string;
  readonly shared: boolean;
  readonly messages: readonly TurnMessage[];
}): TurnWritePlan | undefined {
  const content = composeTurnMemory(input.messages);
  if (content === '') return undefined;
  const banks = banksFor({
    accountId: 'local',
    tenantId: 'default',
    memoryGroupId: input.cwd === '' ? undefined : input.cwd,
    shared: input.shared,
  });
  return { bank: banks.write, content };
}

/**
 * 回合写入去重器。
 *
 * 记录已经写过的 `sessionId:endSeq`，并限制条目数：长时间运行的进程不会无限增长，
 * 超出上限时淘汰最早的一条。淘汰只影响去重记忆，不影响已经写入的数据。
 */
export class TurnWriteDeduper {
  readonly #seen = new Set<string>();

  constructor(private readonly limit = 1024) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError(`去重上限必须是正安全整数，收到 ${String(limit)}`);
  }

  /** 当前记录数。 */
  get size(): number {
    return this.#seen.size;
  }

  /**
   * 接受一个键；已经见过时返回 false。
   * @param key - `sessionId:endSeq`。
   * @returns 是否首次见到。
   */
  accept(key: string): boolean {
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    if (this.#seen.size > this.limit) {
      const oldest = this.#seen.values().next().value;
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return true;
  }
}
