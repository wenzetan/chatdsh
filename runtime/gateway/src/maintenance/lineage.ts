/**
 * 血缘：归属详情、父子关系与完整血缘链。
 *
 * 父会话优先取会话归属记录里的 `parent_session`，缺失时取副本里的导入声明。继承内容范围按
 * 实测得出：子会话与父会话从开头起逐条相同的前缀就是被复制的部分，回合数、事件数与字符数
 * 都从这段前缀算出；父副本已被清理时退回导入声明记录的事件条数。附件完整性看数据根下对应
 * 目录是否存在。对外形状只有内容范围与归属，不含任何副本序号或水位。
 * @module @chatdsh/gateway/maintenance/lineage
 */

import type { DatabaseSync } from 'node:sqlite';
import { ChatdshError, CHATDSH_ERROR_CODES, lineageNodeSchema, type LineageNode } from '@chatdsh/core-contracts';
import {
  attachmentAvailability,
  attachmentIdsOf,
  contentScopeOf,
  importedRecordOf,
  inheritedPrefixLength,
} from './content.ts';
import { assertNoInternalCursor } from './dto.ts';
import { replicaEventsOf, sessionRowOf, sessionRows, type SessionRow } from './rows.ts';
import { DATA_SPANS, type DataTelemetry } from './telemetry.ts';

/** 血缘链的上限，防止异常数据把查询拖成无限循环。 */
const MAX_CHAIN = 64;

/** 后代节点的上限。 */
const MAX_DESCENDANTS = 512;

/** 一次血缘查询的结果。 */
export interface LineageView {
  /** 查询的会话。 */
  readonly sessionId: string;
  /** 链上最早的会话。 */
  readonly rootSessionId: string;
  /** 到根的层数。 */
  readonly depth: number;
  /** 从根到父的祖先，按层级排列。 */
  readonly ancestors: readonly LineageNode[];
  /** 被查询的会话。 */
  readonly self: LineageNode;
  /** 直接子会话。 */
  readonly children: readonly LineageNode[];
  /** 全部后代，按层数广度优先。 */
  readonly descendants: readonly LineageNode[];
}

/** 会话血缘查询。 */
export class SessionLineage {
  constructor(
    private readonly database: DatabaseSync,
    private readonly telemetry: DataTelemetry,
    private readonly dataRoot: string,
  ) {}

  /**
   * 取一个会话的归属详情。
   * @param sessionId - 会话标识。
   * @returns 归属详情，含父会话与继承内容范围。
   */
  async node(sessionId: string): Promise<LineageNode> {
    return this.telemetry.run(DATA_SPANS.lineage, 'lineage.node', { count: 1 }, async () => {
      const node = this.#nodeOf(sessionId);
      assertNoInternalCursor(node, '归属详情');
      return node;
    });
  }

  /**
   * 查询完整血缘链：祖先、自身、直接子会话与全部后代。
   * @param sessionId - 会话标识。
   * @returns 血缘链。
   */
  async chain(sessionId: string): Promise<LineageView> {
    return this.telemetry.run(DATA_SPANS.lineage, 'lineage.chain', { count: 1 }, async () => {
      const ancestors: LineageNode[] = [];
      const seen = new Set<string>([sessionId]);
      let cursor = sessionId;
      for (;;) {
        const node = this.#nodeOf(cursor);
        const parent = node.parentSession;
        if (parent === undefined) break;
        if (seen.has(parent)) {
          throw new ChatdshError(CHATDSH_ERROR_CODES.internalError, `血缘链出现环：${parent}`);
        }
        if (sessionRowOf(this.database, parent) === undefined) break;
        seen.add(parent);
        ancestors.push(this.#nodeOf(parent));
        if (ancestors.length > MAX_CHAIN) {
          throw new ChatdshError(CHATDSH_ERROR_CODES.internalError, `血缘链超过 ${String(MAX_CHAIN)} 层`);
        }
        cursor = parent;
      }
      ancestors.reverse();
      const self = this.#nodeOf(sessionId);
      const children = this.#childrenOf(sessionId);
      const descendants: LineageNode[] = [];
      let frontier = children;
      const expanded = new Set<string>([sessionId]);
      while (frontier.length > 0) {
        const next: LineageNode[] = [];
        for (const child of frontier) {
          if (expanded.has(child.sessionId)) continue;
          expanded.add(child.sessionId);
          descendants.push(child);
          if (descendants.length > MAX_DESCENDANTS) {
            throw new ChatdshError(CHATDSH_ERROR_CODES.internalError, `后代会话超过 ${String(MAX_DESCENDANTS)} 个`);
          }
          next.push(...this.#childrenOf(child.sessionId));
        }
        frontier = next;
      }
      const view: LineageView = {
        sessionId,
        rootSessionId: ancestors[0]?.sessionId ?? sessionId,
        depth: ancestors.length,
        ancestors,
        self,
        children,
        descendants,
      };
      assertNoInternalCursor(view, '血缘链');
      return view;
    });
  }

  /**
   * 列出直接子会话。
   * @param sessionId - 父会话标识。
   * @returns 子会话的归属详情。
   */
  async childrenOf(sessionId: string): Promise<LineageNode[]> {
    return this.telemetry.run(DATA_SPANS.lineage, 'lineage.node', { count: 1 }, async () => this.#childrenOf(sessionId));
  }

  /** 把一条会话归属行转成归属详情。 */
  #nodeOf(sessionId: string): LineageNode {
    const row = sessionRowOf(this.database, sessionId);
    if (row === undefined) {
      throw new ChatdshError(CHATDSH_ERROR_CODES.sessionNotFound, `会话 ${sessionId} 不存在`);
    }
    const events = replicaEventsOf(this.database, sessionId);
    const record = importedRecordOf(events);
    const parent = row.parent_session ?? record?.sourceSessionId;
    const scope = parent === undefined ? undefined : this.#inheritedScope(parent, events, record?.eventCount, record?.lossy);
    return lineageNodeSchema.parse({
      sessionId: row.session_id,
      deviceId: row.device_id,
      cwd: row.cwd,
      kind: row.kind === 'chat' ? 'chat' : 'work',
      createdAt: row.created_at,
      ...(parent === undefined ? {} : { parentSession: parent }),
      ...(scope === undefined ? {} : { inheritedScope: scope }),
    });
  }

  /** 直接子会话。 */
  #childrenOf(sessionId: string): LineageNode[] {
    return sessionRows(this.database)
      .filter((row) => row.parent_session === sessionId)
      .map((row) => this.#nodeOf(row.session_id));
  }

  /**
   * 计算子会话从父会话继承的内容范围。
   * @param parentSessionId - 父会话标识。
   * @param events - 子会话的副本事件。
   * @param declaredEvents - 导入声明记录的事件条数。
   * @param compressed - 导入声明里的压缩标记。
   * @returns 继承内容范围；没有可核对的前缀时空缺。
   */
  #inheritedScope(
    parentSessionId: string,
    events: ReturnType<typeof replicaEventsOf>,
    declaredEvents: number | undefined,
    compressed: boolean | undefined,
  ) {
    const parentRow: SessionRow | undefined = sessionRowOf(this.database, parentSessionId);
    const parentEvents = parentRow === undefined ? [] : replicaEventsOf(this.database, parentSessionId);
    const measured = inheritedPrefixLength(events, parentEvents);
    const inherited = measured > 0 ? measured : (declaredEvents ?? 0);
    if (inherited === 0 || inherited > events.length) return undefined;
    const prefix = events.slice(0, inherited);
    const missing = attachmentAvailability(attachmentIdsOf(prefix), this.dataRoot).missing;
    return contentScopeOf(prefix, {
      compressed: compressed === true,
      attachmentsComplete: missing.length === 0,
    });
  }
}
