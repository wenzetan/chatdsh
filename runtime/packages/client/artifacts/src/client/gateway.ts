/**
 * 制品面板的数据入口。
 *
 * 传输层只负责把 `<服务名>/<方法名>` 与位置参数送到 Remote 命名空间；这一层负责解包结果
 * 信封、核对返回形状，并把每次调用交给遥测。读取结果里的受限预览标记在这里再核对一遍：
 * 三个开关里任何一个不是假，都拒绝把内容交给查看器。
 * @module @chatdsh/client-artifacts/gateway
 */

import {
  ArtifactClientError,
  CLIENT_ERROR_CODES,
  PREVIEW_ERROR_CODES,
  PREVIEW_MODES,
} from './state.ts';
import type {
  ActionOutcome,
  ArtifactDeleteScope,
  ArtifactPreviewMode,
  ArtifactPreviewView,
  ArtifactReadResult,
  ArtifactRecord,
  ArtifactUiAction,
  ArtifactsGateway,
  ArtifactsTransport,
  ArtifactVersionList,
  ArtifactVersionView,
  PanelTelemetry,
  RemoteEnvelope,
} from './types.ts';

/** 一个 Remote 命名空间的最小形状。 */
export interface RemoteNamespace {
  readonly [method: string]: ((...args: never[]) => Promise<RemoteEnvelope>) | undefined;
}

/**
 * 从模块加载器给出的命名空间构造传输层。
 *
 * 缺命名空间与缺方法按能力不可用返回信封；调用本身的拒绝原样向上抛，由数据入口统一
 * 折算成离线失败。
 * @param namespaceOf - 按服务名取命名空间。
 * @returns 传输层。
 */
export function createRemoteTransport(namespaceOf: (name: string) => RemoteNamespace | undefined): ArtifactsTransport {
  return {
    async call(endpoint: string, args: readonly unknown[]): Promise<RemoteEnvelope> {
      const separator = endpoint.indexOf('/');
      const service = endpoint.slice(0, separator);
      const method = endpoint.slice(separator + 1);
      const namespace = namespaceOf(service);
      if (namespace === undefined) {
        return { ok: false, error: { code: CLIENT_ERROR_CODES.unavailable, message: `当前部署没有提供 ${service} 命名空间` } };
      }
      const invoke = namespace[method];
      if (typeof invoke !== 'function') {
        return { ok: false, error: { code: CLIENT_ERROR_CODES.unavailable, message: `${service} 没有 ${method} 方法` } };
      }
      return await (invoke as (...input: unknown[]) => Promise<RemoteEnvelope>)(...args);
    },
  };
}

/** 断言结果是一个数组。 */
function requireArray<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, `${what}的返回形状不符合约定`);
  return value as T[];
}

/** 断言结果是一个对象。 */
function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, `${what}的返回形状不符合约定`);
  return value as Record<string, unknown>;
}

/** 断言结果是一个字符串。 */
function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, `${what}的返回形状不符合约定`);
  return value;
}

/** 断言结果是一个整数。 */
function requireInteger(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, `${what}的返回形状不符合约定`);
  return value;
}

/** 断言结果是一个布尔值。 */
function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, `${what}的返回形状不符合约定`);
  return value;
}

/** 核对受限预览标记：三个开关必须是假，预览方式必须在登记的取值里。 */
function previewOf(value: unknown): ArtifactPreviewView {
  const record = requireRecord(value, '受限预览标记');
  const mode = requireString(record['mode'], '预览方式');
  if (!(PREVIEW_MODES as readonly string[]).includes(mode)) {
    throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, `预览方式 ${mode} 不在登记的取值里`);
  }
  if (record['scriptAllowed'] !== false || record['hostBridgeAllowed'] !== false || record['formSubmitAllowed'] !== false) {
    throw new ArtifactClientError(
      PREVIEW_ERROR_CODES.unsafePreview,
      '宿主返回的预览标记没有关闭脚本、宿主访问或表单提交',
    );
  }
  return {
    mode: mode as ArtifactPreviewMode,
    scriptAllowed: false,
    hostBridgeAllowed: false,
    formSubmitAllowed: false,
  };
}

/** 核对一个版本记录。 */
function versionOf(value: unknown): ArtifactVersionView {
  const record = requireRecord(value, '版本记录');
  const version = record as unknown as ArtifactVersionView;
  requireString(version.artifactId, '版本所属的制品标识');
  requireInteger(version.version, '版本号');
  requireString(version.mimeType, '版本的媒体类型');
  requireInteger(version.size, '版本的字节数');
  requireInteger(version.createdAt, '版本的建立时刻');
  requireString(version.sourceSessionId, '版本的来源会话');
  requireBoolean(version.downloadable, '版本的可下载标记');
  if (version.immutable !== true) throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, '版本记录没有标明历史版本不可改写');
  return version;
}

/** 核对一次读取的结果。 */
function readOf(value: unknown): ArtifactReadResult {
  const record = requireRecord(value, '读取结果');
  return {
    record: requireRecord(record['record'], '制品记录') as unknown as ArtifactRecord,
    version: versionOf(record['version']),
    base64: requireString(record['base64'], '内容字节'),
    contentType: requireString(record['contentType'], '内容类型'),
    preview: previewOf(record['preview']),
  };
}

/** 核对版本列表：当前版本必须出现在列表里，且每个版本属于同一个制品。 */
function versionListOf(value: unknown): ArtifactVersionList {
  const record = requireRecord(value, '版本列表');
  const artifactId = requireString(record['artifactId'], '版本列表里的制品标识');
  const currentVersion = requireInteger(record['currentVersion'], '当前版本号');
  const versions = requireArray<ArtifactVersionView>(record['versions'], '版本列表').map(versionOf);
  if (versions.length === 0) throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, '版本列表为空');
  for (const version of versions) {
    if (version.artifactId !== artifactId) {
      throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, '版本与制品标识不一致');
    }
  }
  if (!versions.some((version) => version.version === currentVersion)) {
    throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, '当前版本没有出现在版本列表里');
  }
  return { artifactId, currentVersion, versions };
}

/** 核对删除范围：必须列出涉及版本与占用空间。 */
function deleteScopeOf(value: unknown): ArtifactDeleteScope {
  const record = requireRecord(value, '删除范围');
  requireString(record['artifactId'], '删除范围里的制品标识');
  const affectedVersions = requireArray<number>(record['affectedVersions'], '删除范围内的版本').map((version) => requireInteger(version, '删除范围内的版本号'));
  if (affectedVersions.length === 0) throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, '删除范围里没有版本');
  requireInteger(record['totalBytes'], '删除范围的占用空间');
  if (record['requiresConfirm'] !== true) throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, '删除范围没有要求确认');
  return record as unknown as ArtifactDeleteScope;
}

/** 构造数据入口所需的依赖。 */
export interface ArtifactsGatewayOptions {
  /** 传输层。 */
  readonly transport: ArtifactsTransport;
  /** 浏览器侧遥测。 */
  readonly telemetry: PanelTelemetry;
}

/**
 * 构造制品面板的数据入口。
 * @param options - 传输层与遥测。
 * @returns 数据入口。
 */
export function createArtifactsGateway(options: ArtifactsGatewayOptions): ArtifactsGateway {
  const { transport, telemetry } = options;

  /**
   * 发一次调用，把失败信封与传输层拒绝都转成异常。
   * @param endpoint - `<服务名>/<方法名>`。
   * @param args - 位置参数。
   * @returns 成功时的值。
   */
  const call = async (endpoint: string, args: readonly unknown[]): Promise<unknown> =>
    telemetry.run(endpoint, async () => {
      const envelope = await transport.call(endpoint, args).then(
        (value) => value,
        (): RemoteEnvelope => ({
          ok: false,
          error: { code: CLIENT_ERROR_CODES.offline, message: '控制平面不可达，请恢复连接后重新加载' },
        }),
      );
      if (!envelope.ok) throw new ArtifactClientError(envelope.error.code, envelope.error.message);
      return envelope.value;
    });

  return {
    async list(sessionId?: string): Promise<ArtifactRecord[]> {
      const value = await call('chatdshArtifacts/list', sessionId === undefined ? [] : [sessionId]);
      return requireArray<ArtifactRecord>(value, '制品列表');
    },

    async versionList(id: string): Promise<ArtifactVersionList> {
      return versionListOf(await call('chatdshArtifacts/versionList', [id]));
    },

    async read(id: string, version?: number): Promise<ArtifactReadResult> {
      return readOf(await call('chatdshArtifacts/read', version === undefined ? [id] : [id, version]));
    },

    async deleteScope(id: string): Promise<ArtifactDeleteScope> {
      return deleteScopeOf(await call('chatdshArtifacts/deleteScope', [id]));
    },

    async remove(id: string): Promise<boolean> {
      const value = await call('chatdshArtifacts/delete', [id]);
      if (typeof value !== 'boolean') throw new ArtifactClientError(CLIENT_ERROR_CODES.internal, '删除结果不符合约定');
      return value;
    },

    noteAction(action: ArtifactUiAction, outcome: ActionOutcome): void {
      telemetry.action(action, outcome);
    },
  };
}
