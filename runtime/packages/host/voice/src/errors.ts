/**
 * 录音操作的错误码。
 *
 * 错误码用于遥测聚合与界面分支，集中定义在这里；转写能力缺失单独一个错误码，界面据此
 * 说明当前部署缺少的条件。
 * @module @chatdsh/host-voice/errors
 */

/** 录音可以抛出的错误码。 */
export const VOICE_ERROR_CODES = {
  /** 请求字段缺失或不合法。 */
  requestInvalid: 'request-invalid',
  /** 录音字节数超过上限。 */
  tooLarge: 'recording-too-large',
  /** 录音媒体类型不在允许范围内。 */
  typeRejected: 'recording-type-rejected',
  /** 录音标识不存在。 */
  notFound: 'recording-not-found',
  /** 录音内容文件读取失败。 */
  readFailed: 'recording-read-failed',
  /** 录音内容文件写入失败。 */
  writeFailed: 'recording-write-failed',
  /** 内容摘要与元数据不一致。 */
  contentCorrupt: 'recording-content-corrupt',
  /** 当前部署没有装载转写能力。 */
  transcriptionUnavailable: 'voice-transcription-unavailable',
  /** 转写提供方拒绝了这次请求。 */
  transcriptionFailed: 'voice-transcription-failed',
  /** 这条录音还没有转写文本。 */
  transcriptMissing: 'voice-transcript-missing',
} as const;

/** 错误码取值。 */
export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[keyof typeof VOICE_ERROR_CODES];

/** 带错误码的录音异常。 */
export class VoiceError extends Error {
  /** 稳定的错误码，写入遥测的 `error.code`。 */
  readonly code: VoiceErrorCode;

  /**
   * @param code - 稳定错误码。
   * @param message - 面向调用方的说明。
   */
  constructor(code: VoiceErrorCode, message: string) {
    super(message);
    this.name = 'VoiceError';
    this.code = code;
  }
}
