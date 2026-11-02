/**
 * 客户端插件在宿主侧的入口。
 *
 * 面板全部在浏览器侧，宿主侧的空实现让这个包出现在宿主名册里；浏览器产物由
 * `dsh.client` 声明与 `./client` 子路径提供。档位叫法、字段上限与副标题文案是纯函数，
 * 与浏览器侧共用同一份取值，便于单独验证。
 * @module @chatdsh/client-assistants
 */

/** 设置页区段席位名，与浏览器侧共用同一个约定。 */
export const SECTION_SLOT = 'settings.section';

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/** 助手记录里的工具档位，标识与 `@chatdsh/core-contracts` 的档位一致。 */
export type AssistantTier = 'chat' | 'work' | 'full';

/** 全部档位，按装配顺序从轻到重。 */
export const ASSISTANT_TIERS: readonly AssistantTier[] = ['chat', 'work', 'full'];

/** 档位在界面上的叫法，与预设名册的展示名一致。 */
export const TIER_LABEL: Readonly<Record<AssistantTier, string>> = {
  chat: '聊天档',
  work: '工作档',
  full: '全量档',
};

/** 每个档位对应的预设标识：助手在档位之上追加工具行。 */
export const TIER_PRESET_ID: Readonly<Record<AssistantTier, string>> = {
  chat: 'chatdsh-chat',
  work: 'chatdsh-work',
  full: 'chatdsh-full',
};

/** 档位的一句话说明，写进新建与编辑向导。 */
export const TIER_DESCRIPTION: Readonly<Record<AssistantTier, string>> = {
  chat: '网页抓取、任务清单与会话检索，不含文件读写与命令执行。',
  work: '文件读写、命令执行、内容检索、任务清单、制品与项目记录，默认档位。',
  full: '工作档之上补子代理、工作树、定时、目标、提问与浏览器，以单个执行入口呈现。',
};

/** 助手名称的字符上限，与宿主校验一致。 */
export const ASSISTANT_NAME_LIMIT = 80;

/** 助手说明的字符上限，与宿主校验一致。 */
export const ASSISTANT_DESCRIPTION_LIMIT = 512;

/** 助手指令的字符上限，与宿主校验一致。 */
export const ASSISTANT_INSTRUCTIONS_LIMIT = 32_000;

/** 排序值允许的范围，与宿主校验一致。 */
export const ASSISTANT_ORDER_RANGE = { min: -1_000_000, max: 1_000_000 } as const;

/** 新建助手的默认排序值，与宿主一致。 */
export const DEFAULT_ASSISTANT_ORDER = 100;

/**
 * 所有档位共用的三行：人格、指令与时间上下文。
 * 这三行不在附加工具候选里，它们由每个档位的装配结果自带。
 */
export const COMMON_ROWS: readonly string[] = ['persona', 'agent-instructions', 'time-context'];

/** 面板副标题需要的最小记录形状。 */
export interface AssistantSubtitleInput {
  /** 工具档位；缺省按默认的工作档。 */
  readonly tier?: AssistantTier;
  /** 助手的指令文本。 */
  readonly instructions: string;
}

/**
 * 助手记录的副标题：档位与指令摘要。
 * @param record - 助手记录。
 * @returns 面向用户的一句话。
 */
export function formatAssistantSubtitle(record: AssistantSubtitleInput): string {
  const tier = record.tier ?? 'work';
  const instructions = record.instructions === '' ? '没有附加说明' : record.instructions;
  return `${TIER_LABEL[tier]} · ${instructions}`;
}

/** 宿主侧插件体：本插件没有宿主侧行为。 */
export function apply(): void {}
