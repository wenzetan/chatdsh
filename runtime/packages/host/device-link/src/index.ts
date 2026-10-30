/**
 * 设备长连接的设备侧：主动连到控制平面，把转发来的请求交给本地运行时。
 *
 * 设备在防火墙后面时没有可拨入的地址，因此连接方向反过来：设备拨出去，控制平面沿这条
 * 连接下发请求。本插件只在设备形态下激活——`controlUrl` 与节点令牌都配置了才连，缺一项
 * 静默跳过，这是设备形态下的常态，不是错误。
 *
 * 升级路径、帧格式与心跳见 `gateway/src/device-link.ts`：控制平面每 30 秒发一帧 `ping`，
 * 这里回一帧 `pong`；转发按 `requestId` 对应，请求体与响应体一律 Base64。
 *
 * 连接建立后本插件在本地运行时上注册 `/healthz`，控制平面的链路自检端点经这条连接取它。
 * @module @chatdsh/host-device-link
 */

import { Service, schema as z, connectionOf, hostWebServerOf, telemetryOf, type Context } from '@chatdsh/adapter';
import type { ChatdshTelemetry, TelemetrySpan } from '@chatdsh/core-contracts';

/** 插件名。 */
export const name = 'chatdsh-device-link';

/** 控制平面侧的长连接升级路径。 */
export const DEVICE_LINK_PATH = '/chatdsh/gateway/device-link';

/** 链路自检的本地端点。 */
export const HEALTH_PATH = '/healthz';

/** 本机身份端点：控制平面据此判断默认运行时是不是一台已登记的设备。 */
export const IDENTITY_PATH = '/chatdsh/device/identity';

/** 重连的起始间隔。 */
export const RECONNECT_BASE_MS = 1000;

/** 运行时界面凭据的 cookie 名前缀。 */
export const CREDENTIAL_COOKIE_PREFIX = 'dsh-auth-';

/** 逐跳头部：转发请求与回填响应时都去掉，它们只对单段连接有意义。 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** 配置。 */
export interface DeviceLinkConfig {
  /** 控制平面地址，例如 `http://127.0.0.1:3170`。为空时插件不激活。 */
  controlUrl: string;
  /** 设备标识，配对响应里的 `deviceId`。 */
  deviceId: string;
  /** 重连退避的上限，单位毫秒。 */
  reconnectMaxMs: number;
}

/** 配置 schema。 */
export const Config: z<DeviceLinkConfig> = z.object({
  controlUrl: z.string().default(process.env.CHATDSH_CONTROL_URL ?? ''),
  deviceId: z.string().default(process.env.CHATDSH_DEVICE_ID ?? ''),
  reconnectMaxMs: z.number().default(30_000),
});

/** 控制平面下发的请求帧。 */
interface RequestFrame {
  readonly type: 'request';
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  /** 请求体，Base64 编码。 */
  readonly body?: string;
}

/** 控制平面下发的其余帧。 */
interface PingFrame {
  readonly type: 'ping';
}

/**
 * 节点令牌只从环境变量读取。
 *
 * 令牌不进配置树：配置导出（`dsh --dump-config`）会打印配置树，令牌写进去就会出现在
 * 日志与排查材料里。
 * @param env - 进程环境变量。
 * @returns 令牌；未配置时为空字符串。
 */
export function nodeTokenFrom(env: NodeJS.ProcessEnv): string {
  const token = env.CHATDSH_NODE_TOKEN;
  return token === undefined ? '' : token.trim();
}

/** 本机界面凭据：索引页与 Remote 端点要求的两份 cookie。 */
export interface LocalCredential {
  /** 凭据对应的本机地址；地址变了要重新换取。 */
  readonly origin: string;
  /** 页面凭据：`/` 的索引页要求它。 */
  readonly page: string;
  /** API 凭据：`/api/` 的 Remote 调用要求它。 */
  readonly api: string;
}

/**
 * 用一次带启动口令的请求换一份 cookie。
 * @param url - 带口令的本机地址。
 * @returns `名=值` 形式的 cookie。
 */
async function mintCookie(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0] ?? '')
    .find((value) => value.startsWith(CREDENTIAL_COOKIE_PREFIX));
  if (cookie === undefined || cookie === '') {
    throw new Error(`device-link: ${new URL(url).pathname} 没有下发界面凭据（HTTP ${response.status}）`);
  }
  return cookie;
}

/**
 * 请求里是否已经带了本机界面凭据。
 *
 * 调用方自带凭据时（例如验收脚本用设备自己的凭据访问另一台设备）原样转发，不补发，
 * 这样凭据归属的判断仍然落在接收请求的那台运行时上。
 * @param cookie - 请求的 Cookie 头。
 * @returns 有凭据时为真。
 */
export function hasLocalCredential(cookie: string | undefined): boolean {
  if (cookie === undefined) return false;
  return cookie.split(';').some((part) => part.trim().startsWith(CREDENTIAL_COOKIE_PREFIX));
}

/**
 * 按路径选要补发的凭据。
 *
 * 索引页与 Remote 端点用的是同名的两份 cookie，值不同，只能按路径分开补发；其余静态
 * 资源不需要凭据。
 * @param credential - 本机凭据。
 * @param path - 转发给本机运行时的路径，可带查询串。
 * @returns 要补发的 cookie；这个路径不需要凭据时为空。
 */
export function credentialFor(credential: LocalCredential, path: string): string | undefined {
  const pathname = path.split('?')[0] ?? '/';
  if (pathname === '/' || pathname === '/index.html') return credential.page;
  if (pathname.startsWith('/api/')) return credential.api;
  return undefined;
}

/**
 * 设备长连接。
 *
 * 连接断开后按指数退避重连：1 秒起，每次翻倍，上限 `reconnectMaxMs`；连上之后退避重置。
 * 进程销毁时关闭连接并清掉定时器。
 */
export class ChatdshDeviceLinkService extends Service {
  /** 依赖本地 HTTP 服务：转发目标地址与 `/healthz` 都由它提供。 */
  static inject = ['webServer'];

  /** 配置 schema。 */
  static Config: z<DeviceLinkConfig> = Config;

  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelayMs = RECONNECT_BASE_MS;
  private stopped = false;
  private linkSpan: TelemetrySpan | undefined;
  private token = '';
  private credential: LocalCredential | undefined;

  constructor(ctx: Context, private readonly config: DeviceLinkConfig) {
    super(ctx, name);
  }

  /**
   * 配置齐全时建立连接，并注册本机身份与自检端点。
   *
   * 身份端点只在本设备标识非空时注册：控制平面用它判断默认运行时是不是一台已登记的
   * 设备（外壳的「在本机继续」要用这个判断）。
   */
  async [Service.init](): Promise<void> {
    this.token = nodeTokenFrom(process.env);
    if (this.config.deviceId !== '') {
      const releaseIdentity = hostWebServerOf(this.ctx).register({
        kind: 'exact',
        path: IDENTITY_PATH,
        handler: (_request, response) => {
          const body = JSON.stringify({ deviceId: this.config.deviceId });
          response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
          });
          response.end(body);
        },
      });
      this.ctx.effect(() => () => releaseIdentity(), `${name}/identity`);
    }
    if (this.config.controlUrl === '' || this.token === '') return;
    const release = hostWebServerOf(this.ctx).register({
      kind: 'exact',
      path: HEALTH_PATH,
      handler: (_request, response) => {
        const body = JSON.stringify({ ok: true, service: name });
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        });
        response.end(body);
      },
    });
    this.ctx.effect(() => () => {
      release();
      this.stop();
    }, name);
    this.connect();
  }

  /** 关闭连接与定时器；重复调用无副作用。 */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      socket.close(1000, 'stop');
    }
    this.linkSpan?.end();
    this.linkSpan = undefined;
  }

  /** 建立一次连接。 */
  private connect(): void {
    if (this.stopped) return;
    const url = `${linkOrigin(this.config.controlUrl)}${DEVICE_LINK_PATH}`;
    const telemetry = telemetryOf<ChatdshTelemetry>(this.ctx);
    const span = telemetry?.startSpan('chatdsh.runtime.device.link', {});
    this.linkSpan = span;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.token}` } });
    this.socket = socket;
    let opened = false;

    socket.addEventListener('open', () => {
      opened = true;
      this.reconnectDelayMs = RECONNECT_BASE_MS;
      span?.setAttribute('outcome', 'connected');
      telemetry?.counter('chatdsh_runtime_device_links_total', { description: '设备长连接生命周期' })
        .add(1, { outcome: 'connected' });
      this.send({
        type: 'hello',
        deviceId: this.config.deviceId,
        platform: process.platform,
        role: 'both',
        capabilities: [],
      });
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        this.violation('frame-not-text');
        return;
      }
      this.handleFrame(event.data);
    });

    socket.addEventListener('error', () => {
      telemetry?.event('chatdsh.runtime.device.rejected', {
        outcome: 'rejected',
        'error.type': 'link',
        'error.code': opened ? 'link-error' : 'connect-failed',
      });
      telemetry?.counter('chatdsh_runtime_device_links_total', { description: '设备长连接生命周期' })
        .add(1, { outcome: 'failed' });
    });

    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = undefined;
      span?.setAttribute('outcome', opened ? 'closed' : 'failed');
      span?.end();
      if (this.linkSpan === span) this.linkSpan = undefined;
      if (opened) {
        telemetry?.counter('chatdsh_runtime_device_links_total', { description: '设备长连接生命周期' })
          .add(1, { outcome: 'closed' });
      }
      if (this.stopped) return;
      telemetry?.counter('chatdsh_runtime_device_links_total', { description: '设备长连接生命周期' })
        .add(1, { outcome: 'reconnect' });
      this.scheduleReconnect();
    });
  }

  /** 按当前退避间隔安排下一次连接，并把间隔翻倍。 */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const delay = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
    this.reconnectDelayMs = Math.min(delay * 2, this.config.reconnectMaxMs);
  }

  /** 处理一帧控制平面消息。 */
  private handleFrame(raw: string): void {
    const frame = JSON.parse(raw) as RequestFrame | PingFrame;
    if (frame.type === 'ping') {
      this.send({ type: 'pong' });
      return;
    }
    if (frame.type === 'request') {
      void this.forward(frame);
      return;
    }
    this.violation('frame-unknown');
  }

  /** 把一次请求转发到本地运行时，回填响应帧。 */
  private async forward(frame: RequestFrame): Promise<void> {
    const telemetry = telemetryOf<ChatdshTelemetry>(this.ctx);
    const carrier: Record<string, string> = {};
    const traceparent = frame.headers?.traceparent;
    const tracestate = frame.headers?.tracestate;
    if (traceparent !== undefined) carrier.traceparent = traceparent;
    if (tracestate !== undefined) carrier.tracestate = tracestate;
    const execute = async (span: TelemetrySpan | undefined): Promise<void> => {
      const origin = hostWebServerOf(this.ctx).getOrigin();
      const target = new URL(frame.path, origin);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(frame.headers ?? {})) {
        const lowered = key.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lowered) || lowered === 'host') continue;
        headers[lowered] = value;
      }
      const body = frame.body === undefined || frame.body === '' ? undefined : Buffer.from(frame.body, 'base64');
      const send = async (cookie: string | undefined): Promise<Response> => {
        const outgoing = { ...headers };
        if (cookie !== undefined) outgoing.cookie = outgoing.cookie === undefined ? cookie : `${outgoing.cookie}; ${cookie}`;
        return fetch(target, { method: frame.method, headers: outgoing, body, redirect: 'manual' });
      };
      // 控制平面沿这条连接下发的请求代表本设备的界面：调用方没有自带界面凭据时，
      // 用本进程的启动口令换一份，再转给本机运行时。
      let injected: string | undefined;
      if (!hasLocalCredential(headers.cookie)) {
        try {
          injected = credentialFor(await this.localCredential(), frame.path);
        } catch (error) {
          span?.setAttribute('error.code', 'credential-unavailable');
          telemetry?.event('chatdsh.runtime.device.forward.failed', {
            outcome: 'failed',
            'error.type': error instanceof Error ? error.name : 'Unknown',
            'error.code': 'credential-unavailable',
          });
        }
      }
      try {
        let response = await send(injected);
        if (response.status === 401 && injected !== undefined) {
          // 凭据过期或运行时的签名密钥换过：丢掉缓存换一份再试一次。
          this.credential = undefined;
          injected = credentialFor(await this.localCredential(), frame.path);
          response = await send(injected);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const replyHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of response.headers) {
          if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
          replyHeaders[key] = value;
        }
        // `set-cookie` 在迭代里被合并成一条，改用逐条取值回填，让多值头部保持独立。
        const cookies = response.headers.getSetCookie();
        if (cookies.length > 0) replyHeaders['set-cookie'] = cookies;
        span?.setAttribute('http.status_code', response.status);
        span?.setAttribute('outcome', 'forwarded');
        telemetry?.counter('chatdsh_runtime_device_forwards_total', { description: '设备侧转发到本地运行时的请求数' })
          .add(1, { outcome: 'ok' });
        this.send({
          type: 'response',
          requestId: frame.requestId,
          status: response.status,
          headers: replyHeaders,
          body: bytes.toString('base64'),
        });
      } catch (error) {
        span?.setAttribute('outcome', 'failed');
        span?.setAttribute('error.type', error instanceof Error ? error.name : 'Unknown');
        span?.setAttribute('error.code', 'local-unreachable');
        telemetry?.event('chatdsh.runtime.device.forward.failed', {
          outcome: 'failed',
          'error.type': error instanceof Error ? error.name : 'Unknown',
          'error.code': 'local-unreachable',
        });
        telemetry?.counter('chatdsh_runtime_device_forwards_total', { description: '设备侧转发到本地运行时的请求数' })
          .add(1, { outcome: 'failed' });
        const body500 = Buffer.from(JSON.stringify({ error: 'local-unreachable' }), 'utf8');
        this.send({
          type: 'response',
          requestId: frame.requestId,
          status: 502,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: body500.toString('base64'),
        });
      }
    };
    if (telemetry === undefined) {
      await execute(undefined);
      return;
    }
    await telemetry.withContext(carrier, () => telemetry.runSpan('chatdsh.runtime.device.forward', { method: frame.method }, execute));
  }

  /**
   * 换取本机的界面凭据。
   *
   * 凭据只能由运行时的进程自己用启动口令换取，因此换一次并缓存；运行时的签名密钥换过
   * 或凭据过期时由调用方清掉缓存重新换取。
   * @returns 本机凭据。
   */
  private async localCredential(): Promise<LocalCredential> {
    const origin = hostWebServerOf(this.ctx).getOrigin();
    const cached = this.credential;
    if (cached !== undefined && cached.origin === origin) return cached;
    const connection = connectionOf(this.ctx);
    if (connection === undefined) throw new Error('device-link: 运行时没有浏览器连接服务，无法换取界面凭据');
    const authorized = new URL(connection.authenticatedUrl(`${origin}/`));
    const token = authorized.searchParams.get('token') ?? '';
    if (token === '') throw new Error('device-link: 启动地址里没有启动口令');
    const credential: LocalCredential = {
      origin,
      page: await mintCookie(`${origin}/?token=${encodeURIComponent(token)}`),
      api: await mintCookie(`${origin}/connect?token=${encodeURIComponent(token)}`),
    };
    this.credential = credential;
    return credential;
  }

  /** 协议违规：记一条事件后断开，重连逻辑会重建连接。 */
  private violation(code: string): void {
    const telemetry = telemetryOf<ChatdshTelemetry>(this.ctx);
    telemetry?.event('chatdsh.runtime.device.rejected', {
      outcome: 'rejected',
      'error.type': 'protocol',
      'error.code': code,
    });
    this.socket?.close(1008, code);
  }

  /** 写一帧。连接不在可写状态时丢弃，重连会重建状态。 */
  private send(frame: unknown): void {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== 1) return;
    socket.send(JSON.stringify(frame));
  }
}

/**
 * 把控制平面地址转成 WebSocket 地址。
 * @param controlUrl - 控制平面地址，例如 `http://127.0.0.1:3170`。
 * @returns 去掉末尾斜杠的 WebSocket 基地址。
 */
export function linkOrigin(controlUrl: string): string {
  const trimmed = controlUrl.replace(/\/+$/, '');
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`;
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`;
  throw new Error(`CHATDSH_CONTROL_URL 必须是 http 或 https 地址：${controlUrl}`);
}

export { ChatdshDeviceLinkService as default };
