/**
 * 桌面控制的同源 HTTP 入口。
 *
 * 界面按这些路径与宿主通信：读取状态、发起授权申请、逐项确认、执行动作、暂停、中断与查询
 * 审计。写操作要求带上 `x-chatdsh-csrf` 请求头，与既有客户端插件保持一致。控制平面把请求
 * 转给这里（路由挂在控制平面的接入由 WP39 完成）。
 * @module chatdsh-desktop-control/http
 */

/** 路由前缀。 */
export const CONTROL_PREFIX = '/chatdsh/desktop-control';

/** 请求体的上限。 */
const BODY_LIMIT = 64 * 1024;

/** 写操作要求的请求头。 */
const CSRF_HEADER = 'x-chatdsh-csrf';

/** 请求体不合法。 */
class BodyRejection extends Error {
  /**
   * @param code - 失败代码。
   * @param detail - 说明。
   */
  constructor(code, detail) {
    super(detail);
    this.code = code;
  }
}

/** 请求层面的拒绝，带固定状态码。 */
class HttpRejection extends Error {
  /**
   * @param code - 失败代码。
   * @param status - HTTP 状态码。
   * @param detail - 说明。
   */
  constructor(code, status, detail) {
    super(detail);
    this.code = code;
    this.status = status;
  }
}

/**
 * 读取并解析 JSON 请求体。
 * @param request - Node 请求对象。
 * @returns 解析后的对象。
 */
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new BodyRejection('body-too-large', `请求体超过 ${BODY_LIMIT} 字节`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BodyRejection('body-malformed', '请求体不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BodyRejection('body-type', '请求体需要对象');
  }
  return parsed;
}

/**
 * 写一个 JSON 响应。
 * @param response - Node 响应对象。
 * @param status - 状态码。
 * @param payload - 响应内容。
 */
function sendJson(response, status, payload) {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

/**
 * 状态码映射：参数错误回 400，状态冲突回 409。
 * @param code - 错误代码。
 * @returns HTTP 状态码。
 */
function statusOf(code) {
  const conflict = new Set([
    'lease-missing',
    'lease-paused',
    'lease-expired',
    'lease-interrupted',
    'lease-revoked',
    'lease-stale',
    'request-missing',
    'request-expired',
    'item-unknown',
    'permit-missing',
    'point-outside-scope',
    'platform-unsupported',
    'provider-missing',
  ]);
  return conflict.has(code) ? 409 : 400;
}

/**
 * 建立请求处理函数。
 * @param options.control - `createDesktopControl` 的返回值。
 * @param options.prefix - 路由前缀。
 * @returns 处理函数，返回 `true` 表示请求已经被接管。
 */
export function createControlHttpHandler({ control, prefix = CONTROL_PREFIX }) {
  if (control === undefined) throw new Error('需要桌面控制对象');
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;

  return async function handle(request, response) {
    if (typeof request.url !== 'string' || !request.url.startsWith(base)) return false;
    const url = new URL(request.url, 'http://127.0.0.1');
    const route = url.pathname.slice(base.length);
    const method = request.method ?? 'GET';

    const requireWrite = () => {
      if (method !== 'POST') throw new HttpRejection('method-not-allowed', 405, '需要 POST');
      if (request.headers[CSRF_HEADER] !== '1') throw new HttpRejection('csrf-missing', 403, '缺少来源校验头');
    };

    try {
      if (route === '/state' && method === 'GET') {
        sendJson(response, 200, { state: control.state() });
        return true;
      }
      if (route === '/audit' && method === 'GET') {
        const limit = url.searchParams.get('limit');
        const entries = control.auditEntries({ limit: limit === null ? 50 : Number.parseInt(limit, 10) });
        sendJson(response, 200, { entries });
        return true;
      }
      if (route === '/request') {
        requireWrite();
        const body = await readBody(request);
        const pending = control.beginRequest({
          scope: body.scope,
          durationMs: body.durationMs,
          purpose: body.purpose,
        });
        sendJson(response, 200, { pending });
        return true;
      }
      if (route === '/confirm') {
        requireWrite();
        const body = await readBody(request);
        const result = await control.confirm({
          requestId: body.requestId,
          itemId: body.itemId,
          confirmed: body.confirmed === true,
        });
        sendJson(response, 200, { result, state: control.state() });
        return true;
      }
      if (route === '/check-permissions') {
        requireWrite();
        await readBody(request);
        const permissions = await control.checkPermissions();
        sendJson(response, 200, { permissions, state: control.state() });
        return true;
      }
      if (route === '/action') {
        requireWrite();
        const body = await readBody(request);
        const permit = control.use({ action: body.action, point: body.point });
        sendJson(response, 200, {
          permit: {
            permitId: permit.permitId,
            leaseId: permit.leaseId,
            action: permit.action,
            expiresAt: permit.expiresAt,
          },
        });
        return true;
      }
      if (route === '/action/end') {
        requireWrite();
        const body = await readBody(request);
        const result = control.end({ permitId: body.permitId, outcome: body.outcome });
        sendJson(response, 200, { result, state: control.state() });
        return true;
      }
      if (route === '/pause') {
        requireWrite();
        const body = await readBody(request);
        sendJson(response, 200, { state: control.setPaused(body.paused === true) });
        return true;
      }
      if (route === '/interrupt') {
        requireWrite();
        const body = await readBody(request);
        sendJson(response, 200, { state: control.interrupt(body.reason) });
        return true;
      }
      if (route === '/revoke') {
        requireWrite();
        const body = await readBody(request);
        sendJson(response, 200, { state: control.revoke(body.reason) });
        return true;
      }
      sendJson(response, 404, { error: 'route-not-found' });
      return true;
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'control-failed';
      const status = typeof error?.status === 'number' ? error.status : statusOf(code);
      sendJson(response, status, { error: code, detail: error instanceof Error ? error.message : undefined });
      return true;
    }
  };
}
