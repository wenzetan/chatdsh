// WP07 命令面板、类型触发、引用对象与无障碍约定的真实函数测试。
//
// 断言覆盖：命令过滤与最近使用、层级返回、禁用原因、键盘意图；`/` 与 `@` 触发的识别与条目
// 分组；引用对象的失效、移除与范围平移；实时播报不逐 token 打断、焦点交接与整屏按键意图。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CommandPalette,
  LiveAnnouncer,
  buildConversationCommands,
  conversationKeyIntent,
  detectTrigger,
  filterCommands,
  filterTriggerItems,
  focusNeighborAfterRemove,
  groupTriggerItems,
  isPaletteShortcut,
  movePaletteSelection,
  orderByRecent,
  paletteKeyIntent,
  shiftSpans,
  toDraftReferences,
  toTriggerItems,
  triggerStartsAt,
  validateReferences,
} from '../../packages/client/conversation/lib/index.js';

/** 一条命令。 */
function command(id, name, extra = {}) {
  return { id, name, group: '会话', scope: 'session', enabled: true, ...extra };
}

test('命令按名称、分组、说明与快捷键过滤，最近使用排在前面', () => {
  const commands = [
    command('send-message', '发送消息', { shortcut: 'Enter' }),
    command('stop-run', '停止当前运行', { shortcut: 'Esc' }),
    command('open-queue', '打开待发送队列', { description: '查看待发送内容' }),
  ];
  assert.deepEqual(filterCommands(commands, '').map((item) => item.id), ['send-message', 'stop-run', 'open-queue']);
  assert.deepEqual(filterCommands(commands, '停止').map((item) => item.id), ['stop-run']);
  assert.deepEqual(filterCommands(commands, '队列').map((item) => item.id), ['open-queue']);
  assert.deepEqual(filterCommands(commands, 'ESC').map((item) => item.id), ['stop-run']);
  assert.deepEqual(filterCommands(commands, '没有').map((item) => item.id), []);
  assert.deepEqual(orderByRecent(commands, ['open-queue']).map((item) => item.id), ['open-queue', 'send-message', 'stop-run']);
  assert.equal(movePaletteSelection(-1, 'ArrowDown', 3), 0);
  assert.equal(movePaletteSelection(2, 'ArrowDown', 3), 0);
  assert.equal(movePaletteSelection(0, 'ArrowUp', 3), 2);
  assert.equal(movePaletteSelection(1, 'Home', 3), 0);
  assert.equal(movePaletteSelection(1, 'End', 3), 2);
  assert.equal(movePaletteSelection(0, 'ArrowDown', 0), -1);
  assert.equal(isPaletteShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }), true);
  assert.equal(isPaletteShortcut({ key: 'k', ctrlKey: true, metaKey: true, altKey: false, shiftKey: false }), false);
});

test('命令面板：查询、移动、执行、子级进入与返回，禁用命令不执行', () => {
  const child = [command('settings:general', '设置：通用', { group: '设置' }), command('settings:models', '设置：模型', { group: '设置' })];
  const commands = [
    command('send-message', '发送消息'),
    command('stop-run', '停止当前运行', { enabled: false, disabledReason: '当前没有运行' }),
    command('more', '更多设置', { children: child }),
  ];
  const palette = new CommandPalette({ recent: [] });
  assert.equal(palette.isOpen, false);
  palette.open(commands);
  assert.equal(palette.isOpen, true);
  assert.equal(palette.levelLabel, '命令');
  assert.equal(palette.active().id, 'send-message', '打开时选中第一条可用命令');

  palette.setQuery('停止');
  assert.equal(palette.filtered().length, 1);
  assert.equal(palette.active().id, 'stop-run');
  assert.deepEqual(palette.select(), { kind: 'none', reason: '当前没有运行' }, '禁用命令返回原因，不执行');

  palette.setQuery('');
  palette.move('End');
  assert.equal(palette.active().id, 'more');
  const entered = palette.select();
  assert.equal(entered.kind, 'enter');
  assert.equal(palette.levelLabel, '更多设置');
  assert.equal(palette.canGoBack, true);
  assert.equal(palette.back(), true);
  assert.equal(palette.levelLabel, '命令');
  assert.equal(palette.back(), false, '根层不能再返回');

  palette.setQuery('');
  const executed = palette.select();
  assert.equal(executed.kind, 'execute');
  assert.equal(executed.command.id, 'send-message');
  assert.deepEqual(palette.recent, ['send-message'], '执行之后记入最近使用');

  palette.close();
  assert.equal(palette.isOpen, false);
  assert.equal(palette.filtered().length, 0);

  assert.deepEqual(paletteKeyIntent({ key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, { query: 'x' }), { kind: 'close' });
  assert.deepEqual(paletteKeyIntent({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, { query: '' }), { kind: 'select' });
  assert.deepEqual(paletteKeyIntent({ key: 'Backspace', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, { query: '' }), { kind: 'back' });
  assert.deepEqual(paletteKeyIntent({ key: 'Backspace', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, { query: 'a' }), { kind: 'none' });
  assert.deepEqual(paletteKeyIntent({ key: 'ArrowDown', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, { query: '' }), { kind: 'move', key: 'ArrowDown' });
  assert.deepEqual(
    paletteKeyIntent({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: true }, { query: '' }),
    { kind: 'none' },
    '输入法组合期间不执行命令'
  );
});

test('会话命令按设备、运行与队列状态给出禁用原因', () => {
  const commands = buildConversationCommands({
    canSend: false,
    sendBlockerReason: '没有可以发送的内容',
    running: false,
    deviceOnline: false,
    queued: 0,
    hasLastMessage: false,
    announcementsPaused: false,
  });
  const byId = new Map(commands.map((item) => [item.id, item]));
  assert.equal(byId.get('send-message').enabled, false);
  assert.match(byId.get('send-message').disabledReason, /目标设备离线/);
  assert.equal(byId.get('stop-run').enabled, false);
  assert.match(byId.get('stop-run').disabledReason, /当前没有运行/);
  assert.equal(byId.get('open-queue').enabled, false);
  assert.match(byId.get('open-queue').disabledReason, /没有待发送内容/);
  assert.equal(byId.get('copy-last-message').enabled, false);
  assert.equal(byId.get('insert-reference').enabled, false);
  assert.match(byId.get('insert-reference').disabledReason, /引用目录读不到/);
  assert.equal(byId.get('toggle-announcements').name, '暂停实时播报');

  const online = buildConversationCommands({
    canSend: true,
    running: true,
    deviceOnline: true,
    queued: 2,
    hasLastMessage: true,
    announcementsPaused: true,
  });
  const onlineById = new Map(online.map((item) => [item.id, item]));
  assert.equal(onlineById.get('send-message').enabled, true);
  assert.equal(onlineById.get('stop-run').enabled, true);
  assert.equal(onlineById.get('open-queue').enabled, true);
  assert.match(onlineById.get('open-queue').description, /2 条待发送内容/);
  assert.equal(onlineById.get('toggle-announcements').name, '恢复实时播报');
  assert.equal(onlineById.get('copy-last-message').enabled, true);
});

test('类型触发只在词首生效，条目按分组聚合，选中后替换查询文本', () => {
  assert.equal(triggerStartsAt('abc', 0), true);
  assert.equal(triggerStartsAt('abc', 2), false);
  assert.equal(triggerStartsAt('ab c', 3), true);
  assert.equal(triggerStartsAt('ab\nc', 3), true);
  assert.deepEqual(detectTrigger('/com', 4), { kind: 'command', start: 0, end: 4, query: 'com' });
  assert.deepEqual(detectTrigger('看 @会话', 5), { kind: 'reference', start: 2, end: 5, query: '会话' });
  assert.equal(detectTrigger('看@会话', 4), undefined, '没有空白的 @ 不触发');
  assert.equal(detectTrigger('/ com', 5), undefined, '触发字符与光标之间有空白时不触发');
  assert.equal(detectTrigger('a/b', 3), undefined);
  assert.throws(() => detectTrigger('abc', 9), /光标位置超出文本范围/);

  const items = toTriggerItems([
    { id: 'f1', kind: 'file', label: 'index.ts', group: '文件', origin: 'local', description: '入口文件' },
    { id: 's1', kind: 'session', label: '会话乙', group: '会话', origin: 'remote' },
    { id: 'm1', kind: 'memory', label: '偏好', group: '记忆', origin: 'local', unavailableReason: '记忆不可达' },
  ]);
  assert.equal(items.length, 3);
  assert.deepEqual(filterTriggerItems(items, '入口').map((item) => item.id), ['f1']);
  assert.deepEqual(filterTriggerItems(items, '会话').map((item) => item.id), ['s1']);
  assert.deepEqual(filterTriggerItems(items, '').length, 3);
  const groups = groupTriggerItems(filterTriggerItems(items, ''));
  assert.deepEqual(groups.map((group) => group.group), ['文件', '会话', '记忆']);
  assert.equal(groups[2].items[0].unavailableReason, '记忆不可达');
});

test('引用对象失效标记、移除与范围平移', () => {
  const references = [
    { id: 'f1', kind: 'file', label: 'index.ts', origin: 'local', spanStart: 4, spanEnd: 14, available: true },
    { id: 's1', kind: 'session', label: '会话乙', origin: 'remote', spanStart: 20, spanEnd: 27, available: true },
  ];
  const { references: updated, invalidated } = validateReferences(references, [
    { kind: 'file', id: 'f1' },
    { kind: 'session', id: 's1', reason: 'unreachable' },
  ]);
  assert.equal(updated[0].available, true);
  assert.equal(updated[1].available, false);
  assert.equal(updated[1].invalidReason, 'unreachable');
  assert.equal(invalidated.length, 1);

  const missing = validateReferences(references, [{ kind: 'file', id: 'f1' }]);
  assert.equal(missing.references[1].invalidReason, 'deleted');

  const shifted = shiftSpans(references, 0, 0, 3);
  assert.equal(shifted[0].spanStart, 7);
  assert.equal(shifted[1].spanEnd, 30);
  assert.throws(() => shiftSpans(references, 0, 6, 0), /引用对象与修改区间重叠/);

  const draft = toDraftReferences([
    ...references,
    { id: 'm1', kind: 'memory', label: '偏好', origin: 'local', spanStart: 30, spanEnd: 35, available: true },
  ]);
  assert.equal(draft.persisted.length, 2);
  assert.equal(draft.dropped.length, 1);
  assert.equal(draft.dropped[0].reason, 'memory-content-not-persisted');
});

test('实时播报按语义片段播报，不逐 token 打断读屏', () => {
  let clock = 0;
  const announcer = new LiveAnnouncer({ now: () => clock, throttleMs: 500, segmentChars: 40 });
  assert.equal(announcer.push('今'), undefined);
  assert.equal(announcer.push('天'), undefined);
  assert.equal(announcer.push('天气'), undefined);
  assert.equal(announcer.lastAnnounced, '', '没有到语义边界时不播报');
  assert.equal(announcer.buffered, '今天天气');
  clock = 100;
  const boundary = announcer.push('很好。');
  assert.deepEqual(boundary, { text: '今天天气很好。', urgent: false });
  assert.equal(announcer.lastAnnounced, '今天天气很好。');

  clock = 200;
  assert.equal(announcer.push('下一句。'), undefined, '节流窗口内不再次播报');
  clock = 700;
  assert.deepEqual(announcer.push('再来。'), { text: '下一句。再来。', urgent: false }, '窗口结束后把累积内容一次播报');

  announcer.pause();
  clock = 2_000;
  assert.equal(announcer.push('暂停期间的片段。'), undefined);
  assert.equal(announcer.buffered, '暂停期间的片段。');
  announcer.resume();
  assert.deepEqual(announcer.push('恢复。'), { text: '暂停期间的片段。恢复。', urgent: false });

  const urgent = announcer.flush('连接中断', true);
  assert.deepEqual(urgent, { text: '连接中断', urgent: true });

  const buffer = new LiveAnnouncer({ now: () => 10_000, throttleMs: 0, segmentChars: 6 });
  const forced = buffer.push('没有标点的一长串文字');
  assert.ok(forced !== undefined, '缓冲达到上限时播报一次，避免无界增长');
});

test('焦点交接与整屏按键意图', () => {
  assert.equal(focusNeighborAfterRemove(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(focusNeighborAfterRemove(['a', 'b', 'c'], 'c'), 'b');
  assert.equal(focusNeighborAfterRemove(['a'], 'a'), undefined);
  assert.throws(() => focusNeighborAfterRemove(['a'], 'z'), /不在列表里/);

  const base = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  assert.equal(conversationKeyIntent({ ...base, key: 'k', ctrlKey: true }, { paletteOpen: false, running: false }), 'open-palette');
  assert.equal(conversationKeyIntent({ ...base, key: 'k', metaKey: true }, { paletteOpen: false, running: false }), 'open-palette');
  assert.equal(conversationKeyIntent({ ...base, key: 'Escape' }, { paletteOpen: true, running: true }), 'close-palette');
  assert.equal(conversationKeyIntent({ ...base, key: 'Escape' }, { paletteOpen: false, running: true }), 'stop-run');
  assert.equal(conversationKeyIntent({ ...base, key: 'Escape' }, { paletteOpen: false, running: false }), 'none');
  assert.equal(conversationKeyIntent({ ...base, key: 'Escape', isComposing: true }, { paletteOpen: false, running: true }), 'none');
  assert.equal(conversationKeyIntent({ ...base, key: 'a', ctrlKey: true, shiftKey: true }, { paletteOpen: false, running: false }), 'toggle-announcements');
  assert.equal(conversationKeyIntent({ ...base, key: 'Enter', altKey: true }, { paletteOpen: false, running: false }), 'focus-composer');
});
