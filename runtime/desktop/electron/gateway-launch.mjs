/**
 * 桌面壳拉起控制平面的编排。
 *
 * 控制平面负责启动运行时；桌面壳只启动控制平面，再用启动口令换取运行时的带令牌路径。
 * 窗口因此始终指向控制平面，由反代注入身份并转发到运行时。
 * @module chatdsh-desktop-shell/gateway-launch
 */

import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';

import { findFreePort } from './launch.mjs';

/** 探测地址状态码；连接失败时抛出。 */
function probe(url) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'GET', timeout: 1500 }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

/** 取启动路径；控制平面还没有就绪时返回 undefined。 */
function bootstrap(url, secret) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${url}/chatdsh/gateway/bootstrap`, {
      method: 'GET',
      timeout: 1500,
      headers: { 'x-chatdsh-bootstrap': secret },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          resolve(undefined);
          return;
        }
        const payload = JSON.parse(body);
        resolve(typeof payload.path === 'string' ? payload.path : undefined);
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

/**
 * 控制平面编排器：一次进程生命周期。
 */
export class GatewayLauncher {
  /**
   * @param {object} options - 启动参数。
   * @param {string} options.bin - 控制平面入口文件或可执行文件。
   * @param {string} options.launchRoot - 中立的启动根，子进程的 cwd。
   * @param {string} options.dshHome - DSH 数据根。
   * @param {string} options.dshBin - DSH 启动入口，控制平面用它拉起运行时。
   * @param {string} options.profile - 运行时 profile。
   * @param {string} options.cwd - 运行时子进程的工作目录。
   * @param {string} options.bootstrapSecret - 启动路径下发端点要求的口令。
   * @param {number} [options.port] - 控制平面端口；缺省 3170，占用时顺延。
   * @param {number} [options.runtimePort] - 运行时起始端口；缺省 3080，占用时顺延。
   * @param {number} [options.readyTimeoutMs] - 就绪等待上限。
   * @param {(line: string) => void} [options.onLog] - 脱敏后的输出行回调。
   */
  constructor(options) {
    this.options = options;
    this.child = undefined;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 180_000;
    this.onLog = options.onLog ?? (() => {});
  }

  /** 记住一行输出。 */
  #remember(chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim() !== '') this.onLog(line.replace(/(\?|\b)token=[A-Za-z0-9_-]+/g, '$1token=<已隐藏>'));
    }
  }

  /**
   * 启动并等到控制平面与运行时都就绪。
   * @returns 控制平面地址、启动路径与端口。
   */
  async start() {
    const requestedGatewayPort = this.options.port ?? 3170;
    const gatewayPort = await findFreePort(requestedGatewayPort);
    let runtimePort = await findFreePort(this.options.runtimePort ?? 3080);
    if (runtimePort === gatewayPort) runtimePort = await findFreePort(gatewayPort + 1);
    this.onLog(gatewayPort === requestedGatewayPort
      ? `[launcher] 控制平面端口 ${gatewayPort}`
      : `[launcher] 端口 ${requestedGatewayPort} 被占用，控制平面顺延到 ${gatewayPort}`);

    const bin = this.options.bin;
    const runAsNode = bin.endsWith('.js') || bin.endsWith('.mjs') || bin.endsWith('.cjs');
    const command = runAsNode ? process.execPath : bin;
    const env = {
      ...process.env,
      DSH_HOME: this.options.dshHome,
      CHATDSH_GATEWAY_PORT: String(gatewayPort),
      CHATDSH_BOOTSTRAP_SECRET: this.options.bootstrapSecret,
      CHATDSH_RUNTIME_BIN: this.options.dshBin,
      CHATDSH_RUNTIME_PROFILE: this.options.profile,
      CHATDSH_RUNTIME_HOME: this.options.dshHome,
      CHATDSH_RUNTIME_CWD: this.options.cwd,
      CHATDSH_RUNTIME_PORT: String(runtimePort),
    };
    if (runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(command, runAsNode ? [bin] : [], {
      cwd: this.options.launchRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => this.#remember(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => this.#remember(chunk));

    let spawnError;
    child.once('error', (error) => { spawnError = error; });

    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    const deadline = Date.now() + this.readyTimeoutMs;
    let health = false;
    let bootPath;
    while (Date.now() < deadline) {
      if (spawnError !== undefined) throw new Error(`控制平面无法启动：${spawnError.message}`);
      if (child.exitCode !== null) throw new Error(`控制平面提前退出（退出码 ${child.exitCode}）`);
      try {
        const status = await probe(`${gatewayUrl}/healthz`);
        health = status >= 200 && status < 300;
        if (health) {
          bootPath = await bootstrap(gatewayUrl, this.options.bootstrapSecret);
          if (bootPath !== undefined) break;
        }
      } catch {
        // 还没起来。
      }
      await new Promise((settle) => setTimeout(settle, 250));
    }
    if (!health) throw new Error(`控制平面在 ${this.readyTimeoutMs} 毫秒内没有就绪`);
    if (bootPath === undefined) throw new Error(`运行时在 ${this.readyTimeoutMs} 毫秒内没有就绪`);
    return { gatewayUrl, bootPath, gatewayPort, runtimePort };
  }

  /** 停止控制平面；它负责先停运行时。 */
  async stop() {
    const child = this.child;
    this.child = undefined;
    if (child === undefined || child.exitCode !== null) return;
    child.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise((resolve) => child.once('exit', () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
    ]);
    if (!exited) child.kill('SIGKILL');
  }
}
