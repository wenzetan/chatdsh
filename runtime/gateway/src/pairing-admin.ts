#!/usr/bin/env node
/**
 * 中继服务端本机配对审批命令行工具。
 *
 * 仅连接容器/本机回环地址 `http://127.0.0.1:<端口>`，直接读取进程环境中的
 * `CHATDSH_PAIRING_CODE` 完成管理员校验，不在命令行参数或终端输出中暴露任何口令与令牌。
 *
 * 用法：
 *   node gateway/lib/pairing-admin.js list [--all]
 *   node gateway/lib/pairing-admin.js approve <requestId>
 *   node gateway/lib/pairing-admin.js reject <requestId>
 * @module @chatdsh/gateway/pairing-admin
 */

const port = Number.parseInt(process.env.CHATDSH_GATEWAY_PORT ?? '3170', 10);
const baseUrl = `http://127.0.0.1:${Number.isSafeInteger(port) && port > 0 ? port : 3170}`;
const pairingCode = process.env.CHATDSH_PAIRING_CODE ?? '';

function adminHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (pairingCode !== '') headers['x-chatdsh-pairing-code'] = pairingCode;
  return headers;
}

async function callJson(path: string, method: 'GET' | 'POST'): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: adminHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const code = typeof (parsed as { error?: unknown } | undefined)?.error === 'string'
      ? (parsed as { error: string }).error
      : `HTTP ${response.status}`;
    throw new Error(`配对审批请求失败：${code}`);
  }
  return parsed;
}

function printUsage(): void {
  console.log([
    '用法：',
    '  node gateway/lib/pairing-admin.js list [--all]',
    '  node gateway/lib/pairing-admin.js approve <requestId>',
    '  node gateway/lib/pairing-admin.js reject <requestId>',
  ].join('\n'));
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command === undefined || command === '-h' || command === '--help') {
    printUsage();
    return;
  }
  if (command === 'list') {
    const query = arg === '--all' ? '' : '?status=pending';
    const data = await callJson(`/chatdsh/gateway/pairing/requests${query}`, 'GET') as {
      readonly requests?: readonly {
        readonly id: string;
        readonly kind: string;
        readonly name: string;
        readonly platform: string;
        readonly role: string;
        readonly status: string;
        readonly createdAt: number;
        readonly expiresAt: number;
      }[];
    };
    const requests = data.requests ?? [];
    if (requests.length === 0) {
      console.log(arg === '--all' ? '当前没有任何配对申请记录。' : '当前没有待审批的配对申请。');
      return;
    }
    for (const item of requests) {
      const expires = new Date(item.expiresAt).toISOString();
      console.log(`${item.id}\tstatus=${item.status}\tkind=${item.kind}\tname=${item.name}\tplatform=${item.platform}\trole=${item.role}\texpires=${expires}`);
    }
    return;
  }
  if (command === 'approve' || command === 'reject') {
    if (arg === undefined || arg.trim() === '') {
      throw new Error(`${command} 需要传入 <requestId>`);
    }
    const id = encodeURIComponent(arg.trim());
    const data = await callJson(`/chatdsh/gateway/pairing/requests/${id}/${command}`, 'POST') as {
      readonly id: string;
      readonly status: string;
      readonly deviceId?: string;
      readonly name?: string;
    };
    if (command === 'approve') {
      console.log(`已批准配对申请：requestId=${data.id} deviceId=${data.deviceId ?? ''} name=${data.name ?? ''}`);
    } else {
      console.log(`已拒绝配对申请：requestId=${data.id}`);
    }
    return;
  }
  throw new Error(`未知子命令：${command}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
