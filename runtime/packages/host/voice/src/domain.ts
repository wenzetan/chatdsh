/**
 * 录音的存储域声明。
 *
 * 录音元数据与转写文本分两张表：`recordings` 只放会话、媒体类型、字节数、时长、摘要与
 * 存储路径；`transcripts` 放转写文本、提供方与语言。音频文件与转写文本文件也分开存放，
 * 转写失败不会留下半份文本。
 * @module @chatdsh/host-voice/domain
 */

import { z } from 'zod';
import { defineDomain, domainTable } from '@chatdsh/adapter';

/** 转写状态。 */
export const TRANSCRIPTION_STATES = ['none', 'transcribed'] as const;

/** 转写状态取值。 */
export type TranscriptionState = (typeof TRANSCRIPTION_STATES)[number];

/** 一条录音记录：只有元数据。 */
export interface RecordingRecord {
  /** 录音标识。 */
  readonly id: string;
  /** 所属会话。 */
  readonly sessionId: string;
  /** 规范化后的音频媒体类型。 */
  readonly mimeType: string;
  /** 字节数。 */
  readonly size: number;
  /** 录制时长，毫秒。 */
  readonly durationMs: number;
  /** 音频字节的 sha256。 */
  readonly digest: string;
  /** 写入时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 音频在产品数据目录里的相对路径。 */
  readonly storageKey: string;
  /** 转写状态；转写文本本身在 `transcripts` 表。 */
  readonly transcriptionState: TranscriptionState;
}

/** 一条转写记录：只有文本与提供方信息。 */
export interface TranscriptRecord {
  readonly recordingId: string;
  /** 转写文本。 */
  readonly text: string;
  /** 产生文本的识别提供方标识。 */
  readonly providerId: string;
  /** 识别使用的语言；请求没有指定时为空。 */
  readonly language?: string;
  /** 写入时刻的毫秒时间戳。 */
  readonly createdAt: number;
  /** 转写文本文件在产品数据目录里的相对路径。 */
  readonly storageKey: string;
}

/** 录音记录的 schema。 */
export const recordingSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  digest: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  storageKey: z.string().min(1),
  transcriptionState: z.enum(TRANSCRIPTION_STATES),
});

/** 转写记录的 schema。 */
export const transcriptSchema = z.object({
  recordingId: z.string().min(1),
  text: z.string().min(1),
  providerId: z.string().min(1),
  language: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
  storageKey: z.string().min(1),
});

/** 存储域声明。域名只允许小写字母、数字与下划线。 */
export const VOICE_DOMAIN = defineDomain({
  name: 'voice_store',
  version: 1,
  tables: {
    recordings: domainTable<'recording', RecordingRecord>(recordingSchema),
    transcripts: domainTable<'transcript', TranscriptRecord>(transcriptSchema),
  },
});
