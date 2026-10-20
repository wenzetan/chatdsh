// 验收用的最小 MCP 服务器：stdio 上的 JSON-RPC，响应 initialize 与 tools/list。
// 每次收到消息都追加到日志文件，供验收脚本核对连接确实建立。
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const LOG = process.env.MCP_PROBE_LOG ?? '/workspace/ChatDSH/.run/mcp-probe.log';

function log(entry) {
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    log({ kind: 'unparsable', line: line.slice(0, 120) });
    return;
  }
  log({ kind: 'request', method: message.method ?? null, id: message.id ?? null });

  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'chatdsh-probe', version: '0.0.1' },
      },
    })}\n`);
    return;
  }
  if (message.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{ name: 'probe-tool', description: '验收用的探针工具', inputSchema: { type: 'object', properties: {} } }],
      },
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
});
reader.on('close', () => log({ kind: 'closed' }));
