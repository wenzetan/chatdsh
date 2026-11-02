/**
 * 导出宿主的依赖接口与对外形状。
 *
 * 这一层只声明边界：会话副本、附件字节、制品内容、请求者身份、PDF 渲染器与遥测出口都由
 * 装配方注入；导出的范围解析、内容收集、脱敏、格式渲染与任务生命周期在其余模块里实现。
 * 对外形状里不出现事件序号、副本水位与内部存储路径。
 * @module @chatdsh/gateway/exports/types
 */

import type { IncomingMessage } from 'node:http';
import type {
  ContentScope,
  ExportAttachment,
  ExportSource,
} from '@chatdsh/core-contracts';

/** 导出失败。错误码取自跨组件错误码表，原因用于区分同一错误码下的具体条件。 */
export class ExportError extends Error {
  /**
   * @param code - 跨组件错误码。
   * @param reason - 具体条件的稳定取值。
   * @param message - 面向使用者的说明。
   */
  constructor(readonly code: string, readonly reason: string, message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

/** 已认证的请求者。 */
export interface ExportActor {
  /** 请求来自的设备。 */
  readonly deviceId: string;
  /** 该请求者具备私有导出权限。 */
  readonly privateExport: boolean;
}

/** 请求者身份校验；写动作会要求校验方同时核对来源与 CSRF。 */
export type ExportAuthorize = (request: IncomingMessage, action: 'read' | 'write') => ExportActor | undefined;

/** 一份附件的可用状态。 */
export type ExportAttachmentAvailability = 'downloadable' | 'missing' | 'needs-source-device';

/** 源会话里引用到的一份附件。 */
export interface AttachmentRef {
  /** 附件标识。 */
  readonly id: string;
  /** 标记里登记的文件名。 */
  readonly filename: string;
  /** 标记里登记的媒体类型；旧标记没有这一项时缺省。 */
  readonly mimeType?: string;
  /** 标记里登记的字节数；旧标记没有这一项时缺省。 */
  readonly size?: number;
}

/** 附件在导出时的解析结论。 */
export interface ResolvedAttachment {
  readonly id: string;
  readonly filename: string;
  readonly state: ExportAttachmentAvailability;
  readonly mimeType: string;
  readonly size?: number;
  /** 可下载时的内容字节。 */
  readonly bytes?: Uint8Array;
}

/** 解析附件状态所需的上下文。 */
export interface AttachmentContext {
  /** 会话归属设备。 */
  readonly ownerDeviceId: string;
  /** 本机设备标识；与本机一致时缺失按丢失处理。 */
  readonly localDeviceId: string;
  /** 数据根。 */
  readonly dataRoot: string;
}

/** 解析附件：按真实文件与设备归属给出状态与字节。 */
export type AttachmentResolver = (
  ref: AttachmentRef,
  context: AttachmentContext,
) => Promise<ResolvedAttachment>;

/** 制品内容读取端口；由制品宿主的装配方实现。 */
export interface ArtifactContentSource {
  /**
   * 读取一个制品版本。
   * @param artifactId - 制品标识。
   * @param version - 版本号。
   * @returns 标题、媒体类型与内容字节。
   */
  read(artifactId: string, version: number): Promise<{ title: string; mimeType: string; bytes: Uint8Array }>;
}

/** 导出文档里的一条内容。 */
export interface ExportEntry {
  /** 所属回合编号。 */
  readonly turn: number;
  /** 角色。 */
  readonly role: 'user' | 'assistant' | 'tool' | 'artifact';
  /** 事件时刻的毫秒时间戳。 */
  readonly time: number;
  /** 条目种类：消息正文或工具阅读记录。 */
  readonly kind: 'message' | 'tool-read';
  /** 脱敏之后的文本。 */
  readonly text: string;
}

/** 导出文档。 */
export interface ExportDocument {
  readonly title: string;
  readonly source: ExportSource;
  /** 生成时刻的毫秒时间戳。 */
  readonly generatedAt: number;
  /** 覆盖的内容范围，按完整回合表达。 */
  readonly scope: ContentScope;
  /** 覆盖的回合编号。 */
  readonly turns: readonly number[];
  readonly entries: readonly ExportEntry[];
  readonly attachments: readonly ExportAttachment[];
  /** 可下载附件的字节与文件名，随导出包一起写出。 */
  readonly attachmentFiles: readonly {
    readonly id: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }[];
  /** 实际生效的排除项。 */
  readonly excluded: readonly string[];
  /** 脱敏计数。 */
  readonly redactions: { readonly paths: number; readonly credentials: number };
  /** 时间显示方式。 */
  readonly timeDisplay: 'local' | 'utc';
  /** 时间显示使用的时区。 */
  readonly timeZone: string;
  /** 是否包含工具阅读记录。 */
  readonly includeToolReads: boolean;
  /** 是否使用严格脱敏。 */
  readonly strict: boolean;
  /** 是否为完整业务记录导出。 */
  readonly privateRecord: boolean;
}

/** 一次下载的内容。 */
export interface ExportDownload {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/** PDF 渲染。 */
export interface PdfRenderer {
  /** 当前环境是否具备渲染能力。 */
  available(): boolean;
  /** 不可用时的原因码，写入失败分类。 */
  unavailableReason(): string;
  /**
   * 把打印文档渲染成 PDF。
   * @param input - 打印文档与工作目录。
   * @returns PDF 字节。
   */
  render(input: { readonly html: string; readonly workDir: string; readonly signal: AbortSignal }): Promise<Uint8Array>;
}

/** 打印文档模型：公开快照与导出都用它分页打印。 */
export interface PrintDocumentModel {
  /** 标题。 */
  readonly title: string;
  /** 建立时刻或导出时刻的毫秒时间戳。 */
  readonly at: number;
  /** 台账行：来源、范围、条数一类的事实。 */
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  /** 正文条目。 */
  readonly entries: readonly {
    readonly role: string;
    readonly time: number;
    readonly text: string;
    readonly kind: 'message' | 'tool-read';
  }[];
  /** 附件清单。 */
  readonly attachments: readonly ExportAttachment[];
  /** 说明段落。 */
  readonly notice: string;
  /** 页脚说明。 */
  readonly footer: string;
}

/** 打印范围与打印文档共用的一行说明。 */
export type PrintFact = { readonly label: string; readonly value: string };
