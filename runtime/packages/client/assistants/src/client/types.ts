/**
 * 助手面板的数据形状与依赖面。
 *
 * 记录字段与宿主 `AssistantRecord` 一致：档位决定挂哪些工具行，`tools` 是档位之上追加的
 * 行，`skills` 是技能引用，`revision` 是写入版本。预设名册与装配清单来自两个上游 Remote
 * 命名空间，技能目录来自技能服务的命名空间，三者都可能不在当前组合里，因此全部按可选面
 * 声明，缺少时由界面显示为能力不可用。
 * @module @chatdsh/client-assistants/types
 */

import type { AssistantTier } from '../index.ts';

/** 一条助手记录。 */
export interface AssistantRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly order: number;
  readonly instructions: string;
  readonly tier?: AssistantTier;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 新建助手的字段。 */
export interface AssistantInput {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tier: AssistantTier;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly order: number;
}

/** 更新助手的字段：只改给出的那些，`revision` 是调用方读到的版本。 */
export interface AssistantPatch {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly tier: AssistantTier;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly order: number;
  readonly revision: number;
}

/** 删除结果。 */
export interface AssistantRemoval {
  readonly id: string;
  readonly removed: boolean;
  readonly liveSessions: number;
}

/** 预设名册里的一条：内置档位与助手都在这里出现。 */
export interface PresetEntry {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly isDefault: boolean;
  readonly broken?: string;
}

/** 装配清单里的一行。 */
export interface PresetRow {
  readonly entryId: string | null;
  readonly moduleName: string;
  readonly enabled: boolean | 'conditional';
  readonly condition?: string;
  readonly fiberPhase?: string | null;
}

/** 一个预设的装配清单。 */
export interface PresetGroup {
  readonly id: string;
  readonly name?: string;
  readonly isDefault?: boolean;
  readonly broken?: string;
  readonly rows: readonly PresetRow[];
}

/** 技能目录里的一条。 */
export interface SkillEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: 'builtin' | 'workspace' | 'user';
  readonly enabled: boolean;
}

/** 技能数量统计。 */
export interface SkillCatalogState {
  readonly total: number;
  readonly enabled: number;
}

/** Remote 结果信封。 */
export interface RemoteEnvelope {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/** 面板的传输层：把 `<服务名>/<方法名>` 与位置参数送到命名空间。 */
export interface AssistantsTransport {
  call(endpoint: string, args: readonly unknown[]): Promise<RemoteEnvelope>;
}

/** 一次加载的完整快照；辅助来源各自的失败单独记录。 */
export interface AssistantsSnapshot {
  readonly assistants: readonly AssistantRecord[];
  readonly roster: readonly PresetEntry[] | undefined;
  readonly presets: readonly PresetGroup[] | undefined;
  readonly skills: readonly SkillEntry[] | undefined;
  readonly skillState: SkillCatalogState | undefined;
  readonly failures: readonly { readonly source: 'roster' | 'presets' | 'skills'; readonly error: unknown }[];
}

/** 界面动作名，同时是遥测属性值。 */
export type AssistantUiAction =
  | 'assistant.create'
  | 'assistant.update'
  | 'assistant.delete'
  | 'assistant.reload'
  | 'assistant.detail';

/** 动作结果。 */
export type ActionOutcome = 'ok' | 'rejected' | 'failed';

/** 浏览器侧遥测面。 */
export interface PanelTelemetry {
  run<T>(method: string, work: () => Promise<T>): Promise<T>;
  action(action: AssistantUiAction, outcome: ActionOutcome): void;
  failure(error: unknown): void;
}

/** 面板的数据入口。 */
export interface AssistantsGateway {
  load(): Promise<AssistantsSnapshot>;
  reload(): Promise<AssistantsSnapshot>;
  roster(): Promise<readonly PresetEntry[]>;
  presets(): Promise<readonly PresetGroup[]>;
  skills(): Promise<readonly SkillEntry[]>;
  skillState(): Promise<SkillCatalogState>;
  create(input: AssistantInput): Promise<AssistantRecord>;
  update(id: string, patch: AssistantPatch): Promise<AssistantRecord>;
  remove(id: string): Promise<AssistantRemoval>;
  noteAction(action: AssistantUiAction, outcome: ActionOutcome): void;
}
