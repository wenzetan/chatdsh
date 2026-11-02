/**
 * 用量：会话 token 记账投影与数据根的存储字节读数。
 *
 * 记账跟着助手消息走（`assistant/message` 的 `usage`），因此这个投影只在该事件上改变状态，
 * 其余事件返回同一引用，不产生下游工作。控制平面按会话、工作区与设备三个维度聚合它。
 *
 * 存储字节读数走真实文件系统：清点结果与磁盘实际占用一致，读取失败就地抛出并带上路径。
 * 对外方法走 typert Remote：客户端与控制平面按 `chatdshStorageUsage` 命名空间调用。
 * @module @chatdsh/host-usage
 */

import { Remote, telemetryOf, TypertRemoteService, type Context } from '@chatdsh/adapter';
import { z } from 'zod';
import { measureStorageUsage, StorageUsageError, type StorageUsageInput, type StorageUsageReport } from './storage.ts';
import type { ChatdshUsageState } from './types.ts';

export type { ChatdshUsageState } from './types.ts';
export {
  bucketOfPath,
  measureStorageUsage,
  STORAGE_BUCKETS,
  STORAGE_DIMENSIONS,
  STORAGE_RETENTION_RANGE,
  StorageUsageError,
} from './storage.ts';
export type {
  StorageAttachmentRef,
  StorageBucket,
  StorageBucketUsage,
  StorageDimension,
  StorageReplicaRef,
  StorageSessionRef,
  StorageUsageErrorCode,
  StorageUsageInput,
  StorageUsageReport,
  StorageUsageRow,
} from './storage.ts';

/** 插件名。 */
export const name = 'chatdsh-usage';

/** 依赖的服务：投影注册表。 */
export const inject = ['sessionProjections'];

/** 投影键。 */
export const PROJECTION_KEY = 'chatdshUsage';

/** 投影状态版本。 */
export const STATE_VERSION = 1;

/** 存储字节读数服务名，同时是 Remote 命名空间。 */
export const STORAGE_SERVICE_NAME = 'chatdshStorageUsage';

/** 状态 schema。 */
export const stateSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  accountedSteps: z.number().int().nonnegative(),
  reportedSteps: z.number().int().nonnegative(),
});

/** 初始状态：全部为零。 */
export const EMPTY_USAGE: ChatdshUsageState = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  accountedSteps: 0,
  reportedSteps: 0,
};

/** 遥测 span 用到的最小接口。 */
type SpanLike = { setAttribute(key: string, value: unknown): void };

/** 用到的遥测面。 */
interface UsageTelemetry {
  runSpan<T>(name: string, attributes: Record<string, unknown>, body: (span: SpanLike) => Promise<T>): Promise<T>;
  counter(name: string, options: { description: string }): { add(delta: number, attributes?: Record<string, unknown>): void };
}

/**
 * 存储字节读数服务。
 *
 * 一个动作只做一件事：在给定的数据根上按真实字节清点，并按设备、工作区与会话聚合。清点失败
 * （路径读不到、输入不合法）就地抛出，调用方拿到的是错误。
 */
export class StorageUsageService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, STORAGE_SERVICE_NAME);
  }

  /**
   * 清点一个数据根的存储用量。
   * @param input - 数据根、设备标识、保留周期与三个索引。
   * @returns 清点结果。
   */
  @Remote('measure')
  async measure(input: StorageUsageInput): Promise<StorageUsageReport> {
    return this.access('measure', async () => measureStorageUsage(input));
  }

  /**
   * 在一个远程调用 span 里执行，失败时补结果属性与计数。
   * @param action - 动作名，写入 `rpc.method`。
   * @param body - 动作主体。
   * @returns 动作结果。
   */
  private async access<T>(action: string, body: () => Promise<T>): Promise<T> {
    const telemetry = telemetryOf<UsageTelemetry>(this.ctx);
    const method = `${STORAGE_SERVICE_NAME}/${action}`;
    const counter = telemetry?.counter('chatdsh_remote_calls_total', { description: 'Remote 调用数' });
    const run = async (span?: SpanLike): Promise<T> => {
      try {
        const value = await body();
        span?.setAttribute('outcome', 'ok');
        counter?.add(1, { method, outcome: 'ok' });
        return value;
      } catch (error) {
        const code = error instanceof StorageUsageError ? error.code : 'internal-error';
        span?.setAttribute('outcome', 'failed');
        counter?.add(1, { method, outcome: 'failed', error_code: code });
        throw error;
      }
    };
    if (telemetry === undefined) return run();
    return telemetry.runSpan('chatdsh.runtime.remote.call', { 'rpc.method': method }, run);
  }
}

/**
 * 注册用量投影与存储字节读数服务。
 * @param ctx - 宿主上下文，提供 `sessionProjections`。
 * @returns 注销函数。
 */
export function apply(ctx: Context): () => void {
  ctx.plugin(StorageUsageService);
  return ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema,
    init: () => EMPTY_USAGE,
    apply: (state, event) => {
      if (event.type !== 'assistant/message') return state;
      const usage = event.data.usage;
      if (usage === undefined) return state;
      return {
        inputTokens: state.inputTokens + usage.inputTokens,
        outputTokens: state.outputTokens + usage.outputTokens,
        cacheReadTokens: state.cacheReadTokens + (usage.cacheReadTokens ?? 0),
        cacheWriteTokens: state.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
        accountedSteps: state.accountedSteps + (usage.totalTokens === undefined ? 0 : 1),
        reportedSteps: state.reportedSteps + 1,
      };
    },
    wire: {
      viewSchema: stateSchema,
      view: (state) => state,
    },
  });
}
