/**
 * 工具档位契约。
 *
 * 同一个运行时里，不同 preset 需要不同规模的工具面：聊天只要少量工具，工作要文件与命令，
 * 重工具档则要把整套工具都提供出来而不挤占上下文。档位把「挂哪些行」与「模型看到什么形态」
 * 分开声明，装配代码按档位生成 preset，呈现选择行再按档位落到会话作用域。
 *
 * 档位只描述工具面，不含人格、指令与时间上下文：那三项所有档位共用。
 * @module @chatdsh/core-contracts/tool-tiers
 */

/** 档位标识。 */
export type ChatdshToolTierId = 'chat' | 'work' | 'full';

/** 一个档位的声明。 */
export interface ChatdshToolTier {
  /** 档位标识，同时也是 preset 标识的后缀。 */
  readonly id: ChatdshToolTierId;
  /** 展示名。 */
  readonly name: string;
  /** 展示说明，写进 preset 名册。 */
  readonly description: string;
  /** 预设名册里的排序值。 */
  readonly order: number;
  /** 模型看到的工具形态。 */
  readonly presentation: 'native' | 'ptc';
  /** 挂载的上游工具行 id，按书写顺序。 */
  readonly upstreamRows: readonly string[];
  /** 挂载的自建工具行 id，按书写顺序。 */
  readonly chatdshRows: readonly string[];
}

/**
 * 聊天档：只需要网页抓取、任务清单与当前会话检索。
 *
 * 不带文件与命令，因为聊天会话没有工作区，读写工具在那种会话里只会被误用。
 */
export const CHAT_TIER: ChatdshToolTier = {
  id: 'chat',
  name: 'ChatDSH 聊天',
  description: '轻量工具面：网页抓取、任务清单与会话检索。不含文件读写与命令执行。',
  order: 10,
  presentation: 'native',
  upstreamRows: ['tool-web', 'tool-todo', 'tool-session-query'],
  chatdshRows: [],
};

/**
 * 工作档：文件、命令、检索、任务与自建产出类工具。
 *
 * 这是默认档位。工具条目数中等，用 native 形态一次全量声明，模型不需要额外跳一层调用。
 */
export const WORK_TIER: ChatdshToolTier = {
  id: 'work',
  name: 'ChatDSH 工作',
  description: '默认工具面：文件读写、命令执行、内容检索、任务清单、制品与项目记录。',
  order: 20,
  presentation: 'native',
  upstreamRows: [
    'tool-bash',
    'tool-pwsh',
    'tool-fs',
    'tool-fs-search',
    'skill-filesystem',
    'tool-skill',
    'tool-jobs',
    'tool-todo',
    'tool-web',
  ],
  chatdshRows: [
    'chatdsh-tool-artifact',
    'chatdsh-tool-project',
    'chatdsh-tool-share',
    'chatdsh-tool-connector',
    'chatdsh-tool-research',
    'chatdsh-tool-image',
    'chatdsh-tool-skill-manage',
  ],
};

/**
 * 重工具档：在工作档之上补上子代理、工作树、定时、目标、结构化提问与浏览器。
 *
 * 走 `ptc` 形态：模型只看到单个 `run_code` 加一份生成的 TypeScript SDK，工具定义不逐条
 * 进入请求。这样条目数增加而请求里的声明列表不变，上下文占用与缓存前缀都稳定。
 */
export const FULL_TIER: ChatdshToolTier = {
  id: 'full',
  name: 'ChatDSH 全量',
  description: '全量工具面：在工作档之上补子代理、工作树、定时、目标、结构化提问与浏览器操作，以 PTC 形态呈现。',
  order: 30,
  presentation: 'ptc',
  upstreamRows: [
    'tool-bash',
    'tool-pwsh',
    'tool-fs',
    'tool-fs-search',
    'tool-str-replace-editor',
    'tool-terminal',
    'tool-working-directory',
    'tool-workspace-dependencies',
    'skill-filesystem',
    'tool-skill',
    'tool-jobs',
    'tool-todo',
    'tool-web',
    'tool-ask-user',
    'tool-goal',
    'tool-schedule',
    'tool-session-query',
    'tool-workflow',
    'tool-subagent',
    'tool-subagent-control',
    'tool-worktree',
  ],
  chatdshRows: [
    'chatdsh-tool-artifact',
    'chatdsh-tool-project',
    'chatdsh-tool-share',
    'chatdsh-tool-connector',
    'chatdsh-tool-research',
    'chatdsh-tool-image',
    'chatdsh-tool-skill-manage',
    'chatdsh-tool-browser',
  ],
};

/** 全部档位，按排序值排列。 */
export const CHATDSH_TOOL_TIERS: readonly ChatdshToolTier[] = [CHAT_TIER, WORK_TIER, FULL_TIER];

/** 默认档位标识。 */
export const DEFAULT_TOOL_TIER: ChatdshToolTierId = 'work';

/** 工具档位对应的 preset 标识。 */
export function presetIdOf(tier: ChatdshToolTierId): string {
  return `chatdsh-${tier}`;
}

/** 按标识取档位。 */
export function toolTierOf(id: ChatdshToolTierId): ChatdshToolTier {
  const found = CHATDSH_TOOL_TIERS.find((tier) => tier.id === id);
  if (found === undefined) throw new Error(`未知的工具档位：${id}`);
  return found;
}
