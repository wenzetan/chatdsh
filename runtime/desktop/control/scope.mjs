/**
 * 桌面控制的作用范围。
 *
 * 范围只有两种：一块屏幕区域，或者一个目标窗口。区域按显示标识、左上角坐标与宽高描述，
 * 动作坐标必须落在区域之内；窗口按应用标识与窗口句柄描述。范围在申请授权时确定，租约期间
 * 不再扩大。
 * @module chatdsh-desktop-control/scope
 */

/** 范围种类。 */
export const SCOPE_KINDS = Object.freeze(['region', 'window']);

/** 坐标与尺寸的上限，防止出现无法理解的取值。 */
const LIMIT = 100_000;

/** 作用范围不合法。 */
export class ScopeRejection extends Error {
  /**
   * @param code - 拒绝原因代码。
   * @param detail - 说明。
   */
  constructor(code, detail) {
    super(detail === undefined ? `作用范围不合法：${code}` : `作用范围不合法：${code}（${detail}）`);
    this.name = 'ScopeRejection';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 校验一个整数取值。
 * @param value - 候选值。
 * @param code - 失败代码。
 * @param min - 下限。
 * @param max - 上限。
 */
function integerField(value, code, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ScopeRejection(code, '需要整数');
  if (value < min || value > max) throw new ScopeRejection(code, `取值范围 ${min}..${max}`);
  return value;
}

/**
 * 校验一个非空文本字段。
 * @param value - 候选值。
 * @param code - 失败代码。
 * @param maxLength - 长度上限。
 */
function textField(value, code, maxLength) {
  if (typeof value !== 'string' || value.trim() === '') throw new ScopeRejection(code, '需要非空文本');
  if (value.length > maxLength) throw new ScopeRejection(code, `长度上限 ${maxLength}`);
  return value;
}

/**
 * 规范化作用范围。
 * @param input - 原始范围。
 * @returns 冻结后的范围。
 */
export function normalizeScope(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ScopeRejection('scope-missing', '需要作用范围对象');
  }
  if (!SCOPE_KINDS.includes(input.kind)) {
    throw new ScopeRejection('scope-kind', `种类只能是 ${SCOPE_KINDS.join(' 或 ')}`);
  }
  if (input.kind === 'region') {
    return Object.freeze({
      kind: 'region',
      displayId: textField(input.displayId, 'display-id', 64),
      x: integerField(input.x, 'region-x', -LIMIT, LIMIT),
      y: integerField(input.y, 'region-y', -LIMIT, LIMIT),
      width: integerField(input.width, 'region-width', 1, LIMIT),
      height: integerField(input.height, 'region-height', 1, LIMIT),
    });
  }
  return Object.freeze({
    kind: 'window',
    applicationId: textField(input.applicationId, 'application-id', 128),
    windowId: textField(input.windowId, 'window-id', 128),
  });
}

/**
 * 范围的一句话说明。
 * @param scope - 规范化之后的范围。
 * @returns 说明文本。
 */
export function describeScope(scope) {
  if (scope.kind === 'region') {
    return `屏幕区域 ${scope.width}×${scope.height}，左上角 (${scope.x}, ${scope.y})，显示器 ${scope.displayId}`;
  }
  return `目标窗口 应用 ${scope.applicationId}，窗口 ${scope.windowId}`;
}

/**
 * 判定一个坐标是否落在范围之内。窗口范围不限制坐标，由目标窗口自身决定。
 * @param scope - 规范化之后的范围。
 * @param point - 屏幕坐标。
 * @returns 是否允许。
 */
export function scopeAllowsPoint(scope, point) {
  if (scope.kind === 'window') return true;
  if (typeof point !== 'object' || point === null) throw new ScopeRejection('point-missing', '需要坐标对象');
  const withinX = point.x >= scope.x && point.x < scope.x + scope.width;
  const withinY = point.y >= scope.y && point.y < scope.y + scope.height;
  return withinX && withinY;
}

/**
 * 范围是否需要在授权期间保持不变。
 * @param first - 一个范围。
 * @param second - 另一个范围。
 * @returns 是否等价。
 */
export function sameScope(first, second) {
  if (first.kind !== second.kind) return false;
  return Object.keys(first).every((key) => first[key] === second[key]);
}
