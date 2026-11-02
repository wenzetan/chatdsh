/**
 * 附件的存储域声明。
 *
 * 元数据落在结构化存储里，内容字节落在产品数据目录的 `attachments/` 下，两者以
 * `storageKey` 关联；同一份内容同时登记到制品库，制品标识与版本写在记录里。实例重建后
 * 读取走同一条路径，内容与元数据都还在。
 * @module @chatdsh/host-attachments/domain
 */

import { z } from 'zod';
import { defineDomain, domainTable } from '@chatdsh/adapter';

/** 一条附件记录。 */
export interface AttachmentRecord {
  /** 附件标识。 */
  readonly id: string;
  /** 所属会话。 */
  readonly sessionId: string;
  /** 所属消息；发送之前为空。 */
  readonly messageId?: string;
  /** 展示名，同时是存储文件名。 */
  readonly filename: string;
  /** 规范化后的媒体类型。 */
  readonly mimeType: string;
  /** 字节数。 */
  readonly size: number;
  /** 内容字节的 sha256。 */
  readonly digest: string;
  /** 写入时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 内容在产品数据目录里的相对路径。 */
  readonly storageKey: string;
  /** 制品库里的同源条目。 */
  readonly artifactId: string;
  /** 制品版本号。 */
  readonly artifactVersion: number;
}

/** 附件记录的 schema。 */
export const attachmentSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().positive(),
  digest: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  storageKey: z.string().min(1),
  artifactId: z.string().min(1),
  artifactVersion: z.number().int().positive(),
});

/** 存储域声明。域名只允许小写字母、数字与下划线。 */
export const ATTACHMENTS_DOMAIN = defineDomain({
  name: 'attachments_store',
  version: 1,
  tables: {
    attachments: domainTable<'attachment', AttachmentRecord>(attachmentSchema),
  },
});
