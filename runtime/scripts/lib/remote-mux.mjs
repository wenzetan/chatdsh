/**
 * 经中继 `/d/<deviceId>/api/remote.mux` 的真实 WebSocket 探测。
 *
 * 升级状态用原始 HTTP 客户端读取，便于断言 409 与 403 的状态行与 JSON 错误码；
 * 双向收发用 Node 内置 WebSocket，向真实运行时的 Remote mux 发一个未知端点的 open，
 * 期待同一 `streamId` 的 error 帧回来。
 */

import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';

/**
 * 发一次 WebSocket 升级请求。
 * @param {string} url - `http` 或 `https` 地址。
 * @param {Record<string, string>} [headers] - 额外请求头。
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function upgradeStatus(url, headers = {}) {
  const target = new URL(url);
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
        ...headers,
      },
      agent: false,
    });
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode ?? 0, body: '' });
    });
    request.on('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * 经中继打开 Remote mux，完成一次请求与回帧。
 * @param {string} base - 中继根地址，例如 `http://127.0.0.1:3170`。
 * @param {string} deviceId - 目标设备标识。
 * @param {number} [timeoutMs] - 等待回帧的时长。
 * @returns {Promise<Record<string, unknown>>} 同一 `streamId` 的回帧。
 */
export async function probeRemoteMux(base, deviceId, timeoutMs = 10_000) {
  const url = `${base.replace(/^http/, 'ws')}/d/${encodeURIComponent(deviceId)}/api/remote.mux`;
  const streamId = 'chatdsh-probe';
  const socket = new WebSocket(url);
  const closed = new Promise((resolve) => socket.addEventListener('close', resolve));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', () => reject(new Error('WebSocket 升级失败')));
  });
  try {
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 Remote mux 回帧超时')), timeoutMs);
      timer.unref();
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const frame = JSON.parse(event.data);
        if (frame.streamId !== streamId) return;
        clearTimeout(timer);
        resolve(frame);
      });
    });
    socket.send(JSON.stringify({
      type: 'open',
      streamId,
      endpoint: '__chatdsh_probe__/missing',
      payload: {},
    }));
    return await reply;
  } finally {
    socket.close();
    await closed;
  }
}
