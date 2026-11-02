/**
 * 录音的准入规则、转写能力探测与部署上限。
 *
 * 录音本身由本模块保存；转写交给成熟的识别能力，本模块只做能力探测与调用适配，
 * 不实现语音识别。部署没有装载识别接口时，`capability` 报告不可用与具体原因，调用方
 * 据此说明缺少的条件。
 * @module @chatdsh/host-voice/rules
 */

import { VOICE_ERROR_CODES, VoiceError } from './errors.ts';

/** 单条录音的字节上限：24 MiB。 */
export const RECORDING_MAX_BYTES = 24 * 1024 * 1024;

/** 单条录音的时长上限：300 秒。 */
export const RECORDING_MAX_DURATION_MS = 300_000;

/** 允许的录音媒体类型。 */
export const ALLOWED_RECORDING_TYPES = ['audio/webm', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mpeg', 'audio/mp4'] as const;

/** 媒体类型到存储扩展名的映射。 */
const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['audio/webm', 'webm'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/ogg', 'ogg'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp4', 'm4a'],
]);

/** 允许的媒体类型集合。 */
const ALLOWED = new Set<string>(ALLOWED_RECORDING_TYPES);

/**
 * 规范化媒体类型：去掉参数、转小写。
 * @param mimeType - 请求里的媒体类型。
 * @returns 规范化后的媒体类型。
 */
export function normalizeRecordingType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * 校验录音媒体类型，不合格时就地抛出。
 * @param mimeType - 原始媒体类型。
 * @returns 规范化后的媒体类型。
 */
export function assertRecordingType(mimeType: string): string {
  const normalized = normalizeRecordingType(mimeType);
  if (normalized === '') throw new VoiceError(VOICE_ERROR_CODES.requestInvalid, '录音需要媒体类型');
  if (!ALLOWED.has(normalized)) {
    throw new VoiceError(
      VOICE_ERROR_CODES.typeRejected,
      `${normalized} 不在允许的录音类型里：${ALLOWED_RECORDING_TYPES.join('、')}`,
    );
  }
  return normalized;
}

/**
 * 取录音的存储扩展名。
 * @param mimeType - 规范化后的媒体类型。
 * @returns 文件扩展名。
 */
export function extensionOf(mimeType: string): string {
  const extension = EXTENSIONS.get(mimeType);
  if (extension === undefined) throw new VoiceError(VOICE_ERROR_CODES.typeRejected, `没有 ${mimeType} 的存储扩展名`);
  return extension;
}

/**
 * 校验录音大小与时长。
 * @param size - 字节数。
 * @param durationMs - 录制时长，毫秒。
 */
export function assertRecordingSize(size: number, durationMs: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new VoiceError(VOICE_ERROR_CODES.requestInvalid, '录音字节数必须是正整数');
  }
  if (size > RECORDING_MAX_BYTES) {
    throw new VoiceError(
      VOICE_ERROR_CODES.tooLarge,
      `录音 ${String(size)} 字节超过上限 ${String(RECORDING_MAX_BYTES)} 字节`,
    );
  }
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new VoiceError(VOICE_ERROR_CODES.requestInvalid, '录制时长必须是非负整数毫秒');
  }
  if (durationMs > RECORDING_MAX_DURATION_MS) {
    throw new VoiceError(
      VOICE_ERROR_CODES.tooLarge,
      `录制时长 ${String(durationMs)} 毫秒超过上限 ${String(RECORDING_MAX_DURATION_MS)} 毫秒`,
    );
  }
}

/** 转写能力的状态。 */
export interface TranscriptionCapability {
  /** 是否可用。 */
  readonly available: boolean;
  /** 不可用的具体原因。 */
  readonly reason?: string;
  /** 识别提供方标识；可用时给出。 */
  readonly providerId?: string;
  readonly maxAudioBytes: number;
  readonly maxDurationMs: number;
  readonly acceptedTypes: readonly string[];
}

/** 成熟的识别接口：上游实验性语音 Remote 的最小形状。 */
export interface SpeechControllerLike {
  catalog(): {
    readonly providers: readonly { readonly id: string; readonly name: string }[];
    readonly selection: { readonly providerId: string; readonly language: string };
  };
  transcribe(
    request: { readonly audioBase64: string; readonly providerId?: string; readonly language?: string },
    signal: AbortSignal,
  ): Promise<{ readonly text: string; readonly audioSeconds: number; readonly inferenceSeconds: number }>;
}

/**
 * 探测当前部署的转写能力。
 * @param controller - 按名读取到的识别接口；没有装载时为 `undefined`。
 * @returns 能力状态。
 */
export function detectCapability(controller: SpeechControllerLike | undefined): TranscriptionCapability {
  const base = {
    maxAudioBytes: RECORDING_MAX_BYTES,
    maxDurationMs: RECORDING_MAX_DURATION_MS,
    acceptedTypes: [...ALLOWED_RECORDING_TYPES],
  };
  if (controller === undefined) {
    return {
      available: false,
      reason: '当前部署没有装载语音识别接口（`dsh-experimental-api-speech-to-text` 行未启用），录音可以保存，转写不可用',
      ...base,
    };
  }
  if (typeof controller.catalog !== 'function' || typeof controller.transcribe !== 'function') {
    return { available: false, reason: '识别接口缺少 catalog 或 transcribe 方法', ...base };
  }
  const catalog = controller.catalog();
  if (catalog.providers.length === 0) {
    return { available: false, reason: '识别接口没有登记任何识别提供方', ...base };
  }
  return { available: true, providerId: catalog.selection.providerId, ...base };
}
