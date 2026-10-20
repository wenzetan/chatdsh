/**
 * 浏览器工具：一个工具，方法作为参数。
 *
 * 工具目录的容量有限，几十个细粒度工具会挤占模型的选择空间，因此这一域只暴露一个入口。
 * 浏览器在首次调用时启动，之后复用同一个会话；插件卸载时关闭。
 * @module @chatdsh/tool-browser
 */

import { defineTool, schema as sz, type Context } from '@chatdsh/adapter';
import { launchBrowser, type Browser, type BrowserSession } from './cdp.ts';
import { expressionOf, METHODS, type BrowserMethod } from './expressions.ts';

export { launchBrowser } from './cdp.ts';
export type { Browser, BrowserSession } from './cdp.ts';
export { expressionOf, METHODS } from './expressions.ts';
export type { BrowserMethod } from './expressions.ts';

/** 插件名。 */
export const name = 'chatdsh-tool-browser';

/** 依赖：工具注册表。 */
export const inject = ['tools'];

/** 配置。 */
export interface BrowserConfig {
  /** 浏览器可执行文件。 */
  executable: string;
  /** 调试端口。 */
  port: number;
}

/** 配置 schema。 */
export const Config: sz<BrowserConfig> = sz.object({
  executable: sz.string().default('/usr/bin/google-chrome'),
  port: sz.number().default(9222),
});

/**
 * 注册浏览器工具。
 * @param ctx - 宿主上下文。
 * @param config - 配置。
 */
export function apply(ctx: Context, config: BrowserConfig): void {
  let browser: Browser | undefined;
  let session: BrowserSession | undefined;

  ctx.effect(() => () => {
    const closing = browser;
    browser = undefined;
    session = undefined;
    if (closing !== undefined) void closing.close();
  });

  async function ensureSession(): Promise<BrowserSession> {
    if (browser === undefined) {
      browser = await launchBrowser({ executable: config.executable, port: config.port });
    }
    if (session === undefined) session = await browser.open();
    return session;
  }

  ctx.tools.register(defineTool({
    name: 'browser',
    description: '驱动本机浏览器：导航、读取地址与标题、提取页面文本、点击元素、填写输入框、截图。一次调用只做一件事。',
    parameters: {
      method: { type: 'string', required: true, enum: [...METHODS], description: '要做的事。' },
      url: { type: 'string', description: 'navigate 时的目标地址。' },
      selector: { type: 'string', description: 'click 与 fill 需要的 CSS 选择器；text 可用它限定区域。' },
      value: { type: 'string', description: 'fill 时写入的值。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          method: { type: 'string', required: true },
          result: { type: 'string', required: true },
          bytes: { type: 'integer' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    async execute(args) {
      const page = await ensureSession();
      const method = args.method as BrowserMethod;
      if (method === 'navigate') {
        if (args.url === undefined) throw new Error('navigate 需要 url');
        await page.navigate(args.url);
        return { method, result: `已打开 ${await page.location()}` };
      }
      if (method === 'screenshot') {
        const data = await page.screenshot();
        return { method, result: `已截图（base64 长度 ${data.length}）`, bytes: data.length };
      }
      const value = await page.evaluate(expressionOf(method, args.selector, args.value));
      return { method, result: typeof value === 'string' ? value : JSON.stringify(value) };
    },
  }));
}
