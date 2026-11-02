/**
 * 制品面板：列表、筛选、版本展开、详情查看与删除全部版本的确认。
 *
 * 列表字段对齐 S09：标题、会话、类型、当前版本、字节大小与更新时间；筛选按名称、会话与
 * 类型三个口径。详情里可以选择版本，旧版本保持只读，下载与外部打开都指向选中的版本。
 * 删除全部版本先取宿主给出的删除范围，把版本数与占用空间显示在二次确认里。
 *
 * 键盘与焦点：两个对话框使用原生 `dialog` 的焦点约束，Escape 关闭并把焦点还给触发元素；
 * 图片工具栏的缩放按键在查看器里处理，按钮都带可访问名称。
 * @module @chatdsh/client-artifacts/panel
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  List,
  Panel,
  Row,
  Skeleton,
  StatusLine,
} from '@chatdsh/core-ui-kit';

import { blobOf, describeSave, filenameOf, objectUrlOf, saveBlob } from './download.ts';
import {
  deleteScopeNoteOf,
  describeFailure,
  EMPTY_FILTER,
  filterArtifacts,
  formatBytes,
  formatTimestamp,
  isCurrentVersion,
  previewPlanOf,
  sessionOptionsOf,
  shortSessionOf,
  sortArtifacts,
  typeOptionsOf,
  versionNoteOf,
  versionSummaryOf,
  type ArtifactFilter,
} from './state.ts';
import { ArtifactPreview, type Attachment } from './viewers.tsx';
import type {
  ArtifactDeleteScope,
  ArtifactReadResult,
  ArtifactRecord,
  ArtifactsGateway,
  ArtifactVersionList,
  ArtifactVersionView,
} from './types.ts';

/** 面板的依赖。 */
export interface ArtifactsPanelProps {
  /** 数据入口；省略时面板停在加载状态，由装配方在 `apply` 之后提供。 */
  readonly gateway?: ArtifactsGateway;
}

/** 详情对话框的目标。 */
interface DetailTarget {
  readonly record: ArtifactRecord;
  readonly version: number;
}

/** 制品面板。 */
export function ArtifactsPanel({ gateway }: ArtifactsPanelProps) {
  const [records, setRecords] = useState<ArtifactRecord[] | undefined>(undefined);
  const [listFailure, setListFailure] = useState<unknown>(undefined);
  const [filter, setFilter] = useState<ArtifactFilter>(EMPTY_FILTER);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const [detail, setDetail] = useState<DetailTarget | undefined>(undefined);
  const [deleting, setDeleting] = useState<ArtifactRecord | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (gateway === undefined) {
      setListFailure(new Error('制品接口不可用'));
      return undefined;
    }
    let active = true;
    setRecords(undefined);
    setListFailure(undefined);
    gateway.list().then(
      (rows) => {
        if (!active) return;
        setRecords(rows);
      },
      (error: unknown) => {
        if (!active) return;
        setListFailure(error);
      },
    );
    return () => {
      active = false;
    };
  }, [gateway, reloadToken]);

  const reload = (): void => setReloadToken((token) => token + 1);

  const changeFilter = (next: ArtifactFilter): void => {
    setFilter(next);
    gateway?.noteAction('artifact.filter', 'ok');
  };

  const all = records ?? [];
  const visible = sortArtifacts(filterArtifacts(all, filter));

  const body = listFailure !== undefined
    ? (
      <>
        <StatusLine tone="danger">{describeFailure(listFailure)}</StatusLine>
        <Button id="wp12-artifact-reload" onClick={reload}>重新加载</Button>
      </>
    )
    : records === undefined
      ? <Skeleton rows={3} />
      : all.length === 0
        ? <EmptyState>还没有制品。会话里的工具写出的文件会出现在这里。</EmptyState>
        : visible.length === 0
          ? <StatusLine>没有符合当前筛选条件的制品。</StatusLine>
          : (
            <List>
              {visible.flatMap((record) => {
                const open = expanded === record.id;
                const rows = [
                  <Row
                    key={record.id}
                    title={record.title}
                    badge={<><Badge>{record.kind}</Badge><Badge tone="brand">{`第 ${String(record.version)} 版`}</Badge></>}
                    meta={`${record.mimeType} · ${formatBytes(record.size)} · 会话 ${shortSessionOf(record.sessionId)} · 更新于 ${formatTimestamp(record.updatedAt)}`}
                    actions={(
                      <>
                        <Button aria-label={`预览 ${record.title}`} onClick={() => setDetail({ record, version: record.version })}>预览</Button>
                        <Button
                          aria-label={`版本 ${record.title}`}
                          aria-expanded={open}
                          onClick={() => setExpanded(open ? undefined : record.id)}
                        >
                          {open ? '收起版本' : '版本列表'}
                        </Button>
                      </>
                    )}
                  />,
                ];
                if (open) {
                  rows.push(
                    <VersionExpansion
                      key={`${record.id}-versions`}
                      gateway={gateway}
                      record={record}
                      onPreview={(version) => setDetail({ record, version })}
                    />,
                  );
                }
                return rows;
              })}
            </List>
          );

  return (
    <Panel title="制品" count={records === undefined ? undefined : String(all.length)}>
      <Field label="按名称筛选">
        <input
          id="wp12-artifact-search"
          type="search"
          value={filter.query}
          placeholder="按名称或媒体类型筛选"
          onChange={(event) => changeFilter({ ...filter, query: event.target.value })}
        />
      </Field>
      <Field label="会话">
        <select
          id="wp12-artifact-session"
          value={filter.sessionId}
          onChange={(event) => changeFilter({ ...filter, sessionId: event.target.value })}
        >
          <option value="">全部会话</option>
          {sessionOptionsOf(all).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </Field>
      <Field label="类型">
        <select
          id="wp12-artifact-type"
          value={filter.mimeType}
          onChange={(event) => changeFilter({ ...filter, mimeType: event.target.value })}
        >
          <option value="">全部类型</option>
          {typeOptionsOf(all).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </Field>
      <Button id="wp12-artifact-refresh" onClick={reload}>刷新</Button>
      {body}
      {detail === undefined || gateway === undefined
        ? null
        : (
          <ArtifactDetail
            gateway={gateway}
            record={detail.record}
            initialVersion={detail.version}
            onClose={() => setDetail(undefined)}
            onRequestDelete={() => setDeleting(detail.record)}
          />
        )}
      {deleting === undefined || gateway === undefined
        ? null
        : (
          <DeleteAllVersions
            gateway={gateway}
            record={deleting}
            onClose={() => setDeleting(undefined)}
            onDeleted={() => {
              setDeleting(undefined);
              setDetail(undefined);
              setExpanded(undefined);
              reload();
            }}
          />
        )}
    </Panel>
  );
}

/** 版本列表展开：摘要、逐版本说明、下载与预览入口。 */
function VersionExpansion({ gateway, record, onPreview }: {
  readonly gateway: ArtifactsGateway | undefined;
  readonly record: ArtifactRecord;
  readonly onPreview: (version: number) => void;
}) {
  const [list, setList] = useState<ArtifactVersionList | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return undefined;
    started.current = true;
    if (gateway === undefined) {
      setFailure(new Error('制品接口不可用'));
      return undefined;
    }
    gateway.versionList(record.id).then(
      (value) => {
        setList(value);
        gateway.noteAction('artifact.versions', 'ok');
      },
      (error: unknown) => {
        setFailure(error);
        gateway.noteAction('artifact.versions', 'failed');
      },
    );
    return undefined;
  }, [gateway, record.id]);

  const download = (version: ArtifactVersionView): void => {
    if (gateway === undefined) return;
    gateway.read(record.id, version.version).then(
      (read) => {
        const saved = describeSave(read);
        saveBlob(blobOf(read), saved.filename);
        gateway.noteAction('artifact.download', 'ok');
        setNotice(saved.note);
      },
      (error: unknown) => {
        gateway.noteAction('artifact.download', 'failed');
        setNotice(describeFailure(error));
      },
    );
  };

  return (
    <li className="chdsh-row">
      <div className="chdsh-row__body">
        <div className="chdsh-row__title">
          版本列表
          {list === undefined ? null : <Badge>{`共 ${String(list.versions.length)} 个`}</Badge>}
        </div>
        {failure === undefined ? null : <ErrorNote>{describeFailure(failure)}</ErrorNote>}
        {notice === undefined ? null : <StatusLine>{notice}</StatusLine>}
        {list === undefined
          ? <Skeleton rows={1} />
          : (
            <>
              <StatusLine>{versionSummaryOf(list)}</StatusLine>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {list.versions.map((version) => (
                  <li key={version.version}>
                    <p style={{ margin: 0 }}>
                      {versionNoteOf(version)}
                      {isCurrentVersion(list, version.version) ? ' · 当前版本' : ''}
                    </p>
                    <Button
                      aria-label={`预览 ${record.title} 第 ${String(version.version)} 版`}
                      onClick={() => onPreview(version.version)}
                    >
                      预览这一版
                    </Button>
                    <Button
                      aria-label={`下载 ${record.title} 第 ${String(version.version)} 版`}
                      disabled={!version.downloadable}
                      onClick={() => download(version)}
                    >
                      下载这一版
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
      </div>
    </li>
  );
}

/** 详情：版本选择、受限预览、下载、外部打开与删除入口。 */
function ArtifactDetail({ gateway, record, initialVersion, onClose, onRequestDelete }: {
  readonly gateway: ArtifactsGateway;
  readonly record: ArtifactRecord;
  readonly initialVersion: number;
  readonly onClose: () => void;
  readonly onRequestDelete: () => void;
}) {
  const [list, setList] = useState<ArtifactVersionList | undefined>(undefined);
  const [listFailure, setListFailure] = useState<unknown>(undefined);
  const [selected, setSelected] = useState(initialVersion);
  const [read, setRead] = useState<ArtifactReadResult | undefined>(undefined);
  const [readFailure, setReadFailure] = useState<unknown>(undefined);
  const [readToken, setReadToken] = useState(0);

  useEffect(() => {
    let active = true;
    gateway.versionList(record.id).then(
      (value) => {
        if (active) setList(value);
      },
      (error: unknown) => {
        if (active) setListFailure(error);
      },
    );
    return () => {
      active = false;
    };
  }, [gateway, record.id]);

  useEffect(() => {
    let active = true;
    setRead(undefined);
    setReadFailure(undefined);
    gateway.read(record.id, selected).then(
      (value) => {
        if (!active) return;
        setRead(value);
        gateway.noteAction('artifact.preview', 'ok');
      },
      (error: unknown) => {
        if (!active) return;
        setReadFailure(error);
        gateway.noteAction('artifact.preview', 'failed');
      },
    );
    return () => {
      active = false;
    };
  }, [gateway, record.id, selected, readToken]);

  const attachment = useMemo<Attachment | undefined>(() => {
    if (read === undefined) return undefined;
    return {
      url: objectUrlOf(blobOf(read)),
      filename: filenameOf(record.title, read.version.version, read.contentType),
    };
  }, [read, record.title]);

  useEffect(() => {
    if (attachment === undefined) return undefined;
    return () => URL.revokeObjectURL(attachment.url);
  }, [attachment]);

  const plan = useMemo(() => (read === undefined ? undefined : previewPlanOf(read)), [read]);

  return (
    <Dialog
      open
      title={`制品：${record.title}`}
      description={`${record.mimeType} · 当前第 ${String(record.version)} 版 · 大小 ${formatBytes(record.size)}`}
      onClose={onClose}
    >
      <Field label="版本" help={list === undefined ? '正在读取版本列表' : versionSummaryOf(list)}>
        <select
          id="wp12-artifact-version"
          value={String(selected)}
          onChange={(event) => setSelected(Number(event.target.value))}
        >
          {(list?.versions ?? []).map((version) => (
            <option key={version.version} value={String(version.version)}>
              {`第 ${String(version.version)} 版 · ${formatBytes(version.size)} · ${formatTimestamp(version.createdAt)}${version.version === (list?.currentVersion ?? 0) ? '（当前）' : ''}`}
            </option>
          ))}
        </select>
      </Field>
      {listFailure === undefined ? null : <ErrorNote>{describeFailure(listFailure)}</ErrorNote>}
      {read === undefined
        ? <Skeleton rows={2} />
        : (
          <StatusLine>
            {`${read.contentType} · ${formatBytes(read.version.size)} · 来源会话 ${shortSessionOf(read.version.sourceSessionId)} · 预览方式 ${read.preview.mode}`}
          </StatusLine>
        )}
      {readFailure === undefined
        ? null
        : (
          <>
            <ErrorNote>{describeFailure(readFailure)}</ErrorNote>
            <Button id="wp12-artifact-reread" onClick={() => setReadToken((token) => token + 1)}>重新读取</Button>
          </>
        )}
      {plan === undefined ? null : <ArtifactPreview plan={plan} title={record.title} attachment={attachment} />}
      {attachment === undefined
        ? null
        : (
          <>
            <p style={{ margin: 0 }}>
              <a
                id="wp12-artifact-download"
                href={attachment.url}
                download={attachment.filename}
                aria-label={`下载第 ${String(selected)} 版`}
                onClick={() => gateway.noteAction('artifact.download', 'ok')}
              >
                {`下载第 ${String(selected)} 版`}
              </a>
            </p>
            <p style={{ margin: 0 }}>
              <a
                id="wp12-artifact-external"
                href={attachment.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`外部打开第 ${String(selected)} 版`}
                onClick={() => gateway.noteAction('artifact.open-external', 'ok')}
              >
                外部打开
              </a>
            </p>
          </>
        )}
      <Button id="wp12-artifact-close" onClick={onClose}>关闭</Button>
      <Button id="wp12-artifact-delete" tone="danger" onClick={onRequestDelete}>删除全部版本</Button>
    </Dialog>
  );
}

/** 删除全部版本的二次确认：说明版本数与占用空间。 */
function DeleteAllVersions({ gateway, record, onClose, onDeleted }: {
  readonly gateway: ArtifactsGateway;
  readonly record: ArtifactRecord;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}) {
  const [scope, setScope] = useState<ArtifactDeleteScope | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    gateway.deleteScope(record.id).then(
      (value) => {
        if (active) setScope(value);
      },
      (error: unknown) => {
        if (active) setFailure(error);
      },
    );
    return () => {
      active = false;
    };
  }, [gateway, record.id]);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    gateway.remove(record.id).then(
      () => {
        gateway.noteAction('artifact.delete', 'ok');
        onDeleted();
      },
      (error: unknown) => {
        gateway.noteAction('artifact.delete', 'failed');
        setFailure(error);
        setBusy(false);
      },
    );
  };

  return (
    <Dialog
      open
      title="删除全部版本"
      description="删除会移除这个制品的每一个版本与内容字节，删除后无法恢复。"
      onClose={onClose}
    >
      {failure === undefined ? null : <ErrorNote>{describeFailure(failure)}</ErrorNote>}
      {scope === undefined
        ? <Skeleton rows={1} />
        : (
          <>
            <p id="wp12-delete-summary">{`${record.title}：${deleteScopeNoteOf(scope)}。`}</p>
            <p>{`涉及的版本：${scope.affectedVersions.map((version) => `第 ${String(version)} 版`).join('、')}`}</p>
          </>
        )}
      <Button id="wp12-delete-cancel" onClick={onClose}>取消</Button>
      <Button id="wp12-delete-confirm" tone="danger" disabled={busy || scope === undefined} onClick={confirm}>
        {busy ? '正在删除' : '确认删除全部版本'}
      </Button>
    </Dialog>
  );
}
