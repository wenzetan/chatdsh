// WP31 的逻辑验收：清单与可安装性、缓存规则、Service Worker 源码、权限、凭据、草稿、
// 扫码能力、移动布局计算与遥测。
//
// 全部判定走真实实现：清单与 Service Worker 源码由包内函数生成，缓存规则用同一份判定函数
// 逐条核对，内联进 Service Worker 的判定函数再取出来执行一遍，确保脚本与浏览器侧行为一致。
// 存储相关的行为在真实浏览器里验收（同工作包的浏览器测试），这里只核对纯函数与资源本身。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  buildManifest,
  checkInstallability,
  parseManifest,
} from '../../packages/client/pwa/lib/client/manifest.js';
import {
  CACHE_EXCLUSIONS,
  CACHE_REASON_TEXT,
  PRECACHE_ASSETS,
  SENSITIVE_QUERY_KEYS,
  cacheDecisionFor,
  classifyRequest,
  defaultCacheRules,
  shouldStoreResponse,
} from '../../packages/client/pwa/lib/client/cache-policy.js';
import { buildServiceWorkerSource } from '../../packages/client/pwa/lib/client/service-worker.js';
import { NAVIGATION_KEY, offlinePage, readNavigationMeta, saveNavigationMeta } from '../../packages/client/pwa/lib/client/offline.js';
import {
  OFFLINE_SEND_MESSAGE,
  SENSITIVE_DRAFT_KEYS,
  draftStorageKey,
  sanitizeDraft,
  submitDraft,
} from '../../packages/client/pwa/lib/client/drafts.js';
import {
  PAIRING_CODE_LENGTH,
  barcodeScanCapability,
  formatPairingCode,
  normalizePairingCode,
  pairingCodeError,
} from '../../packages/client/pwa/lib/client/scanner.js';
import {
  PERMISSION_GUIDANCE,
  PERMISSION_LABELS,
  PERMISSION_TARGETS,
} from '../../packages/client/pwa/lib/client/permissions.js';
import { KEYBOARD_INSET_THRESHOLD, TOUCH_TARGET_MIN, keyboardInsetOf } from '../../packages/client/pwa/lib/client/mobile-layout.js';
import { createPwaTelemetry, failureAttributesOf } from '../../packages/client/pwa/lib/client/telemetry.js';
import { openCredentialStore } from '../../packages/client/pwa/lib/client/secure-storage.js';
import { pwaStaticContent } from '../../packages/client/pwa/lib/index.js';

const PACKAGE_ROOT = resolve(dirname(import.meta.filename), '..', '..', 'packages', 'client', 'pwa');
const ORIGIN = 'http://127.0.0.1:4173';

/** 一条请求事实。 */
function factsOf(path, extra = {}) {
  return { url: `${ORIGIN}${path}`, method: 'GET', mode: 'no-cors', origin: ORIGIN, authorization: false, ...extra };
}

test('清单字段满足安装要求，图标与快捷入口齐全', () => {
  const manifest = buildManifest({ version: '9' });
  assert.equal(manifest.name, 'ChatDSH 会话客户端');
  assert.equal(manifest.short_name, 'ChatDSH');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#3d56e8');
  assert.equal(manifest.background_color, '#0e0e10');
  assert.equal(manifest.prefer_related_applications, false);
  assert.deepEqual(
    manifest.icons.map((icon) => icon.sizes),
    ['192x192', '512x512', '512x512']
  );
  assert.equal(manifest.icons[2].purpose, 'maskable');
  assert.ok(manifest.icons.every((icon) => icon.src.includes('v=9')), '图标地址带版本');
  assert.deepEqual(manifest.shortcuts.map((shortcut) => shortcut.url), ['/', '/sessions/new']);

  const parsed = parseManifest(JSON.stringify(manifest));
  assert.deepEqual(parsed.icons, manifest.icons);

  const iconFiles = [
    { name: 'icon-192.png', size: 192 },
    { name: 'icon-512.png', size: 512 },
    { name: 'icon-maskable-512.png', size: 512 },
  ];
  for (const icon of iconFiles) {
    const bytes = readFileSync(join(PACKAGE_ROOT, 'assets', 'icons', icon.name));
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(bytes.readUInt32BE(16), icon.size);
    assert.equal(bytes.readUInt32BE(20), icon.size);
    assert.ok(manifest.icons.some((entry) => entry.src.startsWith(`/assets/icons/${icon.name}`)), `${icon.name} 在清单里`);
  }
});

test('可安装性检查逐项给出阻断与提醒', () => {
  const manifest = buildManifest();
  const ready = {
    manifest,
    manifestStatus: 200,
    manifestContentType: 'application/manifest+json',
    secureContext: true,
    serviceWorker: { registered: true, active: true, controlling: true, scope: '/' },
    displayMode: 'browser',
    startUrl: `${ORIGIN}/`,
  };
  const passed = checkInstallability(ready);
  assert.equal(passed.installable, true);
  assert.equal(passed.installed, false);
  assert.deepEqual(passed.issues, []);

  const installed = checkInstallability({ ...ready, displayMode: 'standalone' });
  assert.equal(installed.installable, true);
  assert.equal(installed.installed, true);

  /** 取某种情况下出现的问题码。 */
  const codesOf = (input) => checkInstallability({ ...ready, ...input }).issues.map((issue) => issue.code);

  assert.deepEqual(codesOf({ secureContext: false, serviceWorker: { registered: true, active: true, controlling: true, scope: '/' } }), ['insecure-context']);
  assert.ok(codesOf({ manifestStatus: 404 }).includes('manifest-unreachable'));
  assert.ok(codesOf({ manifestContentType: 'text/html' }).includes('manifest-content-type'));
  assert.ok(codesOf({ manifest: undefined }).includes('manifest-invalid'));
  assert.ok(codesOf({ displayMode: 'browser', manifest: { ...manifest, display: 'browser' } }).includes('display-invalid'));
  assert.ok(codesOf({ manifest: { ...manifest, icons: manifest.icons.filter((icon) => icon.sizes !== '512x512') } }).includes('icon-missing-512'));
  assert.ok(codesOf({ manifest: { ...manifest, prefer_related_applications: true } }).includes('prefer-related-applications'));
  assert.ok(codesOf({ serviceWorker: { registered: false, active: false, controlling: false } }).includes('service-worker-missing'));
  assert.ok(codesOf({ serviceWorker: { registered: true, active: true, controlling: false, scope: '/' } }).includes('service-worker-not-controlling'));
  assert.ok(codesOf({ startUrl: `${ORIGIN}/`, manifest: { ...manifest, scope: '/app/' } }).includes('start-url-out-of-scope'));
  assert.ok(codesOf({ serviceWorker: { registered: true, active: true, controlling: true, scope: '/other/' } }).includes('service-worker-scope'));

  const warning = checkInstallability({ ...ready, manifest: { ...manifest, short_name: 'ChatDSH 移动客户端' } });
  assert.equal(warning.installable, true);
  assert.deepEqual(warning.issues.map((issue) => issue.severity), ['warning']);
  assert.equal(warning.issues[0].code, 'short-name-long');
});

test('缓存规则排除私有接口、凭据地址与非读取请求', () => {
  const rules = defaultCacheRules();
  const decision = (path, extra) => classifyRequest(factsOf(path, extra), rules);

  const excluded = [
    ['/chatdsh/client/sessions', 'control-plane-api'],
    ['/chatdsh/telemetry/browser', 'control-plane-api'],
    ['/chatdsh/gateway/notifications', 'control-plane-api'],
    ['/d/device-1/sessions/s-1', 'device-runtime'],
    ['/api/session/create', 'runtime-rpc'],
    ['/s/share-token-1', 'share-snapshot'],
    ['/healthz', 'health-probe'],
  ];
  for (const [path, reason] of excluded) {
    const result = decision(path);
    assert.deepEqual(result, { strategy: 'network', cacheable: false, reason }, `${path} 不进入缓存`);
    assert.equal(typeof CACHE_REASON_TEXT[reason], 'string', `${reason} 有中文说明`);
  }

  assert.deepEqual(decision('/assets/theme.css?token=secret'), { strategy: 'network', cacheable: false, reason: 'sensitive-query' });
  assert.deepEqual(decision('/assets/theme.css', { authorization: true }), { strategy: 'network', cacheable: false, reason: 'authorization' });
  assert.deepEqual(decision('/assets/theme.css', { method: 'POST' }), { strategy: 'network', cacheable: false, reason: 'method-not-get' });
  assert.deepEqual(decision('/assets/theme.css', { origin: 'https://other.invalid' }), { strategy: 'network', cacheable: false, reason: 'cross-origin' });
  assert.deepEqual(decision('/', { mode: 'navigate' }), { strategy: 'navigation', cacheable: false, reason: 'navigation' });
  assert.deepEqual(decision('/unknown/page'), { strategy: 'network', cacheable: false, reason: 'not-allowlisted' });
  assert.deepEqual(decision('/assets/icons/icon-192.png'), { strategy: 'precache', cacheable: true, reason: 'precache' });
  assert.deepEqual(decision('/assets/theme.css'), { strategy: 'static', cacheable: true, reason: 'static-asset' });
  assert.deepEqual(decision('/offline.html'), { strategy: 'precache', cacheable: true, reason: 'precache' });

  for (const key of ['token', 'authorization', 'pairing', 'code']) {
    assert.ok(SENSITIVE_QUERY_KEYS.includes(key), `${key} 属于敏感查询参数`);
  }
  for (const entry of CACHE_EXCLUSIONS) {
    assert.equal(typeof CACHE_REASON_TEXT[entry.reason], 'string');
  }
  assert.ok(PRECACHE_ASSETS.includes('/'));
  assert.ok(PRECACHE_ASSETS.includes('/offline.html'));

  const cached = cacheDecisionFor(`${ORIGIN}/assets/app.js`, ORIGIN, rules);
  assert.equal(cached.cacheable, true);
  const privateApi = cacheDecisionFor(`${ORIGIN}/chatdsh/client/sessions`, ORIGIN, rules);
  assert.equal(privateApi.cacheable, false);
});

test('响应写入条件拒绝禁止缓存的响应', () => {
  const base = { status: 200, type: 'basic', headers: [] };
  assert.equal(shouldStoreResponse(base), true);
  assert.equal(shouldStoreResponse({ ...base, headers: [['cache-control', 'public, max-age=60']] }), true);
  assert.equal(shouldStoreResponse({ ...base, headers: [['cache-control', 'no-store']] }), false);
  assert.equal(shouldStoreResponse({ ...base, headers: [['cache-control', 'private, max-age=0']] }), false);
  assert.equal(shouldStoreResponse({ ...base, headers: [['set-cookie', 'session=1']] }), false);
  assert.equal(shouldStoreResponse({ ...base, headers: [['vary', '*']] }), false);
  assert.equal(shouldStoreResponse({ ...base, status: 204 }), false);
  assert.equal(shouldStoreResponse({ ...base, type: 'opaque' }), false);
});

test('Service Worker 源码按版本命名缓存、预缓存清单与受控更新', () => {
  const source = buildServiceWorkerSource({ version: '2' });
  assert.match(source, /const VERSION = "2";/);
  assert.match(source, /const CACHE_NAME = CACHE_PREFIX \+ '-static-' \+ VERSION;/);
  assert.match(source, /const CACHE_PREFIX = "chatdsh-pwa";/);
  for (const asset of PRECACHE_ASSETS) {
    assert.ok(source.includes(JSON.stringify(asset)), `预缓存清单包含 ${asset}`);
  }
  assert.ok(source.includes('"/chatdsh/"'), '排除规则写进脚本');
  assert.ok(source.includes('"control-plane-api"'));
  assert.ok(source.includes('"/api/"'));
  assert.ok(source.includes('"/s/"'));
  assert.ok(source.includes('"/d/"'));
  assert.ok(source.includes('sensitiveQueryKeys'));
  for (const marker of ["addEventListener('install'", "addEventListener('activate'", "addEventListener('message'", "addEventListener('fetch'", 'SKIP_WAITING', 'self.clients.claim()', 'removeOldCaches', 'precacheAll', 'shouldStoreResponse']) {
    assert.ok(source.includes(marker), `脚本包含 ${marker}`);
  }
  assert.ok(source.includes('OFFLINE_PATH'), '离线回退页写进脚本');
  assert.ok(!source.includes('localStorage'), 'Service Worker 不碰本地存储');
  assert.ok(!source.includes('indexedDB'), 'Service Worker 不碰 IndexedDB');
  assert.ok(!source.includes('chatdsh.'), '脚本不携带遥测信号名');

  // 内联进脚本的判定函数取出来执行，结果与包内实现逐条一致。
  const begin = source.indexOf('const classifyRequest = ') + 'const classifyRequest = '.length;
  const end = source.indexOf('\nconst shouldStoreResponse = ');
  const embedded = new Function(`return ${source.slice(begin, end).trim().replace(/;$/, '')}`)();
  const rules = defaultCacheRules();
  const cases = [
    factsOf('/assets/app.js'),
    factsOf('/chatdsh/client/sessions'),
    factsOf('/api/memory/search'),
    factsOf('/s/token-value'),
    factsOf('/d/device-1/sessions'),
    factsOf('/healthz'),
    factsOf('/assets/app.js?token=abc'),
    factsOf('/assets/app.js', { method: 'HEAD' }),
    factsOf('/assets/app.js', { mode: 'navigate' }),
    factsOf('/unlisted/path'),
  ];
  for (const facts of cases) {
    assert.deepEqual(embedded(facts, rules), classifyRequest(facts, rules), facts.url);
  }

  const storeBegin = source.indexOf('const shouldStoreResponse = ') + 'const shouldStoreResponse = '.length;
  const storeEnd = source.indexOf('\n\n/* 预缓存全部静态资源');
  const embeddedStore = new Function(`return ${source.slice(storeBegin, storeEnd).trim().replace(/;$/, '')}`)();
  const responses = [
    { status: 200, type: 'basic', headers: [] },
    { status: 200, type: 'basic', headers: [['cache-control', 'no-store']] },
    { status: 200, type: 'opaque', headers: [] },
    { status: 500, type: 'basic', headers: [] },
  ];
  for (const response of responses) {
    assert.equal(embeddedStore(response), shouldStoreResponse(response), JSON.stringify(response));
  }
});

test('离线回退页说明正文读取失败并列出导航元数据', () => {
  const html = offlinePage({ navigation: { workspace: '/work/alpha', deviceId: 'device-7', unread: 3, updatedAt: 0 } });
  for (const text of ['当前离线', '正文读取失败', '本机保留的内容', '返回会话列表', '/work/alpha', 'device-7', '>3<']) {
    assert.ok(html.includes(text), `离线页包含 ${text}`);
  }
  assert.ok(html.includes('viewport-fit=cover'));
  assert.ok(html.includes('env(safe-area-inset-bottom)'));
  assert.ok(!html.includes('<script'), '离线页不加载脚本');
  assert.ok(!html.includes('http://'), '离线页不引用外部地址');

  const bare = offlinePage();
  assert.ok(bare.includes('本机没有已保留的导航位置'));
  assert.ok(bare.includes('100dvh'));
});

test('导航元数据只保留工作区、设备与未读', () => {
  const source = readFileSync(join(PACKAGE_ROOT, 'src', 'client', 'offline.ts'), 'utf8');
  assert.ok(source.includes(NAVIGATION_KEY));
  assert.ok(!source.includes('localStorage'), '导航元数据通过传进来的存储写入');
  assert.ok(!/message|content/i.test(source.slice(source.indexOf('export interface NavigationMeta'), source.indexOf('export function saveNavigationMeta'))), '导航元数据没有消息正文字段');
  assert.equal(typeof saveNavigationMeta, 'function');
  assert.equal(typeof readNavigationMeta, 'function');
});

test('草稿按客户端、窗口、设备与会话隔离并剔除非白名单字段', () => {
  const identity = { clientId: 'client-1', windowId: 'window-1', deviceId: 'device-1', sessionId: 'session-1' };
  const key = draftStorageKey(identity);
  assert.equal(key, 'chatdsh-pwa.draft.v1:client-1:window-1:device-1:session-1');
  assert.equal(draftStorageKey({ ...identity, sessionId: undefined }), 'chatdsh-pwa.draft.v1:client-1:window-1:device-1:new');
  assert.throws(() => draftStorageKey({ clientId: 'client-1', windowId: '', deviceId: 'device-1' }), /草稿键/);

  const sanitized = sanitizeDraft({
    text: '离线时写的内容',
    token: 'secret-token',
    authorization: 'Bearer secret',
    memoryQuery: '记忆查询内容',
    toolResult: '工具原文',
    references: [
      { kind: 'file', id: 'file-1', label: 'a.ts', available: true },
      { kind: 'unknown', id: 'x', label: 'y', available: true },
      { kind: 'file', id: '', label: 'z', available: true },
    ],
    attachments: [
      { id: 'att-1', filename: 'a.txt', mimeType: 'text/plain', size: 12, confirmed: true, needsReselect: false },
      { id: 'att-2', filename: 'b.txt', mimeType: 'text/plain', size: 12, confirmed: false },
      { id: 'att-3', filename: 'c.txt', mimeType: 'text/plain', size: 12, confirmed: true, bytes: 'AAAA' },
    ],
  });
  assert.deepEqual(Object.keys(sanitized).sort(), ['attachments', 'references', 'text']);
  assert.equal(sanitized.text, '离线时写的内容');
  assert.deepEqual(sanitized.references.map((reference) => reference.id), ['file-1']);
  assert.deepEqual(sanitized.attachments.map((attachment) => attachment.id), ['att-1', 'att-3']);
  assert.equal('bytes' in sanitized.attachments[1], false);
  const serialized = JSON.stringify(sanitized);
  for (const key of SENSITIVE_DRAFT_KEYS) assert.equal(key in sanitized, false, `草稿不含字段 ${key}`);
  assert.equal(serialized.includes('secret-token'), false, '草稿不含令牌原值');
});

test('离线发送被拒绝且不发出任何请求', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const offline = await submitDraft({ endpoint: '/chatdsh/client/messages', text: '离线草稿', online: false, fetchImpl });
  assert.deepEqual(offline, {
    outcome: 'rejected',
    code: 'offline',
    message: OFFLINE_SEND_MESSAGE,
    draftKept: true,
    queued: false,
  });
  assert.equal(calls.length, 0, '离线时没有发出请求');

  const empty = await submitDraft({ endpoint: '/chatdsh/client/messages', text: '   ', online: true, fetchImpl });
  assert.deepEqual(empty, { outcome: 'rejected', code: 'empty', message: '输入区没有内容', draftKept: true, queued: false });
  assert.equal(calls.length, 0);

  const sent = await submitDraft({ endpoint: '/chatdsh/client/messages', text: '在线内容', online: true, fetchImpl });
  assert.equal(sent.outcome, 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: '在线内容' });

  const failedFetch = async () => ({ ok: false, status: 503 });
  const failed = await submitDraft({ endpoint: '/chatdsh/client/messages', text: '在线内容', online: true, fetchImpl: failedFetch });
  assert.equal(failed.outcome, 'rejected');
  assert.equal(failed.code, 'network');
  assert.equal(failed.queued, false);
});

test('权限项目的中文名称与设置指引齐全', () => {
  assert.deepEqual([...PERMISSION_TARGETS], ['notifications', 'camera', 'microphone', 'clipboard']);
  for (const target of PERMISSION_TARGETS) {
    assert.equal(typeof PERMISSION_LABELS[target], 'string');
    assert.match(PERMISSION_GUIDANCE[target], /站点设置/);
  }
});

test('配对码规范化与手填校验', () => {
  assert.equal(PAIRING_CODE_LENGTH, 16);
  assert.equal(normalizePairingCode('abcd-efgh-jklm-npqr'), 'ABCDEFGHJKLMNPQR');
  assert.equal(normalizePairingCode('ABCD EFGH JKLM NPQR'), 'ABCDEFGHJKLMNPQR');
  assert.equal(normalizePairingCode('ABCDEFGHJKLMNPQ0'), undefined);
  assert.equal(normalizePairingCode('ABCDEFGHJKLMNPQ'), undefined);
  assert.equal(formatPairingCode('ABCDEFGHJKLMNPQR'), 'ABCD-EFGH-JKLM-NPQR');
  assert.equal(pairingCodeError(''), '请输入配对码');
  assert.match(pairingCodeError('ABCD'), /当前输入 4 位/);
  assert.match(pairingCodeError('ABCDEFGHJKLMNPQ0'), /不允许的字符/);
  assert.equal(pairingCodeError('ABCD-EFGH-JKLM-NPQR'), undefined);

  const unavailable = barcodeScanCapability({});
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.decoder, 'none');
  assert.equal(unavailable.fallback, 'manual-entry');
  assert.match(unavailable.detail, /手动输入配对码/);

  const available = barcodeScanCapability({ BarcodeDetector: function BarcodeDetector() {} });
  assert.equal(available.available, true);
  assert.equal(available.decoder, 'barcode-detector');
});

test('输入法遮挡高度与触控目标下限', () => {
  assert.equal(TOUCH_TARGET_MIN, 44);
  assert.equal(KEYBOARD_INSET_THRESHOLD, 80);
  assert.equal(keyboardInsetOf({ innerHeight: 844, height: 500, offsetTop: 0 }), 344);
  assert.equal(keyboardInsetOf({ innerHeight: 844, height: 800, offsetTop: 0 }), 0);
  assert.equal(keyboardInsetOf({ innerHeight: 800, height: 500, offsetTop: 100 }), 200);
  assert.equal(keyboardInsetOf({ innerHeight: 800, height: 740, offsetTop: 0 }), 0);
});

test('设备凭据缺少 IndexedDB 时退回内存并给出原因', async () => {
  const store = await openCredentialStore({ crypto: globalThis.crypto, indexedDB: null });
  assert.equal(store.kind, 'memory');
  assert.equal(store.reason, 'indexeddb-unavailable');
  assert.equal(store.has('device-9'), false);
  await store.save({ deviceId: 'device-9', token: 'token-value', issuedAt: 1 });
  assert.equal(store.has('device-9'), true);
  assert.deepEqual(await store.load('device-9'), { deviceId: 'device-9', token: 'token-value', issuedAt: 1 });
  await store.clear();
  assert.equal(await store.load('device-9'), undefined);

  const missingCrypto = await openCredentialStore({ crypto: null, indexedDB: null });
  assert.equal(missingCrypto.kind, 'memory');
  assert.equal(missingCrypto.reason, 'crypto-unavailable');

  const source = readFileSync(join(PACKAGE_ROOT, 'src', 'client', 'secure-storage.ts'), 'utf8');
  assert.ok(!source.includes('localStorage'), '凭据模块不写本地存储');
  assert.ok(!source.includes('sessionStorage'), '凭据模块不写会话存储');
  assert.ok(source.includes('AES-GCM'));
  assert.ok(source.includes("generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])"), '密钥生成时标记为不可导出');
});

test('遥测名称、属性与失败计数', () => {
  const posts = [];
  const telemetry = createPwaTelemetry({
    fetchImpl: async (url, init) => {
      posts.push({ url, init, body: JSON.parse(init.body) });
      return { ok: true, status: 204 };
    },
    now: () => 1000,
    randomHex: (bytes) => 'a'.repeat(bytes * 2),
  });

  telemetry.action('install-check', 'ok');
  assert.equal(posts[0].url, '/chatdsh/telemetry/browser');
  assert.equal(posts[0].init.headers['x-chatdsh-signal'], 'logs');
  assert.equal(posts[0].init.headers['x-chatdsh-csrf'], '1');
  const log = posts[0].body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(log.body.stringValue, 'chatdsh.client.ui.action');
  assert.deepEqual(
    log.attributes.map((entry) => [entry.key, entry.value.stringValue]),
    [['action', 'install-check'], ['outcome', 'ok']]
  );

  telemetry.boot(6, 'ok');
  const bootSpan = posts[1].body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(posts[1].init.headers['x-chatdsh-signal'], 'traces');
  assert.equal(bootSpan.name, 'chatdsh.client.boot');
  assert.deepEqual(
    bootSpan.attributes.map((entry) => entry.key),
    ['module.count', 'outcome']
  );

  telemetry.moduleLoad('service-worker', 'ok');
  const moduleSpan = posts[2].body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(moduleSpan.name, 'chatdsh.client.module.load');
  assert.deepEqual(moduleSpan.attributes.map((entry) => entry.key), ['module.id', 'outcome']);

  const error = new Error('拒绝');
  error.name = 'NotAllowedError';
  telemetry.failure('permission-request', error);
  const actionLog = posts[3].body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(actionLog.body.stringValue, 'chatdsh.client.ui.action');
  assert.deepEqual(actionLog.attributes.map((entry) => entry.value.stringValue), ['permission-request', 'failed']);
  const errorLog = posts[4].body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(errorLog.body.stringValue, 'chatdsh.client.error');
  assert.deepEqual(
    errorLog.attributes.map((entry) => [entry.key, entry.value.stringValue]),
    [['error.type', 'NotAllowedError'], ['error.code', 'unknown']]
  );
  const metric = posts[5].body.resourceMetrics[0].scopeMetrics[0].metrics[0];
  assert.equal(metric.name, 'chatdsh_client_errors_total');
  assert.equal(metric.sum.dataPoints[0].attributes[0].value.stringValue, 'NotAllowedError');

  assert.deepEqual(failureAttributesOf({ name: 'TypeError', code: 'boom' }), { type: 'TypeError', code: 'boom' });
  assert.deepEqual(failureAttributesOf('文本'), { type: 'Error', code: 'unknown' });
});

test('移动样式覆盖安全区、触控目标与文字缩放', () => {
  const css = readFileSync(join(PACKAGE_ROOT, 'src', 'client', 'mobile.css'), 'utf8');
  for (const marker of [
    'env(safe-area-inset-top)',
    'env(safe-area-inset-right)',
    'env(safe-area-inset-bottom)',
    'env(safe-area-inset-left)',
    'var(--pwa-keyboard-inset, 0px)',
    'min-height: 44px',
    '100dvh',
    'font-size: 0.9375rem',
    'overflow-wrap: anywhere',
  ]) {
    assert.ok(css.includes(marker), `样式包含 ${marker}`);
  }
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(css), false, '组件样式不写颜色字面值');
  const drawer = /\.pwa-drawer \{[^}]*width: min\(20rem, 86vw\)/.test(css);
  assert.equal(drawer, true, '抽屉宽度按视口收窄');
});

test('宿主侧生成的静态内容可直接作为响应体', () => {
  const content = pwaStaticContent({ version: '5' });
  assert.equal(content.manifestPath, '/manifest.webmanifest');
  assert.equal(content.manifestContentType, 'application/manifest+json');
  assert.equal(JSON.parse(content.manifestJson).icons[0].src, '/assets/icons/icon-192.png?v=5');
  assert.equal(content.serviceWorkerPath, '/sw.js');
  assert.equal(content.cacheName, 'chatdsh-pwa-static-5');
  assert.ok(content.serviceWorkerSource.includes('"5"'));
  assert.equal(content.offlinePath, '/offline.html');
  assert.ok(content.offlineHtml.includes('当前离线'));
});
