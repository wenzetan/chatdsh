// WP05 本地草稿与离线写失败的验收测试。
//
// 草稿记录用真实契约 `draftRecordSchema` 校验；四元组键、敏感字段排除、附件元数据、写入
// 失败原因与离线发送结论都走外壳的真实实现。浏览器存储用内存实现（Node 没有
// `localStorage`），失败分支用真实的 `DOMException`（`QuotaExceededError`、`SecurityError`）
// 触发，不用字符串伪造。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftRecordSchema } from '../../packages/core/contracts/lib/drafts.js';
import {
  clearDraft,
  clientIdentity,
  draftStorageAvailable,
  draftStorageKey,
  normalizeDraft,
  offlineSendOutcome,
  OFFLINE_SEND_MESSAGE,
  readDraft,
  windowIdentity,
  writeDraft,
} from '../../packages/client/shell/lib/client/drafts.js';

/** 内存存储：真实 Storage 语义。 */
class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  get length() {
    return this.map.size;
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  key(index) {
    return [...this.map.keys()][index] ?? null;
  }
}

/** 在写入时抛指定名称错误的存储。 */
class FailingStorage extends MemoryStorage {
  constructor(errorName) {
    super();
    this.errorName = errorName;
  }

  setItem(key, value) {
    if (key.endsWith('.probe')) throw new DOMException('拒绝写入', this.errorName);
    throw new DOMException('拒绝写入', this.errorName);
  }
}

const identity = (overrides = {}) => ({
  clientId: 'client-1',
  windowId: 'window-1',
  deviceId: 'device-a',
  sessionId: 'session-1',
  ...overrides,
});

test('草稿键：客户端、窗口、设备与会话四元组各自独立', () => {
  const base = identity();
  assert.equal(draftStorageKey(base), draftStorageKey(identity()));
  assert.notEqual(draftStorageKey(base), draftStorageKey(identity({ windowId: 'window-2' })));
  assert.notEqual(draftStorageKey(base), draftStorageKey(identity({ deviceId: 'device-b' })));
  assert.notEqual(draftStorageKey(base), draftStorageKey(identity({ sessionId: 'session-2' })));
  assert.notEqual(draftStorageKey(base), draftStorageKey(identity({ clientId: 'client-2' })));
  assert.equal(draftStorageKey(identity({ sessionId: undefined })).endsWith(':new'), true, '新建会话的草稿单独一段');
  assert.throws(() => draftStorageKey(identity({ clientId: '' })), /三个标识/);
});

test('草稿保存与恢复：换设备、换会话与换窗口分别恢复各自的文本', () => {
  const storage = new MemoryStorage();
  const deviceA = identity();
  const deviceB = identity({ deviceId: 'device-b' });
  const otherSession = identity({ sessionId: 'session-2' });
  const secondWindow = identity({ windowId: 'window-2' });

  assert.equal(writeDraft(storage, deviceA, { text: '甲设备上的草稿' }, 1_000).outcome, 'saved');
  assert.equal(writeDraft(storage, deviceB, { text: '乙设备上的草稿' }, 1_001).outcome, 'saved');
  assert.equal(writeDraft(storage, otherSession, { text: '另一条会话的草稿' }, 1_002).outcome, 'saved');

  assert.equal(readDraft(storage, deviceA).text, '甲设备上的草稿');
  assert.equal(readDraft(storage, deviceB).text, '乙设备上的草稿');
  assert.equal(readDraft(storage, otherSession).text, '另一条会话的草稿');
  assert.equal(readDraft(storage, secondWindow), undefined, '第二个窗口有自己的独立草稿');

  // 再次写入同一键时版本号递增、内容替换。
  assert.equal(writeDraft(storage, deviceA, { text: '甲设备上的新草稿' }, 1_003).revision, 2);
  assert.equal(readDraft(storage, deviceA).text, '甲设备上的新草稿');

  clearDraft(storage, deviceA);
  assert.equal(readDraft(storage, deviceA), undefined);
  assert.equal(readDraft(storage, deviceB).text, '乙设备上的草稿', '清掉一条不影响另一条');
});

test('草稿内容是草稿契约的合法记录，且只保留允许持久化的字段', () => {
  const storage = new MemoryStorage();
  const written = writeDraft(
    storage,
    identity(),
    {
      text: '保留这段文本',
      references: [
        { kind: 'file', id: 'file-1', label: 'src/index.ts', available: true },
        { kind: 'unknown', id: 'bad', label: '不认识', available: true },
      ],
      attachments: [
        { id: 'att-1', filename: '图.png', mimeType: 'image/png', size: 2048, confirmed: true, needsReselect: true, bytes: 'AABB' },
        { id: 'att-2', filename: '未完成.png', mimeType: 'image/png', size: 10, confirmed: false },
      ],
      credentials: { accessToken: 'secret-token' },
      memoryQuery: '记忆查询内容',
      toolBody: '工具原文',
    },
    5_000
  );
  assert.equal(written.outcome, 'saved');

  const stored = JSON.parse(storage.getItem(draftStorageKey(identity())));
  assert.equal('credentials' in stored, false, '凭据不得进入草稿');
  assert.equal('memoryQuery' in stored, false, '记忆查询内容不得进入草稿');
  assert.equal('toolBody' in stored, false, '工具原文不得进入草稿');
  assert.equal(JSON.stringify(stored).includes('secret-token'), false);
  assert.equal(stored.attachments.length, 1, '未确认附件不持久化');
  assert.equal('bytes' in stored.attachments[0], false, '附件字节不进入草稿');
  assert.equal(stored.references.length, 1, '未知引用种类被丢弃');

  const parsed = draftRecordSchema.safeParse(stored);
  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));

  // 读回的记录同样是合法契约形状。
  const restored = readDraft(storage, identity());
  assert.deepEqual(restored.references, [{ kind: 'file', id: 'file-1', label: 'src/index.ts', available: true }]);
  assert.equal(restored.attachments[0].needsReselect, true);
  assert.equal(restored.revision, 1);
  assert.equal(restored.updatedAt, 5_000);
});

test('草稿写入失败：额度不足、隐私模式与存储不可用都给出固定原因', () => {
  const quota = writeDraft(new FailingStorage('QuotaExceededError'), identity(), { text: '甲' });
  assert.deepEqual(quota, { outcome: 'rejected', reason: 'storage-full' });
  const privacy = writeDraft(new FailingStorage('SecurityError'), identity(), { text: '甲' });
  assert.deepEqual(privacy, { outcome: 'rejected', reason: 'privacy-mode' });
  const broken = writeDraft(new FailingStorage('InvalidStateError'), identity(), { text: '甲' });
  assert.deepEqual(broken, { outcome: 'rejected', reason: 'storage-unavailable' });
  const none = writeDraft(undefined, identity(), { text: '甲' });
  assert.deepEqual(none, { outcome: 'rejected', reason: 'storage-unavailable' });
  assert.equal(readDraft(undefined, identity()), undefined);
  assert.doesNotThrow(() => clearDraft(undefined, identity()));
});

test('存储可用性探测：正常存储可读写，隐私模式判为不可用', () => {
  assert.equal(draftStorageAvailable(new MemoryStorage()), true);
  assert.equal(draftStorageAvailable(new FailingStorage('SecurityError')), false);
  assert.equal(draftStorageAvailable(undefined), false);
  assert.equal(new MemoryStorage().getItem('chatdsh-shell.draft.probe'), null, '探测不留下残留键');
});

test('离线发送：只得到固定结论，草稿保留且不进入待发队列', () => {
  const sent = offlineSendOutcome('要发送的内容');
  assert.equal(sent.outcome, 'rejected');
  assert.equal(sent.code, 'device-offline');
  assert.equal(sent.draftKept, true);
  assert.equal(sent.queued, false);
  assert.equal(sent.message, OFFLINE_SEND_MESSAGE);
  assert.deepEqual(offlineSendOutcome('   '), { outcome: 'empty' });
  // 结论里没有网络与队列相关字段，写操作不可能排进待发队列。
  assert.deepEqual(Object.keys(sent).sort(), ['code', 'draftKept', 'message', 'outcome', 'queued']);
});

test('客户端与窗口标识：刷新后稳定，新窗口与另一浏览器不同', () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  let generated = 0;
  const generate = () => `id-${String((generated += 1))}`;
  const clientFirst = clientIdentity(local, generate);
  const windowFirst = windowIdentity(session, generate);
  assert.equal(clientIdentity(local, generate), clientFirst, '同一浏览器内客户端标识稳定');
  assert.equal(windowIdentity(session, generate), windowFirst, '同一窗口刷新后窗口标识稳定');
  const otherWindow = windowIdentity(new MemoryStorage(), generate);
  assert.notEqual(otherWindow, windowFirst);
  const otherBrowser = clientIdentity(new MemoryStorage(), generate);
  assert.notEqual(otherBrowser, clientFirst);
  assert.equal(clientIdentity(undefined, generate).startsWith('id-'), true, '存储不可用时本次页面仍然有标识');
});

test('草稿内容收敛：非法内容被丢弃，文本长度截到契约上限', () => {
  assert.deepEqual(normalizeDraft(undefined), { text: '', references: [], attachments: [] });
  assert.deepEqual(normalizeDraft('字符串'), { text: '', references: [], attachments: [] });
  const long = 'a'.repeat(300_000);
  assert.equal(normalizeDraft({ text: long }).text.length, 262_144);
  assert.deepEqual(normalizeDraft({ references: 'x', attachments: {} }).references, []);
  assert.deepEqual(normalizeDraft({ references: 'x', attachments: {} }).attachments, []);
  assert.deepEqual(
    normalizeDraft({ references: [{ kind: 'skill', id: '', label: '技能', available: true }] }).references,
    []
  );
});
