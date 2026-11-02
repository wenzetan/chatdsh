/**
 * 系统通知桥。
 *
 * 通知只转发已经发生的业务事实，权限状态按系统返回值如实报告。点击通知回到对应业务
 * 页面，路径在放行前缀之内，并且只拼在当前运行时的地址后面。
 * @module chatdsh-desktop-shell/notifications
 */

/** 通知类别。 */
export const NOTIFICATION_KINDS = Object.freeze(['approval', 'turn-complete', 'failure', 'update']);

/** 允许从通知跳转的页面前缀。 */
const ROUTE_PREFIXES = Object.freeze(['/sessions', '/approvals', '/settings', '/diagnostics', '/devices', '/workspaces']);

/** 一次通知请求被拒绝。 */
export class NotificationRejection extends Error {
  /**
   * @param code - 拒绝原因代码。
   * @param detail - 说明文本。
   */
  constructor(code, detail) {
    super(detail === undefined ? `通知拒绝：${code}` : `通知拒绝：${code}（${detail}）`);
    this.name = 'NotificationRejection';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 报告通知能力状态。
 *
 * Windows 与 Linux 的系统通知不单独授权，只要系统接口可用就算可投递；macOS 需要用户在
 * 系统设置里授权，未授权时如实报告，不返回成功。
 * @param context - 平台、系统接口是否可用、系统授权状态。
 * @returns 状态与说明。
 */
export function notificationCapability(context = {}) {
  const platform = context.platform ?? process.platform;
  if (context.isSupported !== true) {
    return { status: 'unsupported', reason: 'unsupported-platform', detail: '当前系统不支持桌面通知' };
  }
  if (platform !== 'darwin') return { status: 'granted', reason: 'system-default', detail: '' };
  const permission = context.permission ?? 'not-determined';
  if (permission === 'granted') return { status: 'granted', reason: 'system-granted', detail: '' };
  if (permission === 'denied') {
    return { status: 'denied', reason: 'system-denied', detail: '系统设置里关闭了 ChatDSH 的通知' };
  }
  return { status: 'denied', reason: 'not-requested', detail: '还没有在系统设置里允许 ChatDSH 发送通知' };
}

/**
 * 校验一条通知请求。
 * @param raw - 类别、标题、正文与跳转路径。
 * @returns 校验后的请求。
 */
export function assertNotificationRequest(raw) {
  if (raw === null || typeof raw !== 'object') throw new NotificationRejection('request-invalid', '请求不是对象');
  if (!NOTIFICATION_KINDS.includes(raw.kind)) throw new NotificationRejection('kind-unknown', `未知类别 ${raw.kind}`);
  if (typeof raw.title !== 'string' || raw.title.trim() === '' || raw.title.length > 120) {
    throw new NotificationRejection('title-invalid', '标题为空或过长');
  }
  if (typeof raw.body !== 'string' || raw.body.length > 320) {
    throw new NotificationRejection('body-invalid', '正文过长');
  }
  return {
    kind: raw.kind,
    title: raw.title.trim(),
    body: raw.body,
    route: assertRoute(raw.route),
  };
}

/**
 * 校验跳转路径。
 * @param route - 以斜杠开头的站内路径。
 * @returns 校验后的路径。
 */
export function assertRoute(route) {
  if (typeof route !== 'string' || !route.startsWith('/')) {
    throw new NotificationRejection('route-invalid', '路径必须以斜杠开头');
  }
  if (route.includes('..') || route.includes('//') || route.includes('\\')) {
    throw new NotificationRejection('route-invalid', '路径里不允许出现上级目录或双斜杠');
  }
  if (/[\u0000-\u001f]/u.test(route)) throw new NotificationRejection('route-invalid', '路径里有控制字符');
  if (route.length > 200) throw new NotificationRejection('route-invalid', '路径过长');
  const allowed = ROUTE_PREFIXES.some((prefix) => route === prefix || route.startsWith(`${prefix}/`));
  if (!allowed) throw new NotificationRejection('route-not-allowed', '路径不在允许的业务页面内');
  return route;
}

/**
 * 把站内路径拼到运行时地址后面。
 * @param route - 站内路径。
 * @param bootUrl - 主窗口当前加载的地址。
 * @returns 可直接加载的地址，业务路径进入地址的片段部分。
 */
export function routeToUrl(route, bootUrl) {
  const path = assertRoute(route);
  if (typeof bootUrl !== 'string' || bootUrl === '') throw new NotificationRejection('boot-url-missing', '运行时地址还没有就绪');
  const base = bootUrl.split('#')[0];
  return `${base}#${path}`;
}

/**
 * 通知失败的说明文案。
 * @param code - 失败原因代码。
 * @returns 说明文本。
 */
export function describeNotificationFailure(code) {
  const hints = {
    'unsupported-platform': '当前系统不支持桌面通知',
    'system-denied': '系统设置里关闭了通知权限',
    'not-requested': '尚未授权通知，请在系统设置里允许',
    'route-not-allowed': '通知关联的页面不在允许范围内',
  };
  return hints[code] ?? '通知没有发出';
}
