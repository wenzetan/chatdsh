// WP00 环境验证：版本基线、真实服务可达性、独立数据根与清理断言。
//
// 条件按 docs/README.md 第二节的取法测量，兼容范围取 docs/compatibility.md 第一节。
// 缺失的服务、命令与凭据都进入报告，失败用例直接断言失败，不做跳过。
import { writeFileSync, existsSync, mkdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import semver from 'semver';
import { ensureDeps } from '../lib/ensure-deps.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
ensureDeps(ROOT);
ensureDeps(resolve(ROOT, '..', 'dsh-adapter'));
const environment = await import('../lib/environment.mjs');

/** 本工作包的真实服务清单。凭据类服务的探测结果单独解释。 */
const SERVICES = [
  { name: 'Hindsight', url: 'http://127.0.0.1:8889/version', note: '记忆服务版本端点' },
  { name: 'Hermes', url: 'http://127.0.0.1:8642/health', note: '聊天后端健康端点' },
  { name: 'OpenObserve', url: 'http://127.0.0.1:5080/healthz', note: '遥测查询端点' },
  { name: '模型网关', url: 'http://127.0.0.1:20128/v1/models', note: '需要 CHATDSH_TEST_GATEWAY_API_KEY 才能完成模型验签' },
];

test('Node、DSH 内核与平台满足仓库基线', async () => {
  const versions = environment.probeVersions();
  assert.ok(semver.satisfies(versions.node.version.replace(/^v/, ''), environment.BASELINE.node), `Node 版本不满足：${versions.node.version}`);
  assert.ok(
    semver.satisfies(versions.dsh.version, environment.BASELINE.dsh, { includePrerelease: true }),
    `DSH 内核版本不满足：${versions.dsh.version}`,
  );
  assert.ok(versions.dsh.entries > 0, 'DSH 安装里没有可枚举的包');
  assert.equal(versions.platform.os, 'linux');
  console.log(`版本：node ${versions.node.version}、dsh ${versions.dsh.version}（${versions.dsh.entries} 个包）、Chrome ${versions.chrome.version}`);

  const baseline = environment.checkBaseline(versions);
  for (const item of baseline) {
    console.log(`基线 ${item.ok ? '满足' : '不满足'}：${item.item} 要求 ${item.required}，实际 ${item.actual}${item.note === undefined ? '' : `（${item.note}）`}`);
  }
  const nodeItem = baseline.find((item) => item.item === 'node');
  const dshItem = baseline.find((item) => item.item === 'dsh');
  assert.equal(nodeItem.ok, true);
  assert.equal(dshItem.ok, true);
  // dsh-tui 的偏差是真实条件，登记下来供 WP36 使用，不在本工作包内伪造满足。
  const tuiItem = baseline.find((item) => item.item === 'dsh-tui');
  assert.ok(tuiItem !== undefined, '基线里缺少 dsh-tui 条目');
  console.log(`dsh-tui 条件：${tuiItem.ok ? '与仓库钉住版本一致' : `偏差 ${tuiItem.actual}，钉住 ${tuiItem.required}`}`);
});

test('外部服务按事实返回可达性', async () => {
  const results = [];
  for (const spec of SERVICES) results.push(await environment.probeHttpService(spec));
  for (const result of results) {
    console.log(`服务 ${result.name}（${result.url}）：${result.reachable ? `${result.status} ${result.latencyMs} 毫秒` : `不可达 ${result.reason}`}`);
    assert.equal(result.reachable, true, `${result.name} 不可达：${result.url}`);
  }
  const model = results.find((result) => result.name === '模型网关');
  assert.ok(model.status === 401 || model.status === 200, `模型网关返回了非预期状态：${model.status}`);
  assert.equal(model.ready, model.status === 200);
  if (!model.ready) {
    console.log('模型网关的未认证请求未通过；真实模型能力仍需带认证请求验证');
  }
  const cold = await environment.probeHttpService({ name: '故意不可达', url: 'http://127.0.0.1:1/' });
  assert.equal(cold.reachable, false);
  assert.ok(typeof cold.reason === 'string' && cold.reason !== '');
});

test('独立数据根位于工作区内，清理后不留残余', () => {
  const home = environment.allocateIndependentHome('wp00');
  assert.ok(home.startsWith('/'), `数据根需要绝对路径：${home}`);
  assert.ok(home.startsWith(environment.workspaceRoot()), `数据根越过工作区：${home}`);
  assert.equal(existsSync(home), true);
  assert.equal(statSync(home).isDirectory(), true);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  const probe = join(home, 'probe.txt');
  writeFileSync(probe, 'wp00\n');
  assert.equal(existsSync(probe), true);

  const result = environment.releaseIndependentHome(home);
  assert.equal(result.removed, home);
  assert.equal(existsSync(home), false);

  const outside = resolve(environment.workspaceRoot(), '..', 'outside-home');
  assert.throws(() => environment.assertInsideWorkspace(outside), /目标不在工作区内/);
});

test('分配器拒绝路径穿越，清理只接受本次分配的目录', () => {
  assert.throws(() => environment.allocateIndependentHome('../escape'), /数据根前缀/);
  assert.throws(() => environment.allocateIndependentHome(''), /数据根前缀/);
  assert.throws(() => environment.releaseIndependentHome(environment.workspaceRoot()), /目标不在工作区内/);
  const home = environment.allocateIndependentHome('wp00-guard');
  try {
    const child = join(home, 'unowned');
    mkdirSync(child);
    assert.throws(() => environment.releaseIndependentHome(child), /未由本次执行分配/);
    const alias = join(home, 'alias');
    symlinkSync(child, alias, 'dir');
    assert.throws(() => environment.releaseIndependentHome(alias), /未由本次执行分配/);
    assert.equal(existsSync(child), true);
    unlinkSync(alias);
  } finally {
    environment.releaseIndependentHome(home);
  }
  assert.throws(() => environment.releaseIndependentHome(home), /未由本次执行分配/);
});

test('用户数据根在分配与清理期间保持不变', () => {
  const before = environment.snapshotUserHome();
  const home = environment.allocateIndependentHome('wp00-isolation');
  try {
    const userHome = process.env.DSH_HOME;
    if (userHome !== undefined && userHome !== '') assert.notEqual(home, resolve(userHome));
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(join(home, 'sessions', 'probe.jsonl'), '{}\n');
  } finally {
    environment.releaseIndependentHome(home);
  }
  const after = environment.snapshotUserHome();
  assert.deepEqual(after, before);
  if (before.configured === true) {
    assert.equal(existsSync(before.path), true);
    console.log(`用户数据根未改动：${before.path}`);
  } else {
    console.log('未设置 DSH_HOME，用户数据根隔离以分配路径互不相交为准');
  }
});

test('环境报告汇总缺失条件与真实证据', async () => {
  const report = await environment.probeEnvironment({ services: SERVICES });
  assert.ok(Array.isArray(report.missing));
  assert.equal(report.baseline.length >= 3, true);
  assert.equal(report.services.length, SERVICES.length);
  console.log(`环境报告：${JSON.stringify({ checkedAt: report.checkedAt, missing: report.missing }, null, 2)}`);
});
