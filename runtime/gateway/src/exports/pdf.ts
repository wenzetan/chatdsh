/**
 * PDF 渲染：用本机的 Chrome 打印管线把打印文档转成 PDF。
 *
 * 渲染器把打印文档写成文件，交给 Chrome 的 `--print-to-pdf` 打印，再核对输出确实以 `%PDF-`
 * 开头。打印管线按打印样式分页，中文是可选中的文本（字体随文档嵌入），长文档跨页时分页
 * 规则生效。取消与超时都会终止渲染进程并清掉半成品文件，不留下可下载的残缺文件。
 * 工作目录与浏览器配置目录都在导出包内，渲染进程的 HOME 指向它，不写用户主目录。
 * @module @chatdsh/gateway/exports/pdf
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHATDSH_ERROR_CODES } from '@chatdsh/core-contracts';
import { ExportError, type PdfRenderer } from './types.ts';

/** 默认渲染超时。 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** 候选的可执行文件路径，按顺序取第一个存在的。 */
const CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/** 渲染器选项。 */
export interface ChromePdfOptions {
  /** 显式指定的可执行文件；缺省按候选路径查找。 */
  readonly executable?: string;
  /** 追加的启动参数。 */
  readonly extraArgs?: readonly string[];
  /** 渲染超时，毫秒。 */
  readonly timeoutMs?: number;
}

/** 查找 Chrome。 */
function locateChrome(options: ChromePdfOptions): string | undefined {
  const explicit = options.executable ?? process.env.CHATDSH_CHROME_PATH;
  if (explicit !== undefined) return existsSync(explicit) ? explicit : undefined;
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 终止子进程并等待它退出。 */
function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null) {
      done();
      return;
    }
    child.once('exit', () => done());
    child.kill('SIGKILL');
  });
}

/**
 * 创建 Chrome 打印渲染器。
 * @param options - 可执行文件、追加参数与超时。
 * @returns PDF 渲染器。
 */
export function createChromePdfRenderer(options: ChromePdfOptions = {}): PdfRenderer {
  const executable = locateChrome(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const extraArgs = options.extraArgs ?? [];
  return {
    available(): boolean {
      return executable !== undefined;
    },
    unavailableReason(): string {
      return 'pdf-renderer-unavailable';
    },
    async render(input): Promise<Uint8Array> {
      if (executable === undefined) {
        throw new ExportError(
          CHATDSH_ERROR_CODES.exportFormatUnsupported,
          'pdf-renderer-unavailable',
          '本机没有可用的 Chrome，PDF 导出不可用',
        );
      }
      await mkdir(input.workDir, { recursive: true });
      const htmlPath = join(input.workDir, 'print.html');
      const pdfPath = join(input.workDir, 'print.pdf');
      const profileDir = join(input.workDir, 'chrome-profile');
      await writeFile(htmlPath, input.html, 'utf8');

      const args = [
        '--headless=new',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-pdf-header-footer',
        '--virtual-time-budget=10000',
        `--user-data-dir=${profileDir}`,
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(htmlPath).href,
        ...extraArgs,
      ];
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        // 以 root 运行时 Chrome 要求关闭沙箱；其他用户保持沙箱开启。
        args.push('--no-sandbox');
      }

      const child = spawn(executable, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, HOME: input.workDir },
      });
      let stderrBytes = 0;
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
      });

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      let aborted = false;
      const onAbort = (): void => {
        aborted = true;
        void stopChild(child);
      };
      input.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        void stopChild(child);
      }, timeoutMs);

      try {
        const result = await exited;
        if (aborted) {
          await rm(pdfPath, { force: true });
          throw new ExportError(CHATDSH_ERROR_CODES.exportExpired, 'export-cancelled', '导出已取消');
        }
        if (result.code !== 0) {
          await rm(pdfPath, { force: true });
          throw new ExportError(
            CHATDSH_ERROR_CODES.internalError,
            'pdf-render-failed',
            `PDF 渲染进程退出码 ${String(result.code ?? -1)}，诊断输出 ${String(stderrBytes)} 字节`,
          );
        }
        const bytes = new Uint8Array(await readFile(pdfPath).catch(() => {
          throw new ExportError(CHATDSH_ERROR_CODES.internalError, 'pdf-missing', 'PDF 渲染没有产出文件');
        }));
        const head = Buffer.from(bytes.subarray(0, 5)).toString('latin1');
        if (head !== '%PDF-') {
          await rm(pdfPath, { force: true });
          throw new ExportError(CHATDSH_ERROR_CODES.internalError, 'pdf-invalid', '渲染结果不是 PDF 文件');
        }
        return bytes;
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
