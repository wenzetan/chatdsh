/**
 * 技能面板的数据形状与依赖面。
 *
 * 技能目录、数量统计与检索来自技能服务的命名空间；启用与停用的决定由同一服务落盘，重启后
 * 重新扫描再叠加，因此界面显示的状态与宿主一致。助手名单来自助手服务的命名空间，用来标注
 * 每条技能被哪些助手引用；那个命名空间不在组合里时，引用一栏显示能力不可用。
 * @module @chatdsh/client-skills/types
 */

import type { SkillCatalogState, SkillSourceKind } from '../index.ts';

/** 一条技能。 */
export interface SkillEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: SkillSourceKind;
  readonly enabled: boolean;
}

/** 检索请求。 */
export interface SkillSearchRequest {
  readonly text?: string;
  readonly source?: SkillSourceKind;
}

/** 助手记录里与引用有关的部分。 */
export interface AssistantReference {
  readonly id: string;
  readonly name: string;
  readonly skills: readonly string[];
}

/** 一次加载的快照。 */
export interface SkillSnapshot {
  readonly skills: readonly SkillEntry[];
  readonly state: SkillCatalogState;
  readonly assistants: readonly AssistantReference[] | undefined;
  readonly assistantsFailure: unknown;
}

/** Remote 结果信封。 */
export interface RemoteEnvelope {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/** 面板的传输层。 */
export interface SkillsTransport {
  call(endpoint: string, args: readonly unknown[]): Promise<RemoteEnvelope>;
}

/** 界面动作名，同时是遥测属性值。 */
export type SkillUiAction =
  | 'skill.search'
  | 'skill.enable'
  | 'skill.disable'
  | 'skill.reload';

/** 动作结果。 */
export type ActionOutcome = 'ok' | 'rejected' | 'failed';

/** 浏览器侧遥测面。 */
export interface PanelTelemetry {
  run<T>(method: string, work: () => Promise<T>): Promise<T>;
  action(action: SkillUiAction, outcome: ActionOutcome): void;
  failure(error: unknown): void;
}

/** 面板的数据入口。 */
export interface SkillsGateway {
  load(): Promise<SkillSnapshot>;
  search(request: SkillSearchRequest): Promise<readonly SkillEntry[]>;
  toggle(id: string, enabled: boolean): Promise<{ readonly id: string; readonly enabled: boolean }>;
  noteAction(action: SkillUiAction, outcome: ActionOutcome): void;
}
