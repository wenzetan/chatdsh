// 浏览器侧遥测链路的验收。
//
// 客户端上报走宿主中继：`/chatdsh/telemetry/status` 报开关与出口状态，
// `/chatdsh/telemetry/self-test` 做一次自检，`/chatdsh/telemetry/browser` 接收 OTLP 日志。
// 这里启动 Web 形态运行时，在已登录页面里依次打这三个端点，核对：
//   1. 状态端点可达并返回开关与出口信息；
//   2. 开关打开时自检成功；
//   3. 中继接收一份 `chatdsh.client.ui.action` 日志并回 200。
// 开关关闭时记录关闭原因并放行；导出凭据未配置时中继回 503 且 detail 为 credential-missing，
// 这属于部署条件，记录后放行，不算链路缺陷。
//
// 用法：node scripts/verify-telemetry-flow.mjs [--profile chatdsh-web] [--port 3099]

import { spawn } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempHome } from './lib/cleanup.mjs';
import { dshCommand } from './lib/dsh.mjs';
import { launchBrowser } from '../packages/tool/browser/lib/cdp.js';

const ROOT = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);

function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`--${name} 缺少取值`);
  return value;
}

const PROFILE = option('profile', 'chatdsh-web');
const PORT = Number.parseInt(option('port', '3099'), 10);

const HOME = tempHome('telemetry-flow');
mkdirSync(join(HOME, 'profiles'), { recursive: true });
symlinkSync(join(ROOT, 'profiles', PROFILE), join(HOME, 'profiles', PROFILE));

const runtime = spawn(dshCommand(), ['--profile', PROFILE, '--port', String(PORT), '--no-open'], {
  env: { ...process.env, DSH_HOME: HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
runtime.stdout.setEncoding('utf8');
runtime.stdout.on('data', (chunk) => { output += chunk; });
runtime.stderr.setEncoding('utf8');
runtime.stderr.on('data', (chunk) => { output += chunk; });

async function waitForUrl(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = output.match(/dsh web: (http:\/\/\S+\?token=\S+)/);
    if (match) return match[1];
    if (output.includes('startup failed')) throw new Error(`启动失败：\n${output.slice(-1200)}`);
    await new Promise((settle) => setTimeout(settle, 400));
  }
  throw new Error(`等待启动超时：\n${output.slice(-1200)}`);
}

const PROBE = `(async () => {
    const readJson = async (response) => {
      const text = await response.text();
      try { return JSON.parse(text); } catch { return { raw: text }; }
    };
    const statusResponse = await fetch('/chatdsh/telemetry/status');
    const statusBody = await readJson(statusResponse);
    const selfTestResponse = await fetch('/chatdsh/telemetry/self-test', { method: 'POST' });
    const selfTestBody = await readJson(selfTestResponse);
    const relayResponse = await fetch('/chatdsh/telemetry/browser', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chatdsh-signal': 'logs', 'x-chatdsh-csrf': '1' },
      body: JSON.stringify({
        resourceLogs: [{
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'chatdsh-runtime' } }] },
          scopeLogs: [{
            scope: { name: 'verify' },
            logRecords: [{
              timeUnixNano: String(Date.now() * 1e6),
              severityNumber: 9,
              severityText: 'INFO',
              body: { stringValue: 'chatdsh.client.ui.action' },
              attributes: [
                { key: 'action', value: { stringValue: 'verify' } },
                { key: 'outcome', value: { stringValue: 'ok' } },
              ],
            }],
          }],
        }],
      }),
    });
    const relayBody = await readJson(relayResponse);
    return {
      statusCode: statusResponse.status,
      statusBody,
      selfTestCode: selfTestResponse.status,
      selfTestBody,
      relayCode: relayResponse.status,
      relayBody,
    };
  })()`;

let browser;
try {
  const url = await waitForUrl();
  browser = await launchBrowser({ executable: '/usr/bin/google-chrome', port: 9369, userDataDir: tempHome('chrome-telemetry') });
  const page = await browser.open();
  await page.navigate(url);
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await page.evaluate('document.getElementById("chatdsh-theme-styles") !== null');
    if (ready === true) break;
    await new Promise((settle) => setTimeout(settle, 300));
  }
  if (ready !== true) throw new Error('页面未就绪，无法探测遥测端点');

  const result = await page.evaluate(PROBE);
  const status = result.statusBody ?? {};
  console.log(`状态端点 ${result.statusCode}，开关 ${status.enabled === true ? '打开' : '关闭'}，出口 ${status.endpoint ?? '未给出'}，凭据 ${status.credential ?? '未给出'}`);

  if (result.statusCode !== 200) {
    console.log(`失败 状态端点返回 ${result.statusCode}`);
    process.exitCode = 1;
  } else if (status.enabled !== true) {
    console.log(`跳过 遥测已关闭：${status.reason ?? '未给出原因'}`);
  } else if (result.selfTestCode !== 200) {
    console.log(`失败 自检返回 ${result.selfTestCode}`);
    process.exitCode = 1;
  } else {
    console.log('通过 状态端点可达，自检成功');
    if (result.relayCode === 200) {
      console.log('通过 中继接收 chatdsh.client.ui.action 并回 200');
    } else if (result.relayCode === 503 && result.relayBody?.detail === 'credential-missing') {
      console.log('跳过 中继拒绝：导出凭据未配置（credential-missing），客户端事件能到宿主但无法出网');
    } else {
      console.log(`失败 中继返回 ${result.relayCode}：${JSON.stringify(result.relayBody)}`);
      process.exitCode = 1;
    }
  }
} finally {
  if (browser !== undefined) await browser.close();
  runtime.kill('SIGTERM');
}
