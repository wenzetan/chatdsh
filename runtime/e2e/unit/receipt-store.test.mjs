// 已读回执存储的单元测试。
//
// 用内存 SQLite 直接调用编译后的真实实现。表结构由控制平面的存储层创建，这里照抄一份最小
// 定义。覆盖三条规则：回执只往前走、按账号隔离、按设备列出。
//
// 运行：node --test e2e/unit/receipt-store.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ReceiptStore } from '../../gateway/lib/store.js';

function fresh() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    create table read_receipts (
      session_id text not null,
      device_id text not null,
      account_id text not null,
      read_up_to_seq integer not null,
      updated_at integer not null,
      primary key (session_id, device_id)
    );
  `);
  return new ReceiptStore(database);
}

test('记录已读并按设备列出', () => {
  const store = fresh();
  store.mark({ sessionId: 's1', deviceId: 'd1', accountId: 'a1', readUpToSeq: 3 });
  store.mark({ sessionId: 's1', deviceId: 'd2', accountId: 'a1', readUpToSeq: 1 });
  const rows = store.list('s1', 'a1');
  assert.deepEqual(rows.map((row) => [row.deviceId, row.readUpToSeq]), [['d1', 3], ['d2', 1]]);
});

test('回退到更小的序号不生效', () => {
  const store = fresh();
  store.mark({ sessionId: 's1', deviceId: 'd1', accountId: 'a1', readUpToSeq: 5 });
  const back = store.mark({ sessionId: 's1', deviceId: 'd1', accountId: 'a1', readUpToSeq: 2 });
  assert.equal(back.readUpToSeq, 5);
  assert.equal(store.list('s1', 'a1')[0].readUpToSeq, 5);
});

test('重复上报同一水位不改变记录', () => {
  const store = fresh();
  store.mark({ sessionId: 's1', deviceId: 'd1', accountId: 'a1', readUpToSeq: 4 });
  const again = store.mark({ sessionId: 's1', deviceId: 'd1', accountId: 'a1', readUpToSeq: 4 });
  assert.equal(again.readUpToSeq, 4);
  assert.equal(store.list('s1', 'a1').length, 1);
});

test('按账号隔离：别人的回执查不到', () => {
  const store = fresh();
  store.mark({ sessionId: 's1', deviceId: 'd1', accountId: 'a1', readUpToSeq: 2 });
  assert.equal(store.list('s1', 'a2').length, 0);
});

test('不同会话各自记录', () => {
  const store = fresh();
  store.mark({ sessionId: 's1', deviceId: 'd1', accountId: 'a1', readUpToSeq: 2 });
  store.mark({ sessionId: 's2', deviceId: 'd1', accountId: 'a1', readUpToSeq: 7 });
  assert.equal(store.list('s1', 'a1')[0].readUpToSeq, 2);
  assert.equal(store.list('s2', 'a1')[0].readUpToSeq, 7);
});
