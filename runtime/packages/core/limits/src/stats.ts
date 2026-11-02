/**
 * 采样分布的分位数。
 *
 * 用最近秩法（nearest rank）取 p50、p95 与 p99：样本按升序排列后取不小于 `ceil(p*n)` 的最小
 * 位置。样本量小于分位对应位置时取最大值。保留原始采样，报告同时给出计数、最小值、最大值
 * 与平均值，便于核对是否有人只看了分位数。
 * @module @chatdsh/core-limits/stats
 */

/** 一组采样。 */
export interface Distribution {
  /** 样本条数。 */
  readonly count: number;
  /** 最小值。 */
  readonly min: number;
  /** 中位数。 */
  readonly p50: number;
  /** 第 95 百分位。 */
  readonly p95: number;
  /** 第 99 百分位。 */
  readonly p99: number;
  /** 最大值。 */
  readonly max: number;
  /** 平均值。 */
  readonly mean: number;
}

/**
 * 取一个分位数。
 * @param sorted - 已升序排列的采样。
 * @param fraction - 分位比例，取 0 到 1。
 * @returns 该分位的取值。
 */
export function percentileOf(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) throw new Error('分位数需要至少一个采样');
  if (!(fraction > 0 && fraction <= 1)) throw new Error(`分位比例必须在 0 到 1 之间：${String(fraction)}`);
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  const value = sorted[index];
  if (value === undefined) throw new Error(`分位位置越界：${String(index)}`);
  return value;
}

/**
 * 汇总一组采样。
 * @param samples - 原始采样。
 * @returns 汇总结果。
 */
export function summarize(samples: readonly number[]): Distribution {
  if (samples.length === 0) throw new Error('汇总需要至少一个采样');
  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) throw new Error('汇总需要至少一个采样');
  return {
    count: sorted.length,
    min: first,
    p50: percentileOf(sorted, 0.5),
    p95: percentileOf(sorted, 0.95),
    p99: percentileOf(sorted, 0.99),
    max: last,
    mean: total / sorted.length,
  };
}
