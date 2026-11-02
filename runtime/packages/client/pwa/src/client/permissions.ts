/**
 * 浏览器权限的状态查询与请求。
 *
 * 通知、相机、麦克风与剪贴板逐项处理：先查状态，再由用户动作触发请求。查询区分已允许、
 * 已拒绝、尚未请求与不可用四种情况；拒绝时给出到浏览器站点设置的路径，不可用时说明缺少
 * 接口、设备或安全来源。请求全部由真实浏览器接口完成，权限结果只来自浏览器。
 * @module @chatdsh/client-pwa/permissions
 */

import type { PwaTelemetry } from './telemetry.ts';

/** 本包处理的权限项目。 */
export const PERMISSION_TARGETS = ['notifications', 'camera', 'microphone', 'clipboard'] as const;

/** 权限项目取值。 */
export type PermissionTarget = (typeof PERMISSION_TARGETS)[number];

/** 权限状态。 */
export type PermissionState = 'granted' | 'denied' | 'prompt' | 'unavailable';

/** 一项权限的中文名称。 */
export const PERMISSION_LABELS: Readonly<Record<PermissionTarget, string>> = {
  notifications: '通知',
  camera: '相机',
  microphone: '麦克风',
  clipboard: '剪贴板',
};

/** 被拒绝后前往浏览器设置修改的说明。 */
export const PERMISSION_GUIDANCE: Readonly<Record<PermissionTarget, string>> = {
  notifications: '在浏览器地址栏的站点设置里把“通知”改为允许，然后刷新页面。',
  camera: '在浏览器地址栏的站点设置里把“相机”改为允许，然后刷新页面。',
  microphone: '在浏览器地址栏的站点设置里把“麦克风”改为允许，然后刷新页面。',
  clipboard: '在浏览器地址栏的站点设置里把“剪贴板”改为允许；读取剪贴板还需要一次点击动作。',
};

/** 一项权限的状态、说明与设置指引。 */
export interface PermissionStatus {
  readonly target: PermissionTarget;
  readonly state: PermissionState;
  /** 当前状态的中文说明。 */
  readonly detail: string;
  /** 拒绝或不可用时的处理指引。 */
  readonly guidance?: string;
}

/** 权限客户端。 */
export interface PermissionClient {
  /** 查询一项权限。 */
  query(target: PermissionTarget): Promise<PermissionStatus>;
  /** 查询全部权限。 */
  queryAll(): Promise<PermissionStatus[]>;
  /** 请求一项权限；必须由用户动作触发。 */
  request(target: PermissionTarget): Promise<PermissionStatus>;
}

/** 权限客户端的构造依赖。 */
export interface PermissionClientOptions {
  /** 遥测面。 */
  readonly telemetry: PwaTelemetry;
  /** 浏览器导航对象；测试与宿主注入时使用。 */
  readonly navigator?: Navigator;
}

/** 权限查询返回的状态映射。 */
function stateOfPermission(value: PermissionState): PermissionState {
  return value;
}

/**
 * 查询浏览器权限接口里的一个名称。
 *
 * 浏览器可能不支持某个名称的查询，此时返回 `undefined`，由调用方说明状态未知；其他失败按
 * 真实错误上抛。
 * @param nav - 浏览器导航对象。
 * @param name - 权限名称。
 * @returns 已允许、已拒绝、尚未请求三者之一；查询不可用时为 `undefined`。
 */
async function queryBrowserPermission(nav: Navigator, name: string): Promise<PermissionState | undefined> {
  const permissions = nav.permissions;
  if (permissions === undefined) return undefined;
  try {
    const result = await permissions.query({ name } as unknown as PermissionDescriptor);
    if (result.state === 'granted' || result.state === 'denied' || result.state === 'prompt') {
      return stateOfPermission(result.state);
    }
    return undefined;
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

/** 状态对应的说明文字。 */
function detailOf(target: PermissionTarget, state: PermissionState): string {
  const label = PERMISSION_LABELS[target];
  if (state === 'granted') return `${label}权限已允许，可以直接使用。`;
  if (state === 'denied') return `${label}权限已被拒绝，浏览器不会再弹出提示。`;
  if (state === 'prompt') return `${label}权限尚未请求，点击请求后由浏览器询问。`;
  return `${label}权限当前不可用。`;
}

/**
 * 按状态补齐说明与指引。
 * @param target - 权限项目。
 * @param state - 权限状态。
 * @param unavailableDetail - 不可用时的具体原因。
 * @returns 完整的状态描述。
 */
function statusOf(target: PermissionTarget, state: PermissionState, unavailableDetail?: string): PermissionStatus {
  const detail = unavailableDetail ?? detailOf(target, state);
  if (state === 'denied') return { target, state, detail, guidance: PERMISSION_GUIDANCE[target] };
  if (state === 'unavailable') return { target, state, detail, guidance: PERMISSION_GUIDANCE[target] };
  return { target, state, detail };
}

/** 相机与麦克风可用的判定结果。 */
function mediaUnavailableReason(nav: Navigator): string | undefined {
  if (nav.mediaDevices === undefined || typeof nav.mediaDevices.getUserMedia !== 'function') {
    return '当前来源不支持相机与麦克风：需要 HTTPS 或本机地址，并且浏览器提供媒体设备接口。';
  }
  return undefined;
}

/**
 * 建立权限客户端。
 * @param options - 遥测面与浏览器对象。
 * @returns 权限客户端。
 */
export function createPermissionClient(options: PermissionClientOptions): PermissionClient {
  const nav = options.navigator ?? navigator;
  const telemetry = options.telemetry;

  /**
   * 查询通知权限。
   * @returns 状态描述。
   */
  const queryNotifications = async (): Promise<PermissionStatus> => {
    if (typeof Notification === 'undefined') {
      return statusOf('notifications', 'unavailable', '当前浏览器没有通知接口，通知权限无法查询。');
    }
    const permission = Notification.permission;
    const state: PermissionState = permission === 'default' ? 'prompt' : permission;
    return statusOf('notifications', state);
  };

  /**
   * 查询相机或麦克风权限。
   * @param target - 相机或麦克风。
   * @returns 状态描述。
   */
  const queryMedia = async (target: 'camera' | 'microphone'): Promise<PermissionStatus> => {
    const unavailable = mediaUnavailableReason(nav);
    if (unavailable !== undefined) return statusOf(target, 'unavailable', unavailable);
    const queried = await queryBrowserPermission(nav, target);
    if (queried === undefined) {
      return statusOf(target, 'prompt', '浏览器不提供该项权限的状态查询，请求时会弹出系统提示。');
    }
    return statusOf(target, queried);
  };

  /**
   * 查询剪贴板权限。
   * @returns 状态描述。
   */
  const queryClipboard = async (): Promise<PermissionStatus> => {
    if (nav.clipboard === undefined) {
      return statusOf('clipboard', 'unavailable', '当前来源没有剪贴板接口：需要 HTTPS 或本机地址。');
    }
    const queried = await queryBrowserPermission(nav, 'clipboard-read');
    if (queried === undefined) {
      return statusOf('clipboard', 'prompt', '浏览器不提供剪贴板权限的状态查询，使用时会弹出提示。');
    }
    return statusOf('clipboard', queried);
  };

  const query = async (target: PermissionTarget): Promise<PermissionStatus> => {
    if (target === 'notifications') return queryNotifications();
    if (target === 'camera') return queryMedia('camera');
    if (target === 'microphone') return queryMedia('microphone');
    return queryClipboard();
  };

  /**
   * 请求通知权限。
   * @returns 状态描述。
   */
  const requestNotifications = async (): Promise<PermissionStatus> => {
    if (typeof Notification === 'undefined') {
      return statusOf('notifications', 'unavailable', '当前浏览器没有通知接口，无法请求通知权限。');
    }
    const permission = await Notification.requestPermission();
    const state: PermissionState = permission === 'default' ? 'prompt' : permission;
    return statusOf('notifications', state);
  };

  /**
   * 请求相机或麦克风权限：打开设备后立刻停止轨道，权限结果由浏览器给出。
   * @param target - 相机或麦克风。
   * @returns 状态描述。
   */
  const requestMedia = async (target: 'camera' | 'microphone'): Promise<PermissionStatus> => {
    const unavailable = mediaUnavailableReason(nav);
    if (unavailable !== undefined) return statusOf(target, 'unavailable', unavailable);
    const constraints: MediaStreamConstraints = target === 'camera' ? { video: true } : { audio: true };
    let stream: MediaStream;
    try {
      stream = await nav.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      if (name === 'NotAllowedError' || name === 'SecurityError') return statusOf(target, 'denied');
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        return statusOf(target, 'unavailable', `没有找到可用的${PERMISSION_LABELS[target]}设备。`);
      }
      if (name === 'NotReadableError') {
        return statusOf(target, 'unavailable', `${PERMISSION_LABELS[target]}被其他程序占用，无法读取。`);
      }
      throw error;
    }
    for (const track of stream.getTracks()) track.stop();
    return statusOf(target, 'granted');
  };

  /**
   * 请求剪贴板读取权限。
   * @returns 状态描述。
   */
  const requestClipboard = async (): Promise<PermissionStatus> => {
    if (nav.clipboard === undefined) {
      return statusOf('clipboard', 'unavailable', '当前来源没有剪贴板接口，无法读取剪贴板。');
    }
    try {
      await nav.clipboard.readText();
      return statusOf('clipboard', 'granted');
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      if (name === 'NotAllowedError' || name === 'SecurityError') return statusOf('clipboard', 'denied');
      throw error;
    }
  };

  const request = async (target: PermissionTarget): Promise<PermissionStatus> => {
    try {
      const status = target === 'notifications'
        ? await requestNotifications()
        : target === 'camera'
          ? await requestMedia('camera')
          : target === 'microphone'
            ? await requestMedia('microphone')
            : await requestClipboard();
      const outcome = status.state === 'granted'
        ? 'ok'
        : status.state === 'denied'
          ? 'rejected'
          : status.state === 'unavailable'
            ? 'unavailable'
            : 'prompt';
      telemetry.action('permission-request', outcome);
      return status;
    } catch (error) {
      telemetry.failure('permission-request', error);
      throw error;
    }
  };

  return {
    async query(target: PermissionTarget): Promise<PermissionStatus> {
      const status = await query(target);
      const outcome = status.state === 'unavailable'
        ? 'unavailable'
        : status.state === 'prompt'
          ? 'prompt'
          : 'ok';
      telemetry.action('permission-query', outcome);
      return status;
    },

    async queryAll(): Promise<PermissionStatus[]> {
      const statuses: PermissionStatus[] = [];
      for (const target of PERMISSION_TARGETS) statuses.push(await query(target));
      telemetry.action('permission-query', 'ok');
      return statuses;
    },

    request,
  };
}
