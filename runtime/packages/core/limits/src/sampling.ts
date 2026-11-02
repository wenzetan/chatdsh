/**
 * 真实进程资源采样。
 *
 * 内存取 `process.memoryUsage()`，文件描述符数取 `/proc/self/fd` 的目录项数，子进程数取
 * `/proc/self/task/<tid>/children` 里登记的全部进程号。三项都来自当前真实进程，不估算、
 * 不复用外部计数。
 * @module @chatdsh/core-limits/sampling
 */

import { readFileSync, readdirSync } from 'node:fs';

/** 一次进程采样。 */
export interface ProcessSample {
  /** 采样时刻的毫秒时间戳。 */
  readonly at: number;
  /** 常驻内存字节数。 */
  readonly rssBytes: number;
  /** 堆已用字节数。 */
  readonly heapUsedBytes: number;
  /** 堆外已用字节数。 */
  readonly externalBytes: number;
  /** 打开的文件描述符数。 */
  readonly fileDescriptors: number;
  /** 当前进程的子进程数。 */
  readonly childProcesses: number;
}

/** 读取打开的文件描述符数。 */
export function readFileDescriptorCount(): number {
  return readdirSync('/proc/self/fd').length;
}

/**
 * 读取当前进程登记的子进程数。
 *
 * 每个线程在 `/proc/self/task/<tid>/children` 里列出自己的子进程号，同一个子进程可能出现在
 * 多个线程下，因此按进程号去重。
 * @returns 子进程数量。
 */
export function readChildProcessCount(): number {
  const tasks = readdirSync('/proc/self/task');
  const children = new Set<string>();
  for (const task of tasks) {
    let text: string;
    try {
      text = readFileSync(`/proc/self/task/${task}/children`, 'utf8');
    } catch {
      // 线程在两次读取之间退出时该线程目录消失，跳过即可。
      continue;
    }
    for (const pid of text.trim().split(/\s+/)) if (pid !== '') children.add(pid);
  }
  return children.size;
}

/**
 * 采样一次当前进程。
 * @returns 采样结果。
 */
export function sampleProcess(): ProcessSample {
  const memory = process.memoryUsage();
  return {
    at: Date.now(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    fileDescriptors: readFileDescriptorCount(),
    childProcesses: readChildProcessCount(),
  };
}

/** 峰值跟踪器。 */
export class PeakTracker {
  private rssPeak = 0;
  private fdPeak = 0;
  private childPeak = 0;
  private latest: ProcessSample | undefined;

  /** 记录一次采样。 */
  observe(sample: ProcessSample): void {
    this.latest = sample;
    this.rssPeak = Math.max(this.rssPeak, sample.rssBytes);
    this.fdPeak = Math.max(this.fdPeak, sample.fileDescriptors);
    this.childPeak = Math.max(this.childPeak, sample.childProcesses);
  }

  /** 采样一次并记录。 */
  sample(): ProcessSample {
    const sample = sampleProcess();
    this.observe(sample);
    return sample;
  }

  /** 常驻内存峰值。 */
  get rssPeakBytes(): number {
    return this.rssPeak;
  }

  /** 文件描述符峰值。 */
  get fileDescriptorPeak(): number {
    return this.fdPeak;
  }

  /** 子进程峰值。 */
  get childProcessPeak(): number {
    return this.childPeak;
  }

  /** 最近一次采样；还没采样时为 `undefined`。 */
  get last(): ProcessSample | undefined {
    return this.latest;
  }
}
