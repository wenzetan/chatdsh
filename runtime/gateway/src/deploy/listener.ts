/**
 * 部署监听：把校验通过的监听计划变成真实服务。
 *
 * 启动前完成绑定地址与安全条件校验，绑定传输材料；每个入站请求与升级请求先过同源、Host、
 * 代理链与身份头校验，通过之后才交给业务处理。轮换证书时重新读取材料，只对新连接生效，
 * 已有连接按原证书自然结束。
 * @module @chatdsh/gateway/deploy/listener
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import {
  DeploymentError,
  createRequestGuard,
  loadTlsMaterial,
  startListener,
  type GuardRequest,
  type ListenerPlan,
  type RequestGuard,
  type RequestKind,
  type TlsMaterial,
  type ValidatedListenerPlan,
} from '@chatdsh/core-deployment';

/** 建立监听需要的输入。 */
export interface DeployListenerOptions {
  /** 监听计划；启动时统一校验。 */
  readonly plan: ListenerPlan;
  /** 遥测客户端。 */
  readonly telemetry: ChatdshTelemetry;
  /** 校验通过之后的业务处理。 */
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
  /** 请求分类；缺省按普通接口处理。 */
  readonly kindOf?: (request: IncomingMessage) => RequestKind;
  /** 校验通过的升级请求交给它；缺省回 501。 */
  readonly onUpgrade?: (request: IncomingMessage, socket: Socket, head: Buffer) => void;
}

/** 一个已经建立或可以建立的监听。 */
export interface DeployListener {
  /** 校验计划并开始监听。 */
  start(): Promise<void>;
  /** 停止监听并等待连接关闭。 */
  stop(): Promise<void>;
  /** 实际监听的地址。 */
  url(): string;
  /** 当前使用的传输材料；明文监听为 `undefined`。 */
  material(): TlsMaterial | undefined;
  /** 重新读取材料并应用到新连接。 */
  rotate(): Promise<TlsMaterial>;
  /** 校验通过的监听计划；未启动时为 `undefined`。 */
  plan(): ValidatedListenerPlan | undefined;
}

/** 写一个 JSON 响应。 */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

/** 判断连接上的客户端证书是否已经通过校验。 */
function clientAuthorizedOf(socket: Socket): boolean {
  if (!('authorized' in socket)) return false;
  return (socket as TLSSocket).authorized === true;
}

/** 组装一次校验输入。 */
function guardRequestOf(request: IncomingMessage, kind: RequestKind): GuardRequest {
  return {
    kind,
    method: request.method ?? 'GET',
    url: request.url ?? '/',
    headers: request.headers,
    remoteAddress: request.socket.remoteAddress,
    clientAuthorized: clientAuthorizedOf(request.socket),
  };
}

/** 在升级握手上写一个拒绝响应并关闭连接。 */
function rejectUpgrade(socket: Socket, status: number, errorCode: string): void {
  const body = JSON.stringify({ error: errorCode });
  const reason = status === 401 ? 'Unauthorized' : status === 426 ? 'Upgrade Required' : 'Forbidden';
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body
  );
  socket.destroy();
}

/**
 * 建立一个部署监听。
 * @param options - 计划、遥测、业务处理与升级处理。
 * @returns 监听句柄。
 */
export function createDeployListener(options: DeployListenerOptions): DeployListener {
  const { telemetry } = options;
  let server: ReturnType<typeof createHttpServer> | undefined;
  let validated: ValidatedListenerPlan | undefined;
  let requestGuard: RequestGuard | undefined;
  let material: TlsMaterial | undefined;

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const guard = requestGuard;
    if (guard === undefined) {
      sendJson(response, 503, { error: 'listener-not-ready' });
      return;
    }
    const kind = options.kindOf?.(request) ?? 'api';
    const verdict = guard.check(guardRequestOf(request, kind), telemetry);
    if (!verdict.allowed) {
      sendJson(response, verdict.status, { error: verdict.errorCode });
      return;
    }
    for (const name of verdict.stripHeaders) delete request.headers[name];
    await options.handler(request, response);
  }

  function upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const guard = requestGuard;
    if (guard === undefined) {
      rejectUpgrade(socket, 403, 'listener-not-ready');
      return;
    }
    const verdict = guard.check(guardRequestOf(request, 'upgrade'), telemetry);
    if (!verdict.allowed) {
      rejectUpgrade(socket, verdict.status, verdict.errorCode);
      return;
    }
    for (const name of verdict.stripHeaders) delete request.headers[name];
    if (options.onUpgrade === undefined) {
      rejectUpgrade(socket, 426, 'upgrade-unsupported');
      return;
    }
    options.onUpgrade(request, socket, head);
  }

  async function listen(plan: ValidatedListenerPlan): Promise<void> {
    material = plan.tls === undefined ? undefined : await loadTlsMaterial(plan.tls, telemetry);
    requestGuard = createRequestGuard(plan);
    validated = plan;
    const created =
      material === undefined
        ? createHttpServer((request, response) => {
            dispatch(request, response).catch(() => {
              if (!response.headersSent) sendJson(response, 500, { error: 'internal' });
              else response.end();
            });
          })
        : createHttpsServer(material.options, (request, response) => {
            dispatch(request, response).catch(() => {
              if (!response.headersSent) sendJson(response, 500, { error: 'internal' });
              else response.end();
            });
          });
    created.on('upgrade', (request, socket, head) => upgrade(request, socket as Socket, head));
    await new Promise<void>((resolve, reject) => {
      created.once('error', reject);
      created.listen(plan.port, plan.host, () => {
        created.off('error', reject);
        resolve();
      });
    });
    server = created;
  }

  return {
    async start(): Promise<void> {
      if (server !== undefined) {
        throw new DeploymentError('listener-already-started', 'bind', 409, '监听已经启动');
      }
      await startListener({ plan: options.plan, telemetry, listen });
    },
    stop(): Promise<void> {
      const current = server;
      if (current === undefined) return Promise.resolve();
      server = undefined;
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref();
        current.closeAllConnections();
        current.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    url(): string {
      const scheme = material === undefined ? 'http' : 'https';
      const address = server?.address();
      const port = address !== undefined && address !== null && typeof address === 'object' ? address.port : options.plan.port;
      return `${scheme}://${options.plan.host}:${port}`;
    },
    material(): TlsMaterial | undefined {
      return material;
    },
    async rotate(): Promise<TlsMaterial> {
      const plan = validated;
      if (plan === undefined || plan.tls === undefined || server === undefined) {
        throw new DeploymentError('tls-not-configured', 'tls', 500, '当前监听没有配置 TLS，无法轮换');
      }
      const loaded = await loadTlsMaterial(plan.tls, telemetry);
      (server as HttpsServer).setSecureContext(loaded.options);
      material = loaded;
      return loaded;
    },
    plan(): ValidatedListenerPlan | undefined {
      return validated;
    },
  };
}
