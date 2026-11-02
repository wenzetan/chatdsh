// WP32 原生能力策略。
//
// 外部打开只放行 http 与 https，文件打开只放行允许目录内的非可执行文件，目录选择只接受
// 用户亲自选出的真实目录，剪贴板只接受文本。每个拒绝分支都核对原因代码。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import {
  BLOCKED_EXTENSIONS, NativeRejection, assertClipboardText, assertControlledPath, assertDirectoryChoice,
  assertExternalUrl, classifyOpenTarget, directoryPickerOptions,
} from '../../desktop/electron/native.mjs';

test('外部打开接受 http 与 https', () => {
  assert.equal(assertExternalUrl('https://example.com/docs?a=1').protocol, 'https:');
  assert.equal(assertExternalUrl('  http://127.0.0.1:3170/chatdsh/boot/x  ').hostname, '127.0.0.1');
  const classified = classifyOpenTarget('https://example.com/', []);
  assert.deepEqual(classified, { kind: 'url', value: 'https://example.com/' });
});

test('外部打开拒绝其他协议、凭据与空地址', () => {
  const cases = [
    ['javascript:alert(1)', 'url-scheme'],
    ['file:///etc/passwd', 'url-scheme'],
    ['data:text/html,<b>x</b>', 'url-scheme'],
    ['vscode://file/x', 'url-scheme'],
    ['https://user:secret@example.com/', 'url-credentials'],
    ['', 'url-empty'],
    ['not a url', 'url-malformed'],
  ];
  for (const [raw, code] of cases) {
    assert.throws(() => assertExternalUrl(raw), (error) => error instanceof NativeRejection && error.code === code, raw);
  }
});

test('文件打开限制在允许目录内且拦截可执行文件', () => {
  const root = tempHome('wp32-native');
  const inside = join(root, 'logs', 'desktop.log');
  mkdirSync(join(root, 'logs'), { recursive: true });
  writeFileSync(inside, 'line\n');
  assert.equal(assertControlledPath(inside, [root]), inside);
  assert.throws(() => assertControlledPath('/etc/passwd', [root]), (error) => error.code === 'path-escape');
  assert.throws(() => assertControlledPath('logs/desktop.log', [root]), (error) => error.code === 'path-not-absolute');
  assert.throws(() => assertControlledPath(join(root, 'missing.log'), [root]), (error) => error.code === 'path-missing');
  const script = join(root, 'setup.exe');
  writeFileSync(script, 'binary');
  assert.throws(() => assertControlledPath(script, [root]), (error) => error.code === 'path-executable');
  assert.ok(BLOCKED_EXTENSIONS.includes('.exe'));
  assert.ok(BLOCKED_EXTENSIONS.includes('.ps1'));
  const nested = join(root, 'logs', '..', 'logs', 'desktop.log');
  assert.equal(assertControlledPath(nested, [root]), inside);
});

test('分类器把路径与地址分开处理', () => {
  const root = tempHome('wp32-native-classify');
  const file = join(root, 'report.html');
  writeFileSync(file, '<html></html>');
  assert.deepEqual(classifyOpenTarget(file, [root]), { kind: 'file', value: file });
  assert.throws(() => classifyOpenTarget('   ', [root]), (error) => error.code === 'target-empty');
  assert.throws(() => classifyOpenTarget('C:\\Users\\me\\a.txt', [root]), (error) => error.code === 'path-not-absolute');
});

test('目录选择选项与结果校验', () => {
  assert.equal(directoryPickerOptions('workspace').title, '选择工作区目录');
  assert.deepEqual(directoryPickerOptions('export').properties, ['openDirectory', 'createDirectory']);
  assert.throws(() => directoryPickerOptions('unknown'), (error) => error.code === 'purpose-unknown');
  const root = tempHome('wp32-native-picker');
  const nested = join(root, 'work');
  mkdirSync(nested);
  assert.equal(assertDirectoryChoice([nested]), nested);
  assert.throws(() => assertDirectoryChoice([]), (error) => error.code === 'picker-cancelled');
  assert.throws(() => assertDirectoryChoice(['relative/dir']), (error) => error.code === 'picker-not-absolute');
  assert.throws(() => assertDirectoryChoice([join(root, 'none')]), (error) => error.code === 'picker-missing');
  writeFileSync(join(root, 'file.txt'), 'x');
  assert.throws(() => assertDirectoryChoice([join(root, 'file.txt')]), (error) => error.code === 'picker-not-directory');
  assert.throws(() => assertDirectoryChoice([nested, root]), (error) => error.code === 'picker-multiple');
});

test('剪贴板只接受非空文本', () => {
  assert.equal(assertClipboardText('复制的文本'), '复制的文本');
  assert.throws(() => assertClipboardText(12), (error) => error.code === 'clipboard-not-text');
  assert.throws(() => assertClipboardText(''), (error) => error.code === 'clipboard-empty');
  assert.throws(() => assertClipboardText('a\u0000b'), (error) => error.code === 'clipboard-control');
});
