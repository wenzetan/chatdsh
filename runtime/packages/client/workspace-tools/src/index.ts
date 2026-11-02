/**
 * ChatDSH 工作区工具客户端：文件浏览与预览、终端展示、附件上传与录音。
 *
 * 模块按职责拆分：
 * - `files`：目录树模型、路径拼接、预览判定与失败说明；
 * - `terminal`：终端展示模型、命令与输出分离、断线重连不重放；
 * - `attachments`：附件校验、进度、重试、取消、发送拦截与引用插入；
 * - `voice`：录音权限、录制状态、上传与转写；
 * - `gateway`：数据入口，接宿主 `workspaceFiles`、`chatdshAttachments` 与 `chatdshVoice`；
 * - `telemetry`：浏览器侧遥测；
 * - `panel`：界面组件。
 * @module @chatdsh/client-workspace-tools
 */

export * from './types.ts';
export * from './files.ts';
export * from './terminal.ts';
export * from './attachments.ts';
export * from './voice.ts';
export * from './gateway.ts';
export * from './telemetry.ts';
export * from './styles.ts';

/** 浏览器侧产物相对包根的路径。 */
export const CLIENT_ENTRY = './client';

/** 面板在浏览器侧登记的组件名，供外壳把席位接进来。 */
export const WORKSPACE_SECTION = 'workspace-tools';

/** 宿主侧插件体：本插件没有宿主侧行为。 */
export function apply(): void {}
