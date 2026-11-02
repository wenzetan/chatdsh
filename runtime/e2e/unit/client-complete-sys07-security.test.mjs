// SYS07 的绑定、传输安全与来源校验验收。
//
// 证书用本机 openssl 真实生成：自建 CA、服务端证书、客户端证书、不由该 CA 签发的错误客户端
// 证书、十天有效的短证书、以及按明确起止日期签发的过期证书。服务端是真实 HTTPS 与双向 TLS
// 监听，客户端是真实的 https.request，逐个核对无证书、错误证书、正确证书、禁止绑定地址、
// 跨 Origin 的 HTTP 与 WebSocket、伪造身份头与代理链错误。
//
// 运行：node --test e2e/unit/client-complete-sys07-security.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { tempHome } from '../../scripts/lib/cleanup.mjs';
import { createTelemetryClient } from '../../packages/core/diagnostics/lib/client.js';
import { defaultTelemetryConfig } from '../../packages/core/diagnostics/lib/config.js';
import {
  assertRuntimeRemote,
  assertRuntimeTarget,
  loadTlsMaterial,
} from '../../packages/core/deployment/lib/index.js';
import { createDeployListener } from '../../gateway/lib/deploy/index.js';

/** 关闭遥测导出的真实客户端。 */
function disabledTelemetry() {
  return createTelemetryClient({
    config: defaultTelemetryConfig({ surface: 'gateway' }),
    component: '@chatdsh/gateway',
    env: { CHATDSH_TELEMETRY: 'off' },
  });
}

/** 向操作系统申请一个回环端口，随后立刻释放。 */
async function freePort() {
  const server = createNetServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((done) => server.close(done));
  return port;
}

/** 跑一次 openssl，失败时把命令输出带进错误。 */
function openssl(cwd, args) {
  try {
    execFileSync('openssl', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`;
    throw new Error(`openssl ${args.join(' ')} 失败：${detail}`);
  }
}

/** 签发证书用的最简配置。 */
const CA_CONFIG = `[ca]
default_ca = CA_default
[CA_default]
dir = .
database = index.txt
new_certs_dir = .
serial = serial.txt
certificate = ca.pem
private_key = ca.key
default_md = sha256
policy = policy_any
email_in_dn = no
rand_serial = no
unique_subject = no
[policy_any]
commonName = supplied
`;

/** 生成一套真实证书，返回各个文件的绝对路径。 */
function generateCertificates(dir) {
  mkdirSync(dir, { recursive: true });
  openssl(dir, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '3650', '-subj', '/CN=ChatDSH 测试 CA']);
  writeFileSync(join(dir, 'server.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n');
  const leaf = (name, cn) => {
    openssl(dir, ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${cn}`]);
  };
  const signed = (name, days) => {
    openssl(dir, ['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', String(days), '-extfile', 'server.ext']);
  };
  leaf('server', 'localhost');
  signed('server', 365);
  leaf('rotation', 'localhost');
  signed('rotation', 30);
  leaf('short', 'localhost');
  signed('short', 10);
  leaf('client', 'chatdsh-client');
  openssl(dir, ['x509', '-req', '-in', 'client.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.pem', '-days', '365']);
  openssl(dir, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'rogue.key', '-out', 'rogue.pem', '-days', '365', '-subj', '/CN=chatdsh-rogue']);

  writeFileSync(join(dir, 'ca.cnf'), CA_CONFIG);
  writeFileSync(join(dir, 'index.txt'), '');
  writeFileSync(join(dir, 'serial.txt'), '1000\n');
  leaf('expired', 'localhost');
  openssl(dir, ['ca', '-batch', '-config', 'ca.cnf', '-in', 'expired.csr', '-out', 'expired.pem', '-startdate', '20200101000000Z', '-enddate', '20200201000000Z', '-notext']);

  return {
    dir,
    ca: join(dir, 'ca.pem'),
    serverCert: join(dir, 'server.pem'),
    serverKey: join(dir, 'server.key'),
    rotationCert: join(dir, 'rotation.pem'),
    rotationKey: join(dir, 'rotation.key'),
    shortCert: join(dir, 'short.pem'),
    shortKey: join(dir, 'short.key'),
    expiredCert: join(dir, 'expired.pem'),
    expiredKey: join(dir, 'expired.key'),
    clientCert: join(dir, 'client.pem'),
    clientKey: join(dir, 'client.key'),
    rogueCert: join(dir, 'rogue.pem'),
    rogueKey: join(dir, 'rogue.key'),
  };
}

/** 读取 PEM 内容；Node 的 TLS 选项接受证书内容，路径字符串会被当成内容。 */
function pem(path) {
  return readFileSync(path);
}

/** 一次 HTTPS 请求。 */
function tlsRequest({ port, path = '/', method = 'GET', headers = {}, body, ca, cert, key, agent, servername = 'localhost', checkServerIdentity }) {
  return new Promise((settle, fail) => {
    const options = {
      host: '127.0.0.1',
      port,
      path,
      method,
      headers,
      servername,
      ...(ca === undefined ? {} : { ca: pem(ca) }),
      ...(checkServerIdentity === undefined ? {} : { checkServerIdentity }),
    };
    if (cert !== undefined) options.cert = pem(cert);
    if (key !== undefined) options.key = pem(key);
    if (agent !== undefined) options.agent = agent;
    const request = httpsRequest(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const socket = response.socket;
        settle({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          peer: socket !== null && typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : undefined,
        });
      });
    });
    request.on('error', fail);
    request.end(body);
  });
}

/** 一次明文 HTTP 请求。 */
function plainRequest({ port, path = '/', method = 'GET', headers = {}, body }) {
  return new Promise((settle, fail) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => settle({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', fail);
    request.end(body);
  });
}

/** 用裸套接字发一次请求，覆盖不带 Host 这类会被 HTTP 客户端自动补齐的写法。 */
function rawRequest({ port, text }) {
  return new Promise((settle, fail) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => {
      buffer += chunk;
    });
    socket.on('error', fail);
    socket.on('close', () => settle(buffer));
    setTimeout(() => socket.destroy(), 1_000).unref();
  });
}

/** 一次原始 WebSocket 升级握手。 */
function upgradeRequest({ port, headers = {} }) {
  return new Promise((settle, fail) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/remote.mux',
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      settle({ status: response.statusCode, headers: response.headers });
    });
    request.on('response', (response) => {
      response.resume();
      settle({ status: response.statusCode, headers: response.headers });
    });
    request.on('error', fail);
    request.end();
  });
}

/** 升级通过时的握手应答：按协议算出 Sec-WebSocket-Accept。 */
function acceptUpgrade(request, socket) {
  const key = String(request.headers['sec-websocket-key'] ?? '');
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.on('error', () => undefined);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

/** 明文开发计划。 */
function plaintextPlan({ port, trustedProxies = [], trustedClientRanges, proxyDepth }) {
  return {
    host: '127.0.0.1',
    port,
    scope: 'gateway',
    development: true,
    allowedOrigins: [`http://127.0.0.1:${port}`],
    allowedHosts: [`127.0.0.1:${port}`],
    trustedProxies,
    ...(trustedClientRanges === undefined ? {} : { trustedClientRanges }),
    ...(proxyDepth === undefined ? {} : { proxyDepth }),
  };
}

/** 双向 TLS 计划。 */
function mutualPlan({ port, certificates }) {
  return {
    host: '127.0.0.1',
    port,
    scope: 'gateway',
    tls: { certPath: certificates.serverCert, keyPath: certificates.serverKey, caPath: certificates.ca, mutual: true },
    allowedOrigins: [`https://127.0.0.1:${port}`],
    allowedHosts: [`127.0.0.1:${port}`],
    trustedProxies: [],
  };
}

/** 建立一个只回固定 JSON 的处理函数。 */
function jsonHandler(payload = { ok: true }) {
  return (request, response) => {
    const body = JSON.stringify({ ...payload, host: request.headers.host ?? null });
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
  };
}

test('绑定检查：通配与公网监听在启动前失败，运行时只允许本机可达', async () => {
  const telemetry = disabledTelemetry();
  const home = tempHome('sys07-bind');
  const port = await freePort();
  const base = { host: '127.0.0.1', port, scope: 'gateway', development: true, allowedOrigins: [`http://127.0.0.1:${port}`], allowedHosts: [`127.0.0.1:${port}`], trustedProxies: [] };
  const cases = [
    { host: '0.0.0.0', code: 'bind-wildcard-forbidden' },
    { host: '::', code: 'bind-wildcard-forbidden' },
    { host: '', code: 'bind-wildcard-forbidden' },
    { host: '8.8.8.8', code: 'bind-public-address-forbidden' },
    { host: '10.255.255.1', code: 'bind-address-not-local' },
    { host: '127.0.0.1', development: false, code: 'bind-plaintext-forbidden' },
    { host: '127.0.0.1', port: 70000, code: 'bind-port-invalid' },
  ];
  try {
    for (const item of cases) {
      const listener = createDeployListener({
        plan: { ...base, ...item, ...(item.development === false ? { development: false } : {}) },
        telemetry,
        handler: jsonHandler(),
      });
      await assert.rejects(listener.start(), (error) => {
        assert.equal(error.code, item.code, `${item.host} 应当以 ${item.code} 失败，实际 ${error.code}`);
        return true;
      }, `${item.host} 应当在启动前被拒绝`);
    }

    // 非回环的本机私有地址必须带双向 TLS；只带 TLS 仍不允许。
    const local = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal);
    if (local !== undefined) {
      const privateHost = local.address;
      const withoutTls = createDeployListener({ plan: { ...base, host: privateHost }, telemetry, handler: jsonHandler() });
      await assert.rejects(withoutTls.start(), (error) => error.code === 'bind-tls-required');
      const withoutClientAuth = createDeployListener({
        plan: { ...base, host: privateHost, tls: { certPath: join(home, 'none.pem'), keyPath: join(home, 'none.key'), mutual: false } },
        telemetry,
        handler: jsonHandler(),
      });
      await assert.rejects(withoutClientAuth.start(), (error) => error.code === 'bind-mutual-tls-required');
      const runtimeOnPrivate = createDeployListener({ plan: { ...base, host: privateHost, scope: 'runtime' }, telemetry, handler: jsonHandler() });
      await assert.rejects(runtimeOnPrivate.start(), (error) => error.code === 'runtime-bind-not-local');
    }

    // 运行时地址与来源：只允许回环。
    assert.equal(assertRuntimeTarget('http://127.0.0.1:3080').hostname, '127.0.0.1');
    assert.throws(() => assertRuntimeTarget('http://192.0.2.10:3080'), (error) => error.code === 'runtime-target-not-local');
    assert.throws(() => assertRuntimeTarget('ftp://127.0.0.1:3080'), (error) => error.code === 'runtime-target-invalid');
    assertRuntimeRemote('127.0.0.1');
    assertRuntimeRemote('::1');
    assert.throws(() => assertRuntimeRemote('10.0.0.5'), (error) => error.code === 'runtime-remote-forbidden');
    assert.throws(() => assertRuntimeRemote(undefined), (error) => error.code === 'runtime-remote-unknown');

    // 合法的明文开发监听可以建立，能被请求到。
    const listener = createDeployListener({ plan: base, telemetry, handler: jsonHandler() });
    await listener.start();
    try {
      const response = await plainRequest({ port, path: '/healthz' });
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).ok, true);
    } finally {
      await listener.stop();
    }

    // 运行时监听只绑回环：明文即可，不需要开发标记，端口另有取值。
    const runtimePort = await freePort();
    const runtimeListener = createDeployListener({
      plan: {
        ...base,
        port: runtimePort,
        scope: 'runtime',
        development: false,
        allowedOrigins: [`http://127.0.0.1:${runtimePort}`],
        allowedHosts: [`127.0.0.1:${runtimePort}`],
      },
      telemetry,
      handler: jsonHandler(),
    });
    await runtimeListener.start();
    try {
      const runtimeResponse = await plainRequest({ port: runtimePort, path: '/healthz' });
      assert.equal(runtimeResponse.status, 200);
    } finally {
      await runtimeListener.stop();
    }
  } finally {
    await telemetry.shutdown();
  }
});

test('真实双向 TLS：无证书与错误证书被拒绝，正确证书放行', async () => {
  const telemetry = disabledTelemetry();
  const home = tempHome('sys07-mtls');
  const certificates = generateCertificates(home);
  const port = await freePort();
  const listener = createDeployListener({ plan: mutualPlan({ port, certificates }), telemetry, handler: jsonHandler() });
  await listener.start();
  try {
    const material = listener.material();
    assert.equal(material?.mutual, true);
    assert.ok(material.daysRemaining > 300, '服务端证书应当有较长剩余有效期');

    // 不带客户端证书
    await assert.rejects(
      tlsRequest({ port, path: '/chatdsh/gateway/deployment', ca: certificates.ca }),
      '没有客户端证书的连接必须在握手阶段失败'
    );
    // 客户端证书不是该 CA 签发
    await assert.rejects(
      tlsRequest({
        port,
        path: '/chatdsh/gateway/deployment',
        ca: certificates.ca,
        cert: certificates.rogueCert,
        key: certificates.rogueKey,
      }),
      '错误客户端证书必须在握手阶段失败'
    );
    // 正确客户端证书
    const allowed = await tlsRequest({
      port,
      path: '/chatdsh/gateway/deployment',
      ca: certificates.ca,
      cert: certificates.clientCert,
      key: certificates.clientKey,
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(JSON.parse(allowed.body), { ok: true, host: `127.0.0.1:${port}` });
  } finally {
    await listener.stop();
    await telemetry.shutdown();
  }
});

test('回环 TLS 监听不要求客户端证书', async () => {
  const telemetry = disabledTelemetry();
  const home = tempHome('sys07-tls');
  const certificates = generateCertificates(home);
  const port = await freePort();
  const listener = createDeployListener({
    plan: {
      host: '127.0.0.1',
      port,
      scope: 'gateway',
      tls: { certPath: certificates.serverCert, keyPath: certificates.serverKey, mutual: false },
      allowedOrigins: [`https://127.0.0.1:${port}`],
      allowedHosts: [`127.0.0.1:${port}`],
      trustedProxies: [],
    },
    telemetry,
    handler: jsonHandler(),
  });
  await listener.start();
  try {
    const response = await tlsRequest({ port, path: '/healthz', ca: certificates.ca });
    assert.equal(response.status, 200);
    assert.equal(listener.material()?.mutual, false);
  } finally {
    await listener.stop();
    await telemetry.shutdown();
  }
});

test('证书与密钥的生命周期、文件权限与轮换', async () => {
  const telemetry = disabledTelemetry();
  const home = tempHome('sys07-cert');
  const certificates = generateCertificates(home);
  const rejectCode = async (paths) => {
    try {
      await loadTlsMaterial(paths, telemetry);
      return undefined;
    } catch (error) {
      return error.code;
    }
  };

  // 权限过宽：属组或其他用户可读即拒绝。
  const looseKey = join(home, 'loose.key');
  copyFileSync(certificates.serverKey, looseKey);
  chmodSync(looseKey, 0o644);
  assert.equal(
    await rejectCode({ certPath: certificates.serverCert, keyPath: looseKey, mutual: false }),
    'key-permission-forbidden'
  );
  chmodSync(looseKey, 0o600);
  const tightened = await loadTlsMaterial({ certPath: certificates.serverCert, keyPath: looseKey, mutual: false }, telemetry);
  assert.equal(tightened.status, 'valid');

  // 已过期、尚未生效之外的失败分支与双向 TLS 缺少签发机构。
  assert.equal(
    await rejectCode({ certPath: certificates.expiredCert, keyPath: certificates.expiredKey, mutual: false }),
    'certificate-expired'
  );
  assert.equal(
    await rejectCode({ certPath: certificates.serverCert, keyPath: certificates.clientKey, mutual: false }),
    'tls-key-mismatch'
  );
  assert.equal(
    await rejectCode({ certPath: certificates.serverCert, keyPath: certificates.serverKey, mutual: true }),
    'tls-client-ca-required'
  );
  assert.equal(
    await rejectCode({ certPath: join(home, 'missing.pem'), keyPath: certificates.serverKey, mutual: false }),
    'tls-cert-unreadable'
  );

  // 十天有效的证书进入告警窗口。
  const short = await loadTlsMaterial({ certPath: certificates.shortCert, keyPath: certificates.shortKey, mutual: false }, telemetry);
  assert.equal(short.status, 'expiring');
  assert.ok(short.daysRemaining > 7 && short.daysRemaining < 11, `短证书剩余天数异常：${short.daysRemaining}`);

  // 轮换：新连接使用新证书，已有连接按原证书自然结束。
  const port = await freePort();
  const rotationPlan = {
    host: '127.0.0.1',
    port,
    scope: 'gateway',
    tls: { certPath: join(home, 'rotation.pem'), keyPath: join(home, 'rotation.key'), mutual: false },
    allowedOrigins: [`https://127.0.0.1:${port}`],
    allowedHosts: [`127.0.0.1:${port}`],
    trustedProxies: [],
  };
  const listener = createDeployListener({ plan: rotationPlan, telemetry, handler: jsonHandler() });
  const agent = new HttpsAgent({ keepAlive: true, ca: pem(certificates.ca), servername: 'localhost' });
  /** 把连接钉在一张证书的指纹上：对面换了证书时握手失败。 */
  const pinTo = (fingerprint) => (_host, certificate) => {
    if (certificate?.fingerprint256 !== fingerprint) return new Error('server certificate pin mismatch');
    return undefined;
  };
  try {
    await listener.start();
    const beforeMaterial = listener.material();
    const before = await tlsRequest({ port, path: '/healthz', ca: certificates.ca, agent });
    assert.equal(before.status, 200);

    copyFileSync(certificates.serverCert, join(home, 'rotation.pem'));
    copyFileSync(certificates.serverKey, join(home, 'rotation.key'));
    chmodSync(join(home, 'rotation.key'), 0o600);
    const rotated = await listener.rotate();
    assert.ok(rotated.daysRemaining > 300, '轮换之后应当使用长有效期证书');
    assert.notEqual(rotated.fingerprintSha256, beforeMaterial?.fingerprintSha256, '轮换必须换成另一张证书');

    // 已有连接按原证书自然结束。
    const existing = await tlsRequest({ port, path: '/healthz', ca: certificates.ca, agent });
    assert.equal(existing.status, 200, '轮换不影响已有连接');

    // 新连接必须使用新证书：钉在旧指纹上失败，钉在新指纹上放行。
    await assert.rejects(
      tlsRequest({ port, path: '/healthz', ca: certificates.ca, checkServerIdentity: pinTo(beforeMaterial?.fingerprintSha256) }),
      '新连接不得继续出示旧证书'
    );
    const fresh = await tlsRequest({
      port,
      path: '/healthz',
      ca: certificates.ca,
      checkServerIdentity: pinTo(rotated.fingerprintSha256),
    });
    assert.equal(fresh.status, 200);
  } finally {
    agent.destroy();
    await listener.stop();
    await telemetry.shutdown();
  }
});

test('精确 Origin 与 Host 校验：跨源的静态资源、SSE 与写请求被拒绝', async () => {
  const telemetry = disabledTelemetry();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const handler = (request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    if (path === '/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.end('data: ok\n\n');
      return;
    }
    const body = JSON.stringify({ path, identity: request.headers['tailscale-user-login'] ?? null });
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
  };
  const kindOf = (request) => {
    const path = (request.url ?? '/').split('?')[0];
    if (path === '/events') return 'sse';
    if (path.startsWith('/assets/')) return 'static';
    return 'api';
  };
  const withLooseProxyTrust = createDeployListener({
    plan: plaintextPlan({ port, trustedProxies: ['198.51.100.0/24'] }),
    telemetry,
    handler,
    kindOf,
  });
  await withLooseProxyTrust.start();
  try {
    const same = await plainRequest({ port, path: '/chatdsh/gateway/ownership', headers: { origin } });
    assert.equal(same.status, 200);

    const noOriginRead = await plainRequest({ port, path: '/chatdsh/gateway/sessions' });
    assert.equal(noOriginRead.status, 200, '本机读取允许不带来源');

    const crossOrigin = await plainRequest({ port, path: '/chatdsh/gateway/ownership', headers: { origin: 'https://evil.example' } });
    assert.equal(crossOrigin.status, 403);
    assert.equal(JSON.parse(crossOrigin.body).error, 'origin-mismatch');

    const crossSite = await plainRequest({
      port,
      path: '/chatdsh/gateway/ownership',
      headers: { origin, 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(JSON.parse(crossSite.body).error, 'origin-cross-site');

    const writeWithoutOrigin = await plainRequest({ port, path: '/chatdsh/gateway/settings', method: 'POST', body: '{}' });
    assert.equal(writeWithoutOrigin.status, 403);
    assert.equal(JSON.parse(writeWithoutOrigin.body).error, 'origin-missing');

    const writeWithOrigin = await plainRequest({ port, path: '/chatdsh/gateway/settings', method: 'POST', headers: { origin }, body: '{}' });
    assert.equal(writeWithOrigin.status, 200);

    const wrongHost = await plainRequest({ port, path: '/healthz', headers: { host: 'evil.example' } });
    assert.equal(wrongHost.status, 403);
    assert.equal(JSON.parse(wrongHost.body).error, 'host-mismatch');

    const missingHost = await rawRequest({
      port,
      text: 'GET /healthz HTTP/1.1\r\nConnection: close\r\n\r\n',
    });
    assert.match(missingHost, /^HTTP\/1\.1 400/, '缺少 Host 的请求必须被拒绝');

    const crossOriginStatic = await plainRequest({ port, path: '/assets/app.js', headers: { origin: 'https://evil.example' } });
    assert.equal(crossOriginStatic.status, 403, '跨源静态资源必须拒绝');
    const sameOriginStatic = await plainRequest({ port, path: '/assets/app.js', headers: { origin } });
    assert.equal(sameOriginStatic.status, 200);

    const crossOriginSse = await plainRequest({ port, path: '/events', headers: { origin: 'https://evil.example' } });
    assert.equal(crossOriginSse.status, 403, '跨源 SSE 必须拒绝');
    const sameOriginSse = await plainRequest({ port, path: '/events', headers: { origin } });
    assert.equal(sameOriginSse.status, 200);
    assert.match(String(sameOriginSse.headers['content-type']), /text\/event-stream/);

    // 伪造代理头与身份头：来源不在可信列表里，出现即拒绝。
    const forgedForwarded = await plainRequest({ port, path: '/healthz', headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.equal(forgedForwarded.status, 403);
    assert.equal(JSON.parse(forgedForwarded.body).error, 'proxy-untrusted');

    const forgedIdentity = await plainRequest({ port, path: '/healthz', headers: { 'tailscale-user-login': 'user@example.ts.net' } });
    assert.equal(forgedIdentity.status, 403);
    assert.equal(JSON.parse(forgedIdentity.body).error, 'identity-header-untrusted');
  } finally {
    await withLooseProxyTrust.stop();
  }

  // 可信代理：转发头与身份头被接受，身份头在下游被剥掉。
  const trustedPort = await freePort();
  const trustedOrigin = `http://127.0.0.1:${trustedPort}`;
  const trusted = createDeployListener({
    plan: plaintextPlan({ port: trustedPort, trustedProxies: ['127.0.0.1/32'], trustedClientRanges: ['198.51.100.0/24'], proxyDepth: 4 }),
    telemetry,
    handler,
    kindOf,
  });
  await trusted.start();
  try {
    const accepted = await plainRequest({
      port: trustedPort,
      path: '/chatdsh/gateway/sessions',
      headers: {
        origin: trustedOrigin,
        'x-forwarded-for': '198.51.100.7, 127.0.0.1',
        'x-forwarded-host': `127.0.0.1:${trustedPort}`,
        'x-forwarded-proto': 'http',
        'tailscale-user-login': 'user@example.ts.net',
        'tailscale-headers-info': 'https://tailscale.com/s/serve-headers',
      },
    });
    assert.equal(accepted.status, 200);
    assert.equal(JSON.parse(accepted.body).identity, null, '下游不得读到身份头');

    const badProto = await plainRequest({
      port: trustedPort,
      path: '/healthz',
      headers: { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'ftp' },
    });
    assert.equal(badProto.status, 403);
    assert.equal(JSON.parse(badProto.body).error, 'proxy-header-invalid');

    const badHost = await plainRequest({
      port: trustedPort,
      path: '/healthz',
      headers: { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-host': 'evil.example' },
    });
    assert.equal(badHost.status, 403);
    assert.equal(JSON.parse(badHost.body).error, 'proxy-host-mismatch');

    const tooLong = await plainRequest({
      port: trustedPort,
      path: '/healthz',
      headers: { 'x-forwarded-for': '198.51.100.7, 198.51.100.8, 198.51.100.9, 198.51.100.10, 198.51.100.11' },
    });
    assert.equal(tooLong.status, 403);
    assert.equal(JSON.parse(tooLong.body).error, 'proxy-chain-too-long');

    const outsideRange = await plainRequest({
      port: trustedPort,
      path: '/healthz',
      headers: { 'x-forwarded-for': '203.0.113.9', 'tailscale-user-login': 'user@example.ts.net' },
    });
    assert.equal(outsideRange.status, 403);
    assert.equal(JSON.parse(outsideRange.body).error, 'identity-client-untrusted');
  } finally {
    await trusted.stop();
    await telemetry.shutdown();
  }
});

test('WebSocket 升级的同源校验', async () => {
  const telemetry = disabledTelemetry();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const listener = createDeployListener({
    plan: plaintextPlan({ port }),
    telemetry,
    handler: jsonHandler(),
    onUpgrade: acceptUpgrade,
  });
  await listener.start();
  try {
    const allowed = await upgradeRequest({ port, headers: { origin } });
    assert.equal(allowed.status, 101);
    assert.equal(allowed.headers.upgrade, 'websocket');

    const crossOrigin = await upgradeRequest({ port, headers: { origin: 'https://evil.example' } });
    assert.equal(crossOrigin.status, 403);

    const noOrigin = await upgradeRequest({ port });
    assert.equal(noOrigin.status, 101, '本机来源的升级允许不带来源');

    const badVersion = await upgradeRequest({ port, headers: { origin, 'sec-websocket-version': '8' } });
    assert.equal(badVersion.status, 426);
  } finally {
    await listener.stop();
    await telemetry.shutdown();
  }
});
