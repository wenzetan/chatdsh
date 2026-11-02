/**
 * 数据管理区段：用量、副本清理、只读副本、血缘、导入与分叉、删除收件箱。
 *
 * 六个分页共用同一个数据入口。用量、清理、血缘与收件箱的读数在读取成功后进入导出口径；导出按
 * 字段清单逐项构造，界面与导出文件都不含副本内部位置。清理执行结束后自动重新清点用量，恢复与
 * 永久删除结束后自动重新读取收件箱。
 * @module @chatdsh/client-data-management
 */

import { Button, Panel, StatusLine, Tabs } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CleanupPanel } from './cleanup-panel.tsx';
import { buildExportDocument, exportText, type ExportInput } from './export.ts';
import { browserFace, type DataManagementFace } from './face.ts';
import { ForkPanel } from './fork-panel.tsx';
import { InboxPanel } from './inbox-panel.tsx';
import { LineagePanel } from './lineage-panel.tsx';
import { ReplicaPanel } from './replica-panel.tsx';
import type {
  CleanupEstimateView,
  CleanupOutcome,
  DeletionInboxItem,
  ForkEstimateView,
  ForkOutcomeView,
  LineageChain,
  PermanentOutcomeView,
  PermanentScopeView,
  ReplicaState,
  RestoreResultView,
  RetentionPolicy,
  UsageReport,
} from './schemas.ts';
import { browserTelemetry } from './telemetry.ts';
import { UsagePanel } from './usage-panel.tsx';

/** 席位名。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-data-management';

/** 浏览器侧依赖：只等席位服务。 */
export const inject = ['slots'];

/** 页面里的六个分页。 */
const TABS = [
  { id: 'usage', label: '用量与空间' },
  { id: 'cleanup', label: '副本清理' },
  { id: 'replica', label: '只读副本' },
  { id: 'lineage', label: '血缘' },
  { id: 'fork', label: '导入与分叉' },
  { id: 'inbox', label: '删除收件箱' },
] as const;

/** 已经读取到的视图，供导出使用。 */
type Snapshot = Omit<ExportInput, 'exportedAt'>;

/** 删除收件箱面板交给外部的读数。 */
interface InboxSnapshot {
  readonly items: readonly DeletionInboxItem[];
  readonly restore?: RestoreResultView;
  readonly permanentScope?: PermanentScopeView;
  readonly permanentOutcome?: PermanentOutcomeView;
}

/** 一次导出。 */
interface ExportResult {
  readonly text: string;
  readonly url: string;
}

/** 数据管理区段的属性；嵌入场景可以直接传数据入口。 */
export interface DataManagementSectionProps {
  readonly face?: DataManagementFace;
}

/**
 * 设置页的数据管理区段。
 * @param props - 可选的数据入口。
 * @returns 区段内容。
 */
export function DataManagementSection({ face = browserFace }: DataManagementSectionProps = {}) {
  const [tab, setTab] = useState<string>('usage');
  const [refreshToken, setRefreshToken] = useState(0);
  const [exported, setExported] = useState<ExportResult | undefined>(undefined);
  const [exportNotice, setExportNotice] = useState<string | undefined>(undefined);
  const snapshot = useRef<Snapshot>({});
  const previousUrl = useRef<string | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (previousUrl.current !== undefined) URL.revokeObjectURL(previousUrl.current);
    };
  }, []);

  /** 合并一次读取结果。 */
  const record = useCallback((patch: Snapshot): void => {
    snapshot.current = { ...snapshot.current, ...patch };
  }, []);

  const onChanged = useCallback((): void => {
    setRefreshToken((current) => current + 1);
  }, []);

  const onUsageLoaded = useCallback((usage: UsageReport, retention: RetentionPolicy): void => {
    record({ usage, retention });
  }, [record]);

  const onCleanupLoaded = useCallback((estimate: CleanupEstimateView, outcome?: CleanupOutcome): void => {
    record(outcome === undefined
      ? { cleanupEstimate: estimate }
      : { cleanupEstimate: estimate, cleanupOutcome: outcome });
  }, [record]);

  const onReplicaLoaded = useCallback((replica: ReplicaState): void => {
    record({ replica });
  }, [record]);

  const onLineageLoaded = useCallback((lineage: LineageChain): void => {
    record({ lineage });
  }, [record]);

  const onForkLoaded = useCallback((forkEstimate: ForkEstimateView | undefined, forkOutcome: ForkOutcomeView | undefined): void => {
    record({
      ...(forkEstimate === undefined ? {} : { forkEstimate }),
      ...(forkOutcome === undefined ? {} : { forkOutcome }),
    });
  }, [record]);

  const onInboxLoaded = useCallback((patch: InboxSnapshot): void => {
    record({
      inbox: patch.items,
      ...(patch.restore === undefined ? {} : { restore: patch.restore }),
      ...(patch.permanentScope === undefined ? {} : { permanentScope: patch.permanentScope }),
      ...(patch.permanentOutcome === undefined ? {} : { permanentOutcome: patch.permanentOutcome }),
    });
  }, [record]);

  const exportNow = (): void => {
    const current = snapshot.current;
    if (current.usage === undefined && current.inbox === undefined && current.lineage === undefined) {
      setExportNotice('还没有读取到可以导出的读数。');
      setExported(undefined);
      return;
    }
    setExportNotice(undefined);
    const payload = buildExportDocument({ ...current, exportedAt: Date.now() });
    const text = exportText(payload);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    if (previousUrl.current !== undefined) URL.revokeObjectURL(previousUrl.current);
    previousUrl.current = url;
    if (!alive.current) return;
    setExported({ text, url });
    browserTelemetry.action('data-usage-export', 'ok');
  };

  return (
    <div data-section="data-management">
      <div>
        <Button data-export-button onClick={exportNow}>导出当前视图</Button>
        <StatusLine>导出文件与界面都只包含用量、范围与时刻，不包含副本的内部位置。</StatusLine>
        {exportNotice === undefined ? null : <StatusLine tone="danger">{exportNotice}</StatusLine>}
      </div>
      <Tabs
        label="数据管理"
        selectedId={tab}
        onSelect={setTab}
        items={TABS.map((item) => ({
          id: item.id,
          label: item.label,
          content: item.id === 'usage'
            ? (
              <UsagePanel face={face} refreshToken={refreshToken} onLoaded={onUsageLoaded} />
            )
            : item.id === 'cleanup'
              ? (
                <CleanupPanel face={face} onChanged={onChanged} onLoaded={onCleanupLoaded} />
              )
              : item.id === 'replica'
                ? (
                  <ReplicaPanel face={face} onLoaded={onReplicaLoaded} />
                )
                : item.id === 'lineage'
                  ? (
                    <LineagePanel face={face} onLoaded={onLineageLoaded} />
                  )
                  : item.id === 'fork'
                    ? (
                      <ForkPanel face={face} onLoaded={onForkLoaded} />
                    )
                    : (
                      <InboxPanel face={face} onLoaded={onInboxLoaded} />
                    ),
        }))}
      />
      {exported === undefined
        ? null
        : (
          <Panel title="导出预览" subtitle="这份内容与界面显示的一致，可以直接下载。">
            <pre data-export-preview tabIndex={0} role="region" aria-label="导出内容预览">{exported.text}</pre>
            <a data-export-download href={exported.url} download="chatdsh-data-management.json">下载 JSON</a>
          </Panel>
        )}
    </div>
  );
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(
    spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string },
    Component: () => unknown,
  ): () => void;
}

/**
 * 注册数据管理区段。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: { slots: ClientSlots }): void {
  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 76,
    label: () => '数据管理',
    locale: 'chatdsh.data-management',
  }, () => <DataManagementSection />));
}
