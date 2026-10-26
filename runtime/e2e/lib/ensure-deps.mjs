// 让 Node 能解析 DSH 安装里的包。
//
// 运行时包从 @chatdsh/adapter 取上游能力，而适配层直接 import @deepseek-ai/*。测试在
// 仓库目录里运行 Node，没有 profile 的安装锚点，因此把 .dsh-deps 投影到 node_modules
// 的 scope 目录。node_modules 与 .dsh-deps 都在版本管理之外。
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 为一个仓库根建立依赖投影。
 * @param {string} root - 仓库根（runtime 或 dsh-adapter）。
 */
export function ensureDeps(root) {
  const deps = join(root, '.dsh-deps');
  for (const scope of ['@deepseek-ai', '@opentelemetry', '@modelcontextprotocol']) {
    const target = join(root, 'node_modules', scope);
    mkdirSync(target, { recursive: true });
    const source = join(deps, scope);
    if (!existsSync(source)) continue;
    for (const name of readdirSync(source)) {
      const link = join(target, name);
      if (!existsSync(link)) symlinkSync(join(source, name), link, 'dir');
    }
  }
  const zod = join(root, 'node_modules', 'zod');
  if (!existsSync(zod) && existsSync(join(deps, 'zod'))) symlinkSync(join(deps, 'zod'), zod, 'dir');
}
