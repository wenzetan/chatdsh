// 核对移动网关插件的挂载配置。
//
// 插件是上游包，它的配置错误不会在编译期暴露，只在运行时表现为「1 entry did not activate」。
// 这里把关键约束做成静态检查：依赖已声明、锁文件有条目、补丁层有插件行、状态文件落在
// 数据根、局域网监听与设备鉴权的取值符合设计、版本与实测通过的版本一致。
//
// 用法：node scripts/check-mobile-plugin.mjs
// 退出码 0 表示配置一致。

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PROFILE = join(ROOT, 'profiles', 'chatdsh-web');
const MANIFEST = join(PROFILE, 'package.json');
const LOCK = join(PROFILE, 'pnpm-lock.yaml');
const PATCH = join(PROFILE, 'cordis.patch.yml');

/** 允许的插件版本；与实机验证过的版本一致。 */
const EXPECTED_VERSION = '0.11.1';

const failures = [];

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const declared = manifest.dependencies?.['dsh-plugin-mobile-gateway'];
if (declared === undefined) failures.push('profile 的 package.json 没有声明 dsh-plugin-mobile-gateway');
else if (declared !== EXPECTED_VERSION) {
  failures.push(`插件版本是 ${declared}，与实测通过的 ${EXPECTED_VERSION} 不一致；升级前先做一次真实连接验证`);
}

if (!existsSync(LOCK)) failures.push('profile 缺少 pnpm-lock.yaml');
else if (!readFileSync(LOCK, 'utf8').includes('dsh-plugin-mobile-gateway')) {
  failures.push('pnpm-lock.yaml 里没有 dsh-plugin-mobile-gateway；先在 profile 目录执行 pnpm install');
}

if (!existsSync(join(PROFILE, 'node_modules', 'dsh-plugin-mobile-gateway'))) {
  failures.push('profile 的 node_modules 里没有插件；先在 profile 目录执行 pnpm install');
}

const patch = readFileSync(PATCH, 'utf8');
// 插件行必须是一条 insert，并且设置项里不含注释掉的占位写法。
const block = patch.split('\n- insert:').find((section) => section.includes("name: 'dsh-plugin-mobile-gateway'"));
if (block === undefined) failures.push('cordis.patch.yml 里没有挂载 dsh-plugin-mobile-gateway 的 insert 行');
else {
  const setting = (name) => {
    const match = block.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'));
    return match === null ? undefined : match[1].trim();
  };
  const path = setting('path');
  if (path !== "'/ws/mobile'") failures.push(`插件路径应为 '/ws/mobile'，实际为 ${path ?? '未设置'}`);
  const lanEnabled = setting('lanEnabled');
  if (lanEnabled !== 'false') failures.push(`lanEnabled 应为 false（手机只经控制平面接入），实际为 ${lanEnabled ?? '未设置'}`);
  const requireAuth = setting('requireAuth');
  if (requireAuth !== 'false') {
    failures.push(
      `requireAuth 应为 false：插件只接受本机回环直连，鉴权由控制平面在转发前完成；实际为 ${requireAuth ?? '未设置'}`
    );
  }
  const adminLoopbackOnly = setting('adminLoopbackOnly');
  if (adminLoopbackOnly !== 'true') failures.push(`adminLoopbackOnly 应为 true，实际为 ${adminLoopbackOnly ?? '未设置'}`);
  for (const key of ['deviceFile', 'gatewayStateFile']) {
    const value = setting(key);
    if (value === undefined) failures.push(`插件配置缺少 ${key}；缺省会写到用户主目录，只读环境会让整行不激活`);
    else if (!value.includes('dshHomePath(')) failures.push(`${key} 必须落在数据根下（用 dshHomePath 表达式），实际为 ${value}`);
  }
}

if (failures.length > 0) {
  for (const line of failures) console.log(`失败 ${line}`);
  process.exit(1);
}
console.log(`移动网关插件 ${EXPECTED_VERSION} 的挂载配置一致`);
