/**
 * CDP 会话：启动一个无头 Chrome，通过调试协议驱动它。
 *
 * 只用到协议里最小的几组：建目标、挂会话、导航、在页面里求值、截图。每条请求按 id 配对
 * 响应，协议侧的错误直接抛出，不做重试。
 * @module @chatdsh/tool-browser/cdp
 */

import { spawn, type ChildProcess } from 'node:child_process';

/** 协议响应。 */
interface CdpMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message: string; readonly code: number };
  readonly method?: string;
  readonly params?: unknown;
}

/** 一个已连接的页面会话。 */
export interface BrowserSession {
  /** 导航到某个地址并等页面加载完成。 */
  navigate(url: string): Promise<void>;
  /** 在页面里求值，返回可序列化的结果。 */
  evaluate(expression: string): Promise<unknown>;
  /** 截取当前视口的 PNG，返回 base64。 */
  screenshot(): Promise<string>;
  /** 当前地址。 */
  location(): Promise<string>;
  /** 关闭页面与会话。 */
  close(): Promise<void>;
}

/** 一个已启动的浏览器。 */
export interface Browser {
  /** 打开一个页面并返回会话。 */
  open(): Promise<BrowserSession>;
  /** 关闭浏览器进程。 */
  close(): Promise<void>;
}

/**
 * 启动浏览器并等调试端点就绪。
 * @param options - 可执行文件、端口与额外参数。
 * @returns 浏览器实例。
 */
export async function launchBrowser(options: {
  readonly executable: string;
  readonly port: number;
  readonly timeoutMs?: number;
  /** 用户数据目录；缺省时 Chrome 会挑一个临时目录，容器里常常不可写。 */
  readonly userDataDir?: string;
}): Promise<Browser> {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${options.port}`,
  ];
  if (options.userDataDir !== undefined) args.push(`--user-data-dir=${options.userDataDir}`);
  args.push('about:blank');

  const child: ChildProcess = spawn(options.executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const endpoint = `http://127.0.0.1:${options.port}`;
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  let wsUrl: string | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const payload = (await response.json()) as { webSocketDebuggerUrl?: string };
        if (typeof payload.webSocketDebuggerUrl === 'string') {
          wsUrl = payload.webSocketDebuggerUrl;
          break;
        }
      }
    } catch {
      // 还没起来：继续等。
    }
    await new Promise((settle) => setTimeout(settle, 200));
  }
  if (wsUrl === undefined) {
    child.kill('SIGKILL');
    throw new Error(`浏览器在 ${options.timeoutMs ?? 20_000} 毫秒内没有就绪`);
  }

  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });

  let nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) waiter.reject(new Error(`CDP ${message.error.message}（${message.error.code}）`));
    else waiter.resolve(message.result);
  });

  function send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    nextId += 1;
    const id = nextId;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify(payload));
    });
  }

  return {
    async open(): Promise<BrowserSession> {
      const target = (await send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
      const attached = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })) as { sessionId: string };
      const sessionId = attached.sessionId;
      await send('Page.enable', {}, sessionId);
      await send('Runtime.enable', {}, sessionId);

      const evaluate = async (expression: string): Promise<unknown> => {
        const result = await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        }, sessionId) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
        if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text ?? '页面求值失败');
        return result.result?.value;
      };

      return {
        async navigate(url: string): Promise<void> {
          await send('Page.navigate', { url }, sessionId);
          // 等文档就绪：轮询 readyState，超时由调用方控制。
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const ready = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId) as { result?: { value?: string } };
            if (ready.result?.value === 'complete') return;
            await new Promise((settle) => setTimeout(settle, 100));
          }
        },
        evaluate,
        async screenshot(): Promise<string> {
          const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId) as { data?: string };
          if (typeof shot.data !== 'string') throw new Error('截图没有返回数据');
          return shot.data;
        },
        async location(): Promise<string> {
          const value = await evaluate('location.href');
          return String(value ?? '');
        },
        async close(): Promise<void> {
          await send('Target.closeTarget', { targetId: target.targetId });
        },
      };
    },
    async close(): Promise<void> {
      try {
        socket.close();
      } finally {
        child.kill('SIGTERM');
      }
    },
  };
}
