/**
 * 导出面板：范围选择、预估、生成、取消、下载与打印预览。
 *
 * 面板只提交用户确认过的范围：格式能力按来源与私有导出权限取舍，缺失附件需要逐项确认，
 * 重复点击生成不会重复建文件（操作标识与请求摘要一起决定幂等），完成后给出文件名与内容
 * 类型，失效之后给出重新生成的入口。所有状态文案来自状态与时刻，不做猜测。
 * @module @chatdsh/client-exports/panel
 */

import { Badge, Button, EmptyState, ErrorNote, List, Panel, ProgressBar, Row, StatusLine } from '@chatdsh/core-ui-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { attachmentRows, missingDecision, needsMissingConfirmation, tallyOf } from './attachments.ts';
import { ATTACHMENT_POLICIES } from './types.ts';
import type {
  AttachmentPolicy,
  ExportAttachmentView,
  ExportEstimateView,
  ExportGateway,
  ExportJobView,
  ExportSource,
  Loadable,
} from './types.ts';
import { ERROR_LABELS, EXPORT_FORMATS } from './types.ts';
import {
  FORMAT_HINTS,
  FORMAT_LABELS,
  formatsFor,
  formatEstimate,
  formatVolume,
} from './format.ts';
import { describeJob, isRunning, nextPollDelay, progressOf, regenerateHint } from './job.ts';
import { printScopeOf, printPreviewSummary, defaultPrintInput, printDocument, canPrint } from './print.ts';
import { newOperationId, requestDigestOf, scopeOf, selectionOf, ExportSelectionError } from './scope.ts';
import { POLICY_HINTS, POLICY_LABELS } from './attachments.ts';

/** 面板属性。 */
export interface ExportPanelProps {
  /** 数据入口。 */
  readonly gateway: ExportGateway;
  /** 导出源。 */
  readonly source: ExportSource;
  /** 可用回合边界。 */
  readonly turnBounds: { readonly turnFrom: number; readonly turnTo: number };
  /** 是否具备私有导出权限。 */
  readonly canPrivate?: boolean;
  /** 当前时刻的实现，测试可以固定时钟。 */
  readonly clock?: () => number;
}

/** 触发浏览器保存字节。 */
function saveBytes(bytes: Uint8Array, filename: string, contentType: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'nofollow';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 失败说明。 */
function explain(error: unknown): string {
  if (error instanceof ExportSelectionError) return error.message;
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && ERROR_LABELS[code] !== undefined) return ERROR_LABELS[code];
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return '导出没有完成，请稍后重试。';
}

/**
 * 导出与打印面板。
 * @param props - 数据入口、来源、回合边界与权限。
 * @returns 面板内容。
 */
export function ExportPanel({ gateway, source, turnBounds, canPrivate = false, clock = () => Date.now() }: ExportPanelProps) {
  const [turnFrom, setTurnFrom] = useState(turnBounds.turnFrom);
  const [turnTo, setTurnTo] = useState(turnBounds.turnTo);
  const [format, setFormat] = useState(() => formatsFor(source, canPrivate)[0] ?? 'markdown');
  const [includeToolReads, setIncludeToolReads] = useState(false);
  const [attachmentPolicy, setAttachmentPolicy] = useState<AttachmentPolicy>('include-missing-list');
  const [timeDisplay, setTimeDisplay] = useState<'local' | 'utc'>('local');
  const [redaction, setRedaction] = useState<'default' | 'strict'>('default');
  const [privateExport, setPrivateExport] = useState(false);
  const [estimate, setEstimate] = useState<Loadable<ExportEstimateView>>({ status: 'loading' });
  const [job, setJob] = useState<ExportJobView | undefined>(undefined);
  const [confirmed, setConfirmed] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [completion, setCompletion] = useState<string | undefined>(undefined);
  const alive = useRef(true);

  const availableFormats = formatsFor(source, canPrivate);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const selectionError = (): string | undefined => {
    try {
      selectionOf({ source, turnFrom, turnTo, format, includeToolReads, attachmentPolicy, timeDisplay, redaction, privateExport: privateExport && canPrivate });
      return undefined;
    } catch (error) {
      return explain(error);
    }
  };

  const runEstimate = useCallback((): void => {
    setFailure(undefined);
    setCompletion(undefined);
    const error = selectionError();
    if (error !== undefined) {
      setEstimate({ status: 'failed', error: new ExportSelectionError('selection', error) });
      gateway.telemetry.action('export-estimate', 'failed');
      return;
    }
    setEstimate({ status: 'loading' });
    const selection = selectionOf({ source, turnFrom, turnTo, format, includeToolReads, attachmentPolicy, timeDisplay, redaction, privateExport: privateExport && canPrivate });
    gateway.estimate(selection).then(
      (value) => {
        if (!alive.current) return;
        setEstimate({ status: 'ready', value });
        gateway.telemetry.action('export-estimate', 'ok');
      },
      (error: unknown) => {
        if (!alive.current) return;
        setEstimate({ status: 'failed', error });
        gateway.telemetry.action('export-estimate', 'failed');
      },
    );
  }, [gateway, source, turnFrom, turnTo, format, includeToolReads, attachmentPolicy, timeDisplay, redaction, privateExport, canPrivate]);

  useEffect(() => {
    runEstimate();
  }, [runEstimate]);

  // 生成中的任务按状态轮询；任务结束时停止。
  useEffect(() => {
    if (job === undefined) return;
    const delay = nextPollDelay(job.state);
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      gateway.job(job.jobId).then(
        (next) => {
          if (alive.current) setJob(next);
        },
        (error: unknown) => {
          if (alive.current) setFailure(explain(error));
        },
      );
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [gateway, job]);

  const startGeneration = (): void => {
    setFailure(undefined);
    setCompletion(undefined);
    const selection = selectionOf({ source, turnFrom, turnTo, format, includeToolReads, attachmentPolicy, timeDisplay, redaction, privateExport: privateExport && canPrivate });
    const estimateValue = estimate.status === 'ready' ? estimate.value : { eventCount: 0, charCount: 0, attachments: [] };
    const scope = scopeOf(selection, estimateValue);
    const operationId = newOperationId();
    void requestDigestOf(scope)
      .then((requestDigest) => gateway.create({ operationId, requestDigest, scope }))
      .then(
        (created) => {
          if (!alive.current) return;
          setJob(created);
          gateway.telemetry.action('export-create', 'ok');
        },
        (error: unknown) => {
          if (!alive.current) return;
          setFailure(explain(error));
          gateway.telemetry.action('export-create', 'failed');
        },
      );
  };

  const requestGeneration = (): void => {
    const attachments = estimate.status === 'ready' ? estimate.value.attachments : [];
    const decision = missingDecision(attachmentPolicy, attachments, confirmed);
    if (decision.action === 'blocked') {
      setFailure(decision.reason);
      return;
    }
    if (decision.action === 'confirm') {
      setFailure(decision.prompt);
      return;
    }
    startGeneration();
  };

  const cancelJob = (): void => {
    if (job === undefined) return;
    gateway.cancel(job.jobId).then(
      (next) => {
        if (!alive.current) return;
        setJob(next);
        gateway.telemetry.action('export-cancel', 'ok');
      },
      (error: unknown) => {
        if (!alive.current) return;
        setFailure(explain(error));
        gateway.telemetry.action('export-cancel', 'failed');
      },
    );
  };

  const downloadJob = (): void => {
    if (job === undefined) return;
    gateway.download(job.jobId).then(
      (download) => {
        if (!alive.current) return;
        saveBytes(download.bytes, download.filename, download.contentType);
        setCompletion(`已开始下载 ${download.filename}（${download.contentType}）。`);
        gateway.telemetry.action('export-download', 'ok');
      },
      (error: unknown) => {
        if (!alive.current) return;
        setFailure(explain(error));
        gateway.telemetry.action('export-download', 'failed');
      },
    );
  };

  const attachments: readonly ExportAttachmentView[] = estimate.status === 'ready' ? estimate.value.attachments : [];
  const tally = tallyOf(attachments);
  const jobView = job === undefined ? undefined : describeJob(job, clock());
  const printScope = printScopeOf(defaultPrintInput(`会话 ${source.kind === 'session' ? source.sessionId : source.artifactId} 打印`));
  const selectionMessage = selectionError();

  return (
    <Panel title="导出与打印" subtitle="按完整回合导出，默认不含副本水位、凭据与内部路径。">
      <div className="chdsh-field-row">
        <label htmlFor="chdsh-export-turn-from">起始回合</label>
        <input id="chdsh-export-turn-from" type="number" min={1} value={turnFrom}
          onChange={(event) => setTurnFrom(Number.parseInt(event.target.value, 10) || 1)} />
        <label htmlFor="chdsh-export-turn-to">结束回合</label>
        <input id="chdsh-export-turn-to" type="number" min={1} value={turnTo}
          onChange={(event) => setTurnTo(Number.parseInt(event.target.value, 10) || 1)} />
        <span className="chdsh-field__help">整段回合都会导出，起止落在回合中间也按完整回合取。</span>
      </div>

      <div className="chdsh-field-row">
        <label htmlFor="chdsh-export-format">格式</label>
        <select id="chdsh-export-format" value={format} onChange={(event) => setFormat(event.target.value as typeof format)}>
          {EXPORT_FORMATS.map((item) => (
            <option key={item} value={item} disabled={!availableFormats.includes(item)}>
              {FORMAT_LABELS[item]}{availableFormats.includes(item) ? '' : '（当前来源不可用）'}
            </option>
          ))}
        </select>
        <span className="chdsh-field__help">{FORMAT_HINTS[format]}</span>
      </div>

      <div className="chdsh-field-row">
        <label htmlFor="chdsh-export-tools">
          <input id="chdsh-export-tools" type="checkbox" checked={includeToolReads}
            onChange={(event) => setIncludeToolReads(event.target.checked)} />
          包含工具阅读记录
        </label>
      </div>

      <div className="chdsh-field-row">
        <label htmlFor="chdsh-export-attachments">附件</label>
        <select id="chdsh-export-attachments" value={attachmentPolicy}
          onChange={(event) => setAttachmentPolicy(event.target.value as AttachmentPolicy)}>
          {ATTACHMENT_POLICIES.map((item) => (
            <option key={item} value={item}>{POLICY_LABELS[item]}</option>
          ))}
        </select>
        <span className="chdsh-field__help">{POLICY_HINTS[attachmentPolicy]}</span>
      </div>

      <div className="chdsh-field-row">
        <label htmlFor="chdsh-export-time">时间显示</label>
        <select id="chdsh-export-time" value={timeDisplay} onChange={(event) => setTimeDisplay(event.target.value === 'utc' ? 'utc' : 'local')}>
          <option value="local">本地时间</option>
          <option value="utc">UTC</option>
        </select>
        <label htmlFor="chdsh-export-redaction">脱敏</label>
        <select id="chdsh-export-redaction" value={redaction} onChange={(event) => setRedaction(event.target.value === 'strict' ? 'strict' : 'default')}>
          <option value="default">默认（凭据与内部路径）</option>
          <option value="strict">严格（另含联系方式与内网地址）</option>
        </select>
      </div>

      {canPrivate ? (
        <div className="chdsh-field-row">
          <label htmlFor="chdsh-export-private">
            <input id="chdsh-export-private" type="checkbox" checked={privateExport}
              onChange={(event) => setPrivateExport(event.target.checked)} />
            完整业务记录导出（私有权限）
          </label>
          <span className="chdsh-field__help">勾选之后可以导出原始 JSONL；这个范围包含完整业务记录，只在单独授权后使用。</span>
        </div>
      ) : null}

      {selectionMessage === undefined ? null : <ErrorNote>{selectionMessage}</ErrorNote>}
      {failure === undefined ? null : <ErrorNote>{failure}</ErrorNote>}
      {completion === undefined ? null : <StatusLine>{completion}</StatusLine>}

      <div className="chdsh-export-estimate">
        {estimate.status === 'loading' ? <StatusLine>正在预估范围与附件…</StatusLine> : null}
        {estimate.status === 'failed' ? <StatusLine tone="danger">{explain(estimate.error)}</StatusLine> : null}
        {estimate.status === 'ready' ? (
          <StatusLine>
            {formatEstimate(estimate.value)}；{formatVolume(estimate.value.eventCount, estimate.value.charCount)}
          </StatusLine>
        ) : null}
      </div>

      {tally.total === 0 ? null : (
        <section aria-label="附件清单">
          <h4>附件清单（可下载 {tally.downloadable}，缺失 {tally.missing}，需要源设备 {tally.needsSourceDevice}）</h4>
          <List>
            {attachmentRows(attachments).map((row) => (
              <Row key={row.id} title={row.filename} dot={row.tone === 'ok' ? 'ok' : row.tone === 'warn' ? 'warn' : 'danger'}
                badge={<Badge tone={row.tone}>{row.stateLabel}</Badge>}
                meta={row.note ?? (row.size === undefined ? undefined : `${String(row.size)} 字节`)} />
            ))}
          </List>
          {needsMissingConfirmation(attachmentPolicy, attachments) ? (
            <label>
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              我确认把不可下载的附件逐项列进导出清单
            </label>
          ) : null}
        </section>
      )}

      <div className="chdsh-export-actions">
        <Button tone="primary" onClick={requestGeneration} aria-busy={jobView?.label === '生成中'}>
          生成导出
        </Button>
        {jobView?.canCancel === true ? <Button tone="danger" onClick={cancelJob}>取消生成</Button> : null}
        {jobView?.canDownload === true ? <Button onClick={downloadJob}>下载文件</Button> : null}
        {jobView?.canRegenerate === true ? <Button onClick={requestGeneration}>{jobView.label === '已失效' ? '重新生成' : '再生成一份'}</Button> : null}
      </div>

      {jobView === undefined ? (
        <EmptyState>还没有导出任务。选好范围与格式后生成，导出只读取权威会话日志。</EmptyState>
      ) : (
        <section aria-label="导出任务状态">
          <StatusLine tone={jobView.tone === 'danger' ? 'danger' : 'muted'}>{jobView.label}：{jobView.detail}</StatusLine>
          {job !== undefined && isRunning(job.state) ? (
            <ProgressBar ratio={progressOf(job, clock())} label="导出进度" />
          ) : null}
          {job?.code === undefined ? null : <StatusLine tone="danger">{ERROR_LABELS[job.code] ?? `失败原因码：${job.code}`}</StatusLine>}
          {job === undefined || !jobView.canRegenerate ? null : <StatusLine>{regenerateHint(job)}</StatusLine>}
        </section>
      )}

      <section aria-label="打印">
        <h4>打印公开页</h4>
        <StatusLine>{printPreviewSummary(printScope)}</StatusLine>
        {canPrint() ? (
          <Button onClick={() => {
            gateway.telemetry.action('export-print-preview', 'ok');
            printDocument();
          }}>打开打印预览</Button>
        ) : <StatusLine tone="danger">当前环境不支持打印命令。</StatusLine>}
      </section>
    </Panel>
  );
}
