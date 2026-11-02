import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Panel,
  ScrollRegion,
  Skeleton,
  StatusLine,
  Toast,
} from '@chatdsh/core-ui-kit';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ACCOUNT_BANK,
  MEMORY_TOKEN_RANGE,
  MemoryFailure,
  PAGE_SIZES,
  SEARCH_LIMIT_MAX,
  callRemote,
  failureOf,
  failureText,
  formatScore,
  formatTimestamp,
  groupBank,
  hitKey,
  isServiceMissing,
  type Loadable,
  type MemoryEntryRef,
  type MemoryGroupView,
  type MemoryRecallHit,
  type MemoryRecallResult,
  type MemoryRemoteFace,
  type MemorySettingsView,
} from './face.ts';
import { buildExport, type ExportFormat, type ExportPayload, type ExportScope } from './export.ts';
import { useProblemFocus, type FormProblem } from './problems.ts';
import { noteAction } from './telemetry.ts';
/**
 * 检索与条目管理面板。
 *
 * 范围按工作区与记忆组列出，提交前校验至少选择一个范围；结果只在页面内存里保存，分页用
 * 页面内存里的游标向宿主追加读取。条目详情显示来源、相关性与时间；编辑、删除与批量删除
 * 都调用宿主接口，宿主没有提供时明确失败并保留选择与输入。
 * @module @chatdsh/client-memory/search-panel
 */

/** 一次检索的结果（含本次请求参数，供分页与重试复用）。 */
interface SearchResult {
  readonly hits: readonly MemoryRecallHit[];
  readonly readAt: number;
  readonly degraded: boolean;
  readonly code?: string;
  readonly limit: number;
  readonly request: { readonly banks: readonly string[]; readonly text: string; readonly maxTokens: number };
}

/** 条目弹窗。 */
type EntryDialog =
  | { readonly kind: 'edit'; readonly hit: MemoryRecallHit; readonly key: string; readonly text: string; readonly busy: boolean; readonly failure?: MemoryFailure }
  | { readonly kind: 'delete'; readonly hit: MemoryRecallHit; readonly key: string; readonly busy: boolean; readonly failure?: MemoryFailure }
  | { readonly kind: 'batch'; readonly targets: readonly MemoryEntryRef[]; readonly missing: number; readonly busy: boolean; readonly failure?: MemoryFailure };

/** 导出状态。 */
type ExportState =
  | { readonly status: 'idle' }
  | { readonly status: 'exporting' }
  | { readonly status: 'done'; readonly payload: ExportPayload; readonly url: string }
  | { readonly status: 'failed'; readonly failure: MemoryFailure };

/** 面板属性。 */
export interface SearchPanelProps {
  /** 记忆服务面。 */
  readonly face: MemoryRemoteFace | undefined;
  /** 配置视图。 */
  readonly settings: Loadable<MemorySettingsView>;
  /** 记忆组列表。 */
  readonly groups: Loadable<readonly MemoryGroupView[]>;
  /** 重新读取配置与记忆组。 */
  readonly onReload: () => void;
}

/**
 * 渲染检索与条目管理面板。
 * @param props - 服务面、配置、记忆组与重新读取动作。
 * @returns 面板。
 */
export function SearchPanel({ face, settings, groups, onReload }: SearchPanelProps) {
  const [selectedBanks, setSelectedBanks] = useState<readonly string[]>([]);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState<number>(PAGE_SIZES[0]);
  const [maxTokensText, setMaxTokensText] = useState('1024');
  const [maxTokensTouched, setMaxTokensTouched] = useState(false);
  const [problems, setProblems] = useState<readonly FormProblem[]>([]);
  const [result, setResult] = useState<SearchResult | undefined>(undefined);
  const [failure, setFailure] = useState<MemoryFailure | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [noMore, setNoMore] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const [dialog, setDialog] = useState<EntryDialog | undefined>(undefined);
  const [exportScope, setExportScope] = useState<ExportScope>('query');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('markdown');
  const [exportState, setExportState] = useState<ExportState>({ status: 'idle' });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const resultsHeading = useRef<HTMLSpanElement>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  useProblemFocus(problems);

  const defaultTokens = settings.status === 'ready' ? settings.value.maxTokens : undefined;
  useEffect(() => {
    if (defaultTokens === undefined || maxTokensTouched) return;
    setMaxTokensText(String(defaultTokens));
  }, [defaultTokens, maxTokensTouched]);

  useEffect(() => {
    if (dialog === undefined) return;
    const timer = setTimeout(() => {
      if (dialog.kind === 'edit') document.getElementById('memory-entry-text')?.focus();
      else document.getElementById('memory-entry-confirm')?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [dialog?.kind]);

  useEffect(() => () => {
    if (exportState.status === 'done') URL.revokeObjectURL(exportState.url);
  }, [exportState]);

  const groupItems = groups.status === 'ready' ? groups.value : [];
  const extraBanks = settings.status === 'ready' ? settings.value.extraBanks : [];
  const scopeOptions: { readonly bank: string; readonly label: string }[] = [
    { bank: ACCOUNT_BANK, label: '个人记忆 acct' },
    ...groupItems.map((group) => ({ bank: groupBank(group.memoryGroupId), label: `工作区记忆：${group.displayName}` })),
    ...extraBanks
      .filter((bank) => bank !== ACCOUNT_BANK)
      .map((bank) => ({ bank, label: `额外 bank：${bank}` })),
  ];
  const rows = result === undefined
    ? []
    : result.hits
      .slice(page * limit, page * limit + limit)
      .map((hit, offset) => ({ hit, key: hitKey(hit, page * limit + offset) }));
  const pageKeys = rows.map((row) => row.key);
  const allSelected = pageKeys.length > 0 && pageKeys.every((key) => selection.has(key));
  const someSelected = pageKeys.some((key) => selection.has(key));
  useEffect(() => {
    if (selectAll.current !== null) selectAll.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);
  const indexedHits = result === undefined
    ? []
    : result.hits.map((hit, index) => ({ hit, key: hitKey(hit, index) }));
  const selectedEntries = indexedHits.filter((entry) => selection.has(entry.key));
  const deletable: MemoryEntryRef[] = selectedEntries
    .filter((entry) => entry.hit.source !== undefined)
    .map((entry) => ({ bank: entry.hit.bank, source: entry.hit.source as string }));
  const missingSource = selectedEntries.length - deletable.length;

  /** 结果标题取得焦点，键盘用户知道分页与删除之后落在哪里。 */
  function focusResults(): void {
    resultsHeading.current?.focus();
  }

  /** 切换一个检索范围。 */
  function toggleBank(bank: string): void {
    setSelectedBanks((current) => (current.includes(bank) ? current.filter((item) => item !== bank) : [...current, bank]));
    setProblems([]);
  }

  /** 切换一条命中的选择。 */
  function toggleRow(key: string): void {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** 全选或取消全选当前页。 */
  function togglePage(): void {
    setSelection((current) => {
      const next = new Set(current);
      for (const key of pageKeys) {
        if (allSelected) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }

  /** 提交检索。 */
  async function submitSearch(): Promise<void> {
    const trimmed = query.trim();
    const tokens = Number(maxTokensText);
    const nextProblems: FormProblem[] = [];
    if (selectedBanks.length === 0) nextProblems.push({ fieldId: 'memory-scopes', message: '至少选择一个检索范围' });
    if (trimmed === '') nextProblems.push({ fieldId: 'memory-query', message: '查询内容不能为空' });
    if (!Number.isInteger(tokens) || tokens < MEMORY_TOKEN_RANGE.min || tokens > MEMORY_TOKEN_RANGE.max) {
      nextProblems.push({ fieldId: 'memory-max-tokens', message: `令牌上限必须是 ${String(MEMORY_TOKEN_RANGE.min)} 到 ${String(MEMORY_TOKEN_RANGE.max)} 的整数` });
    }
    setProblems(nextProblems);
    if (nextProblems.length > 0) return;
    if (face?.search === undefined) {
      setFailure(new MemoryFailure('记忆服务没有提供检索接口'));
      noteAction('memory-search', 'failed');
      return;
    }
    setBusy(true);
    setFailure(undefined);
    setExportState({ status: 'idle' });
    try {
      const request = { banks: selectedBanks, text: trimmed, maxTokens: tokens };
      const value = await callRemote<MemoryRecallResult>('检索记忆', () => face.search!({ ...request, limit }));
      setResult({
        hits: value.hits,
        readAt: value.readAt,
        degraded: value.degraded,
        ...(value.code === undefined ? {} : { code: value.code }),
        limit,
        request,
      });
      setPage(0);
      setNoMore(false);
      setSelection(new Set());
      setExpanded(undefined);
      noteAction('memory-search', value.degraded ? 'degraded' : 'ok');
      focusResults();
    } catch (error) {
      setFailure(failureOf(error));
      setResult(undefined);
      setSelection(new Set());
      setPage(0);
      setNoMore(false);
      noteAction('memory-search', 'failed');
    } finally {
      setBusy(false);
    }
  }

  /** 用同一次查询重读当前页。 */
  async function rerunSearch(): Promise<void> {
    const current = result;
    if (current === undefined || face?.search === undefined) return;
    try {
      const value = await callRemote<MemoryRecallResult>('检索记忆', () => face.search!({ ...current.request, limit: current.limit }));
      setResult({ ...current, hits: value.hits, readAt: value.readAt, degraded: value.degraded, ...(value.code === undefined ? {} : { code: value.code }) });
      setPage(0);
      setNoMore(false);
      setSelection(new Set());
      setExpanded(undefined);
      focusResults();
    } catch (error) {
      setFailure(failureOf(error));
    }
  }

  /** 跳到指定页；需要时向宿主追加读取更多结果。 */
  async function gotoPage(target: number): Promise<void> {
    const current = result;
    if (current === undefined || face?.search === undefined) return;
    const needed = Math.min(SEARCH_LIMIT_MAX, (target + 1) * limit);
    setBusy(true);
    setFailure(undefined);
    try {
      const value = await callRemote<MemoryRecallResult>('检索记忆', () => face.search!({ ...current.request, limit: needed }));
      if (value.degraded) {
        setFailure(new MemoryFailure('分页读取时记忆后端不可达', value.code));
        noteAction('memory-search', 'degraded');
        return;
      }
      setResult({
        ...current,
        hits: value.hits,
        readAt: value.readAt,
        degraded: false,
        limit: needed,
      });
      if (value.hits.slice(target * limit, target * limit + limit).length === 0) {
        setNoMore(true);
        setNotice('没有更多结果，已停在当前页');
      } else {
        setPage(target);
        setNoMore(false);
        focusResults();
      }
    } catch (error) {
      setFailure(failureOf(error));
      noteAction('memory-search', 'failed');
    } finally {
      setBusy(false);
    }
  }

  /** 键盘操作：行间移动焦点、切换选择、批量删除与全选。 */
  function onResultsKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.ctrlKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelection(new Set(pageKeys));
      return;
    }
    const active = document.activeElement;
    const rowAction = active instanceof HTMLElement && active.dataset.rowAction === 'true';
    if (!rowAction) return;
    const position = Number(active.dataset.rowIndex ?? '-1');
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? Math.min(rows.length - 1, position + 1) : Math.max(0, position - 1);
      document.querySelector<HTMLElement>(`[data-row-action="true"][data-row-index="${String(next)}"]`)?.focus();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : rows.length - 1;
      document.querySelector<HTMLElement>(`[data-row-action="true"][data-row-index="${String(next)}"]`)?.focus();
      return;
    }
    if (event.key === ' ') {
      const row = rows[position];
      if (row === undefined) return;
      event.preventDefault();
      toggleRow(row.key);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selection.size === 0) return;
      event.preventDefault();
      openBatchDialog();
      return;
    }
    if (event.key === 'Escape' && selection.size > 0) {
      setSelection(new Set());
    }
  }

  /** 打开批量删除确认。 */
  function openBatchDialog(): void {
    if (deletable.length === 0) {
      setNotice(missingSource > 0 ? '选中的条目缺少来源标识，无法删除' : '还没有选中条目');
      return;
    }
    setDialog({ kind: 'batch', targets: deletable, missing: missingSource, busy: false });
  }

  /** 保存编辑。 */
  async function saveEdit(): Promise<void> {
    const current = dialog;
    if (current?.kind !== 'edit') return;
    if (current.text.trim() === '') {
      setDialog({ ...current, failure: new MemoryFailure('记忆内容不能为空') });
      return;
    }
    if (current.hit.source === undefined) {
      setDialog({ ...current, failure: new MemoryFailure('这条命中没有来源标识，无法编辑') });
      return;
    }
    if (face?.updateEntry === undefined) {
      noteAction('memory-entry-edit', 'failed');
      setDialog({ ...current, failure: new MemoryFailure('记忆服务没有提供条目编辑接口') });
      return;
    }
    setDialog({ ...current, busy: true, failure: undefined });
    try {
      await callRemote('更新记忆条目', () => face.updateEntry!(current.hit.bank, current.hit.source as string, current.text));
      noteAction('memory-entry-edit', 'ok');
      setDialog(undefined);
      setNotice('已更新 1 条记忆');
      await rerunSearch();
    } catch (error) {
      noteAction('memory-entry-edit', 'failed');
      setDialog({ ...current, busy: false, failure: failureOf(error) });
    }
  }

  /** 删除单条。 */
  async function removeOne(): Promise<void> {
    const current = dialog;
    if (current?.kind !== 'delete') return;
    if (current.hit.source === undefined || face?.deleteEntry === undefined) {
      noteAction('memory-entry-delete', 'failed');
      setDialog({
        ...current,
        busy: false,
        failure: new MemoryFailure(current.hit.source === undefined ? '这条命中没有来源标识，无法删除' : '记忆服务没有提供条目删除接口'),
      });
      return;
    }
    setDialog({ ...current, busy: true, failure: undefined });
    try {
      await callRemote('删除记忆条目', () => face.deleteEntry!(current.hit.bank, current.hit.source as string));
      noteAction('memory-entry-delete', 'ok');
      setDialog(undefined);
      setNotice('已删除 1 条记忆');
      await rerunSearch();
    } catch (error) {
      noteAction('memory-entry-delete', 'failed');
      setDialog({ ...current, busy: false, failure: failureOf(error) });
    }
  }

  /** 批量删除。 */
  async function removeBatch(): Promise<void> {
    const current = dialog;
    if (current?.kind !== 'batch') return;
    if (face?.deleteEntries === undefined) {
      noteAction('memory-entries-delete', 'failed');
      setDialog({ ...current, busy: false, failure: new MemoryFailure('记忆服务没有提供批量删除接口') });
      return;
    }
    setDialog({ ...current, busy: true, failure: undefined });
    try {
      await callRemote('批量删除记忆条目', () => face.deleteEntries!(current.targets));
      noteAction('memory-entries-delete', 'ok');
      setDialog(undefined);
      setNotice(`已删除 ${String(current.targets.length)} 条记忆`);
      await rerunSearch();
    } catch (error) {
      noteAction('memory-entries-delete', 'failed');
      setDialog({ ...current, busy: false, failure: failureOf(error) });
    }
  }

  /** 选择导出范围对应的命中条目；查询范围在导出时重新读取。 */
  function exportHits(): readonly MemoryRecallHit[] {
    if (exportScope === 'page') return rows.map((row) => row.hit);
    if (exportScope === 'selected') return selectedEntries.map((entry) => entry.hit);
    return [];
  }

  /** 按范围与格式生成导出。 */
  async function runExport(): Promise<void> {
    const scopeLabel = exportScope === 'page' ? '当前页' : exportScope === 'selected' ? '已选条目' : '本次查询的全部结果（最多 50 条）';
    setExportState({ status: 'exporting' });
    setNotice(undefined);
    try {
      let hits = exportHits();
      if (exportScope === 'query') {
        const current = result;
        if (current === undefined || face?.search === undefined) throw new MemoryFailure('记忆服务没有提供检索接口');
        const value = await callRemote<MemoryRecallResult>('检索记忆', () => face.search!({ ...current.request, limit: SEARCH_LIMIT_MAX }));
        if (value.degraded) throw new MemoryFailure('导出前读取检索结果失败', value.code);
        hits = value.hits;
      }
      if (hits.length === 0) throw new MemoryFailure(`${scopeLabel}没有可导出的结果`);
      const payload = await buildExport({
        hits,
        format: exportFormat,
        scopeLabel,
        readAt: result?.readAt ?? Date.now(),
      });
      const url = URL.createObjectURL(new Blob([payload.text], { type: payload.mimeType }));
      setExportState({ status: 'done', payload, url });
      noteAction('memory-export', 'ok');
    } catch (error) {
      noteAction('memory-export', 'failed');
      setExportState({ status: 'failed', failure: failureOf(error) });
    }
  }

  if (settings.status === 'loading') {
    return (
      <Panel title="检索与条目">
        <Skeleton rows={3} />
      </Panel>
    );
  }
  if (settings.status === 'unavailable') {
    return (
      <Panel title="检索与条目">
        <StatusLine tone="danger">记忆检索不可用：宿主没有注册记忆服务。</StatusLine>
        <EmptyState>记忆组合包加入 profile 的 bundles 列表并部署记忆后端之后才能检索。</EmptyState>
      </Panel>
    );
  }
  if (settings.status === 'failed') {
    return (
      <Panel title="检索与条目">
        <StatusLine tone="danger">
          {isServiceMissing(settings.failure) ? '记忆未启用：宿主没有注册记忆服务' : '读取检索范围失败'}：{failureText(settings.failure)}
        </StatusLine>
        <p><Button onClick={onReload}>重新读取</Button></p>
      </Panel>
    );
  }

  return (
    <Panel title="检索与条目" count={result === undefined ? undefined : `${String(result.hits.length)} 条`}>
      {notice === undefined ? null : <Toast onDismiss={() => setNotice(undefined)}>{notice}</Toast>}
      <h4>检索记忆</h4>
      <form noValidate onSubmit={(event) => { event.preventDefault(); void submitSearch(); }} aria-label="记忆检索">
        <fieldset id="memory-scopes" tabIndex={-1} style={{ border: '1px solid var(--chatdsh-line-2)', borderRadius: 'var(--cdh-r2)', padding: 'var(--cdh-s2)' }}>
          <legend>检索范围（必选）</legend>
          {scopeOptions.length === 0 ? <StatusLine>还没有可选的检索范围。</StatusLine> : null}
          {scopeOptions.map((option) => (
            <label key={option.bank} style={{ display: 'block', minHeight: '44px', paddingBlock: 'var(--cdh-s1)' }}>
              <input
                type="checkbox"
                value={option.bank}
                checked={selectedBanks.includes(option.bank)}
                onChange={() => toggleBank(option.bank)}
              />
              {' '}{option.label}
            </label>
          ))}
        </fieldset>
        {groups.status === 'failed' ? <StatusLine tone="danger">记忆组读取失败，工作区范围暂不可选。</StatusLine> : null}
        {problems.length === 0 ? null : (
          <div role="alert" className="chdsh-error">
            {problems.map((problem) => <p key={problem.fieldId}>{problem.message}</p>)}
          </div>
        )}
        <Field label="搜索记忆" required help="查询内容只保留在当前页面内存，关闭页面即释放。">
          <input
            id="memory-query"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setProblems([]); }}
          />
        </Field>
        <Field label="每次返回条数">
          <select id="memory-limit" value={limit} onChange={(event) => { setLimit(Number(event.target.value)); setProblems([]); }}>
            {PAGE_SIZES.map((size) => <option key={size} value={size}>{String(size)} 条</option>)}
          </select>
        </Field>
        <Field label="单次令牌上限" help={`整数，${String(MEMORY_TOKEN_RANGE.min)} 到 ${String(MEMORY_TOKEN_RANGE.max)}；服务端可能按实际限制收紧。`}>
          <input
            id="memory-max-tokens"
            type="number"
            min={MEMORY_TOKEN_RANGE.min}
            max={MEMORY_TOKEN_RANGE.max}
            value={maxTokensText}
            onChange={(event) => { setMaxTokensText(event.target.value); setMaxTokensTouched(true); setProblems([]); }}
          />
        </Field>
        <div className="chdsh-row__acts">
          <Button id="memory-search-submit" type="submit" tone="primary" disabled={busy}>{busy ? '正在检索…' : '查询'}</Button>
          <Button
            id="memory-clear"
            onClick={() => {
              setQuery('');
              setResult(undefined);
              setFailure(undefined);
              setSelection(new Set());
              setExpanded(undefined);
              setPage(0);
              setNoMore(false);
              setExportState({ status: 'idle' });
              setProblems([]);
            }}
          >
            清空查询
          </Button>
        </div>
      </form>
      {failure === undefined ? null : (
        <ErrorNote>
          记忆检索未被受理：{failureText(failure)}
          <Button onClick={() => void submitSearch()}>重试</Button>
        </ErrorNote>
      )}
      {result !== undefined && result.degraded ? (
        <ErrorNote>
          记忆检索降级：后端不可达，页面不声称查询成功（错误码 {result.code ?? '未提供'}）。查询内容仍保留，可以重试。
          <Button onClick={() => void submitSearch()}>重新查询</Button>
        </ErrorNote>
      ) : null}
      {result === undefined ? (
        failure === undefined ? <EmptyState>输入查询内容并选择检索范围后开始检索。没有结果时换用更短的关键词。</EmptyState> : null
      ) : result.hits.length === 0 ? (
        result.degraded ? null : <EmptyState>没有检索结果。换一个查询词，或扩大检索范围。</EmptyState>
      ) : (
        <>
          <h4>检索结果</h4>
          <StatusLine>
            已选 {String(selection.size)} 条 · 本页 {String(rows.length)} 条 · 服务端单次最多 {String(SEARCH_LIMIT_MAX)} 条
          </StatusLine>
          <div className="chdsh-row__acts">
            <Button id="memory-prev-page" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page === 0 || busy}>上一页</Button>
            <Button
              id="memory-next-page"
              onClick={() => void gotoPage(page + 1)}
              disabled={busy || noMore || (page + 1) * limit >= SEARCH_LIMIT_MAX}
            >
              下一页
            </Button>
            <Button id="memory-batch-delete" tone="danger" onClick={openBatchDialog} disabled={selection.size === 0}>删除选中（{String(selection.size)}）</Button>
          </div>
          {noMore ? <StatusLine>没有更多结果。</StatusLine> : null}
          <div onKeyDown={onResultsKeyDown}>
            <ScrollRegion label="记忆检索结果">
              <table
                data-cursor={`${String(result.readAt)}:${String(page * limit)}`}
                style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--cdh-fs-12)' }}
              >
                <caption style={{ textAlign: 'start', padding: 'var(--cdh-s2)', color: 'var(--chatdsh-muted)' }}>
                  <span id="memory-results-caption" ref={resultsHeading} tabIndex={-1}>
                    检索结果 · 第 {String(page + 1)} 页 · 读取于 {formatTimestamp(result.readAt)}
                  </span>
                </caption>
                <thead>
                  <tr>
                    <th scope="col" style={{ textAlign: 'start', padding: 'var(--cdh-s2)' }}>
                      <input
                        id="memory-select-all"
                        ref={selectAll}
                        type="checkbox"
                        aria-label="全选当前页结果"
                        checked={allSelected}
                        onChange={togglePage}
                      />
                    </th>
                    <th scope="col" style={{ textAlign: 'start', padding: 'var(--cdh-s2)' }}>内容</th>
                    <th scope="col" style={{ textAlign: 'start', padding: 'var(--cdh-s2)' }}>来源</th>
                    <th scope="col" style={{ textAlign: 'start', padding: 'var(--cdh-s2)' }}>时间</th>
                    <th scope="col" style={{ textAlign: 'start', padding: 'var(--cdh-s2)' }}>相关性</th>
                    <th scope="col" style={{ textAlign: 'start', padding: 'var(--cdh-s2)' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <ResultRow
                      key={row.key}
                      rowKey={row.key}
                      hit={row.hit}
                      index={index}
                      selected={selection.has(row.key)}
                      expanded={expanded === row.key}
                      onToggleSelect={() => toggleRow(row.key)}
                      onToggleExpand={() => setExpanded(expanded === row.key ? undefined : row.key)}
                      onEdit={() => setDialog({ kind: 'edit', hit: row.hit, key: row.key, text: row.hit.text, busy: false })}
                      onDelete={() => setDialog({ kind: 'delete', hit: row.hit, key: row.key, busy: false })}
                    />
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </div>
          <h4>导出检索结果</h4>
          <form onSubmit={(event) => { event.preventDefault(); void runExport(); }} aria-label="导出检索结果">
            <Field label="导出范围">
              <select id="memory-export-scope" value={exportScope} onChange={(event) => setExportScope(event.target.value as ExportScope)}>
                <option value="page">当前页</option>
                <option value="query">本次查询的全部结果（最多 50 条）</option>
                <option value="selected">已选条目</option>
              </select>
            </Field>
            <Field label="导出格式">
              <select id="memory-export-format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}>
                <option value="json">JSON</option>
                <option value="markdown">Markdown</option>
                <option value="text">纯文本</option>
              </select>
            </Field>
            <Button id="memory-export-submit" type="submit" disabled={exportState.status === 'exporting'}>
              {exportState.status === 'exporting' ? '正在生成…' : '导出'}
            </Button>
          </form>
          <div data-export-state={exportState.status} aria-live="polite">
            {exportState.status === 'exporting' ? <StatusLine>正在生成导出文件，生成完成后给出下载链接。</StatusLine> : null}
            {exportState.status === 'failed' ? <ErrorNote>导出失败：{failureText(exportState.failure)}</ErrorNote> : null}
            {exportState.status === 'done' ? (
              <div className="chdsh-toast">
                <StatusLine>
                  导出已生成：{String(exportState.payload.count)} 条 · 格式 {exportFormat === 'json' ? 'JSON' : exportFormat === 'markdown' ? 'Markdown' : '纯文本'} · {String(exportState.payload.bytes)} 字节
                </StatusLine>
                <a href={exportState.url} download={exportState.payload.fileName}>下载 {exportState.payload.fileName}</a>
              </div>
            ) : null}
          </div>
        </>
      )}
      <Dialog
        open={dialog !== undefined}
        title={dialog?.kind === 'edit' ? '编辑记忆条目' : dialog?.kind === 'delete' ? '删除记忆条目' : '删除选中的记忆条目'}
        description="修改与删除由宿主在记忆后端执行；界面按宿主的返回结果更新。"
        onClose={() => setDialog(undefined)}
      >
        {dialog === undefined ? null : (
          <div data-dialog-kind={dialog.kind}>
            {dialog.failure === undefined ? null : <ErrorNote>操作未被受理：{failureText(dialog.failure)}</ErrorNote>}
            {dialog.kind === 'edit' ? (
              <>
                <p>来源：{dialog.hit.source ?? '未提供'} · bank：{dialog.hit.bank}</p>
                <Field label="记忆内容" required error={dialog.failure?.message === '记忆内容不能为空' ? '记忆内容不能为空' : undefined}>
                  <textarea
                    id="memory-entry-text"
                    rows={6}
                    value={dialog.text}
                    onChange={(event) => setDialog({ ...dialog, text: event.target.value, failure: undefined })}
                    disabled={dialog.busy}
                  />
                </Field>
              </>
            ) : null}
            {dialog.kind === 'delete' ? (
              <p>删除来源为 {dialog.hit.source ?? '未提供'} 的这条记忆？删除之后不可恢复。</p>
            ) : null}
            {dialog.kind === 'batch' ? (
              <p>
                删除选中的 {String(dialog.targets.length)} 条记忆？
                {dialog.missing > 0 ? `另有 ${String(dialog.missing)} 条缺少来源标识，无法删除。` : ''}
              </p>
            ) : null}
            <div className="chdsh-row__acts">
              <Button
                id="memory-entry-confirm"
                tone="danger"
                onClick={() => {
                  if (dialog.kind === 'edit') void saveEdit();
                  else if (dialog.kind === 'delete') void removeOne();
                  else void removeBatch();
                }}
                disabled={dialog.busy}
              >
                {dialog.kind === 'edit' ? (dialog.busy ? '正在保存…' : '保存') : dialog.busy ? '正在删除…' : '确认删除'}
              </Button>
              <Button onClick={() => setDialog(undefined)} disabled={dialog.busy}>取消</Button>
            </div>
          </div>
        )}
      </Dialog>
    </Panel>
  );
}

/** 一条结果行。 */
function ResultRow({ rowKey, hit, index, selected, expanded, onToggleSelect, onToggleExpand, onEdit, onDelete }: {
  readonly rowKey: string;
  readonly hit: MemoryRecallHit;
  readonly index: number;
  readonly selected: boolean;
  readonly expanded: boolean;
  readonly onToggleSelect: () => void;
  readonly onToggleExpand: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  const detailId = `memory-detail-${rowKey.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const at = hit.at;
  return (
    <>
      <tr data-row-key={rowKey} data-selected={selected ? 'true' : 'false'} style={{ borderTop: '1px solid var(--chatdsh-line-2)' }}>
        <td style={{ padding: 'var(--cdh-s2)' }}>
          <input type="checkbox" aria-label={`选择第 ${String(index + 1)} 条记忆`} checked={selected} onChange={onToggleSelect} />
        </td>
        <td style={{ padding: 'var(--cdh-s2)', maxWidth: '32rem' }}>
          <button
            type="button"
            className="chdsh-btn"
            data-row-action="true"
            data-row-index={String(index)}
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={onToggleExpand}
            style={{ textAlign: 'start', whiteSpace: 'normal' }}
          >
            {expanded ? '收起详情' : (hit.text.length > 60 ? `${hit.text.slice(0, 60)}…` : hit.text)}
          </button>
        </td>
        <td style={{ padding: 'var(--cdh-s2)' }}>{hit.source ?? '未提供'}</td>
        <td style={{ padding: 'var(--cdh-s2)' }}>{at === undefined ? '未提供' : formatTimestamp(at)}</td>
        <td style={{ padding: 'var(--cdh-s2)' }}>{formatScore(hit.score)}</td>
        <td style={{ padding: 'var(--cdh-s2)' }}>
          <Badge tone={hit.source === undefined ? 'warn' : 'neutral'}>{hit.bank}</Badge>
          <div className="chdsh-row__acts">
            <Button
              aria-label={`编辑第 ${String(index + 1)} 条记忆`}
              onClick={onEdit}
              disabled={hit.source === undefined}
              title={hit.source === undefined ? '这条命中没有来源标识' : undefined}
            >
              编辑
            </Button>
            <Button
              aria-label={`删除第 ${String(index + 1)} 条记忆`}
              tone="danger"
              onClick={onDelete}
              disabled={hit.source === undefined}
              title={hit.source === undefined ? '这条命中没有来源标识' : undefined}
            >
              删除
            </Button>
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr id={detailId} data-detail-for={rowKey}>
          <td colSpan={6} style={{ padding: 'var(--cdh-s2)', borderTop: '1px solid var(--chatdsh-line)' }}>
            <p style={{ whiteSpace: 'pre-wrap', margin: '0 0 var(--cdh-s2)' }}>{hit.text}</p>
            <StatusLine>
              bank：{hit.bank} · 来源：{hit.source ?? '未提供'} · 相关性：{formatScore(hit.score)} · 时间：{at === undefined ? '未提供' : formatTimestamp(at)}
            </StatusLine>
          </td>
        </tr>
      ) : null}
    </>
  );
}
