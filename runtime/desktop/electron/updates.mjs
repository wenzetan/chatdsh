/**
 * 更新源、清单校验、下载与安装闸门。
 *
 * 更新清单必须带签名，签名用配置里的公钥验证；下载完成后重新计算摘要，与清单不一致
 * 就不进入安装。安装前给出运行中任务与草稿的影响，失败时给出回滚说明。
 * @module chatdsh-desktop-shell/updates
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 一次更新操作失败。 */
export class UpdateError extends Error {
  /**
   * @param code - 失败原因代码。
   * @param detail - 说明文本。
   */
  constructor(code, detail) {
    super(detail === undefined ? `更新失败：${code}` : `更新失败：${code}（${detail}）`);
    this.name = 'UpdateError';
    this.code = code;
    this.detail = detail;
  }
}

/** 更新通道。 */
export const UPDATE_CHANNELS = Object.freeze(['stable', 'beta']);

/** 安装包大小上下限。 */
export const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;
export const MIN_PACKAGE_BYTES = 1024;

/** 版本号形状。 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u;

/** 本机回环主机：允许用 http 搭本地更新镜像。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

/** 更新状态初值。 */
export const INITIAL_UPDATE_STATE = Object.freeze({ status: 'idle', version: undefined, channel: undefined });

/** 版本状态文案。 */
const STATUS_LABELS = Object.freeze({
  idle: '未检查',
  checking: '正在检查',
  available: '发现新版本',
  downloading: '正在下载',
  verifying: '正在校验',
  ready: '等待安装',
  installing: '正在安装',
  failed: '更新失败',
});

/** 判定地址是否允许：https，或者本机回环的 http。 */
function assertUpdateUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UpdateError('url-invalid', '更新地址无法解析');
  }
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'http:' && loopback) return parsed;
  throw new UpdateError('url-scheme', `更新地址只允许 https 或本机回环 http，收到 ${parsed.protocol}`);
}

/**
 * 解析更新源配置。
 * @param raw - 地址、通道与公钥 PEM 文本。
 * @returns 规范化后的更新源。
 */
export function normalizeUpdateSource(raw) {
  if (raw === null || typeof raw !== 'object') throw new UpdateError('source-invalid', '更新源配置不是对象');
  const url = assertUpdateUrl(raw.url);
  const channel = raw.channel ?? 'stable';
  if (!UPDATE_CHANNELS.includes(channel)) throw new UpdateError('channel-not-allowed', `未知通道 ${channel}`);
  if (typeof raw.publicKeyPem !== 'string' || raw.publicKeyPem.trim() === '') {
    throw new UpdateError('public-key-missing', '没有配置更新签名公钥');
  }
  let publicKey;
  try {
    publicKey = createPublicKey(raw.publicKeyPem);
  } catch {
    throw new UpdateError('public-key-invalid', '更新签名公钥无法解析');
  }
  const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
  return {
    baseUrl,
    origin: url.origin,
    channel,
    publicKey,
  };
}

/**
 * 读取更新源配置。
 * @param options.file - 配置文件路径。
 * @param options.env - 环境变量。
 * @returns 更新源；没有配置地址时返回 undefined。
 */
export function loadUpdateSource({ file, env = {} }) {
  let stored = {};
  if (existsSync(file)) stored = JSON.parse(readFileSync(file, 'utf8'));
  const url = env.CHATDSH_UPDATE_URL ?? stored.url;
  if (typeof url !== 'string' || url.trim() === '') return undefined;
  return normalizeUpdateSource({
    url,
    channel: env.CHATDSH_UPDATE_CHANNEL ?? stored.channel,
    publicKeyPem: env.CHATDSH_UPDATE_PUBLIC_KEY ?? stored.publicKeyPem,
  });
}

/**
 * 清单里参与签名的字段拼成的字节串。
 * @param manifest - 清单对象。
 * @returns 待验证的字节串。
 */
export function canonicalManifestPayload(manifest) {
  return Buffer.from([
    manifest.version,
    manifest.channel,
    manifest.url,
    String(manifest.size),
    manifest.sha512,
  ].join('\n'), 'utf8');
}

/**
 * 比较两个版本号。
 * @param left - 左侧版本。
 * @param right - 右侧版本。
 * @returns 左侧较大时为 1，相等为 0，较小为 -1。
 */
export function compareVersions(left, right) {
  const split = (value) => {
    const [core, preRelease] = String(value).split('-');
    return { parts: core.split('.').map((part) => Number.parseInt(part, 10)), preRelease };
  };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (a.preRelease === b.preRelease) return 0;
  if (a.preRelease === undefined) return 1;
  if (b.preRelease === undefined) return -1;
  return a.preRelease > b.preRelease ? 1 : -1;
}

/**
 * 校验更新清单：字段、通道、版本、地址、大小、摘要与签名。
 * @param manifest - 清单对象。
 * @param context.source - 更新源。
 * @param context.appVersion - 当前版本。
 * @returns 通过校验的清单。
 */
export function verifyUpdateManifest(manifest, { source, appVersion }) {
  if (manifest === null || typeof manifest !== 'object') throw new UpdateError('manifest-invalid', '清单不是对象');
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
    throw new UpdateError('version-invalid', '清单里的版本号不合法');
  }
  if (manifest.channel !== source.channel) {
    throw new UpdateError('channel-mismatch', `清单通道 ${manifest.channel} 与配置通道 ${source.channel} 不一致`);
  }
  if (compareVersions(manifest.version, appVersion) <= 0) {
    throw new UpdateError('downgrade', `目标版本 ${manifest.version} 不高于当前版本 ${appVersion}`);
  }
  const url = assertUpdateUrl(manifest.url);
  if (url.origin !== source.origin) throw new UpdateError('url-host', '安装包地址与更新源不同源');
  if (!Number.isInteger(manifest.size) || manifest.size < MIN_PACKAGE_BYTES || manifest.size > MAX_PACKAGE_BYTES) {
    throw new UpdateError('size-invalid', '安装包大小超出范围');
  }
  if (typeof manifest.sha512 !== 'string' || !/^[0-9a-f]{128}$/u.test(manifest.sha512)) {
    throw new UpdateError('digest-format', '清单里的摘要不是 128 位十六进制');
  }
  if (typeof manifest.signature !== 'string' || manifest.signature.trim() === '') {
    throw new UpdateError('signature-missing', '清单没有签名');
  }
  const signature = Buffer.from(manifest.signature, 'base64');
  if (signature.length === 0) throw new UpdateError('signature-format', '签名不是有效的 base64');
  const valid = verifySignature(null, canonicalManifestPayload(manifest), source.publicKey, signature);
  if (!valid) throw new UpdateError('signature-invalid', '清单签名校验失败');
  return {
    version: manifest.version,
    channel: manifest.channel,
    url: url.toString(),
    size: manifest.size,
    sha512: manifest.sha512,
    notes: typeof manifest.notes === 'string' ? manifest.notes.slice(0, 4000) : '',
  };
}

/**
 * 校验下载得到的安装包字节。
 * @param bytes - 安装包字节。
 * @param verified - 通过校验的清单。
 */
export function verifyUpdatePackage(bytes, verified) {
  if (bytes.length !== verified.size) {
    throw new UpdateError('size-mismatch', `安装包大小 ${bytes.length} 与清单 ${verified.size} 不一致`);
  }
  const digest = createHash('sha512').update(bytes).digest('hex');
  if (digest !== verified.sha512) throw new UpdateError('digest-mismatch', '安装包摘要与清单不一致');
}

/** 允许的状态迁移。 */
const TRANSITIONS = Object.freeze({
  idle: new Set(['checking', 'failed']),
  checking: new Set(['available', 'idle', 'failed', 'cancelled']),
  available: new Set(['downloading', 'failed', 'idle']),
  downloading: new Set(['verifying', 'failed', 'cancelled']),
  verifying: new Set(['ready', 'failed']),
  ready: new Set(['installing', 'idle']),
  installing: new Set(['installed', 'failed']),
  installed: new Set(['idle']),
  cancelled: new Set(['idle', 'checking', 'downloading']),
  failed: new Set(['checking', 'available', 'idle']),
});

/**
 * 推进更新状态。
 * @param state - 当前状态。
 * @param event - 事件类型与附加字段。
 * @returns 新状态。
 */
export function reduceUpdateState(state, event) {
  const current = state ?? { status: 'idle' };
  const from = current.status;
  const target = event.type === 'error' ? 'failed' : event.type;
  const allowed = TRANSITIONS[from];
  if (allowed === undefined || !allowed.has(target)) {
    throw new UpdateError('state-invalid', `状态 ${from} 不接受 ${event.type}`);
  }
  if (target === 'idle') return { status: 'idle', channel: current.channel };
  const next = { status: target };
  const version = event.version ?? current.version;
  if (version !== undefined) next.version = version;
  const channel = event.channel ?? current.channel;
  if (channel !== undefined) next.channel = channel;
  const notes = event.notes ?? current.notes;
  if (notes !== undefined) next.notes = notes;
  const progress = event.progress ?? current.progress;
  if (target === 'downloading' || target === 'verifying') next.progress = progress;
  if (event.message !== undefined) next.message = event.message;
  if (event.error !== undefined) next.error = event.error;
  return next;
}

/**
 * 更新状态的界面文案。
 * @param state - 当前状态。
 * @param appVersion - 当前版本。
 * @returns 文案、细节与可用动作。
 */
export function updatePresentation(state, appVersion) {
  const status = state.status ?? 'idle';
  const label = STATUS_LABELS[status];
  const detail = status === 'available'
    ? `${appVersion} → ${state.version}，下载后重启安装，会话保留`
    : status === 'downloading'
      ? `${state.progress?.received ?? 0} / ${state.progress?.total ?? 0} 字节`
      : status === 'ready'
        ? `已下载并校验 ${state.version}，等待确认安装`
        : status === 'failed'
          ? state.error?.message ?? '更新失败'
          : status === 'idle'
            ? state.message ?? `当前版本 ${appVersion}`
            : '';
  const actions = [];
  if (status === 'idle' || status === 'failed') actions.push('check');
  if (status === 'available') actions.push('download');
  if (status === 'downloading' || status === 'verifying') actions.push('cancel');
  if (status === 'ready') actions.push('install');
  return { status, label, detail, actions, notes: state.notes ?? '' };
}

/**
 * 判定能否开始安装。
 * @param context.state - 当前更新状态。
 * @param context.activity - 运行中回合、草稿与待审批数量。
 * @param context.confirmed - 用户是否已经确认。
 * @returns 是否放行、是否需要确认与影响说明。
 */
export function installGate(context) {
  const state = context.state ?? {};
  const activity = context.activity ?? {};
  if (state.status !== 'ready') {
    return { allowed: false, confirm: false, reasons: ['not-ready'], message: '安装包还没有下载并校验完成' };
  }
  const runningTurns = activity.runningTurns ?? 0;
  const pendingApprovals = activity.pendingApprovals ?? 0;
  const drafts = activity.drafts ?? 0;
  const reasons = [];
  if (runningTurns > 0) reasons.push('running-turns');
  if (pendingApprovals > 0) reasons.push('pending-approvals');
  if (drafts > 0) reasons.push('drafts');
  if (reasons.length === 0) {
    return { allowed: context.confirmed === true, confirm: true, reasons, message: '安装会重启应用，未保存的输入会保留' };
  }
  const parts = [];
  if (runningTurns > 0) parts.push(`${runningTurns} 个回合正在运行`);
  if (pendingApprovals > 0) parts.push(`${pendingApprovals} 个审批等待处理`);
  if (drafts > 0) parts.push(`${drafts} 份草稿没有提交`);
  const impact = `${parts.join('，')}。安装会重启应用并中断这些操作。`;
  return {
    allowed: context.confirmed === true,
    confirm: true,
    reasons,
    message: impact,
  };
}

/**
 * 安装失败时的回滚说明。
 * @param context - 原版本、目标版本、失败原因与暂存路径。
 * @returns 标题与说明行。
 */
export function describeRollback(context) {
  const from = context.from ?? '当前版本';
  const to = context.to ?? '新版本';
  const lines = [
    `${from} 继续可以启动，安装没有覆盖正在使用的程序目录。`,
    `已下载的 ${to} 安装包保留在 ${context.stagedPath ?? '更新目录'}，可以重新校验后再试。`,
    `要回到 ${from}，用原来的安装包覆盖安装即可；会话、设置与日志不受影响。`,
  ];
  if (context.reason !== undefined) lines.unshift(`失败原因：${context.reason}`);
  return { title: '更新没有完成', lines };
}

/**
 * 创建更新服务。
 *
 * 服务持有当前状态，负责检查、下载、校验与安装放行；真正的进程启动由调用方完成。
 * @param options.source - 更新源；未配置时为 undefined。
 * @param options.appVersion - 当前版本。
 * @param options.directory - 暂存目录。
 * @param options.fetchImpl - 取回实现，缺省用全局 fetch。
 * @returns 服务对象。
 */
export function createUpdateService({ source, appVersion, directory, fetchImpl = fetch }) {
  let state = { status: 'idle', channel: source?.channel };
  let verified;
  let stagedPath;
  let controller;
  let installedFrom;

  const snapshot = () => ({
    configured: source !== undefined,
    channel: source?.channel,
    appVersion,
    status: state.status,
    version: state.version,
    notes: state.notes,
    progress: state.progress,
    error: state.error,
    message: state.message,
    stagedPath,
    rollback: state.error === undefined ? undefined : describeRollback({
      from: installedFrom ?? appVersion,
      to: state.version,
      reason: state.error.message,
      stagedPath,
    }),
  });

  /** 把失败落到状态上并抛出。 */
  function fail(error) {
    const code = error instanceof UpdateError ? error.code : 'update-failed';
    state = { ...state, status: 'failed', error: { code, message: error.message } };
    throw error;
  }

  return {
    /** 当前状态快照。 */
    state: snapshot,

    /** 检查更新。 */
    async check() {
      if (source === undefined) throw new UpdateError('source-missing', '没有配置更新源');
      if (['downloading', 'verifying', 'installing', 'ready'].includes(state.status)) {
        throw new UpdateError('busy', '更新正在进行中');
      }
      state = { ...reduceUpdateState({ status: state.status === 'available' ? 'idle' : state.status }, { type: 'checking' }), channel: source.channel };
      try {
        const response = await fetchImpl(`${source.baseUrl}/latest.json`, { cache: 'no-store' });
        if (!response.ok) throw new UpdateError('manifest-status', `清单请求返回 ${response.status}`);
        const manifest = await response.json();
        verified = verifyUpdateManifest(manifest, { source, appVersion });
        state = {
          status: 'available',
          channel: source.channel,
          version: verified.version,
          notes: verified.notes,
        };
        return snapshot();
      } catch (error) {
        fail(error);
      }
    },

    /** 下载并校验安装包。 */
    async download() {
      if (verified === undefined || state.status !== 'available') {
        throw new UpdateError('not-available', '还没有可下载的新版本');
      }
      state = reduceUpdateState(state, { type: 'downloading', version: verified.version, progress: { received: 0, total: verified.size } });
      controller = new AbortController();
      const directoryForVersion = join(directory, verified.version);
      mkdirSync(directoryForVersion, { recursive: true });
      stagedPath = join(directoryForVersion, 'ChatDSH-Setup.exe');
      const handle = await openFile(stagedPath, 'w');
      const hash = createHash('sha512');
      let received = 0;
      try {
        const response = await fetchImpl(verified.url, { signal: controller.signal });
        if (!response.ok) throw new UpdateError('download-status', `下载返回 ${response.status}`);
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk);
          received += buffer.length;
          if (received > MAX_PACKAGE_BYTES) throw new UpdateError('download-too-large', '安装包超过上限');
          hash.update(buffer);
          await handle.write(buffer);
          state = { ...state, status: 'downloading', progress: { received, total: verified.size } };
        }
      } catch (error) {
        await handle.close();
        rmSync(stagedPath, { force: true });
        if (error.name === 'AbortError') {
          state = { ...state, status: 'cancelled', message: '下载已中断' };
          return snapshot();
        }
        fail(error);
      }
      await handle.close();
      state = reduceUpdateState(state, { type: 'verifying', version: verified.version });
      if (received !== verified.size) {
        rmSync(stagedPath, { force: true });
        fail(new UpdateError('size-mismatch', `安装包大小 ${received} 与清单 ${verified.size} 不一致`));
      }
      const digest = hash.digest('hex');
      if (digest !== verified.sha512) {
        rmSync(stagedPath, { force: true });
        fail(new UpdateError('digest-mismatch', '安装包摘要与清单不一致'));
      }
      state = reduceUpdateState(state, { type: 'ready', version: verified.version, notes: verified.notes });
      return snapshot();
    },

    /** 中断下载。 */
    cancel() {
      if (state.status !== 'downloading' && state.status !== 'verifying') {
        throw new UpdateError('not-downloading', '当前没有正在进行的下载');
      }
      controller?.abort();
      return snapshot();
    },

    /**
     * 判定能否安装，并把状态推进到等待启动安装程序。
     * @param activity - 运行中回合、待审批与草稿数量。
     * @param confirmed - 用户确认结果。
     */
    install(activity, confirmed) {
      const gate = installGate({ state, activity, confirmed });
      if (!gate.allowed) throw new UpdateError('install-blocked', gate.message);
      state = reduceUpdateState(state, { type: 'installing', version: verified.version });
      installedFrom = appVersion;
      return { packagePath: stagedPath, version: verified.version, gate };
    },

    /** 记录安装程序启动失败。 */
    markInstallFailed(error) {
      state = { ...state, status: 'failed', error: { code: 'install-failed', message: error.message } };
      return snapshot();
    },

    /** 重置到空闲状态。 */
    reset() {
      state = { status: 'idle', channel: source?.channel, message: '准备检查更新' };
      return snapshot();
    },
  };
}
