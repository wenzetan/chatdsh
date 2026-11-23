#!/usr/bin/env node
// 分层依赖方向的核对。
//
// 角色目录决定允许的依赖方向：
//   core     只依赖 core 自身、适配层与上游
//   host     只依赖 core、其它 host 包与适配层
//   client   只依赖 core
//   bundle   可以依赖全部自建包
//   gateway  只依赖 core
// 适配层（dsh-adapter）不依赖任何自建运行时包。
//
// 另外核对客户端插件不引用第三方插件包：`dsh.client.inject` 里只允许上游包。
//
// 用法：node scripts/check-layering.mjs
// 退出码 0 表示方向正确，1 表示存在反向依赖。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(import.meta.filename), '..');
const REPO = resolve(ROOT, '..');
const failures = [];

/** 角色目录允许的自建依赖。 */
const ALLOWED = {
  core: [/^@chatdsh\/core-/, /^@chatdsh\/adapter$/],
  host: [/^@chatdsh\/core-/, /^@chatdsh\/host-/, /^@chatdsh\/adapter$/],
  client: [/^@chatdsh\/core-/],
  bundle: [/^@chatdsh\//],
};

function manifestOf(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

function depsOf(manifest) {
  return {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
  };
}

for (const role of Object.keys(ALLOWED)) {
  const base = join(ROOT, 'packages', role);
  if (!existsSync(base)) {
    failures.push(`缺少角色目录 packages/${role}`);
    continue;
  }
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    if (!existsSync(join(dir, 'package.json'))) continue;
    const manifest = manifestOf(dir);
    for (const name of Object.keys(depsOf(manifest))) {
      if (!name.startsWith('@chatdsh/')) continue;
      if (name === manifest.name) continue;
      if (!ALLOWED[role].some((pattern) => pattern.test(name))) {
        failures.push(`packages/${role}/${entry.name} 依赖了 ${name}，${role} 角色不允许这个方向`);
      }
    }
  }
}

for (const name of ['gateway']) {
  const dir = join(ROOT, name);
  if (!existsSync(join(dir, 'package.json'))) continue;
  const manifest = manifestOf(dir);
  for (const dep of Object.keys(depsOf(manifest))) {
    if (!dep.startsWith('@chatdsh/')) continue;
    if (/^@chatdsh\/core-/.test(dep)) continue;
    failures.push(`${name} 依赖了 ${dep}，该层只允许依赖 core`);
  }
}

const adapterManifest = join(REPO, 'dsh-adapter', 'package.json');
if (existsSync(adapterManifest)) {
  const manifest = JSON.parse(readFileSync(adapterManifest, 'utf8'));
  for (const dep of Object.keys(depsOf(manifest))) {
    // 唯一豁免是契约包：适配器转出上游类型时必须引用契约里的类型，且契约包不含任何实现。
    if (dep === '@chatdsh/core-contracts') continue;
    if (dep.startsWith('@chatdsh/')) failures.push(`dsh-adapter 依赖了自建运行时包 ${dep}`);
  }
}

// 客户端插件只允许注入上游包。
for (const entry of readdirSync(join(ROOT, 'packages', 'client'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = join(ROOT, 'packages', 'client', entry.name, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const injected of manifest.dsh?.client?.inject ?? []) {
    if (typeof injected !== 'string') continue;
    if (!injected.startsWith('@deepseek-ai/')) {
      failures.push(`packages/client/${entry.name} 的 dsh.client.inject 里出现非上游包 ${injected}`);
    }
  }
}

if (failures.length > 0) {
  console.log(`失败项：\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('分层依赖方向核对通过');
