/**
 * 部署检查与装卸的 HTTP 接口。
 *
 * 检查接口返回组合包状态、持有的资源、菜单、端点与平台能力；装卸接口按标识装载或卸载一个
 * 组合包。已装载组合包登记的端点也从这里分派，卸载之后同一个路径立即回到未命中。
 * @module @chatdsh/gateway/deploy/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import { CapabilityDeployment, DeploymentError, type RequestKind } from '@chatdsh/core-deployment';

/** 部署接口的路径前缀。 */
export const DEPLOYMENT_PREFIX = '/chatdsh/gateway/deployment';

/** 装卸接口的路径形状。 */
const BUNDLE_ACTION_PATH = /^\/chatdsh\/gateway\/deployment\/bundles\/([^/]+)\/(mount|unmount)$/;

/** 建立部署处理器的输入。 */
export interface DeploymentHandlerOptions {
  /** 组合包装卸与检查。 */
  readonly deployment: CapabilityDeployment;
  /** 遥测客户端。 */
  readonly telemetry: ChatdshTelemetry;
  /** 未命中的请求交给它。 */
  readonly fallback?: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
}

/** 部署处理器。 */
export interface DeploymentHandler {
  /** 处理一个请求；返回前已经写出响应。 */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** 请求分类：静态资源、SSE 与普通接口分开判定来源规则。 */
  kindOf(request: IncomingMessage): RequestKind;
}

/** 写一个 JSON 响应。 */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

/** 把失败映射成状态码与稳定错误码。 */
function sendFailure(response: ServerResponse, error: unknown): void {
  if (error instanceof DeploymentError) {
    sendJson(response, error.status, { error: error.code });
    return;
  }
  sendJson(response, 500, { error: 'internal' });
}

/**
 * 建立部署处理器。
 * @param options - 组合包部署、遥测与兜底处理。
 * @returns 处理器与请求分类。
 */
export function createDeploymentHandler(options: DeploymentHandlerOptions): DeploymentHandler {
  const { deployment } = options;

  function kindOf(request: IncomingMessage): RequestKind {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const method = request.method ?? 'GET';
    const endpoint = deployment.routeOf(method, path);
    if (endpoint?.transport === 'sse') return 'sse';
    if (method === 'GET' || method === 'HEAD') {
      if (path.startsWith('/assets/') || path === '/' || /\.(?:webmanifest|js|html|png|svg|css)$/.test(path)) {
        return 'static';
      }
    }
    return 'api';
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const method = request.method ?? 'GET';

    if (path === DEPLOYMENT_PREFIX) {
      if (method !== 'GET') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      sendJson(response, 200, deployment.inspect());
      return;
    }

    if (path === `${DEPLOYMENT_PREFIX}/capabilities`) {
      if (method !== 'GET') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      sendJson(response, 200, { capabilities: deployment.inspect().capabilities });
      return;
    }

    const action = BUNDLE_ACTION_PATH.exec(path);
    if (action !== null) {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      const bundleId = decodeURIComponent(action[1] ?? '');
      const verb = action[2];
      try {
        const state = verb === 'mount' ? await deployment.mount(bundleId) : await deployment.unmount(bundleId);
        sendJson(response, 200, { bundle: state, deployment: deployment.inspect() });
      } catch (error) {
        sendFailure(response, error);
      }
      return;
    }

    const endpoint = deployment.routeOf(method, path);
    if (endpoint !== undefined) {
      await endpoint.handle(request, response);
      return;
    }

    if (options.fallback !== undefined) {
      await options.fallback(request, response);
      return;
    }
    sendJson(response, 404, { error: 'not-found' });
  }

  return { handle, kindOf };
}
