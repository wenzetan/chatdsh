/**
 * 设置增强包浏览器侧的数据形状。
 *
 * 字段目录描述界面要显示与写入的字段；读数来自宿主设置服务的描述接口，作用范围来自设置
 * 同步插件的白名单表。保存状态按字段记录，冲突按字段给出用户编辑值与服务器当前值。
 * @module @chatdsh/host-settings-enhancements/types
 */

/** 一次 Remote 调用的参数表。 */
export type RemoteArgs = Readonly<Record<string, unknown>>;

/** 一次 Remote 调用。 */
export interface RemoteCaller {
  /**
   * 调一个端点，成功时返回结果值，失败时抛出 {@link SettingsCallError}。
   * @param endpoint - `<命名空间>/<方法名>`。
   * @param args - 命名参数表。
   * @returns 结果值。
   */
  call<T>(endpoint: string, args: RemoteArgs): Promise<T>;
}

/** 一次调用失败。 */
export class SettingsCallError extends Error {
  /**
   * @param code - 稳定错误码，取自应答信封。
   * @param message - 面向用户的说明。
   * @param details - 应答附带的细节。
   */
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'SettingsCallError';
  }
}

/** 设置服务里一个命名空间的读数。 */
export interface NamespaceReading {
  /** 命名空间。 */
  readonly ns: string;
  /** 生效值。 */
  readonly value: Record<string, unknown>;
  /** 用户层。 */
  readonly user?: Record<string, unknown>;
  /** 版本；下一次写入用它做栅栏。 */
  readonly revision: number;
  /** 是否接受写入。 */
  readonly writable?: boolean;
}

/** 设置服务的描述结果。 */
export interface SettingsDocument {
  /** 全部命名空间。 */
  readonly namespaces: readonly NamespaceReading[];
  /** 文档是否接受写入。 */
  readonly writable: boolean;
}

/** 一个字段的作用范围。 */
export interface FieldScope {
  /** 字段名。 */
  readonly field: string;
  /** 作用范围。 */
  readonly scope: 'client' | 'device';
  /** 是否参与跨设备同步。 */
  readonly synced: boolean;
}

/** 一个命名空间的作用范围表。 */
export interface NamespaceScope {
  /** 命名空间。 */
  readonly namespace: string;
  /** 命名空间的作用范围。 */
  readonly scope: 'client' | 'device';
  /** 字段表。 */
  readonly fields: readonly FieldScope[];
}

/** 设置同步状态。 */
export interface SyncStatus {
  /** 本设备标识。 */
  readonly deviceId: string;
  /** 白名单。 */
  readonly whitelist: {
    readonly namespaces: readonly string[];
    readonly fields: Readonly<Record<string, readonly string[]>>;
    readonly deviceFields: Readonly<Record<string, readonly string[]>>;
  };
  /** 各命名空间的版本与字段来源。 */
  readonly namespaces: Readonly<Record<string, unknown>>;
  /** 控制平面登记的设备。 */
  readonly devices: readonly { readonly deviceId: string; readonly name: string; readonly online: boolean }[];
  /** 不参与同步的字段统计。 */
  readonly filtered: { readonly total: number; readonly byNamespace: Readonly<Record<string, number>>; readonly at: number };
}

/** 一次读数的全部来源。 */
export interface SettingsLoad {
  /** 设置服务描述。 */
  readonly document: SettingsDocument;
  /** 作用范围表。 */
  readonly scopes: readonly NamespaceScope[];
  /** 同步状态。 */
  readonly sync: SyncStatus;
}

/** 字段的输入类型。 */
export type FieldKind = 'select' | 'number' | 'text' | 'path' | 'list' | 'boolean' | 'shortcut';

/** 一个可选值。 */
export interface FieldOption {
  /** 写进设置的值。 */
  readonly value: string;
  /** 显示文案。 */
  readonly label: string;
}

/** 字段目录里的一条。 */
export interface FieldSpec {
  /** 稳定键，`<命名空间>.<字段路径>`。 */
  readonly key: string;
  /** 命名空间。 */
  readonly ns: string;
  /** 字段路径；嵌套字段用点分开。 */
  readonly field: string;
  /** 显示名称。 */
  readonly label: string;
  /** 输入类型。 */
  readonly kind: FieldKind;
  /** 帮助说明。 */
  readonly help?: string;
  /** 可选值。 */
  readonly options?: readonly FieldOption[];
  /** 数字下限。 */
  readonly min?: number;
  /** 数字上限。 */
  readonly max?: number;
  /** 单位。 */
  readonly unit?: string;
  /** 宿主没有给出作用范围表时按设备范围处理。 */
  readonly deviceOnly?: boolean;
}

/** 保存状态。 */
export type FieldSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'failed';

/** 一个字段的保存状态。 */
export interface FieldStatus {
  /** 状态。 */
  readonly state: FieldSaveState;
  /** 说明。 */
  readonly message?: string;
  /** 冲突时服务器当前值的文本。 */
  readonly serverValue?: string;
}

/** 一个字段的冲突读数。 */
export interface FieldConflict {
  /** 字段键。 */
  readonly key: string;
  /** 用户编辑值。 */
  readonly userValue: string;
  /** 服务器当前值。 */
  readonly serverValue: string;
}

/** 设置页区段的服务入口。 */
export interface SettingsGateway {
  /**
   * 读设置文档、作用范围与同步状态。
   * @returns 一次读数。
   */
  load(): Promise<SettingsLoad>;
  /**
   * 写一个命名空间的字段。
   * @param ns - 命名空间。
   * @param patch - 字段与取值。
   * @param expectedRevision - 读到的版本。
   * @returns 写入后的命名空间读数。
   */
  update(ns: string, patch: Record<string, unknown>, expectedRevision: number): Promise<NamespaceReading>;
}

/** 插件清单里的一行。 */
export interface PluginEntryView {
  /** 装载树条目标识。 */
  readonly entryId: string;
  /** 模块名。 */
  readonly moduleName: string;
  /** 是否启用。 */
  readonly enabled: boolean;
  /** 生命周期阶段；没有运行时为空。 */
  readonly fiberPhase?: string | null;
  /** 显示名称。 */
  readonly title?: string;
  /** 只读原因。 */
  readonly readOnlyReason?: string;
  /** profile 补丁行标识。 */
  readonly patchId?: string;
}

/** 一个组合包。 */
export interface BundleView {
  /** 包名。 */
  readonly name: string;
  /** 版本。 */
  readonly version?: string;
  /** 是否启用。 */
  readonly enabled: boolean;
  /** 可用性来源。 */
  readonly availability: string;
  /** 是否可移除。 */
  readonly removable: boolean;
  /** 只读原因。 */
  readonly readOnlyReason?: string;
  /** 补丁层插入或覆盖的行。 */
  readonly rows: readonly { readonly rowId: string; readonly moduleName: string; readonly entryId?: string }[];
}

/** 插件清单与操作的服务入口。 */
export interface PluginGateway {
  /**
   * 读装配清单。
   * @returns 插件行与组合包。
   */
  load(): Promise<{ readonly plugins: readonly PluginEntryView[]; readonly bundles: readonly BundleView[] }>;
  /**
   * 启用或停用一个插件行。
   * @param entryId - 条目标识。
   * @param enabled - 目标状态。
   */
  setPluginEnabled(entryId: string, enabled: boolean): Promise<void>;
  /**
   * 启用或停用一个组合包。
   * @param name - 包名。
   * @param enabled - 目标状态。
   */
  setBundleEnabled(name: string, enabled: boolean): Promise<void>;
  /**
   * 卸载一个组合包。
   * @param name - 包名。
   */
  removeBundle(name: string): Promise<void>;
}
