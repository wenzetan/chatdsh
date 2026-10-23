/**
 * 客户端插件在宿主侧的入口。
 *
 * 面板全部在浏览器侧，宿主侧的空实现让这个包出现在宿主名册里；浏览器产物由
 * `dsh.client` 声明与 `./client` 子路径提供。副标题文案是纯函数，与浏览器侧共用，
 * 便于单独验证。
 * @module @chatdsh/client-assistants
 */

/** 设置页区段席位名，与浏览器侧共用同一个约定。 */
export const SECTION_SLOT = 'settings.section';

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/** 助手记录里的工具档位，标识与 `@chatdsh/core-contracts` 的档位一致。 */
export type AssistantTier = 'chat' | 'work' | 'full';

/** 档位在界面上的叫法，与预设名册的展示名一致。 */
export const TIER_LABEL: Readonly<Record<AssistantTier, string>> = {
  chat: '聊天档',
  work: '工作档',
  full: '全量档',
};

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
