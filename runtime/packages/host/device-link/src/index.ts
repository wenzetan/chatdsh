/**
 * 设备长连接的设备侧：主动连到控制平面，把转发来的请求交给本地运行时。
 *
 * 设备在防火墙后面时没有可拨入的地址，因此连接方向反过来：设备拨出去，控制平面沿这条
 * 连接下发请求。本插件只在设备形态下激活——`controlUrl` 与节点令牌都配置了才连，缺一项
 * 静默跳过，这是设备形态下的常态。
 *
 * 线协议是版本 2 的多路复用帧：`hello` 带版本号，控制平面回 `welcome` 下发代次与预算；
 * 之后每条通道按 `open`／`accepted`／`data`／`credit`／`end`／`cancel`／`cancelled`／
 * `reset` 收发，心跳使用 `ping`／`pong`。连接建立后本插件在本地运行时上注册 `/healthz`，
 * 控制平面的链路自检端点经这条连接取它。
 * @module @chatdsh/host-device-link
 */

import { Service, schema as z, connectionOf, hostWebServerOf, telemetryOf, type Context } from '@chatdsh/adapter';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { DeviceLinkClient } from './client.ts';
import { mintCookie, type LocalCredential } from './credential.ts';

export { DEVICE_LINK_PATH, DeviceLinkClient, RECONNECT_BASE_MS, linkOrigin } from './client.ts';
export type { DeviceLinkClientOptions, DeviceLinkClientStats, DeviceLinkWelcome } from './client.ts';
export { CREDENTIAL_COOKIE_PREFIX, credentialFor, hasLocalCredential } from './credential.ts';
export type { CredentialProvider, LocalCredential } from './credential.ts';
export { DeviceLinkSession } from './v2-channel.ts';
export type { DeviceLinkSessionOptions, DeviceLinkStats } from './v2-channel.ts';
export { PROTOCOL_VERSION } from './protocol.ts';

/** 插件名。 */
export const name = 'chatdsh-device-link';

/** 链路自检的本地端点。 */
export const HEALTH_PATH = '/healthz';

/** 本机身份端点：控制平面据此判断默认运行时是不是一台已登记的设备。 */
export const IDENTITY_PATH = '/chatdsh/device/identity';

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

/**
 * 设备长连接插件。
 *
 * 配置齐全时建立连接；连接断开后由客户端按指数退避重连。进程销毁时关闭连接与定时器。
 */
export class ChatdshDeviceLinkService extends Service {
  /** 依赖本地 HTTP 服务：转发目标地址与 `/healthz` 都由它提供。 */
  static inject = ['webServer', 'chatdshTelemetry'];

  /** 配置 schema。 */
  static Config: z<DeviceLinkConfig> = Config;

  private client: DeviceLinkClient | undefined;
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
    const releaseHealth = hostWebServerOf(this.ctx).register({
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
    this.client = new DeviceLinkClient({
      controlUrl: this.config.controlUrl,
      token: this.token,
      deviceId: this.config.deviceId,
      platform: process.platform,
      role: 'both',
      capabilities: ['http', 'websocket'],
      localOrigin: hostWebServerOf(this.ctx).getOrigin(),
      credentials: {
        get: () => this.localCredential(),
        refresh: () => {
          this.credential = undefined;
          return this.localCredential();
        },
      },
      telemetry: telemetryOf<ChatdshTelemetry>(this.ctx),
      reconnectMaxMs: this.config.reconnectMaxMs,
    });
    this.ctx.effect(() => () => {
      releaseHealth();
      this.stop();
    }, name);
    this.client.start();
  }

  /** 关闭连接与定时器；重复调用无副作用。 */
  stop(): void {
    this.client?.stop();
    this.client = undefined;
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
}

export { ChatdshDeviceLinkService as default };
