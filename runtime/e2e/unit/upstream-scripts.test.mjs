// 上游脚本的回归测试。
//
// 两个脚本都在构建与升级流程里承担闸门职责：check-upstream-surface 核对安装面，
// upgrade-dsh 在 --dry-run 时必须只打印计划、不写文件。测试用真实脚本与真实安装目录，
// 不替身输出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const DSH_BIN = process.env.DSH_BIN ?? '/usr/local/nvm/versions/node/v24.19.0/bin/dsh';
const hasDsh = existsSync(DSH_BIN);

test('check-upstream-surface 在真实安装上通过并输出三行统计', { skip: hasDsh ? false : '缺少 DSH 安装' }, () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/check-upstream-surface.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DSH_BIN },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /实装包 \d+ 个，登记 \d+ 个/);
  assert.match(result.stdout, /补丁文件 \d+ 个，补丁行 \d+ 个/);
  assert.match(result.stdout, /能力清单 \d+ 行/);
  assert.match(result.stdout, /上游安装面核对通过/);
});

test('upgrade-dsh --dry-run 只打印计划，不修改适配层清单', () => {
  const manifest = join(ROOT, '..', 'dsh-adapter', 'package.json');
  const before = readFileSync(manifest, 'utf8');
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts/upgrade-dsh.mjs'), '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DSH_BIN },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[1\/5\]/);
  assert.match(result.stdout, /\[5\/5\]/);
  assert.match(result.stdout, /只打印计划，未写文件/);
  assert.equal(readFileSync(manifest, 'utf8'), before);
});
