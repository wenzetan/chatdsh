// WP20 分享完整界面的验收辅助：真实 SQLite、真实分享域模块与真实附件目录。
//
// 这里只做装配与数据准备：分享领域用 `gateway/src/sharing/` 的真实实现，记录与快照存在真实
// SQLite 里，附件字节落在真实目录里，公开页由真实渲染函数生成。身份校验由测试按单用户控制
// 平面的约定给出：请求携带所有者 cookie，写动作还要求同源与 CSRF 请求头。

import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { ShareRepository } from '../../gateway/lib/sharing/repository.js';
import { ShareService } from '../../gateway/lib/sharing/service.js';
import { createShareHttpHandler } from '../../gateway/lib/sharing/http.js';
import { createDirectoryAttachmentSource } from '../../gateway/lib/sharing/attachments.js';

/** 第一份公开文本。 */
export const PUBLIC_TEXT_ONE = '第一回合的公开回复';
/** 第二份公开文本。 */
export const PUBLIC_TEXT_TWO = '第二回合的公开回复';
/** 第三份公开文本。 */
export const PUBLIC_TEXT_THREE = '第三回合的公开回复';
/** 记忆内容，不应出现在公开页。 */
export const PRIVATE_MEMORY = '记忆召回的内容不应出现';
/** 思考内容，不应出现在公开页。 */
export const PRIVATE_REASONING = '思考过程不应出现';
/** 工具结果原文，不应出现在公开页。 */
export const PRIVATE_TOOL_OUTPUT = '工具输出原文不应出现';
/** 内部路径，公开时会被替换成固定标记。 */
export const PRIVATE_PATH = '/workspace/private/notes/todo.md';
/** 凭据形态的文本，公开时会被替换成固定标记。 */
export const PRIVATE_CREDENTIAL = ['sk', 'wp20demo', '0123456789abcdef'].join('-');

/** 第一份附件。 */
export const ATTACHMENT_PUBLIC = {
  id: 'attach-report',
  filename: '排障报告-2026-11-01.txt',
  bytes: Buffer.from('第一份公开附件的内容\n第二行\n', 'utf8'),
};

/** 第二份附件。 */
export const ATTACHMENT_SECOND = {
  id: 'attach-photo',
  filename: '修图前的原图说明.txt',
  bytes: Buffer.from('第二份公开附件的内容\n', 'utf8'),
};

/** 只在事件里出现、源设备上没有内容的附件标识。 */
export const ATTACHMENT_MISSING_ID = 'attach-gone';

/** 一条副本事件。 */
export function eventOf(seq, time, kind, data) {
  return { seq, kind, time, bytes: 96, payload: { seq, type: kind, time, data } };
}

/**
 * 三个完整回合的会话：带附件引用、脱敏材料与应当被排除的事件。
 * @param {number} base - 起始时间戳。
 * @returns {object[]} 副本事件。
 */
export function buildEvents(base) {
  const events = [];
  let seq = 0;
  const push = (kind, time, data) => {
    events.push(eventOf(seq, base + time, kind, data));
    seq += 1;
  };
  push('session/title', 0, { title: 'WP20 分享验收会话' });
  push('turn/start', 1, { turn: 1 });
  push('user/message', 2, {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: `看一下 ${PRIVATE_PATH} 的失败日志，token=${PRIVATE_CREDENTIAL}` }],
  });
  push('assistant/message', 3, { message: { content: [{ type: 'text', text: PUBLIC_TEXT_ONE }] } });
  push('assistant/reasoning', 4, { text: PRIVATE_REASONING });
  push('tool/call', 5, { name: 'shell', arguments: { command: 'cat secrets.txt' }, callId: 'call-1' });
  push('tool/result', 6, { callId: 'call-1', output: PRIVATE_TOOL_OUTPUT });
  push('user/message', 7, {
    role: 'user',
    source: { kind: 'memory-recall' },
    content: [{ type: 'text', text: PRIVATE_MEMORY }],
  });
  push('turn/end', 8, { turn: 1, reason: { kind: 'completed' } });
  push('turn/start', 9, { turn: 2 });
  push('user/message', 10, {
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: '第二回合的提问，附带排障报告' },
      { type: 'file', attachment: { attachmentId: ATTACHMENT_PUBLIC.id, filename: ATTACHMENT_PUBLIC.filename, mimeType: 'text/plain; charset=utf-8', size: ATTACHMENT_PUBLIC.bytes.byteLength } },
    ],
  });
  push('assistant/message', 11, { message: { content: [{ type: 'text', text: PUBLIC_TEXT_TWO }] } });
  push('turn/end', 12, { turn: 2, reason: { kind: 'completed' } });
  push('turn/start', 13, { turn: 3 });
  push('user/message', 14, {
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: '第三回合的提问，附带两份文件' },
      { type: 'file', attachment: { attachmentId: ATTACHMENT_SECOND.id, filename: ATTACHMENT_SECOND.filename, size: ATTACHMENT_SECOND.bytes.byteLength } },
      { type: 'file', attachment: { attachmentId: ATTACHMENT_MISSING_ID, filename: '已被清理的附件.txt', size: 12 } },
    ],
  });
  push('assistant/message', 15, { message: { content: [{ type: 'text', text: PUBLIC_TEXT_THREE }] } });
  push('turn/end', 16, { turn: 3, reason: { kind: 'completed' } });
  return events;
}

/**
 * 把一份附件按宿主的目录布局写进源附件目录。
 * @param {string} root - 源附件根目录。
 * @param {{id: string, filename: string, bytes: Buffer}} attachment - 附件。
 */
export async function writeAttachment(root, attachment) {
  const directory = join(root, attachment.id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, attachment.filename), attachment.bytes);
}

/** 从 Cookie 头取一个值。 */
function cookieOf(header, name) {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

/**
 * 单用户控制平面的所有者校验。
 * @param {object} options - cookie 名称与取值、来源地址取值函数。
 * @returns {(request: import('node:http').IncomingMessage, action: 'read' | 'write') => {deviceId: string} | undefined}
 */
export function ownerAuthorize(options) {
  const cookieName = options.cookieName;
  const cookieValue = options.cookieValue;
  return (request, action) => {
    const origin = options.getOrigin();
    if (action === 'write') {
      if (request.headers.origin !== origin) return undefined;
      if (request.headers['x-chatdsh-csrf'] !== '1') return undefined;
    }
    if (cookieOf(request.headers.cookie, cookieName) !== cookieValue) return undefined;
    return { deviceId: 'owner-device' };
  };
}

/**
 * 装配分享域的真实 HTTP 服务。
 * @param {object} options - 存储、副本、遥测、数据目录与所有者校验。
 * @returns {Promise<object>} 服务、来源地址与关闭函数。
 */
export async function startShareDomain(options) {
  const sharesRoot = join(options.home, 'shares');
  const attachmentsRoot = join(options.home, 'attachments');
  await mkdir(sharesRoot, { recursive: true });
  await mkdir(attachmentsRoot, { recursive: true });
  const repository = new ShareRepository(options.store.handle());
  const service = new ShareService({
    repository,
    replica: options.replica,
    attachments: createDirectoryAttachmentSource({ root: attachmentsRoot }),
    telemetry: options.telemetry,
    sharesRoot,
  });
  let origin = '';
  const handler = createShareHttpHandler({
    service,
    telemetry: options.telemetry,
    authorize: options.authorize,
  });
  const server = createServer(async (request, response) => {
    if (await handler(request, response)) return;
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'object-not-found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    sharesRoot,
    attachmentsRoot,
    repository,
    service,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
