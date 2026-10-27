// APK 下载服务：只绑定私网地址，按文件名提供安装包与目录列表。
//
// 用法：node scripts/serve-apk.mjs [--bind <监听地址>] [--port 8099]
// 退出码 0 表示服务正常结束；端口占用或目录不可读时直接失败。

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`--${name} 缺少取值`);
  return value;
};

// 监听地址不写默认的真实网段：部署机的私网地址属于环境信息，用 CHATDSH_APK_BIND 或
// --bind 给出；缺省只监听回环，避免无意把安装包暴露到未预期的网卡。
const BIND = option('bind', process.env.CHATDSH_APK_BIND ?? '127.0.0.1');
const PORT = Number.parseInt(option('port', process.env.CHATDSH_APK_PORT ?? '8099'), 10);
const DIR = resolve(option('dir', process.env.CHATDSH_APK_DIR ?? join(ROOT, '.run', 'apk')));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`端口非法：${PORT}`);

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

function listPage(host) {
  const files = existsSync(DIR) ? readdirSync(DIR).filter((name) => name.endsWith('.apk')).sort().reverse() : [];
  const items = files.map((name) => {
    const size = statSync(join(DIR, name)).size;
    const megabytes = `${(size / 1024 / 1024).toFixed(1)} MB`;
    return `<li><a class="file" href="/${encodeURIComponent(name)}">` +
      `<span class="name">${name}</span><span class="meta">${megabytes}</span><span class="action">下载</span></a></li>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>ChatDSH 安装包</title><style>` +
    `:root{color-scheme:light}` +
    `*{box-sizing:border-box}` +
    `body{margin:0;background:#f5f7fb;color:#171a1f;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif}` +
    `main{max-width:760px;margin:0 auto;padding:44px 20px}` +
    `h1{font-size:28px;margin:0 0 8px}` +
    `.sub{color:#5b636f;margin:0 0 28px;line-height:1.6}` +
    `ul{list-style:none;padding:0;margin:0;display:grid;gap:12px}` +
    `.file{display:flex;align-items:center;gap:16px;padding:18px 20px;background:#fff;border:1px solid #dfe3ea;border-radius:14px;text-decoration:none;color:inherit;box-shadow:0 4px 14px rgba(23,26,31,.05)}` +
    `.file:hover{border-color:#4d6bfe;box-shadow:0 6px 20px rgba(77,107,254,.14)}` +
    `.name{font-weight:600;flex:1;word-break:break-all}` +
    `.meta{font-size:13px;color:#69707c;white-space:nowrap}` +
    `.action{background:#4d6bfe;color:#fff;padding:8px 14px;border-radius:9px;font-size:14px;white-space:nowrap}` +
    `.empty{padding:22px;background:#fff;border:1px solid #dfe3ea;border-radius:14px;color:#5b636f}` +
    `footer{margin-top:24px;color:#69707c;font-size:13px;line-height:1.7;word-break:break-all}` +
    `</style></head><body><main><h1>ChatDSH 安装包</h1>` +
    `<p class="sub">选择版本下载，安装前请确认手机已连接到 ChatDSH 所在网络。</p>` +
    `<ul>${items || '<li class="empty">还没有构建产物</li>'}</ul>` +
    `<footer>下载地址格式：http://${host}/chatdsh&lt;版本号&gt;.apk</footer>` +
    `</main></body></html>`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${BIND}:${PORT}`);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'method-not-allowed' });
    return;
  }
  if (url.pathname === '/') {
    const html = listPage(request.headers.host ?? `${BIND}:${PORT}`);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
    if (request.method === 'HEAD') response.end();
    else response.end(html);
    return;
  }
  let name;
  try {
    name = decodeURIComponent(url.pathname.slice(1));
  } catch {
    sendJson(response, 400, { error: 'invalid-path' });
    return;
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    sendJson(response, 400, { error: 'invalid-path' });
    return;
  }
  const file = join(DIR, name);
  if (!existsSync(file) || !statSync(file).isFile()) {
    sendJson(response, 404, { error: 'not-found' });
    return;
  }
  const size = statSync(file).size;
  const type = extname(file) === '.apk' ? 'application/vnd.android.package-archive' : 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
});

server.on('error', (error) => {
  console.error(`APK 下载服务启动失败：${error.message}`);
  process.exit(1);
});
server.listen(PORT, BIND, () => {
  console.log(`APK 下载服务：http://${BIND}:${PORT}/`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
