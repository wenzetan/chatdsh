// 联调桥：把客户端上下文里的 remote 对象暴露到全局。
//
// 客户端模块图通过 `window.__ModuleLoader__.load({ id, factory })` 注册模块，factory
// 返回 CommonJS 的 module.exports。只用于 e2e 联调 profile，不进入产品组合包。
window.__ModuleLoader__.load({
  id: '@chatdsh/e2e-client-remote-bridge',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    module.exports.inject = ['remote'];
    module.exports.apply = function apply(ctx) {
      globalThis.__CHATDSH_BRIDGE_APPLIED__ = true;
      try {
        globalThis.__CHATDSH_REMOTE__ = ctx.remote;
        globalThis.__CHATDSH_CLIENT_KEYS__ = Object.keys(ctx).sort();
      } catch (error) {
        globalThis.__CHATDSH_BRIDGE_ERROR__ = String(error);
      }
    };
    return module.exports;
  },
});
