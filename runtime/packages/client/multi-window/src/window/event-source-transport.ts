/**
 * 基于 EventSource 的真实订阅传输。
 *
 * 采用方给出订阅地址，这里建立一条浏览器原生的 `EventSource`：连接打开、中断与关闭分别映射
 * 成共用运行时的状态；每条 `message` 事件按 JSON 解析后交给共用运行时。帧内容不是 JSON 时
 * 记为中断并给出原因，不做猜测修补。
 *
 * 连接由共用运行时按窗口选举结果建立，因此本模块自身不关心有几个窗口。
 * @module @chatdsh/client-multi-window/event-source-transport
 */

import type { RuntimeConnection, RuntimeTransport, RuntimeTransportHandlers } from './shared-runtime.ts';

/** 传输层的构造参数。 */
export interface EventSourceTransportOptions {
  /** 订阅地址。 */
  readonly url: string;
  /** 是否携带同源凭据，缺省跟随浏览器默认值。 */
  readonly withCredentials?: boolean;
}

/**
 * 建立一条 EventSource 订阅传输。
 * @param options - 订阅地址。
 * @returns 传输层。
 */
export function eventSourceTransport(options: EventSourceTransportOptions): RuntimeTransport {
  return {
    open(handlers: RuntimeTransportHandlers): RuntimeConnection {
      let source: EventSource | undefined = new EventSource(
        options.url,
        options.withCredentials === undefined ? undefined : { withCredentials: options.withCredentials }
      );
      handlers.onStatus('connecting');
      source.onopen = () => {
        handlers.onStatus('open');
      };
      source.onmessage = (event: MessageEvent<string>) => {
        let frame: unknown;
        try {
          frame = JSON.parse(event.data);
        } catch {
          handlers.onStatus('interrupted', 'frame-invalid');
          return;
        }
        handlers.onFrame(frame);
      };
      source.onerror = () => {
        handlers.onStatus('interrupted', 'connection-error');
      };
      return {
        close(): void {
          if (source === undefined) return;
          source.close();
          source = undefined;
          handlers.onStatus('closed');
        },
      };
    },
  };
}
