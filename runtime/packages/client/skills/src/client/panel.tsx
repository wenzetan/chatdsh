/**
 * 技能面板：来源分组、关键字与来源检索、启停开关与引用标注。
 *
 * 列表按内置、工作区、用户目录三组显示，每条技能带启用状态徽标与被哪些助手引用的说明。
 * 检索交给宿主完成，关键字超限之类的拒绝由宿主判定，界面显示宿主原本的说明并保留上一批结果。
 * 启停走二次确认：开关状态以宿主返回的结果为准，失败时提示原因并按宿主重新读取。
 * @module @chatdsh/client-skills/panel
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge, Button, Dialog, EmptyState, ErrorNote, Field, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';

import { formatSkillSummary, SKILL_SOURCES, type SkillSourceKind } from '../index.ts';
import {
  describeFailure,
  FIELD_IDS,
  groupSkills,
  nextEnabledOf,
  referencesOf,
  requestOf,
} from './state.ts';
import { installSkillsStyles } from './styles.ts';
import type { SkillEntry, SkillsGateway, SkillSnapshot } from './types.ts';

/** 面板的依赖。 */
export interface SkillsPanelProps {
  /** 数据入口。 */
  readonly gateway: SkillsGateway;
}

/** 检索表单的状态。 */
interface Query {
  readonly text: string;
  readonly source: SkillSourceKind | 'all';
}

/** 启停确认的展开状态。 */
type ToggleState = { readonly entry: SkillEntry } | undefined;

/** 技能面板。 */
export function SkillsPanel({ gateway }: SkillsPanelProps) {
  useEffect(() => {
    installSkillsStyles(document);
  }, []);

  const [snapshot, setSnapshot] = useState<SkillSnapshot | undefined>(undefined);
  const [loadFailure, setLoadFailure] = useState<unknown>(undefined);
  const [searchFailure, setSearchFailure] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState<Query>({ text: '', source: 'all' });
  /** 输入框与来源选择在同一次交互里连续变化时，按这里的最新取值发起检索。 */
  const queryRef = useRef<Query>(query);
  const [results, setResults] = useState<readonly SkillEntry[] | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [toggle, setToggle] = useState<ToggleState>(undefined);

  const reload = useCallback((): void => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let active = true;
    setLoadFailure(undefined);
    void gateway.load().then(
      (next) => {
        if (active) setSnapshot(next);
      },
      (error: unknown) => {
        if (active) setLoadFailure(error);
      },
    );
    return () => {
      active = false;
    };
  }, [gateway, reloadToken]);

  /** 重新执行当前检索；没有过滤条件时回到完整目录。 */
  const runSearch = (next: Query): void => {
    queryRef.current = next;
    setQuery(next);
    const request = requestOf(next.text, next.source);
    if (request.text === undefined && request.source === undefined) {
      setResults(undefined);
      setSearchFailure(undefined);
      return;
    }
    setSearching(true);
    gateway.search(request).then(
      (hits) => {
        setSearching(false);
        setSearchFailure(undefined);
        setResults(hits);
        gateway.noteAction('skill.search', 'ok');
      },
      (error: unknown) => {
        setSearching(false);
        setSearchFailure(error);
        gateway.noteAction('skill.search', 'failed');
      },
    );
  };

  /** 提交检索表单。 */
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    runSearch(queryRef.current);
  };

  if (loadFailure !== undefined) {
    return (
      <Panel title="技能">
        <StatusLine tone="danger">{`技能目录读取失败：${describeFailure(loadFailure)}`}</StatusLine>
        <Button id="wp11-skill-reload" onClick={reload}>重新加载</Button>
      </Panel>
    );
  }

  const shown = results ?? snapshot?.skills ?? [];
  const groups = groupSkills(shown);
  const references = referencesOf(snapshot?.assistants);

  return (
    <Panel
      title="技能"
      subtitle={snapshot === undefined
        ? undefined
        : `${formatSkillSummary(snapshot.state)}。技能目录在宿主启动时扫描一次，新增或删除技能文件需要重启宿主；启用与停用的决定立即保存，重启后仍然生效。`}
      count={snapshot === undefined ? undefined : String(snapshot.state.total)}
    >
      <form aria-label="检索技能" onSubmit={submit} noValidate>
        <Field
          label="检索关键字"
          help="按标识、名称与说明做包含匹配；最多 120 个字符，超限由宿主拒绝。"
        >
          <input
            id={FIELD_IDS.search}
            type="search"
            value={query.text}
            onChange={(event) => {
              const next = { ...queryRef.current, text: event.target.value };
              queryRef.current = next;
              setQuery(next);
            }}
          />
        </Field>
        <Field label="来源" help="只看某一个来源，或者搜索全部来源。">
          <select
            id={FIELD_IDS.source}
            value={query.source}
            onChange={(event) => runSearch({ ...queryRef.current, source: event.target.value as Query['source'] })}
          >
            <option value="all">全部来源</option>
            {SKILL_SOURCES.map((source) => (
              <option key={source} value={source}>{`来源：${source}`}</option>
            ))}
          </select>
        </Field>
        <Button id="wp11-skill-search-submit" type="submit" disabled={searching}>
          {searching ? '正在检索' : '检索'}
        </Button>
        <Button
          id="wp11-skill-search-clear"
          onClick={() => {
            queryRef.current = { text: '', source: 'all' };
            setQuery({ text: '', source: 'all' });
            setResults(undefined);
            setSearchFailure(undefined);
          }}
        >
          清除过滤
        </Button>
        <Button id="wp11-skill-refresh" onClick={reload}>刷新</Button>
      </form>
      {searchFailure === undefined ? null : <ErrorNote>{`检索没有被受理：${describeFailure(searchFailure)}`}</ErrorNote>}
      {notice === undefined ? null : <StatusLine>{notice}</StatusLine>}
      {snapshot === undefined
        ? <Skeleton rows={3} />
        : (
          <>
            {snapshot.assistantsFailure === undefined
              ? null
              : <StatusLine tone="danger">{`引用状态不可用：${describeFailure(snapshot.assistantsFailure)}`}</StatusLine>}
            {shown.length === 0
              ? (
                <EmptyState
                  action={results === undefined
                    ? undefined
                    : (
                      <Button
                        id="wp11-skill-clear-empty"
                        onClick={() => {
                          queryRef.current = { text: '', source: 'all' };
                          setQuery({ text: '', source: 'all' });
                          setResults(undefined);
                          setSearchFailure(undefined);
                        }}
                      >
                        清除过滤
                      </Button>
                    )}
                >
                  {results === undefined ? '技能目录里还没有技能。' : '没有匹配的技能。'}
                </EmptyState>
              )
              : groups.map((group) => (
                <section key={group.source} aria-label={`${group.label}技能`} className="chdsh-skills-group" id={`wp11-skill-group-${group.source}`}>
                  <h4>{`${group.label}（${String(group.entries.length)}，已启用 ${String(group.enabled)}）`}</h4>
                  <StatusLine>{group.note}</StatusLine>
                  {group.entries.length === 0
                    ? <StatusLine>这个来源没有技能。</StatusLine>
                    : (
                      <List>
                        {group.entries.map((entry) => (
                          <Row
                            key={entry.id}
                            dot={entry.enabled ? 'ok' : 'idle'}
                            title={entry.name}
                            badge={(
                              <>
                                <Badge tone={entry.enabled ? 'ok' : 'warn'}>{entry.enabled ? '已启用' : '已停用'}</Badge>
                                <Badge tone="neutral">{`来源：${group.label}`}</Badge>
                              </>
                            )}
                            meta={`${entry.description} · ${
                              references === undefined
                                ? '引用状态不可用'
                                : references.get(entry.id) === undefined
                                  ? '没有助手引用'
                                  : `被助手 ${(references.get(entry.id) ?? []).join('、')} 引用`
                            }`}
                            actions={(
                              <Button
                                aria-label={`${entry.enabled ? '停用' : '启用'} ${entry.name}`}
                                onClick={() => {
                                  gateway.noteAction(entry.enabled ? 'skill.disable' : 'skill.enable', 'ok');
                                  setToggle({ entry });
                                }}
                              >
                                {entry.enabled ? '停用' : '启用'}
                              </Button>
                            )}
                          />
                        ))}
                      </List>
                    )}
                </section>
              ))}
          </>
        )}
      {toggle === undefined
        ? null
        : (
          <ToggleConfirm
            gateway={gateway}
            entry={toggle.entry}
            onClose={() => setToggle(undefined)}
            onDone={(next, message) => {
              setToggle(undefined);
              setNotice(message);
              reload();
              const request = requestOf(queryRef.current.text, queryRef.current.source);
              if (request.text !== undefined || request.source !== undefined) {
                setResults((previous) => previous?.map((item) => (item.id === next.id ? { ...item, enabled: next.enabled } : item)));
              }
            }}
            onFailed={() => {
              setNotice(undefined);
              setSearchFailure(undefined);
              reload();
            }}
          />
        )}
    </Panel>
  );
}

/** 启用或停用的二次确认。 */
function ToggleConfirm({ gateway, entry, onClose, onDone, onFailed }: {
  readonly gateway: SkillsGateway;
  readonly entry: SkillEntry;
  readonly onClose: () => void;
  readonly onDone: (next: { readonly id: string; readonly enabled: boolean }, message: string) => void;
  readonly onFailed: () => void;
}) {
  const target = nextEnabledOf(entry);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    gateway.toggle(entry.id, target).then(
      (next) => {
        setBusy(false);
        gateway.noteAction(target ? 'skill.enable' : 'skill.disable', 'ok');
        onDone(next, `技能 ${entry.name} 已${target ? '启用' : '停用'}；宿主已保存这个决定。`);
      },
      (error: unknown) => {
        setBusy(false);
        setFailure(error);
        gateway.noteAction(target ? 'skill.enable' : 'skill.disable', 'failed');
        onFailed();
      },
    );
  };

  return (
    <Dialog
      open
      title={target ? '启用技能' : '停用技能'}
      description={target
        ? '启用之后这个技能重新出现在技能目录里，助手可以引用它。'
        : '停用只改本项目的技能目录视图与技能管理工具：它不再出现在技能目录里，新建助手时不能引用；已经引用它的助手保留原引用，引用面板标注为已停用。'}
      onClose={onClose}
    >
      <p>{`${entry.name}（来源：${entry.source}）`}</p>
      <StatusLine>{entry.description}</StatusLine>
      <StatusLine>{`当前状态：${entry.enabled ? '已启用' : '已停用'}；提交后按宿主返回的结果为准。`}</StatusLine>
      {failure === undefined ? null : <ErrorNote>{`启停没有被受理：${describeFailure(failure)}`}</ErrorNote>}
      <Button id="wp11-skill-toggle-cancel" onClick={onClose}>取消</Button>
      <Button id="wp11-skill-toggle-confirm" tone={target ? 'primary' : 'danger'} disabled={busy} onClick={confirm}>
        {busy ? '正在提交' : target ? '启用' : '停用'}
      </Button>
    </Dialog>
  );
}
