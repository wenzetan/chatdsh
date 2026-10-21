// 联调桥：把客户端上下文里的 remote 对象暴露到全局，并挂载自建 Remote 服务的客户端贡献。
//
// 客户端模块图通过 `window.__ModuleLoader__.load({ id, factory })` 注册模块，factory
// 返回 CommonJS 的 module.exports。自建 Remote 服务没有 typert 生成器，这里手写最小
// descriptor：只需要参数与结果的 strict codec，客户端调用按 descriptor id 发 RPC。
// 只用于 e2e 联调 profile，不进入产品组合包。
window.__ModuleLoader__.load({
  id: '@chatdsh/e2e-client-remote-bridge',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const zod = require('zod');
    const stringCodec = { mode: 'strict', typeSymbol: 'string', create: () => zod.string() };
    const jsonCodec = { mode: 'strict', typeSymbol: 'json', create: () => zod.any() };

    /** 一个自建服务的 contribution。 */
    function contribution(service, methods) {
      const descriptors = Object.entries(methods).map(([endpoint, definition]) => ({
        id: `${service}#${endpoint}`,
        service,
        namespace: endpoint.slice(0, endpoint.indexOf('/')),
        method: endpoint.slice(endpoint.indexOf('/') + 1),
        invocation: { kind: 'direct' },
        parameters: definition.parameters.map((name) => ({ name, wire: name, source: 'json', codec: stringCodec })),
        result: jsonCodec,
      }));
      return { package: service, descriptors };
    }

    module.exports.inject = ['remote'];
    module.exports.apply = async function apply(ctx) {
      globalThis.__CHATDSH_BRIDGE_APPLIED__ = true;
      try {
        await ctx.remote.$mount(contribution('chatdshHermesChat', {
          'chatdshHermesChat/health': { parameters: [] },
          'chatdshHermesChat/send': { parameters: ['sessionId', 'text'] },
          'chatdshHermesChat/answerApproval': { parameters: ['runId', 'requestId', 'choice'] },
        }));
        globalThis.__CHATDSH_REMOTE__ = ctx.remote;
        globalThis.__CHATDSH_BRIDGE_ERROR__ = null;
        // 命名空间是注入点：直接读 remote.chatdshHermesChat 需要声明注入，
        // 这里用 ctx.inject 等命名空间就绪后把对象暴露给联调脚本。
        ctx.inject(['remote.chatdshHermesChat'], (remoteCtx) => {
          globalThis.__CHATDSH_NAMESPACE__ = remoteCtx.remote.chatdshHermesChat;
        });
      } catch (error) {
        globalThis.__CHATDSH_REMOTE__ = ctx.remote;
        globalThis.__CHATDSH_BRIDGE_ERROR__ = String(error);
      }
    };
    return module.exports;
  },
});
