/**
 * 会话跟随流的订阅。
 *
 * 用浏览器的 `EventSource` 订阅真实 SSE 端点：每个 `message` 事件的 `data` 是一帧跟随帧，
 * 交给装配器处理。连接中断时上报 `interrupted` 并由装配器暂停接收；浏览器自动重连之后，
 * 端点重新发送打开窗口，装配器据此重新读取。帧结构不合法时同样上报中断，并把原因交给调用
 * 方登记，不做猜测修补。
 * @module @chatdsh/client-conversation/client/follow-stream
 */

import { parseFollowFrame, type FollowFrame } from '../messages/frames.ts';

/** 连接状态。 */
export const FOLLOW_STATUSES = ['idle', 'connecting', 'open', 'interrupted', 'closed'] as const;

/** 连接状态取值。 */
export type FollowStatus = (typeof FOLLOW_STATUSES)[number];

/** 订阅的依赖。 */
export interface FollowStreamOptions {
  /** SSE 端点地址。 */
  readonly url: string;
  /** 每帧的回调。 */
  readonly onFrame: (frame: FollowFrame) => void;
  /** 状态变化的回调。 */
  readonly onStatus: (status: FollowStatus, detail?: string) => void;
  /** 建立 EventSource 的实现；缺省用浏览器实现。 */
  readonly createSource?: (url: string) => EventSource;
}

/**
 * 跟随流订阅。
 */
export class FollowStream {
  private source: EventSource | undefined;
  private current: FollowStatus = 'idle';
  private readonly options: FollowStreamOptions;

  /**
   * 建立订阅。
   * @param options - 端点、回调与 EventSource 实现。
   */
  constructor(options: FollowStreamOptions) {
    this.options = options;
  }

  /** 当前连接状态。 */
  get status(): FollowStatus {
    return this.current;
  }

  /** 开始订阅。 */
  start(): void {
    if (this.source !== undefined) return;
    const create = this.options.createSource ?? ((url: string) => new EventSource(url));
    const source = create(this.options.url);
    this.source = source;
    this.setStatus('connecting');
    source.onopen = () => this.setStatus('open');
    source.onmessage = (event: MessageEvent<string>) => {
      let frame: FollowFrame;
      try {
        frame = parseFollowFrame(JSON.parse(event.data));
      } catch (error) {
        this.setStatus('interrupted', error instanceof Error ? error.message : String(error));
        return;
      }
      this.options.onFrame(frame);
    };
    source.onerror = () => this.setStatus('interrupted', 'connection-error');
  }

  /** 关闭订阅。 */
  stop(): void {
    this.source?.close();
    this.source = undefined;
    this.setStatus('closed');
  }

  /** 重新订阅。 */
  restart(): void {
    this.stop();
    this.start();
  }

  /**
   * 更新状态并通知调用方。
   * @param status - 新状态。
   * @param detail - 原因说明。
   */
  private setStatus(status: FollowStatus, detail?: string): void {
    this.current = status;
    this.options.onStatus(status, detail);
  }
}
