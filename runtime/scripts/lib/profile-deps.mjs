// 把 profile 声明的自建包接到它的 node_modules 里。
//
// profile 的依赖用 `link:` 指向仓库里的包；测试在仓库里直接起运行时，数据根里的
// profile 指向仓库目录，包管理器没有替它建立链接时插件会以「找不到包」停用。
// 这里按 package.json 的 dependencies 逐条补链接，已存在且指向目标时跳过。
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * 补齐一个 profile 的自建依赖链接。
 * @param profileDir - profile 目录。
 */
export function normalizeProfileDeps(profileDir) {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue;
    const target = resolve(profileDir, spec.slice('link:'.length));
    const scopeDir = join(profileDir, 'node_modules', name.startsWith('@') ? name.split('/')[0] : '');
    const link = join(profileDir, 'node_modules', name);
    if (!existsSync(scopeDir)) mkdirSync(scopeDir, { recursive: true });
    if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false }) !== undefined) {
      if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) continue;
      rmSync(link, { recursive: true, force: true });
    }
    symlinkSync(target, link, 'dir');
  }
}
