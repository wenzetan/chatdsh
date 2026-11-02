// WP05 命令面板与键盘约定的验收测试。
//
// 命令描述符用真实契约 `commandDescriptorSchema` 校验，快捷键判定、过滤、选中移动与最近使用
// 记录使用外壳的真实实现。浏览器存储用内存实现（Node 没有 `localStorage`）；真实按键与焦点
// 行为由同编号的 Chrome 用例覆盖。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandDescriptorSchema } from '../../packages/core/contracts/lib/navigation.js';
import {
  buildShellCommands,
  filterCommands,
  isPaletteNavigationKey,
  isPaletteShortcut,
  movePaletteSelection,
  orderByRecent,
  PALETTE_SHORTCUT_LABEL,
  readRecentCommands,
  recentCommandsStorageKey,
  recordRecentCommand,
  RECENT_COMMANDS_MAX,
  SETTINGS_SECTION_TITLES,
} from '../../packages/client/shell/lib/client/commands.js';
import { SETTINGS_SECTIONS } from '../../packages/client/shell/lib/client/route.js';

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

/** 写入时抛错的存储。 */
class FailingStorage extends MemoryStorage {
  setItem() {
    throw new DOMException('拒绝写入', 'QuotaExceededError');
  }
}

test('快捷键判定：Ctrl+K 与 Cmd+K 打开面板，带其他修饰键不触发', () => {
  const base = { altKey: false, shiftKey: false };
  assert.equal(isPaletteShortcut({ ...base, key: 'k', ctrlKey: true, metaKey: false }), true);
  assert.equal(isPaletteShortcut({ ...base, key: 'K', ctrlKey: true, metaKey: false }), true);
  assert.equal(isPaletteShortcut({ ...base, key: 'k', ctrlKey: false, metaKey: true }), true);
  assert.equal(isPaletteShortcut({ ...base, key: 'k', ctrlKey: false, metaKey: false }), false);
  assert.equal(isPaletteShortcut({ ...base, key: 'k', ctrlKey: true, metaKey: true }), false);
  assert.equal(isPaletteShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: true, shiftKey: false }), false);
  assert.equal(isPaletteShortcut({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }), false);
  assert.equal(isPaletteShortcut({ ...base, key: 'j', ctrlKey: true, metaKey: false }), false);
  assert.equal(PALETTE_SHORTCUT_LABEL, 'Ctrl/Cmd+K');
});

test('命令列表：每条都是合法描述符，设置区段逐段覆盖，禁用时给出原因', () => {
  const states = [
    { hasSelection: false, localAvailable: false, localReason: undefined },
    { hasSelection: false, localAvailable: true, localReason: undefined },
    { hasSelection: true, localAvailable: false, localReason: '本机运行时未登记为设备' },
    { hasSelection: true, localAvailable: true, localReason: undefined },
  ];
  for (const state of states) {
    const commands = buildShellCommands(state);
    const ids = new Set();
    for (const command of commands) {
      const parsed = commandDescriptorSchema.safeParse(command);
      assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
      assert.equal(ids.has(command.id), false, `命令标识重复：${command.id}`);
      ids.add(command.id);
      if (!command.enabled) assert.equal(typeof command.disabledReason, 'string');
      else assert.equal(command.disabledReason, undefined);
    }
    assert.deepEqual(
      commands.filter((command) => command.id.startsWith('settings:')).map((command) => command.id),
      SETTINGS_SECTIONS.map((section) => `settings:${section}`)
    );
    for (const section of SETTINGS_SECTIONS) {
      assert.equal(typeof SETTINGS_SECTION_TITLES[section], 'string');
      const command = commands.find((entry) => entry.id === `settings:${section}`);
      assert.equal(command.name, `设置：${SETTINGS_SECTION_TITLES[section]}`);
    }
    const continueLocal = commands.find((command) => command.id === 'continue-local');
    assert.equal(continueLocal.enabled, state.hasSelection && state.localAvailable);
    if (!continueLocal.enabled) {
      assert.equal(
        continueLocal.disabledReason,
        state.hasSelection ? state.localReason : '先选择一条会话'
      );
    }
  }
});

test('命令过滤：名称、分组与说明都参与匹配，空文本返回全部', () => {
  const commands = buildShellCommands({ hasSelection: false, localAvailable: false, localReason: undefined });
  assert.equal(filterCommands(commands, '').length, commands.length);
  assert.deepEqual(
    filterCommands(commands, '新建').map((command) => command.id),
    ['new-session', 'continue-local'],
    '说明里带「新建」的命令同样命中'
  );
  assert.deepEqual(filterCommands(commands, '设置').length, SETTINGS_SECTIONS.length);
  assert.deepEqual(filterCommands(commands, '设备').map((command) => command.id).includes('settings:devices'), true);
  assert.deepEqual(filterCommands(commands, '没有这条命令'), []);
  // 大小写不敏感。
  assert.deepEqual(filterCommands(commands, ' ').length, commands.length);
});

test('选中移动：方向键在两端循环，Home/End 跳到首尾，空列表为 -1', () => {
  assert.equal(movePaletteSelection(-1, 'ArrowDown', 3), 0);
  assert.equal(movePaletteSelection(2, 'ArrowDown', 3), 0);
  assert.equal(movePaletteSelection(0, 'ArrowUp', 3), 2);
  assert.equal(movePaletteSelection(1, 'ArrowUp', 3), 0);
  assert.equal(movePaletteSelection(2, 'Home', 3), 0);
  assert.equal(movePaletteSelection(0, 'End', 3), 2);
  assert.equal(movePaletteSelection(0, 'ArrowDown', 0), -1);
  assert.equal(isPaletteNavigationKey('ArrowDown'), true);
  assert.equal(isPaletteNavigationKey('Enter'), false);
});

test('最近使用：只存命令标识、最近的在前、去重并限制条数', () => {
  const storage = new MemoryStorage();
  assert.deepEqual(readRecentCommands(storage, 'client-1'), []);
  assert.deepEqual(recordRecentCommand(storage, 'client-1', 'new-session'), ['new-session']);
  assert.deepEqual(recordRecentCommand(storage, 'client-1', 'go-list'), ['go-list', 'new-session']);
  assert.deepEqual(recordRecentCommand(storage, 'client-1', 'new-session'), ['new-session', 'go-list']);
  for (let index = 0; index < RECENT_COMMANDS_MAX + 5; index += 1) {
    recordRecentCommand(storage, 'client-1', `command-${String(index)}`);
  }
  const recent = readRecentCommands(storage, 'client-1');
  assert.equal(recent.length, RECENT_COMMANDS_MAX);
  assert.equal(recent[0], `command-${String(RECENT_COMMANDS_MAX + 4)}`);
  const stored = JSON.parse(storage.getItem(recentCommandsStorageKey('client-1')));
  assert.equal(stored.every((entry) => typeof entry === 'string'), true, '只保存标识');
  // 另一台客户端互不影响。
  assert.deepEqual(readRecentCommands(storage, 'client-2'), []);
  // 存储被拒绝时不影响返回值，也不会抛错。
  const failing = new FailingStorage();
  assert.deepEqual(recordRecentCommand(failing, 'client-1', 'go-list'), ['go-list']);
  assert.deepEqual(readRecentCommands(undefined, 'client-1'), []);
  storage.setItem(recentCommandsStorageKey('client-1'), '["ok","", 3, "ok"]');
  assert.deepEqual(readRecentCommands(storage, 'client-1'), ['ok'], '非法条目被丢弃并去重');
});

test('最近使用排序：用过的排前面，其余保持原顺序', () => {
  const commands = buildShellCommands({ hasSelection: false, localAvailable: false, localReason: undefined });
  const ordered = orderByRecent(commands, ['diagnostics', 'new-session']);
  assert.equal(ordered[0].id, 'diagnostics');
  assert.equal(ordered[1].id, 'new-session');
  assert.deepEqual(
    ordered.slice(2).map((command) => command.id),
    commands.filter((command) => command.id !== 'diagnostics' && command.id !== 'new-session').map((command) => command.id)
  );
});
