/**
 * 血缘面板。
 *
 * 显示一条会话的完整血缘：从根到父的祖先、这条会话的归属详情、直接子会话与整棵子树。每个
 * 节点都列出它从父会话继承的内容范围（完整回合数、事件数、字符数、压缩标记与附件完整性），
 * 并且可以点开继续查看该节点的血缘。
 * @module @chatdsh/client-data-management/lineage-panel
 */

import type { LineageNode } from '@chatdsh/core-contracts';
import { Badge, Button, EmptyState, ErrorNote, Field, Panel, StatusLine } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { callFace, type DataManagementFace } from './face.ts';
import {
  attachmentsText,
  formatCount,
  formatTimestamp,
  turnsOf,
} from './format.ts';
import { DataCallError, failureOf, failureText } from './errors.ts';
import { parseLineageChain, type LineageChain } from './schemas.ts';
import { browserTelemetry } from './telemetry.ts';

/** 会话类型的名称。 */
const KIND_LABELS: Readonly<Record<'work' | 'chat', string>> = { work: '工作会话', chat: '聊天会话' };

/** 继承范围的属性。 */
function InheritedScope({ node }: { readonly node: LineageNode }) {
  const scope = node.inheritedScope;
  if (scope === undefined) {
    return <StatusLine>这条会话没有从父会话继承内容。</StatusLine>;
  }
  return (
    <dl data-inherited={node.sessionId}>
      <div><dt>继承回合数</dt><dd data-inherited-turns>{formatCount(turnsOf(scope), '个完整回合')}</dd></div>
      <div><dt>继承事件数</dt><dd data-inherited-events>{formatCount(scope.eventCount, '个事件')}</dd></div>
      <div><dt>继承字符数</dt><dd data-inherited-chars>{formatCount(scope.charCount, '个字符')}</dd></div>
      <div><dt>压缩标记</dt><dd data-inherited-compressed>{scope.compressed ? '压缩复制' : '原文复制'}</dd></div>
      <div><dt>附件完整性</dt><dd data-inherited-attachments>{attachmentsText(scope)}</dd></div>
    </dl>
  );
}

/** 血缘面板的属性。 */
export interface LineagePanelProps {
  /** 数据入口；缺省表示控制平面没有接入。 */
  readonly face?: DataManagementFace;
  /** 读取成功时把血缘链交给外部，供导出使用。 */
  readonly onLoaded?: (chain: LineageChain) => void;
}

/**
 * 血缘面板。
 * @param props - 数据入口与回调。
 * @returns 面板内容。
 */
export function LineagePanel({ face, onLoaded }: LineagePanelProps) {
  const [sessionId, setSessionId] = useState('');
  const [inputError, setInputError] = useState<string | undefined>(undefined);
  const [chain, setChain] = useState<LineageChain | undefined>(undefined);
  const [failure, setFailure] = useState<DataCallError | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(async (target: string): Promise<void> => {
    if (face?.lineage === undefined) {
      setFailure(failureOf(new Error('控制平面没有提供血缘接口')));
      return;
    }
    setFailure(undefined);
    setLoading(true);
    try {
      const value = await callFace('读取血缘', () => face.lineage!(target), parseLineageChain);
      if (!alive.current) return;
      setChain(value);
      setSessionId(target);
      browserTelemetry.action('data-lineage-read', 'ok');
      onLoaded?.(value);
    } catch (error) {
      if (!alive.current) return;
      setChain(undefined);
      setFailure(failureOf(error));
      browserTelemetry.action('data-lineage-read', 'failed');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [face, onLoaded]);

  /** 一个可导航的节点。 */
  const navNode = (node: LineageNode, attribute: string): ReactElement => (
    <li key={node.sessionId}>
      <Button
        {...{ [attribute]: node.sessionId }}
        aria-label={`查看 ${node.sessionId} 的血缘`}
        onClick={() => { void read(node.sessionId); }}
      >
        {`${node.sessionId} · ${KIND_LABELS[node.kind]} · ${node.deviceId} · ${formatTimestamp(node.createdAt)}`}
      </Button>
      <InheritedScope node={node} />
    </li>
  );

  return (
    <Panel title="血缘" subtitle="祖先、自身、直接子会话与整棵子树；继承范围按真实复制内容计算。">
      <Field label="会话标识" error={inputError} help="填写会话标识，查看它在血缘链上的位置与继承内容。">
        <input
          type="text"
          data-lineage-input
          value={sessionId}
          onChange={(event) => {
            setSessionId(event.target.value);
          }}
        />
      </Field>
      <Button
        data-lineage-read
        disabled={loading}
        onClick={() => {
          if (sessionId.trim() === '') {
            setInputError('请填写会话标识');
            return;
          }
          setInputError(undefined);
          void read(sessionId.trim());
        }}
      >
        {loading ? '正在读取…' : '查询血缘'}
      </Button>
      {failure === undefined ? null : <ErrorNote>{`读取血缘失败：${failureText(failure)}`}</ErrorNote>}
      {chain === undefined && failure === undefined ? <EmptyState>还没有查询任何会话的血缘。</EmptyState> : null}
      {chain === undefined ? null : (
        <div data-lineage-view>
          <dl>
            <div><dt>根会话</dt><dd data-lineage-root>{chain.rootSessionId}</dd></div>
            <div><dt>层数</dt><dd data-lineage-depth>{formatCount(chain.depth, '层')}</dd></div>
          </dl>
          <h3>祖先</h3>
          {chain.ancestors.length === 0
            ? <StatusLine>这条会话是血缘链的起点。</StatusLine>
            : <ul data-lineage-ancestors>{chain.ancestors.map((node) => navNode(node, 'data-lineage-ancestor'))}</ul>}
          <h3>当前会话</h3>
          <div data-lineage-self={chain.self.sessionId}>
            <dl>
              <div><dt>归属设备</dt><dd>{chain.self.deviceId}</dd></div>
              <div><dt>工作目录</dt><dd>{chain.self.cwd}</dd></div>
              <div><dt>会话类型</dt><dd>{KIND_LABELS[chain.self.kind]}</dd></div>
              <div><dt>建立时刻</dt><dd>{formatTimestamp(chain.self.createdAt)}</dd></div>
              <div><dt>父会话</dt><dd>{chain.self.parentSession ?? '没有父会话'}</dd></div>
            </dl>
            <InheritedScope node={chain.self} />
          </div>
          <h3>直接子会话</h3>
          {chain.children.length === 0
            ? <StatusLine>这条会话还没有子会话。</StatusLine>
            : <ul data-lineage-children>{chain.children.map((node) => navNode(node, 'data-lineage-child'))}</ul>}
          <h3>整棵子树</h3>
          {chain.descendants.length === 0
            ? <StatusLine>这条会话没有后代。</StatusLine>
            : (
              <>
                <Badge tone="neutral">{formatCount(chain.descendants.length, '个后代会话')}</Badge>
                <ul data-lineage-descendants>{chain.descendants.map((node) => navNode(node, 'data-lineage-descendant'))}</ul>
              </>
            )}
        </div>
      )}
    </Panel>
  );
}
