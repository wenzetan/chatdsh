// 将 @chatdsh/bundle 及其 12 个工作区包打包为自包含发布归档（chatdsh-plugin-bundle.tar.gz），
// 内置 manifest.json 与打包了 yaml 第三方库的 apply-overrides.cjs，供终端设备无需克隆仓库直接安装。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const RUNTIME_ROOT = join(REPO_ROOT, 'runtime');

const REQUIRED_ARTIFACTS = [
  'dsh-adapter/lib/index.js',
  'runtime/packages/bundle/chatdsh/lib/index.js',
  'runtime/packages/client/pwa/lib/index.js',
  'runtime/packages/client/pwa/lib/client.js',
  'runtime/packages/client/telemetry/lib/index.js',
  'runtime/packages/client/telemetry/lib/client.js',
  'runtime/packages/client/remote/lib/index.js',
  'runtime/packages/client/remote/lib/client.js',
  'runtime/packages/core/contracts/lib/index.js',
  'runtime/packages/core/diagnostics/lib/index.js',
  'runtime/packages/core/remote-client/lib/index.js',
  'runtime/packages/host/device-link/lib/index.js',
  'runtime/packages/host/import/lib/index.js',
  'runtime/packages/host/push/lib/index.js',
  'runtime/packages/host/settings-sync/lib/index.js',
  'runtime/packages/host/telemetry/lib/index.js',
];

const PACKAGE_DIRS = [
  'dsh-adapter',
  'runtime/packages/bundle/chatdsh',
  'runtime/packages/client/pwa',
  'runtime/packages/client/telemetry',
  'runtime/packages/client/remote',
  'runtime/packages/core/contracts',
  'runtime/packages/core/diagnostics',
  'runtime/packages/core/remote-client',
  'runtime/packages/host/device-link',
  'runtime/packages/host/import',
  'runtime/packages/host/push',
  'runtime/packages/host/settings-sync',
  'runtime/packages/host/telemetry',
];

function parseArgs(argv) {
  let outDir = join(REPO_ROOT, '.run', 'plugin-bundle-dist');
  let archiveName = 'chatdsh-plugin-bundle.tar.gz';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out-dir' && argv[i + 1]) {
      outDir = resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--out-dir=')) {
      outDir = resolve(arg.slice('--out-dir='.length));
    } else if (arg === '--archive-name' && argv[i + 1]) {
      archiveName = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--archive-name=')) {
      archiveName = arg.slice('--archive-name='.length);
    } else if (arg === '-h' || arg === '--help') {
      console.log('用法：node scripts/pack-plugin-bundle.mjs [--out-dir <目录>] [--archive-name <文件名>]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { outDir, archiveName };
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function readGitCommit() {
  try {
    const env = { ...process.env };
    delete env.GIT_CONFIG_COUNT;
    delete env.GIT_CONFIG_KEY_0;
    delete env.GIT_CONFIG_VALUE_0;
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, env, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function bundleApplyOverridesHelper(stageDir) {
  const runtimeRequire = createRequire(join(RUNTIME_ROOT, 'package.json'));
  const esbuild = runtimeRequire('esbuild');
  const yamlEntry = runtimeRequire.resolve('yaml');

  const helperSource = `
const fs = require('node:fs');
const path = require('node:path');
const YAML = require(${JSON.stringify(yamlEntry)});

const workspaceFile = process.argv[2];
const manifestFile = process.argv[3];
if (!workspaceFile || !manifestFile) {
  console.error('用法：node apply-overrides.cjs <pnpm-workspace.yaml> <manifest.json>');
  process.exit(1);
}

const tarballsDir = path.dirname(path.resolve(manifestFile));
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
  throw new Error('manifest.json 缺少有效的 packages 清单');
}

const text = fs.existsSync(workspaceFile) ? fs.readFileSync(workspaceFile, 'utf8') : '';
const doc = YAML.parseDocument(text.trim() === '' ? '{}\\n' : text);
for (const pkg of manifest.packages) {
  const tarballPath = path.join(tarballsDir, pkg.tarball);
  if (!fs.existsSync(tarballPath)) {
    throw new Error('缺少插件包产物：' + tarballPath);
  }
  doc.setIn(['overrides', pkg.name], 'file:' + tarballPath.split(path.sep).join('/'));
}
fs.writeFileSync(workspaceFile, String(doc), 'utf8');
`;

  await esbuild.build({
    stdin: {
      contents: helperSource,
      resolveDir: RUNTIME_ROOT,
      loader: 'js',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: join(stageDir, 'apply-overrides.cjs'),
    logLevel: 'warning',
  });
}

async function main() {
  const { outDir, archiveName } = parseArgs(process.argv.slice(2));

  const missing = REQUIRED_ARTIFACTS.filter((rel) => !existsSync(join(REPO_ROOT, rel)));
  if (missing.length > 0) {
    throw new Error(`插件产物缺失 ${missing.length} 项，请先构建 dsh-adapter 与 runtime：\n  ${missing.join('\n  ')}`);
  }

  mkdirSync(outDir, { recursive: true });
  const stageDir = join(outDir, `.stage-${process.pid}`);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  const storeDir =
    process.env.pnpm_config_store_dir ||
    process.env.npm_config_store_dir ||
    process.env.CHATDSH_PNPM_STORE ||
    join(RUNTIME_ROOT, '.run', 'pnpm-store');

  try {
    const packages = [];
    let bundleEntry = null;

    for (const relDir of PACKAGE_DIRS) {
      const absDir = join(REPO_ROOT, relDir);
      const pkg = JSON.parse(readFileSync(join(absDir, 'package.json'), 'utf8'));
      execFileSync(
        'pnpm',
        [
          `--config.store-dir=${storeDir}`,
          '--config.verify-deps-before-run=false',
          '--dir',
          absDir,
          'pack',
          '--pack-destination',
          stageDir,
        ],
        {
          cwd: RUNTIME_ROOT,
          env: {
            ...process.env,
            npm_config_store_dir: storeDir,
            pnpm_config_store_dir: storeDir,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      const base = pkg.name.replace(/^@/, '').replace('/', '-');
      const tarball = `${base}-${pkg.version}.tgz`;
      const tarballPath = join(stageDir, tarball);
      if (!existsSync(tarballPath)) {
        throw new Error(`未找到打包产物：${tarballPath}`);
      }
      const entry = {
        name: pkg.name,
        version: pkg.version,
        tarball,
        sha256: sha256File(tarballPath),
      };
      packages.push(entry);
      if (pkg.name === '@chatdsh/bundle') {
        bundleEntry = entry;
      }
    }

    if (!bundleEntry) {
      throw new Error('未在打包清单中找到 @chatdsh/bundle');
    }

    await bundleApplyOverridesHelper(stageDir);

    const manifest = {
      schemaVersion: 1,
      version: bundleEntry.version,
      commit: readGitCommit(),
      builtAt: new Date().toISOString(),
      bundle: {
        name: bundleEntry.name,
        version: bundleEntry.version,
        tarball: bundleEntry.tarball,
        sha256: bundleEntry.sha256,
      },
      packages,
    };
    writeFileSync(join(stageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const archivePath = join(outDir, archiveName);
    execFileSync('tar', ['-czf', archivePath, '-C', stageDir, '.'], { stdio: 'inherit' });

    const archiveSha = sha256File(archivePath);
    const checksumPath = join(outDir, 'SHA256SUMS.txt');
    writeFileSync(checksumPath, `${archiveSha}  ${archiveName}\n`, 'utf8');

    console.log(`已生成插件发布归档：${archivePath}`);
    console.log(`SHA-256：${archiveSha}`);
    console.log(`包含包数量：${packages.length}（入口：${bundleEntry.tarball}）`);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

await main();
