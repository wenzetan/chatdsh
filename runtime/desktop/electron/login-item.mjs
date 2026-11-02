/**
 * 开机启动设置。
 *
 * 只有 Windows 与 macOS 支持登记开机启动；其他平台如实报告不支持，并给出替代说明。
 * 设置项与失败说明都在这里计算，主进程负责调用系统接口。
 * @module chatdsh-desktop-shell/login-item
 */

/** 一次开机启动设置被拒绝。 */
export class LoginRejection extends Error {
  /**
   * @param code - 拒绝原因代码。
   * @param detail - 说明文本。
   */
  constructor(code, detail) {
    super(detail === undefined ? `开机启动拒绝：${code}` : `开机启动拒绝：${code}（${detail}）`);
    this.name = 'LoginRejection';
    this.code = code;
    this.detail = detail;
  }
}

/** 支持开机启动登记的平台。 */
const SUPPORTED = new Set(['win32', 'darwin']);

/** 开机启动时附加的启动参数。 */
export const LOGIN_ARGUMENTS = Object.freeze(['--launch-at-login']);

/**
 * 判定平台是否支持开机启动。
 * @param platform - 运行平台。
 * @returns 支持标记与说明。
 */
export function loginSupport(platform) {
  if (SUPPORTED.has(platform)) return { supported: true, hint: '' };
  return {
    supported: false,
    hint: '当前平台不支持登记开机启动，请在桌面环境的自启动设置里手动添加',
  };
}

/**
 * 计算要交给系统接口的设置。
 * @param options - 开关、平台、可执行文件路径。
 * @returns 系统接口需要的设置对象。
 */
export function loginItemSettings(options) {
  const platform = options.platform ?? process.platform;
  const support = loginSupport(platform);
  if (!support.supported) throw new LoginRejection('platform-unsupported', support.hint);
  const enabled = options.enabled === true;
  const settings = { openAtLogin: enabled };
  if (enabled) {
    if (platform === 'win32') {
      const executablePath = options.executablePath;
      if (typeof executablePath !== 'string' || executablePath === '') {
        throw new LoginRejection('path-missing', '缺少可执行文件路径');
      }
      settings.path = executablePath;
      settings.args = [...LOGIN_ARGUMENTS];
    } else {
      settings.openAsHidden = true;
    }
  }
  return settings;
}

/**
 * 开机启动失败的说明文案。
 * @param code - 失败原因代码。
 * @returns 说明文本。
 */
export function describeLoginFailure(code) {
  const hints = {
    'platform-unsupported': '当前平台不支持登记开机启动',
    'path-missing': '无法定位程序路径，开机启动没有写入',
    'settings-write-failed': '系统拒绝了开机启动设置，可能在策略里被禁用',
    'status-mismatch': '系统返回的开机启动状态与设置不一致',
  };
  return hints[code] ?? '开机启动设置没有生效';
}
