/**
 * 录音：音频文件与录音元数据分开存储，转写文本单独一张表与单独一个文件。
 *
 * 录音上传只校验媒体类型、字节数与时长，随后把音频写进产品数据目录的 `voice/` 下并把
 * 元数据写进结构化存储。转写调用成熟的识别接口（上游实验性语音 Remote），本模块不实现
 * 识别算法；部署没有装载识别接口时，能力探测报告不可用与具体原因，转写请求按同一个原因
 * 拒绝，录音本身仍可保存与回放。
 *
 * 对外方法走 typert Remote：客户端与控制平面按 `chatdshVoice` 命名空间调用。
 * @module @chatdsh/host-voice
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Remote, storageDomainOf, telemetryOf, TypertRemoteService, type Context } from '@chatdsh/adapter';
import { VOICE_DOMAIN, type RecordingRecord, type TranscriptRecord } from './domain.ts';
import { VOICE_ERROR_CODES, VoiceError } from './errors.ts';
import {
  assertRecordingSize,
  assertRecordingType,
  detectCapability,
  extensionOf,
  type SpeechControllerLike,
  type TranscriptionCapability,
} from './rules.ts';

export type { RecordingRecord, TranscriptRecord, TranscriptionState } from './domain.ts';
export { TRANSCRIPTION_STATES, VOICE_DOMAIN, recordingSchema, transcriptSchema } from './domain.ts';
export { VOICE_ERROR_CODES, VoiceError, type VoiceErrorCode } from './errors.ts';
export {
  ALLOWED_RECORDING_TYPES,
  RECORDING_MAX_BYTES,
  RECORDING_MAX_DURATION_MS,
  detectCapability,
  normalizeRecordingType,
  type SpeechControllerLike,
  type TranscriptionCapability,
} from './rules.ts';

/** 录音运行时使用的服务名，同时是 Remote 命名空间。 */
export const SERVICE_NAME = 'chatdshVoice';

/** 上传一段录音的输入。 */
export interface RecordingInput {
  readonly sessionId: string;
  readonly mimeType: string;
  /** 录制时长，毫秒。 */
  readonly durationMs: number;
  /** 音频字节；字符串内容按 base64 解释。 */
  readonly content: string | Uint8Array;
  readonly encoding?: 'utf8' | 'base64';
}

/** 一次转写请求的选项。 */
export interface TranscriptionOptions {
  /** 语言提示。 */
  readonly language?: string;
  /** 指定识别提供方；省略时用接口的当前选择。 */
  readonly providerId?: string;
}

/** 一次转写的结果。 */
export interface TranscriptionResult {
  readonly recordingId: string;
  readonly text: string;
  readonly providerId: string;
  readonly createdAt: number;
}

/** 录音操作的动作名，写入 span 的 `rpc.method`。 */
export type VoiceAction = 'capability' | 'put' | 'get' | 'list' | 'transcribe' | 'transcript' | 'delete';

/** 遥测 span 用到的最小接口。 */
type SpanLike = { setAttribute(key: string, value: unknown): void };

/** 用到的遥测面。 */
interface VoiceTelemetry {
  runSpan<T>(name: string, attributes: Record<string, unknown>, body: (span: SpanLike) => Promise<T>): Promise<T>;
  counter(name: string, options: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
}

/** 只用到四个方法的键值表。 */
interface Table<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** 数据根：音频与转写文本写在这里的 `voice/` 下。 */
function dataRoot(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** 内容字节的 sha256。 */
function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 把底层原因收进错误说明。 */
function reasonOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return `${String((error as { readonly code: unknown }).code)}：${error instanceof Error ? error.message : String(error)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 录音服务。
 */
export class ChatdshVoiceService extends TypertRemoteService {
  /** 结构化存储是唯一注入依赖；识别接口按名读取。 */
  static inject = ['storageDomain'];

  private recordings: Table<RecordingRecord> | undefined;
  private transcripts: Table<TranscriptRecord> | undefined;

  constructor(ctx: Context) {
    super(ctx, SERVICE_NAME);
  }

  /** 打开存储域。失败按 fiber 启动失败上报。 */
  async [TypertRemoteService.init](): Promise<void> {
    const domain = await storageDomainOf(this.ctx).open(VOICE_DOMAIN);
    this.recordings = domain.table('recordings') as unknown as Table<RecordingRecord>;
    this.transcripts = domain.table('transcripts') as unknown as Table<TranscriptRecord>;
  }

  /**
   * 转写能力状态与录音上限。
   * @returns 是否可用、不可用原因、提供方与上限。
   */
  @Remote('capability')
  capability(): TranscriptionCapability {
    return detectCapability(this.speech());
  }

  /**
   * 上传一段录音。
   * @param input - 会话、媒体类型、时长与音频内容。
   * @returns 写入后的录音记录。
   */
  @Remote('put')
  async put(input: RecordingInput): Promise<RecordingRecord> {
    return this.access('put', async (span) => {
      const table = this.require(this.recordings);
      if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') {
        throw new VoiceError(VOICE_ERROR_CODES.requestInvalid, '上传录音需要会话标识');
      }
      const mimeType = assertRecordingType(input.mimeType);
      const bytes = typeof input.content === 'string'
        ? Buffer.from(input.content, input.encoding === 'base64' ? 'base64' : 'utf8')
        : Buffer.from(input.content);
      assertRecordingSize(bytes.byteLength, input.durationMs);
      const id = randomUUID();
      const storageKey = join(id, `audio.${extensionOf(mimeType)}`);
      const absolute = join(dataRoot(), 'voice', storageKey);
      const record: RecordingRecord = {
        id,
        sessionId: input.sessionId,
        mimeType,
        size: bytes.byteLength,
        durationMs: input.durationMs,
        digest: digestOf(bytes),
        createdAt: Date.now(),
        storageKey,
        transcriptionState: 'none',
      };
      await mkdir(dirname(absolute), { recursive: true });
      try {
        await writeFile(absolute, bytes, { flag: 'wx' });
      } catch (error) {
        throw new VoiceError(VOICE_ERROR_CODES.writeFailed, `录音写入失败：${reasonOf(error)}`);
      }
      await table.put(id, record);
      span?.setAttribute('bytes', bytes.byteLength);
      return record;
    });
  }

  /**
   * 读一条录音的元数据。
   * @param id - 录音标识。
   * @returns 录音记录。
   */
  @Remote('get')
  get(id: string): RecordingRecord {
    return this.recordOf(id);
  }

  /**
   * 列出录音；给出会话标识时只列该会话的。
   * @param sessionId - 会话标识。
   * @returns 按写入时间升序排列的记录。
   */
  @Remote('list')
  list(sessionId?: string): RecordingRecord[] {
    const table = this.require(this.recordings);
    const all = [...table.entries()].map(([, record]) => record);
    const scoped = sessionId === undefined ? all : all.filter((record) => record.sessionId === sessionId);
    return scoped.sort((left, right) => left.createdAt - right.createdAt);
  }

  /**
   * 把一条录音交给识别接口转写，文本单独存储。
   * @param id - 录音标识。
   * @param options - 语言与识别提供方。
   * @returns 转写结果。
   */
  @Remote('transcribe')
  async transcribe(id: string, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
    return this.access('transcribe', async (span) => {
      const record = this.recordOf(id);
      const capability = detectCapability(this.speech());
      if (!capability.available) {
        throw new VoiceError(
          VOICE_ERROR_CODES.transcriptionUnavailable,
          capability.reason ?? '当前部署没有装载转写能力',
        );
      }
      const bytes = await this.readAudio(record);
      const controller = this.speech() as SpeechControllerLike;
      let transcript: { readonly text: string; readonly audioSeconds: number; readonly inferenceSeconds: number };
      try {
        transcript = await controller.transcribe(
          {
            audioBase64: bytes.toString('base64'),
            ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
            ...(options.language === undefined ? {} : { language: options.language }),
          },
          new AbortController().signal,
        );
      } catch (error) {
        throw new VoiceError(VOICE_ERROR_CODES.transcriptionFailed, `转写失败：${reasonOf(error)}`);
      }
      if (transcript.text.trim() === '') {
        throw new VoiceError(VOICE_ERROR_CODES.transcriptionFailed, '识别接口返回了空文本');
      }
      const createdAt = Date.now();
      const storageKey = join(id, 'transcript.txt');
      const absolute = join(dataRoot(), 'voice', storageKey);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, transcript.text, { encoding: 'utf8', flag: 'wx' });
      const providerId = options.providerId ?? capability.providerId ?? 'unknown';
      const stored: TranscriptRecord = {
        recordingId: id,
        text: transcript.text,
        providerId,
        ...(options.language === undefined ? {} : { language: options.language }),
        createdAt,
        storageKey,
      };
      await this.require(this.transcripts).put(id, stored);
      await this.require(this.recordings).put(id, { ...record, transcriptionState: 'transcribed' });
      span?.setAttribute('bytes', bytes.byteLength);
      return { recordingId: id, text: stored.text, providerId, createdAt };
    });
  }

  /**
   * 读一条录音的转写文本。
   * @param id - 录音标识。
   * @returns 转写记录。
   */
  @Remote('transcript')
  transcript(id: string): TranscriptRecord {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new VoiceError(VOICE_ERROR_CODES.requestInvalid, '录音标识不能为空');
    }
    const stored = this.require(this.transcripts).get(id);
    if (stored === undefined) {
      throw new VoiceError(VOICE_ERROR_CODES.transcriptMissing, `录音 ${id} 还没有转写文本`);
    }
    return stored;
  }

  /**
   * 删除录音：音频文件、转写文本文件与两条记录一并移除。
   * @param id - 录音标识。
   * @returns 是否存在并删除。
   */
  @Remote({ name: 'delete' })
  async remove(id: string): Promise<boolean> {
    return this.access('delete', async () => {
      const recordings = this.require(this.recordings);
      if (recordings.get(id) === undefined) return false;
      await this.require(this.transcripts).delete(id);
      await rm(join(dataRoot(), 'voice', id), { recursive: true, force: true });
      return recordings.delete(id);
    });
  }

  /** 取一条录音记录，缺失时就地抛出。 */
  private recordOf(id: string): RecordingRecord {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new VoiceError(VOICE_ERROR_CODES.requestInvalid, '录音标识不能为空');
    }
    const record = this.require(this.recordings).get(id);
    if (record === undefined) throw new VoiceError(VOICE_ERROR_CODES.notFound, `录音 ${id} 不存在`);
    return record;
  }

  /** 读取音频字节并核对摘要。 */
  private async readAudio(record: RecordingRecord): Promise<Buffer> {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(dataRoot(), 'voice', record.storageKey));
    } catch (error) {
      throw new VoiceError(VOICE_ERROR_CODES.readFailed, `录音 ${record.id} 读取失败：${reasonOf(error)}`);
    }
    if (digestOf(bytes) !== record.digest) {
      throw new VoiceError(VOICE_ERROR_CODES.contentCorrupt, `录音 ${record.id} 的内容摘要与元数据不一致`);
    }
    return bytes;
  }

  /** 按名读取识别接口；没有装载时返回 `undefined`。 */
  private speech(): SpeechControllerLike | undefined {
    return this.ctx.reflect.get('speechController') as SpeechControllerLike | undefined;
  }

  /**
   * 在一个动作 span 里执行，失败时补计数与结果属性。
   * @param action - 动作名，写入 `rpc.method`。
   * @param body - 动作主体。
   * @returns 动作结果。
   */
  private async access<T>(action: VoiceAction, body: (span: SpanLike | undefined) => Promise<T> | T): Promise<T> {
    const telemetry = telemetryOf<VoiceTelemetry>(this.ctx);
    const method = `${SERVICE_NAME}/${action}`;
    const counter = telemetry?.counter('chatdsh_remote_calls_total', { description: 'Remote 调用数' });
    const run = async (span?: SpanLike): Promise<T> => {
      try {
        const value = await body(span);
        span?.setAttribute('outcome', 'ok');
        counter?.add(1, { method, outcome: 'ok' });
        return value;
      } catch (error) {
        const code = error instanceof VoiceError ? error.code : 'internal-error';
        span?.setAttribute('outcome', 'failed');
        counter?.add(1, { method, outcome: 'failed', error_code: code });
        throw error;
      }
    };
    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.runtime.remote.call', { 'rpc.method': method }, run);
  }

  private require<V>(table: Table<V> | undefined): Table<V> {
    if (table === undefined) throw new Error('voice storage is not ready');
    return table;
  }
}

export default ChatdshVoiceService;
