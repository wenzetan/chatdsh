// 设置白名单同步的整机验收：一个真实控制平面与两台真实 dsh 运行时。
//
// 编排同 verify-device-link.mjs：控制平面不托管运行时，两台设备各跑一个真实安装的
// 官方 `dsh --profile web`，用配对得到的节点令牌连上控制平面。
//
// 断言按顺序打印：
//   1. 控制平面接受白名单命名空间的写入，并回传接收时刻；
//   2. 白名单之外的命名空间被拒绝（400 namespace-not-whitelisted）；
//   3. 在设备 A 上改一个白名单设置（agent-default-model 的 model），它被上报到控制平面；
//   4. 设备 A 上报的设置经控制平面推给设备 B，写进 B 的 home 层补丁文件；
//   5. 白名单之外的设置在设备侧被拒绝，且不进入任何设备的 home 层；
//   6. 过期版本写入返回冲突，同一命名空间的两个字段按接收时刻合并。
//
// 用法：node scripts/verify-settings-sync.mjs
// 退出码 0 表示全部通过。端口从 20180 起；被占用时顺延，并在输出里写明实际端口。

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';
import { installRuntimeProfile } from './lib/dsh-runtime.mjs';
import { findFreePort } from './lib/ports.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PAIRING_CODE = randomBytes(9).toString('base64url');
const failures = [];

if (!existsSync(join(ROOT, 'gateway', 'lib', 'main.js'))) {
  throw new Error('控制平面尚未编译：先执行 pnpm build');
}

/** 记一条断言结果。 */
function check(ok, label, detail) {
  console.log(`${ok ? '通过' : '失败'}：${label}${detail === undefined ? '' : ` → ${detail}`}`);
  if (!ok) failures.push(label);
}

/** 等一个条件成立。 */
async function waitFor(fn, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last.ok) return last;
    await new Promise((settle) => setTimeout(settle, intervalMs));
  }
  return last ?? { ok: false, detail: '没有尝试' };
}

/** 起一个子进程并收集输出。 */
function startProcess(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, output: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { state.output += chunk; });
  child.stderr.on('data', (chunk) => { state.output += chunk; });
  return state;
}

/** 等运行时打印启动地址。 */
async function waitForBoot(runtime, timeoutMs) {
  return waitFor(() => {
    if (runtime.child.exitCode !== null) {
      return { ok: false, detail: `运行时已退出（${runtime.child.exitCode}）\n${runtime.output.slice(-800)}` };
    }
    const match = runtime.output.match(/dsh web: (http:\/\/\S+\?token=\S+)/);
    return match === null ? { ok: false, detail: '还没打印启动地址' } : { ok: true, detail: match[1] };
  }, timeoutMs, 1000);
}

/** 用启动口令换一份只在本设备有效的 API 凭据。 */
async function apiCookie(bootUrl) {
  const url = new URL(bootUrl);
  const token = url.searchParams.get('token');
  const response = await fetch(`${url.origin}/connect?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0]);
  if (response.status !== 302 || cookies.length === 0) throw new Error(`取 API 凭据失败：${response.status}`);
  return cookies.join('; ');
}

/** 调一次设备运行时的 Remote 一元端点。 */
async function rpc(origin, cookie, endpoint, args) {
  const body = { type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } };
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    envelope = undefined;
  }
  return { status: response.status, text, envelope };
}

/** 读 home 层的补丁文件（原始文本）。 */
function readHomeLayer(home) {
  const path = join(home, 'cordis.patch.yml');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const controlPort = await findFreePort(20180);
const portA = await findFreePort(controlPort + 1);
const portB = await findFreePort(portA + 1);
console.log(`端口：控制平面 ${controlPort}、设备 A ${portA}、设备 B ${portB}`);

const root = tempHome('verify-settings-sync');
const base = `http://127.0.0.1:${controlPort}`;

const gateway = startProcess(process.execPath, [join(ROOT, 'gateway', 'lib', 'main.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    DSH_HOME: root,
    CHATDSH_TELEMETRY: 'off',
    CHATDSH_GATEWAY_HOST: '127.0.0.1',
    CHATDSH_GATEWAY_PORT: String(controlPort),
    CHATDSH_GATEWAY_DB: join(root, 'gateway.sqlite'),
    CHATDSH_PAIRING_CODE: PAIRING_CODE,
    CHATDSH_RUNTIME_URL: 'http://127.0.0.1:1',
  },
});

const runtimes = [];
try {
  const health = await waitFor(async () => {
    if (gateway.child.exitCode !== null) {
      return { ok: false, detail: `控制平面已退出（${gateway.child.exitCode}）\n${gateway.output.slice(-1200)}` };
    }
    try {
      const response = await fetch(`${base}/healthz`);
      return { ok: response.ok, detail: `${response.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }, 30_000);
  check(health.ok, '控制平面已监听', health.detail);
  if (!health.ok) throw new Error('控制平面没有就绪');

  // 断言一：控制平面接受白名单命名空间的写入。
  const accepted = await fetch(`${base}/chatdsh/gateway/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ namespace: 'client-locale', key: 'language', value: JSON.stringify('zh-CN') }),
  });
  const acceptedBody = await accepted.json();
  check(accepted.status === 200 && typeof acceptedBody.updatedAt === 'number', '控制平面接受白名单命名空间的写入', `${accepted.status} ${JSON.stringify(acceptedBody)}`);

  // 断言二：越界命名空间被拒绝。
  const rejected = await fetch(`${base}/chatdsh/gateway/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ namespace: 'bash-local', key: 'cwd', value: JSON.stringify('/etc') }),
  });
  const rejectedBody = await rejected.json();
  check(rejected.status === 400 && rejectedBody.error === 'namespace-not-whitelisted', '白名单之外的命名空间被拒绝', `${rejected.status} ${JSON.stringify(rejectedBody)}`);

  // 两台设备配对并起运行时。
  const nodes = [];
  for (const name of ['device-a', 'device-b']) {
    const response = await fetch(`${base}/chatdsh/gateway/devices/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: PAIRING_CODE, name, platform: 'linux', role: 'both', capabilities: ['shell'] }),
    });
    if (!response.ok) throw new Error(`配对 ${name} 失败：${response.status} ${await response.text()}`);
    const paired = await response.json();
    nodes.push({ name, deviceId: paired.deviceId, token: paired.token });
    console.log(`配对 ${name}：deviceId=${paired.deviceId}`);
  }
  const ports = [portA, portB];
  const homes = [tempHome('verify-settings-a'), tempHome('verify-settings-b')];
  for (const [index, node] of nodes.entries()) {
    installRuntimeProfile(homes[index]);
    runtimes.push({
      node,
      home: homes[index],
      runtime: startProcess(dshCommand(), ['--profile', 'web', '--port', String(ports[index]), '--no-open'], {
        cwd: ROOT,
        env: {
          ...process.env,
          DSH_HOME: homes[index],
          CHATDSH_TELEMETRY: 'off',
          CHATDSH_CONTROL_URL: base,
          CHATDSH_NODE_TOKEN: node.token,
          CHATDSH_DEVICE_ID: node.deviceId,
        },
      }),
    });
  }

  for (const entry of runtimes) {
    const boot = await waitForBoot(entry.runtime, 180_000);
    check(boot.ok, `${entry.node.name} 运行时已启动`, boot.ok ? new URL(boot.detail).origin : boot.detail);
    if (!boot.ok) throw new Error(`${entry.node.name} 没有启动：${entry.runtime.output.slice(-1200)}`);
    entry.bootUrl = boot.detail;
  }

  const online = await waitFor(async () => {
    const listed = await (await fetch(`${base}/chatdsh/gateway/devices`)).json();
    const onlineIds = new Set(listed.devices.filter((device) => device.online).map((device) => device.id));
    const missing = nodes.filter((node) => !onlineIds.has(node.deviceId)).map((node) => node.name);
    return missing.length === 0 ? { ok: true, detail: '两台都在线' } : { ok: false, detail: `未上线：${missing.join('、')}` };
  }, 90_000, 800);
  check(online.ok, '两台设备的长连接都已建立', online.detail);
  if (!online.ok) throw new Error('长连接没有建立');

  // 断言三：在设备 A 上改一个白名单设置（agent-default-model 的 model），它被上报到控制平面。
  const cookieA = await apiCookie(runtimes[0].bootUrl);
  const newModel = `chatdsh-sync-${Date.now()}`;
  const updated = await rpc(new URL(runtimes[0].bootUrl).origin, cookieA, 'settings/update', { ns: 'agent-default-model', patch: { model: newModel } });
  check(updated.envelope?.result?.ok === true, '在设备 A 上改了 agent-default-model 的 model', `${updated.status} ${updated.text.slice(0, 200)}`);

  const reported = await waitFor(async () => {
    const snapshot = await (await fetch(`${base}/chatdsh/gateway/settings`)).json();
    const rows = snapshot.namespaces?.['agent-default-model'] ?? [];
    const row = rows.find((entry) => entry.key === 'model');
    const value = row === undefined ? undefined : JSON.parse(row.value);
    return value === newModel ? { ok: true, detail: JSON.stringify(row) } : { ok: false, detail: `控制平面记录：${JSON.stringify(rows)}` };
  }, 30_000, 500);
  check(reported.ok, '断言三：设备 A 的设置变更上报到控制平面', reported.detail);

  // 断言四：控制平面把设置推给设备 B，写进 B 的 home 层补丁文件。
  const applied = await waitFor(async () => {
    const text = readHomeLayer(runtimes[1].home);
    return text.includes('agent-default-model') && text.includes(newModel)
      ? { ok: true, detail: text.replaceAll('\n', ' ⏎ ').slice(0, 240) }
      : { ok: false, detail: text === '' ? '（空文件）' : text.replaceAll('\n', ' ⏎ ').slice(0, 240) };
  }, 30_000, 500);
  check(applied.ok, '断言四：设备 B 的 home 层补丁文件写入了同一设置', applied.detail);

  // 断言五：设备侧拒绝白名单之外的命名空间，任何设备的 home 层都不出现该写入。
  const cookieB = await apiCookie(runtimes[1].bootUrl);
  const deviceRejected = await fetch(`${new URL(runtimes[0].bootUrl).origin}/chatdsh/device/settings/form`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieA },
    body: JSON.stringify({ namespace: 'bash-local', revision: 0, fields: { cwd: '/etc' } }),
  });
  const deviceRejectedBody = await deviceRejected.json();
  check(
    deviceRejected.status === 400
      && deviceRejectedBody.outcome === 'rejected'
      && deviceRejectedBody.reason === 'namespace-device-scope',
    '断言五：设备侧拒绝白名单之外的命名空间',
    `${deviceRejected.status} ${JSON.stringify(deviceRejectedBody)}`,
  );
  const homeA = readHomeLayer(runtimes[0].home);
  const homeB = readHomeLayer(runtimes[1].home);
  check(
    !homeA.includes('bash-local') && !homeA.includes('/etc') && !homeB.includes('bash-local') && !homeB.includes('/etc'),
    '断言五：白名单之外的设置没有进入任何设备的 home 层',
    `A=${homeA.includes('/etc')} B=${homeB.includes('/etc')}`,
  );

  // 断言六：过期版本写入返回冲突；另一个字段随后按接收时刻合并进同一补丁行。
  const conflict = await fetch(`${new URL(runtimes[1].bootUrl).origin}/chatdsh/device/settings/form`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieB },
    body: JSON.stringify({ namespace: 'agent-default-model', revision: 0, fields: { model: 'stale-model' } }),
  });
  const conflictBody = await conflict.json();
  check(
    conflict.status === 409
      && conflictBody.outcome === 'conflict'
      && conflictBody.conflict?.currentRevision >= 1
      && conflictBody.values?.model === newModel,
    '断言六：过期版本写入返回冲突并给出当前值',
    `${conflict.status} ${JSON.stringify(conflictBody)}`,
  );
  const provider = `provider-${Date.now()}`;
  const providerWrite = await fetch(`${base}/chatdsh/gateway/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ namespace: 'agent-default-model', key: 'provider', value: JSON.stringify(provider) }),
  });
  check(providerWrite.status === 200, '断言六：控制平面接受同一命名空间的第二个字段', `${providerWrite.status}`);
  const merged = await waitFor(async () => {
    const text = readHomeLayer(runtimes[1].home);
    return text.includes(newModel) && text.includes(provider)
      ? { ok: true, detail: text.replaceAll('\n', ' ⏎ ').slice(0, 300) }
      : { ok: false, detail: text === '' ? '（空文件）' : text.replaceAll('\n', ' ⏎ ').slice(0, 300) };
  }, 30_000, 500);
  check(merged.ok, '断言六：同一命名空间的两个字段按接收时刻合并到设备 B', merged.detail);
} catch (error) {
  check(false, '验收中断', error instanceof Error ? error.message : String(error));
  if (gateway.output !== '') console.log(`控制平面输出片段：\n${gateway.output.slice(-1200)}`);
  for (const entry of runtimes) {
    if (entry.runtime.output !== '') console.log(`${entry.node.name} 输出片段：\n${entry.runtime.output.slice(-1200)}`);
  }
} finally {
  for (const entry of runtimes) entry.runtime.child.kill('SIGTERM');
  gateway.child.kill('SIGTERM');
  await new Promise((settle) => setTimeout(settle, 800));
}

if (failures.length > 0) {
  console.log(`失败项：${[...new Set(failures)].join('；')}`);
  process.exit(1);
}
console.log('设置白名单同步验收通过');
process.exit(0);
