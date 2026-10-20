/**
 * 定时任务的调度循环。
 *
 * 控制平面是唯一的调度者：按固定间隔取出到期任务并执行。动作只有两类——唤醒运行时并
 * 投递一次请求，或登记一条待推送。执行结果写回记录，因此「有没有按期触发」可以事后查询；
 * 运行时不可达时记为失败而不是重试，下一次到期由新的任务承担。
 * @module @chatdsh/gateway/scheduler
 */

import type { ChatdshTelemetry } from '@chatdsh/core-contracts';
import type { PushHub } from './push.ts';
import type { ScheduleStore, TaskRecord } from './store.ts';

/** 调度器。 */
export interface Scheduler {
  /** 开始循环。 */
  start(): void;
  /** 停止循环。 */
  stop(): void;
  /** 立即跑一轮，返回本轮执行的任务数。 */
  runOnce(): Promise<number>;
}

/** 调度器构造输入。 */
export interface SchedulerOptions {
  readonly store: ScheduleStore;
  readonly telemetry: ChatdshTelemetry;
  /** 推送中枢，`notify` 动作经它投递。 */
  readonly push: PushHub;
  /** 运行时地址，`wake` 动作向它发一次请求。 */
  readonly runtimeUrl: string;
  /** 扫描间隔。 */
  readonly intervalMs: number;
}

/**
 * 建立调度器。
 * @param options - 存储、遥测、运行时地址与扫描间隔。
 * @returns 调度器。
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { store, telemetry, runtimeUrl } = options;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function execute(task: TaskRecord): Promise<void> {
    await telemetry.runSpan('chatdsh.gateway.schedule.run', {
      'task.id': task.id,
      action: task.action,
    }, async (span) => {
      const outcome = await perform(task);
      span.setAttribute('outcome', outcome);
      telemetry.counter('chatdsh_schedule_runs_total', { description: '定时任务执行次数' })
        .add(1, { action: task.action, outcome });
      store.markExecuted(task.id, outcome);
    });
  }

  async function perform(task: TaskRecord): Promise<string> {
    if (task.action === 'notify') {
      const payload = JSON.stringify({
        kind: 'scheduled',
        taskId: task.id,
        sessionId: task.sessionId,
        detail: task.payload,
        at: Date.now(),
      });
      const result = options.push.deliver(task.accountId, payload, task.sessionId);
      return result.delivered > 0 ? 'delivered' : 'queued';
    }
    try {
      const response = await fetch(`${runtimeUrl}/chatdsh/telemetry/status`, {
        method: 'GET',
        headers: { 'x-chatdsh-schedule': task.id },
      });
      return response.ok ? 'delivered' : `runtime-${response.status}`;
    } catch (error) {
      telemetry.log('warn', 'scheduled wake failed', {
        'task.id': task.id,
        'error.type': error instanceof Error ? error.name : 'Unknown',
      });
      return 'runtime-unreachable';
    }
  }

  return {
    start(): void {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void this.runOnce();
      }, options.intervalMs);
      timer.unref();
    },
    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
    async runOnce(): Promise<number> {
      if (running) return 0;
      running = true;
      try {
        // 先处理到期任务，再处理需要升级的通知。
        const due = store.due(Date.now());
        for (const task of due) await execute(task);
        const escalated = options.push.escalateDue(Date.now());
        return due.length + escalated;
      } finally {
        running = false;
      }
    },
  };
}
