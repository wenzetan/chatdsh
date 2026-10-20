/**
 * 种子构造：把控制平面副本里的记录还原成会话事件。
 *
 * 副本的每一行同时存着排序用的标量与被上报的完整事件。会话创建要的是完整信封
 * （`type`／`seq`／`time`／`data`），所以这里取 `payload`，并核对它与外层的序号一致——
 * 两者不一致说明副本被写坏了，就地抛出而不做修补。
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
}

/**
 * 把副本记录还原成种子事件。
 * @param records - 按序号升序的副本记录。
 * @returns 可直接交给会话创建的种子。
 * @throws 记录缺少完整信封，或内外序号不一致。
 */
export function buildSeed(records: readonly ReplicaRecord[]): SessionSeedEvent[] {
  if (records.length === 0) throw new Error('副本为空，没有可恢复的事件');
  return records.map((record, index) => {
    const payload = record.payload;
    if (payload === null || typeof payload !== 'object') {
      throw new Error(`第 ${index} 条副本记录缺少完整事件：${record.seq}`);
    }
    const event = payload as Partial<SessionSeedEvent>;
    if (typeof event.type !== 'string' || typeof event.time !== 'number') {
      throw new Error(`第 ${index} 条副本记录的事件信封不完整：${record.seq}`);
    }
    if (event.seq !== record.seq) {
      throw new Error(`第 ${index} 条副本记录的序号不一致：外层 ${record.seq}，事件 ${String(event.seq)}`);
    }
    return { type: event.type, seq: event.seq, time: event.time, data: event.data };
  });
}
