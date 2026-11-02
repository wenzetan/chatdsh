// WP13 连接器客户端纯逻辑的验收测试：名称规范化、条件校验、状态徽标与失败说明。
//
// 断言对象是编译产物 `packages/client/connectors/lib/client/state.js`，不经过浏览器与网络。
// 规范化结果与宿主 `toServerName` 逐项对比：界面拦下冲突的前提是两边算出的服务器名一致。
//
// 运行：node --test e2e/unit/client-complete-wp13-state.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const REPO = resolve(import.meta.dirname, '../../..');
ensureDeps(resolve(import.meta.dirname, '../..'));
ensureDeps(resolve(REPO, 'dsh-adapter'));

const state = await import('../../packages/client/connectors/lib/client/state.js');
const connectors = await import('../../packages/host/connectors/lib/index.js');

/** 一份记录。 */
function recordOf(overrides) {
  return {
    id: 'connector-1',
    name: 'notes',
    transport: 'stdio',
    command: 'notes-mcp',
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

/** 一份草稿。 */
function draftOf(overrides) {
  return {
    name: 'notes',
    transport: 'stdio',
    command: 'notes-mcp',
    argsText: '',
    url: '',
    credentialEnv: '',
    enabled: true,
    ...overrides,
  };
}

/** 取某个字段的错误说明。 */
function messageOf(errors, fieldId) {
  return errors.find((entry) => entry.fieldId === fieldId)?.message;
}

test('服务器名规范化与宿主实现一致，界面才能拦下同名冲突', () => {
  const cases = [
    'notes',
    'my notes',
    'my-notes',
    'Notes Server',
    'a'.repeat(40),
    '中文名称',
    '',
    '   ',
    'a.b_c-d',
    '***',
  ];
  for (const name of cases) {
    assert.equal(state.toServerName(name), connectors.toServerName(name), `规范化结果不一致：${JSON.stringify(name)}`);
  }
  assert.equal(state.rowIdOf('notes'), connectors.rowIdOf('notes'), '行标识与宿主一致');
  assert.equal(state.registryServerOf('chatdsh-mcp-endpoint-notes'), 'notes');
  assert.equal(state.registryServerOf('chatdsh-connector-notes'), undefined, '连接器行不是注册表行');
});

test('stdio 与 http 的条件字段互斥校验', () => {
  const others = [recordOf({})];
  assert.equal(messageOf(state.validateDraft(draftOf({ name: 'other', command: '' }), others), state.FIELD_IDS.command), 'stdio 方式的连接器必须给出命令');
  assert.equal(
    messageOf(state.validateDraft(draftOf({ name: 'other', url: 'https://example.test/mcp' }), others), state.FIELD_IDS.url),
    'stdio 方式的连接器不接受地址',
  );

  const http = draftOf({ name: 'other', transport: 'http', command: '', url: 'https://example.test/mcp' });
  assert.deepEqual(state.validateDraft(http, others), [], 'http 方式带地址可以保存');
  assert.equal(
    messageOf(state.validateDraft({ ...http, url: '' }, others), state.FIELD_IDS.url),
    'http 方式的连接器必须给出地址',
  );
  assert.match(
    messageOf(state.validateDraft({ ...http, url: 'ftp://example.test/mcp' }, others), state.FIELD_IDS.url) ?? '',
    /只支持 http 与 https/u,
  );
  assert.match(
    messageOf(state.validateDraft({ ...http, url: 'example.test' }, others), state.FIELD_IDS.url) ?? '',
    /完整的 URL/u,
  );
  assert.equal(
    messageOf(state.validateDraft({ ...http, command: 'notes-mcp' }, others), state.FIELD_IDS.command),
    'http 方式的连接器不接受命令',
  );
  assert.equal(
    messageOf(state.validateDraft({ ...http, argsText: '["--dir"]' }, others), state.FIELD_IDS.args),
    'http 方式的连接器不接受参数',
  );
});

test('参数按 JSON 字符串数组校验，解析成功时写入输入', () => {
  const others = [];
  assert.match(
    messageOf(state.validateDraft(draftOf({ name: 'other', argsText: '{' }), others), state.FIELD_IDS.args) ?? '',
    /无法解析/u,
  );
  assert.match(
    messageOf(state.validateDraft(draftOf({ name: 'other', argsText: '["ok",3]' }), others), state.FIELD_IDS.args) ?? '',
    /字符串数组/u,
  );
  assert.match(
    messageOf(state.validateDraft(draftOf({ name: 'other', argsText: '{"a":1}' }), others), state.FIELD_IDS.args) ?? '',
    /字符串数组/u,
  );
  const input = state.inputOf(draftOf({ name: ' other ', argsText: '["--dir","/srv"]', credentialEnv: '  ' }));
  assert.equal(input.name, 'other', '名称去空白');
  assert.deepEqual(input.args, ['--dir', '/srv']);
  assert.equal('credentialEnv' in input, false, '空凭据变量不写入');
  const httpInput = state.inputOf(draftOf({ name: 'other', transport: 'http', command: 'x', url: 'https://example.test/mcp' }));
  assert.equal(httpInput.transport, 'http');
  assert.equal('command' in httpInput, false, 'http 输入不带命令');
  assert.equal(httpInput.url, 'https://example.test/mcp');
});

test('凭据只接受环境变量名，写成值会被拒绝', () => {
  const others = [];
  assert.match(
    messageOf(state.validateDraft(draftOf({ name: 'other', credentialEnv: 'token=abc' }), others), state.FIELD_IDS.credential) ?? '',
    /只填环境变量名/u,
  );
  assert.equal(messageOf(state.validateDraft(draftOf({ name: 'other', credentialEnv: 'CHATDSH_TOKEN' }), others), state.FIELD_IDS.credential), undefined);
});

test('名称唯一与规范化后冲突都阻止保存', () => {
  const others = [recordOf({ id: 'connector-2', name: 'my notes' })];
  assert.equal(
    messageOf(state.validateDraft(draftOf({ name: 'my notes' }), others), state.FIELD_IDS.name),
    '连接器名称 my notes 已被占用',
  );
  const conflict = messageOf(state.validateDraft(draftOf({ name: 'my-notes' }), others), state.FIELD_IDS.name) ?? '';
  assert.match(conflict, /名称规范化后与「my notes」冲突/u);
  assert.match(conflict, /服务器名 my-notes 只能由一个连接器占用/u);
  assert.equal(state.validateDraft(draftOf({ name: 'my-notes-2' }), others).length, 0, '规范化结果不同时可以保存');
  assert.equal(
    messageOf(state.validateDraft(draftOf({ name: 'x'.repeat(state.CONNECTOR_NAME_LIMIT + 1) }), []), state.FIELD_IDS.name),
    `连接器名称最多 ${String(state.CONNECTOR_NAME_LIMIT)} 个字符`,
  );
});

test('配置保存与同步结果各自成徽标，双重状态同时可见', () => {
  const failed = {
    id: 'connector-1',
    name: 'notes',
    transport: 'stdio',
    enabled: true,
    configSaved: true,
    rows: [],
    tools: [],
    sync: { id: 'connector-1', status: 'failed', rows: 0, errorType: 'ChatdshError', errorCode: 'connector-credential-missing', at: 1767225600000 },
  };
  assert.deepEqual(state.configBadge(), { tone: 'neutral', label: '已保存' });
  assert.deepEqual(state.syncBadgeOf(failed), { tone: 'danger', label: '同步失败' });
  assert.deepEqual(state.syncBadgeOf(failed, true), { tone: 'warn', label: '同步中' });
  assert.deepEqual(state.syncBadgeOf({ ...failed, sync: undefined }), { tone: 'neutral', label: '未同步' });
  assert.deepEqual(state.syncBadgeOf({ ...failed, sync: { id: 'connector-1', status: 'ok', rows: 1, at: 1 } }), { tone: 'ok', label: '同步成功' });
  assert.deepEqual(state.enabledBadgeOf(failed), { tone: 'ok', label: '启用' });
  assert.deepEqual(state.enabledBadgeOf({ ...failed, enabled: false }), { tone: 'neutral', label: '已停用' });
  assert.deepEqual(state.connectionBadgeOf(failed), { tone: 'neutral', label: '未接入目录' });
  assert.deepEqual(state.connectionBadgeOf({ ...failed, rows: ['chatdsh-connector-notes'] }), { tone: 'warn', label: '已生成行，等待工具' });
  assert.deepEqual(
    state.connectionBadgeOf({ ...failed, rows: ['chatdsh-connector-notes'], tools: ['mcp__notes__probe-tool'] }),
    { tone: 'ok', label: '已连接' },
  );
});

test('同步说明带错误码、错误类型与最近时间，工具调用原因按启用状态给出', () => {
  const sync = { id: 'connector-1', status: 'failed', rows: 0, errorType: 'ChatdshError', errorCode: 'connector-credential-missing', at: 1767225600000 };
  const text = state.describeSync(sync);
  assert.match(text, /同步失败/u);
  assert.match(text, /connector-credential-missing/u);
  assert.match(text, /ChatdshError/u);
  const moment = new Date(1767225600000);
  const pad = (value) => String(value).padStart(2, '0');
  const expectedTime = `${String(moment.getFullYear())}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${pad(moment.getHours())}:${pad(moment.getMinutes())}:${pad(moment.getSeconds())}`;
  assert.ok(text.includes(expectedTime), `最近时间按本地时区格式化：${text}`);
  assert.match(state.describeSync(undefined), /还没有同步过/u);
  assert.match(state.describeSync({ id: 'a', status: 'ok', rows: 1, at: 1767225600000 }), /同步成功：1 行/u);

  const connected = { id: 'a', name: 'notes', transport: 'stdio', enabled: true, configSaved: true, rows: ['chatdsh-connector-notes'], tools: ['mcp__notes__probe-tool'] };
  assert.equal(state.callDeniedReason(connected), undefined);
  assert.match(state.callDeniedReason({ ...connected, enabled: false }) ?? '', /已停用/u);
  assert.match(state.callDeniedReason({ ...connected, tools: [] }) ?? '', /没有这台服务器的工具/u);
});

test('注册表行标识按服务器名去重排序，工具名拆出服务器段', () => {
  assert.deepEqual(
    state.registryServersOf(['chatdsh-mcp-endpoint-b', 'chatdsh-mcp-endpoint-a', 'chatdsh-mcp-endpoint-b', 'chatdsh-connector-c']),
    ['a', 'b'],
  );
  assert.deepEqual(state.registryServersOf([]), []);
  assert.equal(state.toolServerOf('mcp__notes-server__probe-tool'), 'notes-server');
  assert.equal(state.toolServerOf('mcp__notes-server'), undefined);
  assert.equal(state.toolServerOf('plain-tool'), undefined);
});

test('失败说明区分离线、能力缺失与宿主边界错误', () => {
  assert.equal(state.describeFailure({ code: 'client/offline', message: 'x' }), '控制平面不可达，恢复连接后重新加载。');
  assert.equal(state.describeFailure({ code: 'client/unavailable', message: 'x' }), '当前部署没有提供这项能力。');
  assert.equal(state.describeFailure({ code: 'gateway/internal', message: '连接器 x 不存在' }), '连接器 x 不存在。');
  assert.equal(state.describeFailure({ code: 'gateway/internal', message: '' }), '宿主没有完成这次调用，也没有给出说明。');
  assert.equal(state.describeFailure({ code: 'request-invalid', message: '字段不合法' }), '字段不合法（request-invalid）');
  assert.equal(state.describeFailure('boom'), '操作没有完成，请稍后再试。');
});

test('草稿与记录互转保留条件字段，目标说明按传输方式给出', () => {
  const stdio = recordOf({ args: ['--dir', '/srv/notes'], credentialEnv: 'CHATDSH_TOKEN' });
  const draft = state.draftOfRecord(stdio);
  assert.equal(draft.argsText, '["--dir","/srv/notes"]');
  assert.equal(draft.credentialEnv, 'CHATDSH_TOKEN');
  assert.equal(state.targetOf(stdio), 'notes-mcp --dir /srv/notes');
  const http = recordOf({ transport: 'http', command: undefined, url: 'https://example.test/mcp' });
  assert.equal(state.targetOf(http), 'https://example.test/mcp');
  assert.equal(state.draftOfRecord(http).argsText, '');
  assert.equal(state.transportLabelOf('stdio'), 'stdio');
  assert.equal(state.transportLabelOf('http'), 'http');
});
