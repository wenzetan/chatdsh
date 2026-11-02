/**
 * 工作区工具的数据入口。
 *
 * 每个方法把 `<服务名>/<方法名>` 与位置参数交给传输层，校验返回形状，再把宿主错误码
 * 原样抛出。文件浏览走宿主的 `workspaceFiles` 命名空间，附件与录音走
 * `chatdshAttachments` 与 `chatdshVoice`；传输层不可达按离线失败处理。每次调用都包在
 * 遥测 span 里，失败补一条错误事件。
 * @module @chatdsh/client-workspace-tools/gateway
 */

import { TEXT_PREVIEW_MAX_LINES, ROOT_PATH_ARGUMENT } from './files.ts';
import {
  WorkspaceClientError,
  type AttachmentContextEntry,
  type AttachmentLimits,
  type AttachmentRecord,
  type ByteFilePage,
  type DirectoryEntry,
  type DirectoryListing,
  type FileStat,
  type RecordingRecord,
  type RemoteEnvelope,
  type RemoteTransport,
  type TextFilePage,
  type TranscriptionCapability,
  type WorkspaceGateway,
  type WorkspaceTelemetry,
} from './types.ts';

/**
 * 断言结果是一个对象。
 * @param value - 待检查的值。
 * @param what - 名称，用于错误说明。
 * @returns 对象本体。
 */
function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new WorkspaceClientError('workspace/internal', `${what}的返回形状不符合约定`);
  }
  return value as Record<string, unknown>;
}

/**
 * 断言结果是一个数组。
 * @param value - 待检查的值。
 * @param what - 名称，用于错误说明。
 * @returns 数组本体。
 */
function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new WorkspaceClientError('workspace/internal', `${what}的返回形状不符合约定`);
  return value;
}

/**
 * 断言结果是一个字符串。
 * @param value - 待检查的值。
 * @param what - 名称，用于错误说明。
 * @returns 字符串本体。
 */
function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new WorkspaceClientError('workspace/internal', `${what}的返回形状不符合约定`);
  return value;
}

/**
 * 断言结果是一个数字。
 * @param value - 待检查的值。
 * @param what - 名称，用于错误说明。
 * @returns 数字本体。
 */
function requireNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WorkspaceClientError('workspace/internal', `${what}的返回形状不符合约定`);
  }
  return value;
}

/**
 * 把字节转成 base64，浏览器与 Node 共用同一段实现。
 * @param bytes - 无符号字节数组。
 * @returns base64 文本。
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const window = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += window) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + window));
  }
  return btoa(binary);
}

/**
 * 把字节内容统一成 base64。
 * @param value - 宿主返回的字节；支持 base64 字符串、字节数组与数字数组。
 * @param what - 名称，用于错误说明。
 * @returns base64 文本。
 */
function toBase64(value: unknown, what: string): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return bytesToBase64(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
    return bytesToBase64(Uint8Array.from(value as number[]));
  }
  throw new WorkspaceClientError('workspace/internal', `${what}的字节内容形状不符合约定`);
}

/** 目录列举的形状校验。 */
function listingOf(value: unknown): DirectoryListing {
  const record = requireRecord(value, '目录列举');
  const entries = requireArray(record.entries, '目录项').map((entry): DirectoryEntry => {
    const item = requireRecord(entry, '目录项');
    const type = item.type === 'directory' || item.type === 'file' || item.type === 'other' ? item.type : 'other';
    return {
      name: requireString(item.name, '目录项名称'),
      type,
      ...(item.size === undefined ? {} : { size: requireNumber(item.size, '目录项字节数') }),
    };
  });
  return {
    path: requireString(record.path, '目录路径'),
    entries,
    truncated: record.truncated === true,
  };
}

/** 文本读取的形状校验。 */
function textPageOf(value: unknown): TextFilePage {
  const record = requireRecord(value, '文本读取');
  return {
    absolutePath: requireString(record.absolutePath, '绝对路径'),
    text: requireString(record.text, '文本内容'),
    lines: requireNumber(record.lines, '行数'),
    offset: requireNumber(record.offset, '起始行'),
    eof: record.eof === true,
    ...(record.bytes === undefined ? {} : { bytes: requireNumber(record.bytes, '字节数') }),
  };
}

/** 附件记录的形状校验。 */
function attachmentOf(value: unknown): AttachmentRecord {
  const record = requireRecord(value, '附件记录');
  return {
    id: requireString(record.id, '附件标识'),
    sessionId: requireString(record.sessionId, '会话标识'),
    ...(record.messageId === undefined ? {} : { messageId: requireString(record.messageId, '消息标识') }),
    filename: requireString(record.filename, '附件文件名'),
    mimeType: requireString(record.mimeType, '媒体类型'),
    size: requireNumber(record.size, '字节数'),
    digest: requireString(record.digest, '内容摘要'),
    createdAt: requireNumber(record.createdAt, '写入时刻'),
    artifactId: requireString(record.artifactId, '制品标识'),
    artifactVersion: requireNumber(record.artifactVersion, '制品版本'),
  };
}

/** 录音记录的形状校验。 */
function recordingOf(value: unknown): RecordingRecord {
  const record = requireRecord(value, '录音记录');
  return {
    id: requireString(record.id, '录音标识'),
    sessionId: requireString(record.sessionId, '会话标识'),
    mimeType: requireString(record.mimeType, '媒体类型'),
    size: requireNumber(record.size, '字节数'),
    durationMs: requireNumber(record.durationMs, '录制时长'),
    digest: requireString(record.digest, '内容摘要'),
    createdAt: requireNumber(record.createdAt, '写入时刻'),
    transcriptionState: record.transcriptionState === 'transcribed' ? 'transcribed' : 'none',
  };
}

/** 工作区工具的数据入口。 */
export interface WorkspaceGatewayOptions {
  readonly transport: RemoteTransport;
  readonly telemetry: WorkspaceTelemetry;
}

/**
 * 建立数据入口。
 * @param options - 传输层与遥测面。
 * @returns 数据入口。
 */
export function createWorkspaceGateway(options: WorkspaceGatewayOptions): WorkspaceGateway {
  const { transport, telemetry } = options;

  /**
   * 调一次命名空间方法。
   * @param endpoint - `<服务名>/<方法名>`。
   * @param args - 位置参数。
   * @returns 结果值。
   */
  const call = async (endpoint: string, args: readonly unknown[]): Promise<unknown> => {
    let envelope: RemoteEnvelope;
    try {
      envelope = await transport.call(endpoint, args);
    } catch (error) {
      const failure = new WorkspaceClientError('client/offline', error instanceof Error ? error.message : '运行时不可达');
      telemetry.failure(failure);
      throw failure;
    }
    if (!envelope.ok) {
      const error = new WorkspaceClientError(envelope.error?.code ?? 'workspace/internal', envelope.error?.message ?? '调用失败');
      telemetry.failure(error);
      throw error;
    }
    return envelope.value;
  };

  return {
    async listDirectory(path: string) {
      return telemetry.run('workspaceFiles/list', async () => listingOf(
        await call('workspaceFiles/list', [path === '' ? ROOT_PATH_ARGUMENT : path]),
      ));
    },

    async readText(path: string) {
      return telemetry.run('workspaceFiles/read', async () => textPageOf(
        await call('workspaceFiles/read', [path, { offset: 1, limit: TEXT_PREVIEW_MAX_LINES }]),
      ));
    },

    async stat(path: string): Promise<FileStat> {
      return telemetry.run('workspaceFiles/stat', async () => {
        const value = requireRecord(await call('workspaceFiles/stat', [path]), '文件信息');
        return {
          absolutePath: requireString(value.absolutePath, '绝对路径'),
          ...(value.bytes === undefined ? {} : { bytes: requireNumber(value.bytes, '字节数') }),
        };
      });
    },

    async readBytes(path: string) {
      return telemetry.run('workspaceFiles/readBytes', async () => {
        const value = requireRecord(await call('workspaceFiles/readBytes', [path, {}]), '字节读取');
        const page: ByteFilePage = {
          absolutePath: requireString(value.absolutePath, '绝对路径'),
          base64: toBase64(value.data, '字节读取'),
          eof: value.eof === true,
          ...(value.bytes === undefined ? {} : { bytes: requireNumber(value.bytes, '字节数') }),
        };
        return page;
      });
    },

    async attachmentLimits() {
      return telemetry.run('chatdshAttachments/limits', async () => {
        const value = requireRecord(await call('chatdshAttachments/limits', []), '附件上限');
        return {
          maxBytes: requireNumber(value.maxBytes, '附件字节上限'),
          maxPerMessage: requireNumber(value.maxPerMessage, '附件数量上限'),
          allowedTypes: requireArray(value.allowedTypes, '允许类型').map((item) => requireString(item, '允许类型')),
          maxFilenameLength: requireNumber(value.maxFilenameLength, '文件名长度上限'),
        } satisfies AttachmentLimits;
      });
    },

    async uploadAttachment(input) {
      return telemetry.run('chatdshAttachments/put', async () => attachmentOf(
        await call('chatdshAttachments/put', [{
          sessionId: input.sessionId,
          filename: input.filename,
          mimeType: input.mimeType,
          content: input.base64,
          encoding: 'base64',
        }]),
      ));
    },

    async readAttachment(id: string) {
      return telemetry.run('chatdshAttachments/read', async () => {
        const value = requireRecord(await call('chatdshAttachments/read', [id]), '附件读取');
        return {
          record: attachmentOf(value.record),
          base64: requireString(value.base64, '附件内容'),
        };
      });
    },

    async attachmentContext(ids: readonly string[]) {
      return telemetry.run('chatdshAttachments/context', async () => {
        const value = requireRecord(await call('chatdshAttachments/context', [ids]), '附件上下文');
        const entries = requireArray(value.entries, '附件上下文条目').map((entry): AttachmentContextEntry => {
          const item = requireRecord(entry, '附件上下文条目');
          return {
            attachmentId: requireString(item.attachmentId, '附件标识'),
            marker: requireString(item.marker, '上下文标记'),
            filename: requireString(item.filename, '附件文件名'),
            mimeType: requireString(item.mimeType, '媒体类型'),
            size: requireNumber(item.size, '字节数'),
          };
        });
        return { entries, text: requireString(value.text, '上下文文本') };
      });
    },

    async voiceCapability() {
      return telemetry.run('chatdshVoice/capability', async () => {
        const value = requireRecord(await call('chatdshVoice/capability', []), '转写能力');
        return {
          available: value.available === true,
          ...(value.reason === undefined ? {} : { reason: requireString(value.reason, '不可用原因') }),
          ...(value.providerId === undefined ? {} : { providerId: requireString(value.providerId, '识别提供方') }),
          maxAudioBytes: requireNumber(value.maxAudioBytes, '录音字节上限'),
          maxDurationMs: requireNumber(value.maxDurationMs, '录音时长上限'),
          acceptedTypes: requireArray(value.acceptedTypes, '允许录音类型').map((item) => requireString(item, '允许录音类型')),
        } satisfies TranscriptionCapability;
      });
    },

    async uploadRecording(input) {
      return telemetry.run('chatdshVoice/put', async () => recordingOf(
        await call('chatdshVoice/put', [{
          sessionId: input.sessionId,
          mimeType: input.mimeType,
          durationMs: input.durationMs,
          content: input.base64,
          encoding: 'base64',
        }]),
      ));
    },

    async transcribeRecording(id: string, transcriptionOptions: { readonly language?: string }) {
      return telemetry.run('chatdshVoice/transcribe', async () => {
        const value = requireRecord(
          await call('chatdshVoice/transcribe', [id, transcriptionOptions]),
          '转写结果',
        );
        return { text: requireString(value.text, '转写文本') };
      });
    },

    async removeRecording(id: string) {
      return telemetry.run('chatdshVoice/delete', async () => {
        const value = await call('chatdshVoice/delete', [id]);
        if (typeof value !== 'boolean') throw new WorkspaceClientError('workspace/internal', '删除录音的返回形状不符合约定');
        return value;
      });
    },
  };
}
