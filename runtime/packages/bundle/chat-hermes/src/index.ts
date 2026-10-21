/**
 * Hermes 聊天后端组合包。
 *
 * 组合包本身不注册服务，内容由补丁层表达：挂载 Hermes 聊天行，并把审批行切到自建
 * 应答链（渠道会话没有活动 Agent，走不了上游的审批请求）。
 * @module @chatdsh/bundle-chat-hermes
 */

/** 相对组合包根的补丁文件路径。 */
export const PATCH_FILE = './cordis.patch.yml';

/** 本组合包挂载的行 id。 */
export const CHAT_ROWS = ['chatdsh-chat-hermes'] as const;
