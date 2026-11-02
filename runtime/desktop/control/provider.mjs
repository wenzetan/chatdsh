/**
 * 控制提供方的接口约定。
 *
 * 提供方完成三件事：报告能力、查询系统授权状态、发起系统授权请求。宿主在启动时把满足这份
 * 约定的实现交给控制模块；控制模块不自行加载提供方，避免在不受支持的平台触发原生库加载。
 * @module chatdsh-desktop-control/provider
 */

/** 提供方必须实现的方法。 */
export const PROVIDER_METHODS = Object.freeze(['capabilities', 'checkPermissions', 'requestPermissions']);

/** 提供方实现不符合约定。 */
export class ProviderRejection extends Error {
  /**
   * @param code - 拒绝原因代码。
   * @param detail - 说明。
   */
  constructor(code, detail) {
    super(detail === undefined ? `控制提供方不符合约定：${code}` : `控制提供方不符合约定：${code}（${detail}）`);
    this.name = 'ProviderRejection';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 核对提供方实现。
 * @param impl - 候选实现。
 * @returns 同一个实现。
 */
export function assertProvider(impl) {
  if (impl === null || typeof impl !== 'object') throw new ProviderRejection('provider-missing', '提供方必须是对象');
  if (typeof impl.name !== 'string' || impl.name === '') {
    throw new ProviderRejection('provider-name', '提供方需要给出名称');
  }
  for (const method of PROVIDER_METHODS) {
    if (typeof impl[method] !== 'function') {
      throw new ProviderRejection('provider-method', `提供方缺少方法 ${method}`);
    }
  }
  return impl;
}
