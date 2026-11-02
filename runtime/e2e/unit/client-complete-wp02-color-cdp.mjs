import assert from 'node:assert/strict';
import { once } from 'node:events';

export async function connectMeasurementSession(cli, pageUrl) {
  const endpoint = await cli('get', 'cdp-url');
  const url = endpoint.data.cdpUrl;
  assert.equal(typeof url, 'string', `CDP 地址返回结构：${JSON.stringify(endpoint)}`);
  const socket = new WebSocket(url);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data);
    const request = pending.get(response.id);
    if (request === undefined) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error !== undefined) request.reject(new Error(`CDP ${request.method}：${JSON.stringify(response.error)}`));
    else request.resolve(response.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 命令超时：${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer, method });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
  });
  try {
    const { targetInfos } = await send('Target.getTargets');
    const target = targetInfos.find((entry) => entry.type === 'page' && entry.url === pageUrl);
    assert.ok(target, '测量连接必须属于当前 agent-browser 页面');
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const { domains } = await send('Schema.getDomains', {}, sessionId);
    assert.ok(domains.some((domain) => domain.name === 'Emulation'), '当前浏览器会话需要支持 Emulation');
    return {
      media: (features) => send('Emulation.setEmulatedMedia', { features }, sessionId),
      close: async () => {
        await send('Target.detachFromTarget', { sessionId });
        socket.close();
        await once(socket, 'close');
      },
    };
  } catch (error) {
    socket.close();
    await once(socket, 'close');
    throw error;
  }
}
