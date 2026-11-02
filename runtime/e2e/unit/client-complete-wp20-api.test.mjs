// WP20 分享完整界面的数据面验收：真实 SQLite、真实分享域模块与真实附件目录。
//
// 分享客户端的数据入口（`packages/client/share/lib/client/gateway.js`）直接请求按 WP19
// `createShareHttpHandler` 装配的真实 HTTP 服务：记录与快照写在真实 SQLite 里，附件字节写在
// 真实目录里，公开页由真实渲染函数生成。这里核对四种范围、逐项附件授权、预览与公开页一致、
// 记录统计与失效结论。
//
// 运行：node --test e2e/unit/client-complete-wp20-api.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { allocateIndependentHome, releaseIndependentHome } from '../lib/environment.mjs';
import { GatewayStore, ReplicaStore } from '../../gateway/lib/store.js';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import { createShareGateway, ShareCallError } from '../../packages/client/share/lib/client/gateway.js';
import { availabilityOf, statsOf, turnRangesOf } from '../../packages/client/share/lib/client/share.js';
import {
  ATTACHMENT_PUBLIC,
  ATTACHMENT_SECOND,
  ATTACHMENT_MISSING_ID,
  PRIVATE_CREDENTIAL,
  PRIVATE_MEMORY,
  PRIVATE_PATH,
  PRIVATE_REASONING,
  PRIVATE_TOOL_OUTPUT,
  PUBLIC_TEXT_ONE,
  PUBLIC_TEXT_THREE,
  buildEvents,
  ownerAuthorize,
  startShareDomain,
  writeAttachment,
} from './client-complete-wp20-support.mjs';

const BASE = Date.UTC(2026, 10, 1, 12, 0, 0);

/** 起一套真实分享域与分享客户端数据入口。 */
async function start() {
  const home = allocateIndependentHome('wp20-api');
  const store = new GatewayStore(join(home, 'gateway.sqlite'));
  const replica = new ReplicaStore(store.handle());
  const events = buildEvents(BASE);
  store.upsertSession({ sessionId: 'session-wp20', deviceId: 'device-alpha', cwd: '/workspace/wp20', kind: 'work', createdAt: BASE });
  replica.append('session-wp20', events);
  const actions = [];
  const telemetry = createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
  const cookieName = 'chatdsh-owner';
  const cookieValue = randomBytes(16).toString('hex');
  const domain = await startShareDomain({
    home,
    store,
    replica,
    telemetry,
    authorize: ownerAuthorize({ cookieName, cookieValue, getOrigin: () => domain.origin }),
  });
  await writeAttachment(domain.attachmentsRoot, ATTACHMENT_PUBLIC);
  await writeAttachment(domain.attachmentsRoot, ATTACHMENT_SECOND);
  const gateway = createShareGateway({
    origin: domain.origin,
    telemetry: { action: (action, outcome) => actions.push({ action, outcome }) },
    fetch: (input, init) => globalThis.fetch(input, {
      ...init,
      headers: { ...(init?.headers ?? {}), cookie: `${cookieName}=${cookieValue}`, origin: domain.origin },
    }),
  });
  const turns = turnRangesOf(events);
  return {
    home,
    store,
    replica,
    domain,
    gateway,
    events,
    turns,
    actions,
    async page(path) {
      const response = await fetch(`${domain.origin}${path}`, { headers: { accept: 'text/html', cookie: `${cookieName}=${cookieValue}` } });
      return { status: response.status, html: await response.text() };
    },
    async close() {
      await domain.close();
      store.close();
      releaseIndependentHome(home);
    },
  };
}

/** 完整的公开选择。 */
const FULL_TEXT = { includeUserText: true, includeAssistantText: true };

test('预览覆盖四种范围，回合清单与回合编号来自服务端解析', async () => {
  const app = await start();
  try {
    const session = await app.gateway.preview({ sessionId: 'session-wp20', range: { mode: 'session' }, ...FULL_TEXT, attachmentIds: [] });
    assert.deepEqual(session.turns, [1, 2, 3]);
    assert.equal(session.title, 'WP20 分享验收会话');
    assert.equal(session.scope.turnFrom, 1);
    assert.equal(session.scope.turnTo, 3);
    assert.ok(session.messageCount >= 6, `会话全部的公开消息数：${session.messageCount}`);
    assert.deepEqual([...session.excluded].sort(), ['internal-paths', 'memory-recall', 'replica-watermark', 'sensitive-metadata', 'tool-arguments']);
    assert.ok(session.redactions.paths >= 1, '内部路径应当有脱敏计数');
    assert.ok(session.redactions.credentials >= 1, '凭据应当有脱敏计数');

    const turns = await app.gateway.preview({ sessionId: 'session-wp20', range: { mode: 'turns', turns: [2] }, ...FULL_TEXT, attachmentIds: [] });
    assert.deepEqual(turns.turns, [2]);
    assert.equal(turns.scope.turnFrom, 2);
    assert.equal(turns.scope.turnTo, 2);

    const range = await app.gateway.preview({ sessionId: 'session-wp20', range: { mode: 'range', turnFrom: 1, turnTo: 2 }, ...FULL_TEXT, attachmentIds: [] });
    assert.deepEqual(range.turns, [1, 2]);
    assert.equal(range.scope.turnFrom, 1);
    assert.equal(range.scope.turnTo, 2);

    const secondEnd = app.turns.find((turn) => turn.turn === 2);
    assert.ok(secondEnd !== undefined);
    const bound = await app.gateway.preview({ sessionId: 'session-wp20', range: { mode: 'bound', upToSeq: secondEnd.endSeq }, ...FULL_TEXT, attachmentIds: [] });
    assert.deepEqual(bound.turns, [1, 2]);

    await assert.rejects(
      app.gateway.preview({ sessionId: 'session-wp20', range: { mode: 'turns', turns: [9] }, ...FULL_TEXT, attachmentIds: [] }),
      (error) => {
        assert.ok(error instanceof ShareCallError);
        assert.equal(error.code, 'request-invalid');
        assert.equal(error.reason, 'turn-unknown');
        assert.match(error.message, /回合/);
        return true;
      },
    );

    await assert.rejects(
      app.gateway.preview({ sessionId: 'session-wp20', range: { mode: 'session' }, includeUserText: false, includeAssistantText: false, attachmentIds: [] }),
      (error) => {
        assert.match(error.message, /至少要公开用户消息或助手消息中的一种/);
        return true;
      },
    );
  } finally {
    await app.close();
  }
});

test('附件逐项授权：预览标出可下载，建立只复制勾选的附件', async () => {
  const app = await start();
  try {
    const preview = await app.gateway.preview({
      sessionId: 'session-wp20',
      range: { mode: 'session' },
      ...FULL_TEXT,
      attachmentIds: [ATTACHMENT_PUBLIC.id, ATTACHMENT_SECOND.id, ATTACHMENT_MISSING_ID],
    });
    const byId = new Map(preview.attachments.map((attachment) => [attachment.id, attachment]));
    assert.equal(byId.get(ATTACHMENT_PUBLIC.id)?.downloadable, true);
    assert.equal(byId.get(ATTACHMENT_PUBLIC.id)?.filename, ATTACHMENT_PUBLIC.filename);
    assert.equal(byId.get(ATTACHMENT_SECOND.id)?.downloadable, true);
    assert.equal(byId.get(ATTACHMENT_MISSING_ID)?.downloadable, false, '源设备上没有内容的附件标为不可下载');

    await assert.rejects(
      app.gateway.create({
        sessionId: 'session-wp20',
        range: { mode: 'session' },
        ...FULL_TEXT,
        attachmentIds: [ATTACHMENT_PUBLIC.id, ATTACHMENT_MISSING_ID],
      }),
      (error) => {
        assert.equal(error.code, 'attachment-missing');
        assert.match(error.message, /附件/);
        return true;
      },
    );

    const created = await app.gateway.create({
      sessionId: 'session-wp20',
      range: { mode: 'session' },
      ...FULL_TEXT,
      attachmentIds: [ATTACHMENT_PUBLIC.id],
      ttlMs: 24 * 60 * 60 * 1000,
    });
    assert.equal(created.status, 'active');
    assert.equal(created.attachments.length, 1);
    assert.equal(created.attachments[0]?.filename, ATTACHMENT_PUBLIC.filename);
    assert.ok(created.bytes >= ATTACHMENT_PUBLIC.bytes.byteLength, '占用字节包含附件副本');

    const page = await app.page(created.path);
    assert.equal(page.status, 200);
    assert.match(page.html, new RegExp(ATTACHMENT_PUBLIC.filename));
    assert.doesNotMatch(page.html, new RegExp(ATTACHMENT_SECOND.filename), '未勾选的附件不出现在公开页');
    const download = await fetch(`${app.domain.origin}${created.path}/attachments/${ATTACHMENT_PUBLIC.id}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-disposition')?.includes('attachment'), true);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), ATTACHMENT_PUBLIC.bytes);
    const denied = await fetch(`${app.domain.origin}${created.path}/attachments/${ATTACHMENT_SECOND.id}`);
    assert.equal(denied.status, 404, '未授权的附件按路径猜测也读不到');
  } finally {
    await app.close();
  }
});

test('预览与公开页结果一致：条数、回合范围、脱敏标记与附件清单都对得上', async () => {
  const app = await start();
  try {
    const selection = { includeUserText: true, includeAssistantText: true, attachmentIds: [ATTACHMENT_SECOND.id] };
    const range = { mode: 'range', turnFrom: 1, turnTo: 3 };
    const preview = await app.gateway.preview({ sessionId: 'session-wp20', range, ...selection });
    const created = await app.gateway.create({ sessionId: 'session-wp20', range, ...selection });
    const page = await app.page(created.path);
    assert.equal(page.status, 200);
    const rendered = page.html.match(/<article class="message">/g) ?? [];
    assert.equal(rendered.length, preview.messageCount, '公开页消息条数与预览一致');
    assert.equal(preview.attachments.length, 1);
    assert.match(page.html, new RegExp(ATTACHMENT_SECOND.filename));
    assert.match(page.html, /回合 1–3/);
    assert.match(page.html, new RegExp(PUBLIC_TEXT_ONE));
    assert.match(page.html, new RegExp(PUBLIC_TEXT_THREE));
    assert.equal(page.html.includes(PRIVATE_MEMORY), false, '记忆内容不进入公开页');
    assert.equal(page.html.includes(PRIVATE_REASONING), false, '思考内容不进入公开页');
    assert.equal(page.html.includes(PRIVATE_TOOL_OUTPUT), false, '工具结果原文不进入公开页');
    assert.equal(page.html.includes(PRIVATE_PATH), false, '内部路径不进入公开页');
    assert.equal(page.html.includes(PRIVATE_CREDENTIAL), false, '凭据不进入公开页');
    assert.match(page.html, /\[路径已隐藏\]/);
    assert.match(page.html, /\[凭据已隐藏\]/);
    assert.doesNotMatch(page.html, /<script/iu);
    assert.doesNotMatch(page.html, /<input|<textarea|<select|<button/iu);
    assert.match(page.html, /只读快照/);
    assert.equal(page.html.includes('watermark'), false, '公开页不出现副本水位');
    assert.equal(page.html.includes('"seq"'), false, '公开页不出现事件序号');
  } finally {
    await app.close();
  }
});

test('记录与统计：状态、剩余有效期、访问次数、占用字节与总量', async () => {
  const app = await start();
  try {
    const first = await app.gateway.create({
      sessionId: 'session-wp20',
      range: { mode: 'turns', turns: [1] },
      ...FULL_TEXT,
      attachmentIds: [ATTACHMENT_PUBLIC.id],
      ttlMs: 60_000,
    });
    const second = await app.gateway.create({
      sessionId: 'session-wp20',
      range: { mode: 'session' },
      ...FULL_TEXT,
      attachmentIds: [],
    });
    assert.equal((await app.page(first.path)).status, 200);
    assert.equal((await app.page(first.path)).status, 200);

    const list = await app.gateway.shares();
    assert.equal(list.shares.length, 2);
    const stored = new Map(list.shares.map((record) => [record.shareId, record]));
    assert.equal(stored.get(first.shareId)?.visits, 2, '公开页访问两次');
    assert.ok((stored.get(first.shareId)?.bytes ?? 0) >= ATTACHMENT_PUBLIC.bytes.byteLength);
    assert.equal(stored.get(first.shareId)?.path, first.path);
    assert.equal(stored.get(second.shareId)?.title, 'WP20 分享验收会话');
    const sum = list.shares.reduce((total, record) => total + record.bytes, 0);
    assert.equal(list.totalBytes, sum, '总量统计等于各记录占用之和');

    const now = Date.now();
    const stats = statsOf(list.shares, list.totalBytes, now);
    assert.deepEqual(stats, { count: 2, active: 2, visits: 2, bytes: list.totalBytes });
    for (const record of list.shares) {
      const availability = availabilityOf(record, now);
      assert.equal(availability.linkable, true);
      assert.equal(availability.kind, 'active');
      assert.match(availability.detail, /后过期|不过期/);
    }

    const revoked = await app.gateway.revoke(first.shareId);
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.status, 'revoked');
    assert.equal((await app.page(first.path)).status, 410, '撤销之后公开页立即失效');
    const afterRevoke = await app.gateway.shares();
    const revokedRecord = afterRevoke.shares.find((record) => record.shareId === first.shareId);
    assert.ok(revokedRecord !== undefined);
    assert.equal(revokedRecord.status, 'revoked');
    assert.equal(revokedRecord.path, undefined, '失效记录不再给出公开路径');
    const revokedAvailability = availabilityOf(revokedRecord, Date.now());
    assert.equal(revokedAvailability.linkable, false);
    assert.equal(revokedAvailability.kind, 'revoked');

    assert.deepEqual(await app.gateway.revoke(first.shareId), { revoked: true, revokedAt: revoked.revokedAt, status: 'revoked' });
    assert.deepEqual(await app.gateway.revoke('unknown-token-0123456789'), { revoked: false });
  } finally {
    await app.close();
  }
});

test('过期与副本缺失的记录不产生可访问链接', async () => {
  const app = await start();
  try {
    const expired = await app.gateway.create({
      sessionId: 'session-wp20',
      range: { mode: 'turns', turns: [1] },
      ...FULL_TEXT,
      attachmentIds: [],
      ttlMs: 80,
    });
    const broken = await app.gateway.create({
      sessionId: 'session-wp20',
      range: { mode: 'turns', turns: [2] },
      ...FULL_TEXT,
      attachmentIds: [ATTACHMENT_PUBLIC.id],
    });
    const empty = await app.gateway.create({
      sessionId: 'session-wp20',
      range: { mode: 'turns', turns: [3] },
      ...FULL_TEXT,
      attachmentIds: [],
    });
    await new Promise((done) => setTimeout(done, 150));

    // 分享包里的附件副本被清理、记录里的完整性结论随之变为不完整：真实的持久化状态。
    await rm(join(app.domain.sharesRoot, broken.shareId), { recursive: true, force: true });
    const beforeScope = app.store.handle().prepare('select scope from share_posts where token = ?').get(broken.shareId);
    app.store.handle()
      .prepare('update share_posts set scope = ? where token = ?')
      .run(JSON.stringify({ ...JSON.parse(beforeScope.scope), attachmentsComplete: false }), broken.shareId);
    // 快照内容被清空：记录还在，正文与字节都没有了。
    app.store.handle().prepare('update share_posts set bytes = 0 where token = ?').run(empty.shareId);

    const list = await app.gateway.shares();
    const byId = new Map(list.shares.map((record) => [record.shareId, record]));
    const now = Date.now();
    const expiredRecord = byId.get(expired.shareId);
    const brokenRecord = byId.get(broken.shareId);
    const emptyRecord = byId.get(empty.shareId);
    assert.ok(expiredRecord !== undefined && brokenRecord !== undefined && emptyRecord !== undefined);

    assert.equal(expiredRecord.status, 'expired');
    const expiredAvailability = availabilityOf(expiredRecord, now);
    assert.equal(expiredAvailability.kind, 'expired');
    assert.equal(expiredAvailability.linkable, false);
    assert.match(expiredAvailability.detail, /过期/);

    assert.equal(brokenRecord.status, 'active');
    const brokenAvailability = availabilityOf(brokenRecord, now);
    assert.equal(brokenAvailability.kind, 'missing-package');
    assert.equal(brokenAvailability.linkable, false);
    assert.match(brokenAvailability.detail, /附件副本/);

    const emptyAvailability = availabilityOf(emptyRecord, now);
    assert.equal(emptyAvailability.kind, 'missing-content');
    assert.equal(emptyAvailability.linkable, false);

    const stats = statsOf(list.shares, list.totalBytes, now);
    assert.equal(stats.active, 0, '三条记录都不可访问');
    assert.equal(stats.count, 3);
  } finally {
    await app.close();
  }
});
