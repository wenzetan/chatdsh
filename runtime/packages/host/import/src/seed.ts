/**
 * 种子构造：把控制平面副本里的记录还原成会话事件。
 *
 * 副本的每一行同时存着排序用的标量与被上报的事件数据。设备上报的 `payload` 是事件数据
 * 本身，历史副本里也可能保存完整信封（`type`／`seq`／`time`／`data`）。会话创建要的是
 * 完整信封，这里统一还原，并核对信封与外层的序号一致——两者不一致说明副本被写坏了，
 * 就地抛出而不做修补。
 * @module @chatdsh/host-import/seed
 */

/** 副本里的一行。 */
export interface ReplicaRecord {
  readonly seq: number;
  readonly kind: string;
  readonly time: number;
  readonly payload?: unknown;
}

/** 会话事件的信封，只取用到的字段。 */
export interface SessionSeedEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data?: unknown;
  /** 可进入对话面的事件必须携带的位置标记。 */
  readonly surfaceOp?: 'append' | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number };
  /** 被替换节点引用的源事件序号。 */
  readonly sourceEventSeqs?: readonly number[];
}

/** 需要携带 `surfaceOp` 的事件类型。 */
const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
]);

/**
 * 取一条副本记录里的事件数据。
 * @param record - 副本记录。
 * @returns 事件数据；payload 不是对象时为 undefined。
 */
export function replicaDataOf(record: ReplicaRecord): unknown {
  const payload = record.payload;
  if (payload === null || typeof payload !== 'object') return undefined;
  const envelope = payload as { readonly type?: unknown; readonly data?: unknown };
  return typeof envelope.type === 'string' ? envelope.data : payload;
}

/**
 * 把副本记录还原成种子事件。
 * @param records - 按序号升序的副本记录。
 * @returns 可直接交给会话创建的种子。
 * @throws 记录缺少事件数据，或信封内外序号不一致。
 */
export function buildSeed(records: readonly ReplicaRecord[]): SessionSeedEvent[] {
  if (records.length === 0) throw new Error('副本为空，没有可恢复的事件');
  return records.map((record, index) => {
    const payload = record.payload;
    if (payload === null || typeof payload !== 'object') {
      throw new Error(`第 ${index} 条副本记录缺少完整事件：${record.seq}`);
    }
    const envelope = payload as Partial<SessionSeedEvent>;
    if (typeof envelope.type !== 'string') {
      return {
        type: record.kind,
        seq: record.seq,
        time: record.time,
        data: payload,
        ...(SURFACE_EVENT_TYPES.has(record.kind) ? { surfaceOp: 'append' as const } : {}),
      };
    }
    if (typeof envelope.time !== 'number') {
      throw new Error(`第 ${index} 条副本记录的事件信封不完整：${record.seq}`);
    }
    if (envelope.seq !== record.seq) {
      throw new Error(`第 ${index} 条副本记录的序号不一致：外层 ${record.seq}，事件 ${String(envelope.seq)}`);
    }
    if (!SURFACE_EVENT_TYPES.has(envelope.type)) {
      return { type: envelope.type, seq: envelope.seq, time: envelope.time, data: envelope.data };
    }
    return {
      type: envelope.type,
      seq: envelope.seq,
      time: envelope.time,
      data: envelope.data,
      surfaceOp: envelope.surfaceOp ?? 'append',
      ...(envelope.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: envelope.sourceEventSeqs }),
    };
  });
}
