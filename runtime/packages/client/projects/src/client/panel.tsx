/**
 * 项目面板的界面：列表、新建向导、项目设置与删除确认。
 *
 * 列表支持搜索与排序，名称为空时显示目录末段；默认模型与默认助手以徽标呈现。新建向导的
 * 目录浏览经 `directoryPicker` 命名空间真实列举，选中的目录写入表单。设置保存带 `revision`，
 * 冲突时提示并给出重新加载，不覆盖其他界面的写入。删除确认说明只移除配置。
 *
 * 键盘与焦点：三个对话框都使用原生 `dialog` 的焦点约束，Escape 关闭并把焦点还给触发元素；
 * 校验失败后焦点落到错误摘要，摘要里的链接把焦点交给对应字段。
 * @module @chatdsh/client-projects/panel
 */

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  ErrorSummary,
  Field,
  List,
  Panel,
  Row,
  Skeleton,
  StatusLine,
} from '@chatdsh/core-ui-kit';

import { draftInputOf } from './gateway.ts';
import {
  ASSISTANT_FIELD_ID,
  assistantBadgeOf,
  describeFailure,
  displayNameOf,
  filterProjects,
  formatUpdatedAt,
  INSTRUCTIONS_FIELD_ID,
  lastSegmentOf,
  MODEL_FIELD_ID,
  modelBadgeOf,
  PATH_FIELD_ID,
  PROJECT_TITLE_LIMIT,
  revisionVerdict,
  SORT_OPTIONS,
  sortProjects,
  TITLE_FIELD_ID,
  validateDraft,
  type FieldError,
  type ProjectDraft,
  type SortKey,
} from './state.ts';
import type {
  AssistantOption,
  DirectoryListing,
  ProjectRecord,
  ProjectsGateway,
} from './types.ts';

/** 面板的依赖。 */
export interface ProjectsPanelProps {
  /** 数据入口。 */
  readonly gateway: ProjectsGateway;
}

/** 三个对话框的展开状态。 */
type DialogState =
  | { readonly kind: 'none' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly record: ProjectRecord }
  | { readonly kind: 'delete'; readonly record: ProjectRecord };

/** 取某个字段的校验结果。 */
function errorFor(errors: readonly FieldError[], fieldId: string): string | undefined {
  return errors.find((entry) => entry.fieldId === fieldId)?.message;
}

/** 把记录转成草稿。 */
function draftOfRecord(record: ProjectRecord): ProjectDraft {
  return {
    path: record.path,
    title: record.title,
    instructions: record.instructions,
    defaultModel: record.defaultModel ?? '',
    defaultAssistant: record.defaultAssistant ?? '',
  };
}

/** 项目面板。 */
export function ProjectsPanel({ gateway }: ProjectsPanelProps) {
  const [records, setRecords] = useState<ProjectRecord[] | undefined>(undefined);
  const [listFailure, setListFailure] = useState<unknown>(undefined);
  const [assistants, setAssistants] = useState<readonly AssistantOption[]>([]);
  const [models, setModels] = useState<readonly string[]>([]);
  const [optionsFailure, setOptionsFailure] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('name');
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    gateway.list().then(
      (rows) => {
        if (!active) return;
        setRecords(rows);
        setListFailure(undefined);
      },
      (error: unknown) => {
        if (!active) return;
        setListFailure(error);
        setRecords(undefined);
      },
    );
    return () => {
      active = false;
    };
  }, [gateway, reloadToken]);

  useEffect(() => {
    let active = true;
    gateway.listAssistants().then(
      (rows) => {
        if (active) setAssistants(rows);
      },
      (error: unknown) => {
        if (active) setOptionsFailure(describeFailure(error));
      },
    );
    gateway.listModels().then(
      (rows) => {
        if (active) setModels(rows);
      },
      (error: unknown) => {
        if (active) setOptionsFailure(describeFailure(error));
      },
    );
    return () => {
      active = false;
    };
  }, [gateway]);

  const reload = (): void => {
    setRecords(undefined);
    setListFailure(undefined);
    setReloadToken((token) => token + 1);
  };
  const close = (): void => setDialog({ kind: 'none' });

  const body = listFailure !== undefined
    ? (
      <>
        <StatusLine tone="danger">{describeFailure(listFailure)}</StatusLine>
        <Button id="wp10-project-reload" onClick={reload}>重新加载</Button>
      </>
    )
    : records === undefined
      ? <Skeleton rows={3} />
      : <ProjectsList
        records={records}
        assistants={assistants}
        query={query}
        sort={sort}
        onOpen={(record) => setDialog({ kind: 'edit', record })}
        onDelete={(record) => setDialog({ kind: 'delete', record })}
      />;

  return (
    <Panel title="项目" count={records === undefined ? undefined : String(records.length)}>
      <Field label="搜索">
        <input
          id="wp10-project-search"
          type="search"
          value={query}
          placeholder="按名称或目录筛选"
          onChange={(event) => setQuery(event.target.value)}
        />
      </Field>
      <Field label="排序">
        <select
          id="wp10-project-sort"
          value={sort}
          onChange={(event) => setSort(event.target.value as SortKey)}
        >
          {SORT_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
        </select>
      </Field>
      <Button id="wp10-project-create" tone="primary" onClick={() => setDialog({ kind: 'create' })}>新建项目</Button>
      <Button id="wp10-project-refresh" onClick={reload}>刷新</Button>
      {body}
      {dialog.kind === 'create'
        ? (
          <CreateWizard
            gateway={gateway}
            existingPaths={(records ?? []).map((record) => record.path)}
            assistants={assistants}
            models={models}
            optionsFailure={optionsFailure}
            onClose={close}
            onCreated={(): void => {
              close();
              reload();
            }}
          />
        )
        : null}
      {dialog.kind === 'edit'
        ? (
          <ProjectSettings
            gateway={gateway}
            record={dialog.record}
            assistants={assistants}
            models={models}
            optionsFailure={optionsFailure}
            onClose={close}
            onSaved={(): void => {
              close();
              reload();
            }}
            onRequestDelete={(record): void => setDialog({ kind: 'delete', record })}
            onGone={(): void => {
              close();
              reload();
            }}
          />
        )
        : null}
      {dialog.kind === 'delete'
        ? (
          <DeleteConfirm
            gateway={gateway}
            record={dialog.record}
            onClose={close}
            onDeleted={(): void => {
              close();
              reload();
            }}
          />
        )
        : null}
    </Panel>
  );
}

/** 列表正文：空列表、无匹配与真实记录。 */
function ProjectsList({ records, assistants, query, sort, onOpen, onDelete }: {
  readonly records: readonly ProjectRecord[];
  readonly assistants: readonly AssistantOption[];
  readonly query: string;
  readonly sort: SortKey;
  readonly onOpen: (record: ProjectRecord) => void;
  readonly onDelete: (record: ProjectRecord) => void;
}) {
  if (records.length === 0) {
    return <EmptyState>还没有项目。新建项目时浏览并选择一个工作目录。</EmptyState>;
  }
  const visible = sortProjects(filterProjects(records, query), sort);
  if (visible.length === 0) return <StatusLine>没有符合条件的项目。</StatusLine>;
  return (
    <List>
      {visible.map((record) => {
        const model = modelBadgeOf(record.defaultModel);
        const assistant = assistantBadgeOf(record.defaultAssistant, assistants);
        return (
          <Row
            key={record.path}
            title={displayNameOf(record)}
            meta={`${record.path} · 更新于 ${formatUpdatedAt(record.updatedAt)}`}
            badge={(
              <>
                {model === undefined ? null : <Badge>{model}</Badge>}
                {assistant === undefined ? null : <Badge tone="brand">{assistant}</Badge>}
              </>
            )}
            actions={(
              <>
                <Button aria-label={`设置 ${displayNameOf(record)}`} onClick={() => onOpen(record)}>设置</Button>
                <Button aria-label={`删除 ${displayNameOf(record)}`} tone="danger" onClick={() => onDelete(record)}>删除</Button>
              </>
            )}
          />
        );
      })}
    </List>
  );
}

/** 四个核心字段的公共表单区。 */
function ProjectFields({ draft, onChange, errors, models, assistants, optionsFailure, pathReadOnly, pathHelp }: {
  readonly draft: ProjectDraft;
  readonly onChange: (draft: ProjectDraft) => void;
  readonly errors: readonly FieldError[];
  readonly models: readonly string[];
  readonly assistants: readonly AssistantOption[];
  readonly optionsFailure: string | undefined;
  readonly pathReadOnly: boolean;
  readonly pathHelp: string | undefined;
}) {
  const suggestions = [...models];
  return (
    <>
      <Field label="目录" required={!pathReadOnly} error={errorFor(errors, PATH_FIELD_ID)} help={pathHelp}>
        <input
          id={PATH_FIELD_ID}
          readOnly={pathReadOnly}
          value={draft.path}
          placeholder="尚未选择目录"
          onChange={(event) => onChange({ ...draft, path: event.target.value })}
        />
      </Field>
      <Field
        label="名称"
        help={`留空时按目录末段显示${draft.path === '' ? '' : `（${lastSegmentOf(draft.path)}）`}，最多 ${String(PROJECT_TITLE_LIMIT)} 个字符`}
        error={errorFor(errors, TITLE_FIELD_ID)}
      >
        <input
          id={TITLE_FIELD_ID}
          value={draft.title}
          onChange={(event) => onChange({ ...draft, title: event.target.value })}
        />
      </Field>
      <Field label="项目说明" error={errorFor(errors, INSTRUCTIONS_FIELD_ID)}>
        <textarea
          id={INSTRUCTIONS_FIELD_ID}
          rows={4}
          value={draft.instructions}
          onChange={(event) => onChange({ ...draft, instructions: event.target.value })}
        />
      </Field>
      <Field
        label="默认模型"
        help={models.length === 0 ? '模型目录里没有声明可选的模型。' : undefined}
        error={errorFor(errors, MODEL_FIELD_ID)}
      >
        <select
          id={MODEL_FIELD_ID}
          value={draft.defaultModel}
          onChange={(event) => onChange({ ...draft, defaultModel: event.target.value })}
        >
          <option value="">不设置默认模型</option>
          {suggestions.includes(draft.defaultModel) || draft.defaultModel === ''
            ? null
            : <option value={draft.defaultModel}>{`${draft.defaultModel}（当前值）`}</option>}
          {suggestions.map((reference) => <option key={reference} value={reference}>{reference}</option>)}
        </select>
      </Field>
      <Field
        label="默认助手"
        help={assistants.length === 0 ? '没有可选的助手。' : undefined}
        error={errorFor(errors, ASSISTANT_FIELD_ID)}
      >
        <select
          id={ASSISTANT_FIELD_ID}
          value={draft.defaultAssistant}
          onChange={(event) => onChange({ ...draft, defaultAssistant: event.target.value })}
        >
          <option value="">不设置默认助手</option>
          {assistants.some((option) => option.id === draft.defaultAssistant) || draft.defaultAssistant === ''
            ? null
            : <option value={draft.defaultAssistant}>{`${draft.defaultAssistant}（当前值）`}</option>}
          {assistants.map((option) => <option key={option.id} value={option.id}>{option.name ?? option.id}</option>)}
        </select>
      </Field>
      {optionsFailure === undefined ? null : <StatusLine tone="danger">{optionsFailure}</StatusLine>}
    </>
  );
}

/** 新建向导：目录浏览、字段填写与提交。 */
function CreateWizard({ gateway, existingPaths, assistants, models, optionsFailure, onClose, onCreated }: {
  readonly gateway: ProjectsGateway;
  readonly existingPaths: readonly string[];
  readonly assistants: readonly AssistantOption[];
  readonly models: readonly string[];
  readonly optionsFailure: string | undefined;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const summaryId = useId();
  const [listing, setListing] = useState<DirectoryListing | undefined>(undefined);
  const [listingFailure, setListingFailure] = useState<unknown>(undefined);
  const [browsing, setBrowsing] = useState(true);
  const [draft, setDraft] = useState<ProjectDraft>({ path: '', title: '', instructions: '', defaultModel: '', defaultAssistant: '' });
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [submitFailure, setSubmitFailure] = useState<unknown>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const started = useRef(false);

  const openDirectory = (path?: string): void => {
    setBrowsing(true);
    gateway.listDirectory(path).then(
      (value) => {
        setListing(value);
        setListingFailure(undefined);
        setBrowsing(false);
        gateway.noteAction('project.browse', 'ok');
      },
      (error: unknown) => {
        setListingFailure(error);
        setBrowsing(false);
        gateway.noteAction('project.browse', 'failed');
      },
    );
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    openDirectory(undefined);
  }, []);

  useEffect(() => {
    if (errors.length === 0) return;
    document.getElementById(summaryId)?.focus();
  }, [errors, summaryId]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (submitting) return;
    const found = validateDraft(draft, existingPaths, 'create');
    setErrors(found);
    if (found.length > 0) {
      gateway.noteAction('project.create', 'rejected');
      return;
    }
    setSubmitFailure(undefined);
    setSubmitting(true);
    gateway.create(draftInputOf(draft)).then(
      () => {
        gateway.noteAction('project.create', 'ok');
        onCreated();
      },
      (error: unknown) => {
        gateway.noteAction('project.create', 'failed');
        gateway.get(draft.path).then(
          (existing) => {
            if (existing === undefined) setSubmitFailure(error);
            else setErrors([{ fieldId: PATH_FIELD_ID, message: '该目录已经有项目记录' }]);
            setSubmitting(false);
          },
          () => {
            setSubmitFailure(error);
            setSubmitting(false);
          },
        );
      },
    );
  };

  return (
    <Dialog open title="新建项目" description="项目把名称、说明与默认值绑在一个工作目录上。" onClose={onClose}>
      <form aria-label="新建项目" onSubmit={submit}>
        <ErrorSummary id={summaryId} errors={errors} />
        {submitFailure === undefined ? null : <ErrorNote>{describeFailure(submitFailure)}</ErrorNote>}
        <ProjectFields
          draft={draft}
          onChange={setDraft}
          errors={errors}
          models={models}
          assistants={assistants}
          optionsFailure={optionsFailure}
          pathReadOnly
          pathHelp="读取自下方目录浏览，选中后只读。"
        />
        <section aria-label="目录浏览">
          {browsing ? <Skeleton rows={2} /> : null}
          {listingFailure === undefined
            ? null
            : (
              <>
                <StatusLine tone="danger">{describeFailure(listingFailure)}</StatusLine>
                <Button id="wp10-project-relist" onClick={() => openDirectory(listing?.path)}>重新列举</Button>
              </>
            )}
          {listing === undefined || browsing
            ? null
            : (
              <>
                <nav aria-label="目录层级">
                  {listing.crumbs.map((crumb) => (
                    <Button key={crumb.path} onClick={() => openDirectory(crumb.path)}>{crumb.name}</Button>
                  ))}
                </nav>
                {listing.entries.length === 0
                  ? <StatusLine>这个目录下没有子目录。</StatusLine>
                  : (
                    <List>
                      {listing.entries.map((entry) => (
                        <Row
                          key={entry.path}
                          title={entry.name}
                          meta={entry.path}
                          actions={<Button aria-label={`打开 ${entry.name}`} onClick={() => openDirectory(entry.path)}>打开</Button>}
                        />
                      ))}
                    </List>
                  )}
                {listing.truncated ? <StatusLine>这一层目录超过上限，只列出了前面的部分。</StatusLine> : null}
                <StatusLine>正在浏览：{listing.path}</StatusLine>
                <Button id="wp10-project-choose" onClick={() => setDraft({ ...draft, path: listing.path })}>选择此目录</Button>
              </>
            )}
        </section>
        <Button id="wp10-project-submit" type="submit" tone="primary" disabled={submitting}>
          {submitting ? '正在创建' : '创建项目'}
        </Button>
        <Button id="wp10-project-cancel" onClick={onClose}>取消</Button>
      </form>
    </Dialog>
  );
}

/** 项目设置：修改字段、处理版本冲突与请求删除。 */
function ProjectSettings({ gateway, record, assistants, models, optionsFailure, onClose, onSaved, onRequestDelete, onGone }: {
  readonly gateway: ProjectsGateway;
  readonly record: ProjectRecord;
  readonly assistants: readonly AssistantOption[];
  readonly models: readonly string[];
  readonly optionsFailure: string | undefined;
  readonly onClose: () => void;
  readonly onSaved: (record: ProjectRecord) => void;
  readonly onRequestDelete: (record: ProjectRecord) => void;
  readonly onGone: () => void;
}) {
  const summaryId = useId();
  const [base, setBase] = useState<ProjectRecord>(record);
  const [draft, setDraft] = useState<ProjectDraft>(draftOfRecord(record));
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [submitFailure, setSubmitFailure] = useState<unknown>(undefined);
  const [conflict, setConflict] = useState<ProjectRecord | undefined>(undefined);
  const [deletedElsewhere, setDeletedElsewhere] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (errors.length === 0) return;
    document.getElementById(summaryId)?.focus();
  }, [errors, summaryId]);

  useEffect(() => {
    if (conflict === undefined) return;
    document.getElementById('wp10-settings-reload')?.focus();
  }, [conflict]);

  const reloadFromHost = (): void => {
    gateway.get(base.path).then(
      (current) => {
        if (current === undefined) {
          setDeletedElsewhere(true);
          setConflict(undefined);
          return;
        }
        setBase(current);
        setDraft(draftOfRecord(current));
        setConflict(undefined);
        setDeletedElsewhere(false);
        setErrors([]);
        setSubmitFailure(undefined);
      },
      (error: unknown) => setSubmitFailure(error),
    );
  };

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    const found = validateDraft(draft, [], 'edit');
    setErrors(found);
    if (found.length > 0) {
      gateway.noteAction('project.update', 'rejected');
      return;
    }
    setSubmitFailure(undefined);
    setBusy(true);
    gateway.set(draftInputOf(draft, base.revision)).then(
      (updated) => {
        gateway.noteAction('project.update', 'ok');
        onSaved(updated);
      },
      (error: unknown) => {
        gateway.noteAction('project.update', 'failed');
        gateway.get(base.path).then(
          (current) => {
            const verdict = revisionVerdict(base.revision, current);
            if (verdict === 'conflict') setConflict(current);
            else if (verdict === 'deleted') setDeletedElsewhere(true);
            else setSubmitFailure(error);
            setBusy(false);
          },
          () => {
            setSubmitFailure(error);
            setBusy(false);
          },
        );
      },
    );
  };

  return (
    <Dialog
      open
      title="项目设置"
      description={`目录在创建后只读；当前版本 ${String(base.revision)}。`}
      onClose={onClose}
    >
      <form aria-label="项目设置" onSubmit={save}>
        <ErrorSummary id={summaryId} errors={errors} />
        {submitFailure === undefined ? null : <ErrorNote>{describeFailure(submitFailure)}</ErrorNote>}
        {deletedElsewhere
          ? (
            <>
              <StatusLine tone="danger">项目已被删除，本地内容没有写入。</StatusLine>
              <Button id="wp10-settings-gone" onClick={onGone}>刷新列表</Button>
            </>
          )
          : null}
        <ProjectFields
          draft={draft}
          onChange={setDraft}
          errors={errors}
          models={models}
          assistants={assistants}
          optionsFailure={optionsFailure}
          pathReadOnly
          pathHelp="路径创建后只读，换目录通过新建项目完成。"
        />
        {conflict === undefined
          ? null
          : (
            <>
              <StatusLine tone="danger">
                {`项目已被其他界面修改（当前版本 ${String(conflict.revision)}），本地内容没有写入。`}
              </StatusLine>
              <Button id="wp10-settings-reload" onClick={reloadFromHost}>重新加载</Button>
            </>
          )}
        <Button id="wp10-settings-save" type="submit" tone="primary" disabled={busy || conflict !== undefined || deletedElsewhere}>
          {busy ? '正在保存' : '保存'}
        </Button>
        <Button id="wp10-settings-cancel" onClick={onClose}>取消</Button>
        <Button id="wp10-settings-delete" tone="danger" onClick={() => onRequestDelete(base)}>删除项目</Button>
      </form>
    </Dialog>
  );
}

/** 删除确认：说明只移除配置，二次确认后才写入。 */
function DeleteConfirm({ gateway, record, onClose, onDeleted }: {
  readonly gateway: ProjectsGateway;
  readonly record: ProjectRecord;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}) {
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    gateway.remove(record.path).then(
      () => {
        gateway.noteAction('project.delete', 'ok');
        onDeleted();
      },
      (error: unknown) => {
        gateway.noteAction('project.delete', 'failed');
        setFailure(error);
        setBusy(false);
      },
    );
  };

  return (
    <Dialog
      open
      title="删除项目"
      description="删除只移除项目配置：工作目录、目录里的文件、既有会话与记忆都会保留。"
      onClose={onClose}
    >
      <p>{`${displayNameOf(record)}（${record.path}）`}</p>
      {failure === undefined ? null : <ErrorNote>{describeFailure(failure)}</ErrorNote>}
      <Button id="wp10-delete-cancel" onClick={onClose}>取消</Button>
      <Button id="wp10-delete-confirm" tone="danger" disabled={busy} onClick={confirm}>{busy ? '正在删除' : '删除项目'}</Button>
    </Dialog>
  );
}
