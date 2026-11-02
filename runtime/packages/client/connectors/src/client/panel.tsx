/**
 * 连接器面板：来源分组列表、运行状态详情、启停与删除确认。
 *
 * 列表按来源分两组：本机连接器记录与控制平面注册表下发的端点。每行同时带配置保存徽标与
 * 加载器同步徽标——保存成功与同步失败可以同时成立，二者都要显示，并给出重新同步入口。
 * 详情对话框展示配置、同步结果（错误码与最近时间）、连接状态、工具列表与工具调用测试。
 *
 * 键盘与焦点：四个对话框都使用原生 `dialog` 的焦点约束，Escape 关闭并把焦点还给触发元素。
 * @module @chatdsh/client-connectors/panel
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorNote,
  List,
  Panel,
  Row,
  ScrollRegion,
  Skeleton,
  StatusLine,
} from '@chatdsh/core-ui-kit';

import { ConnectorForm } from './form.tsx';
import { ToolTest } from './mcp.tsx';
import {
  configBadge,
  connectionBadgeOf,
  describeFailure,
  describeSync,
  enabledBadgeOf,
  formatTime,
  REGISTRY_ROW_PREFIX,
  registryServersOf,
  syncBadgeOf,
  targetOf,
  toServerName,
  transportLabelOf,
} from './state.ts';
import type { ConnectorRecord, ConnectorStateView, ConnectorsGateway, McpRowResult, McpStatusView } from './types.ts';

/** 面板的依赖。 */
export interface ConnectorsPanelProps {
  /** 数据入口。 */
  readonly gateway: ConnectorsGateway;
}

/** 对话框的展开状态。 */
type DialogState =
  | { readonly kind: 'none' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly record: ConnectorRecord }
  | { readonly kind: 'detail'; readonly record: ConnectorRecord; readonly state: ConnectorStateView }
  | { readonly kind: 'toggle'; readonly state: ConnectorStateView; readonly next: boolean }
  | { readonly kind: 'delete'; readonly state: ConnectorStateView };

/** 列表加载后的快照。 */
interface Snapshot {
  readonly records: readonly ConnectorRecord[];
  readonly states: readonly ConnectorStateView[];
  readonly status: McpStatusView;
}

/** 连接器面板。 */
export function ConnectorsPanel({ gateway }: ConnectorsPanelProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(undefined);
  const [loadFailure, setLoadFailure] = useState<unknown>(undefined);
  const [actionFailure, setActionFailure] = useState<unknown>(undefined);
  const [syncing, setSyncing] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });

  useEffect(() => {
    let active = true;
    setSnapshot(undefined);
    setLoadFailure(undefined);
    void Promise.all([gateway.list(), gateway.states(), gateway.mcpStatus()]).then(
      ([records, states, status]) => {
        if (!active) return;
        setSnapshot({ records, states, status });
      },
      (error: unknown) => {
        if (!active) return;
        setLoadFailure(error);
      },
    );
    return () => {
      active = false;
    };
  }, [gateway, reloadToken]);

  const reload = useCallback((): void => {
    setReloadToken((token) => token + 1);
  }, []);

  const close = (): void => setDialog({ kind: 'none' });

  const finish = (): void => {
    close();
    reload();
  };

  /** 重新同步全部加载器行，让同步徽标回到真实结果。 */
  const resyncAll = (): void => {
    if (syncing) return;
    setSyncing(true);
    setActionFailure(undefined);
    gateway.syncMcpRows().then(
      () => {
        setSyncing(false);
        gateway.noteAction('connector.sync', 'ok');
        reload();
      },
      (error: unknown) => {
        setSyncing(false);
        setActionFailure(error);
        gateway.noteAction('connector.sync', 'failed');
        reload();
      },
    );
  };

  /** 从控制平面拉取注册表并按本设备端点重建行。 */
  const refreshRegistry = (): void => {
    setActionFailure(undefined);
    gateway.refreshMcpRegistry().then(
      () => {
        gateway.noteAction('connector.registry.refresh', 'ok');
        reload();
      },
      (error: unknown) => {
        setActionFailure(error);
        gateway.noteAction('connector.registry.refresh', 'failed');
      },
    );
  };

  if (loadFailure !== undefined) {
    return (
      <Panel title="连接器">
        <StatusLine tone="danger">{describeFailure(loadFailure)}</StatusLine>
        <Button id="wp13-connector-reload" onClick={reload}>重新加载</Button>
      </Panel>
    );
  }

  const body = snapshot === undefined
    ? <Skeleton rows={3} />
    : (
      <>
        <StatusLine>
          {`控制平面注册表 ${String(snapshot.status.servers)} 台服务器 · 本机端点 ${String(snapshot.status.endpoints)} 个`}
        </StatusLine>
        <ConnectorList
          snapshot={snapshot}
          syncing={syncing}
          onCreate={() => setDialog({ kind: 'create' })}
          onRefresh={reload}
          onRefreshRegistry={refreshRegistry}
          onResyncAll={resyncAll}
          onDetail={(state, record) => setDialog({ kind: 'detail', state, record })}
          onToggle={(state) => setDialog({ kind: 'toggle', state, next: !state.enabled })}
          onDelete={(state) => setDialog({ kind: 'delete', state })}
          onEdit={(record) => setDialog({ kind: 'edit', record })}
        />
      </>
    );

  return (
    <Panel
      title="连接器"
      subtitle="凭据只保存环境变量名：值从本机环境读取，界面不回显也不保存值。"
      count={snapshot === undefined ? undefined : String(snapshot.records.length)}
    >
      {actionFailure === undefined ? null : <ErrorNote>{describeFailure(actionFailure)}</ErrorNote>}
      {body}
      {dialog.kind === 'create' || dialog.kind === 'edit'
        ? (
          <ConnectorForm
            gateway={gateway}
            mode={dialog.kind}
            record={dialog.kind === 'edit' ? dialog.record : undefined}
            others={snapshot === undefined
              ? []
              : dialog.kind === 'edit'
                ? snapshot.records.filter((record) => record.id !== dialog.record.id)
                : snapshot.records}
            onClose={close}
            onSaved={finish}
          />
        )
        : null}
      {dialog.kind === 'detail'
        ? (
          <ConnectorDetail
            gateway={gateway}
            id={dialog.record.id}
            initialRecord={dialog.record}
            initialState={dialog.state}
            onClose={close}
            onChanged={reload}
          />
        )
        : null}
      {dialog.kind === 'toggle'
        ? (
          <ToggleConfirm
            gateway={gateway}
            state={dialog.state}
            next={dialog.next}
            onClose={close}
            onDone={finish}
            onRefresh={reload}
          />
        )
        : null}
      {dialog.kind === 'delete'
        ? (
          <DeleteConfirm
            gateway={gateway}
            state={dialog.state}
            onClose={close}
            onDone={finish}
            onRefresh={reload}
          />
        )
        : null}
    </Panel>
  );
}

/** 列表：两组来源与各自的空状态。 */
function ConnectorList({ snapshot, syncing, onCreate, onRefresh, onRefreshRegistry, onResyncAll, onDetail, onToggle, onDelete, onEdit }: {
  readonly snapshot: Snapshot;
  readonly syncing: boolean;
  readonly onCreate: () => void;
  readonly onRefresh: () => void;
  readonly onRefreshRegistry: () => void;
  readonly onResyncAll: () => void;
  readonly onDetail: (state: ConnectorStateView, record: ConnectorRecord) => void;
  readonly onToggle: (state: ConnectorStateView) => void;
  readonly onDelete: (state: ConnectorStateView) => void;
  readonly onEdit: (record: ConnectorRecord) => void;
}) {
  const registryServers = registryServersOf(snapshot.status.rows);
  const recordById = new Map(snapshot.records.map((record) => [record.id, record]));
  const rows = snapshot.states.flatMap((state) => {
    const record = recordById.get(state.id);
    return record === undefined ? [] : [{ state, record }];
  });
  return (
    <>
      <Button id="wp13-connector-create" tone="primary" onClick={onCreate}>新建连接器</Button>
      <Button id="wp13-connector-refresh" onClick={onRefresh}>刷新</Button>
      <Button id="wp13-connector-resync" onClick={onResyncAll} disabled={syncing || rows.length === 0}>
        {syncing ? '正在同步' : '重新同步全部'}
      </Button>
      <Button id="wp13-connector-registry" onClick={onRefreshRegistry}>刷新注册表</Button>
      <section aria-label="本机连接器">
        <h4>{`本机连接器（${String(rows.length)}）`}</h4>
        {rows.length === 0
          ? (
            <EmptyState action={<Button id="wp13-connector-create-empty" onClick={onCreate}>新建连接器</Button>}>
              还没有登记外部连接器。连接器把外部能力接进工具目录。
            </EmptyState>
          )
          : (
            <List>
              {rows.map(({ state, record }) => (
                <Row
                  key={state.id}
                  dot={!state.enabled ? 'idle' : state.tools.length > 0 ? 'ok' : 'warn'}
                  title={state.name}
                  badge={(
                    <>
                      <Badge tone="brand">{transportLabelOf(state.transport)}</Badge>
                      <Badge tone={enabledBadgeOf(state).tone}>{enabledBadgeOf(state).label}</Badge>
                      <Badge tone={configBadge().tone}>{configBadge().label}</Badge>
                      <Badge tone={syncBadgeOf(state, syncing).tone}>{syncBadgeOf(state, syncing).label}</Badge>
                      <Badge tone={connectionBadgeOf(state).tone}>{connectionBadgeOf(state).label}</Badge>
                    </>
                  )}
                  meta={(
                    <>
                      {`${targetOf(record)} · 服务器名 ${toServerName(record.name)} · 凭据变量 ${record.credentialEnv ?? '无'}`}
                      {state.sync?.status === 'failed'
                        ? ` · ${describeSync(state.sync)}`
                        : ''}
                    </>
                  )}
                  actions={(
                    <>
                      <Button aria-label={`详情 ${state.name}`} onClick={() => onDetail(state, record)}>详情</Button>
                      <Button aria-label={`${state.enabled ? '停用' : '启用'} ${state.name}`} onClick={() => onToggle(state)}>
                        {state.enabled ? '停用' : '启用'}
                      </Button>
                      <Button aria-label={`编辑 ${state.name}`} onClick={() => onEdit(record)}>编辑</Button>
                      <Button aria-label={`删除 ${state.name}`} tone="danger" onClick={() => onDelete(state)}>删除</Button>
                    </>
                  )}
                />
              ))}
            </List>
          )}
      </section>
      <section aria-label="注册表端点">
        <h4>{`注册表端点（${String(registryServers.length)}）`}</h4>
        {registryServers.length === 0
          ? <StatusLine>控制平面没有给这台设备下发端点，或者还没有拉取过注册表。</StatusLine>
          : (
            <List>
              {registryServers.map((server) => (
                <Row
                  key={server}
                  dot="ok"
                  title={server}
                  badge={<Badge tone="brand">注册表端点</Badge>}
                  meta={`行 ${REGISTRY_ROW_PREFIX}${server} · 由控制平面下发，本机按设备决定接入；凭据值保存在本机环境`}
                />
              ))}
            </List>
          )}
      </section>
    </>
  );
}

/** 详情：配置、同步结果、连接状态、工具列表与调用测试。 */
function ConnectorDetail({ gateway, id, initialRecord, initialState, onClose, onChanged }: {
  readonly gateway: ConnectorsGateway;
  readonly id: string;
  readonly initialRecord: ConnectorRecord;
  readonly initialState: ConnectorStateView;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const [record, setRecord] = useState<ConnectorRecord>(initialRecord);
  const [state, setState] = useState<ConnectorStateView>(initialState);
  const [rows, setRows] = useState<readonly McpRowResult[] | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback((): void => {
    void Promise.all([gateway.get(id), gateway.state(id), gateway.mcpRows()]).then(
      ([nextRecord, nextState, nextRows]) => {
        setRecord(nextRecord);
        setState(nextState);
        setRows(nextRows);
        setFailure(undefined);
      },
      (error: unknown) => setFailure(error),
    );
  }, [gateway, id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const resync = (): void => {
    if (syncing) return;
    setSyncing(true);
    gateway.syncMcpRows().then(
      () => {
        setSyncing(false);
        gateway.noteAction('connector.sync', 'ok');
        refresh();
        onChanged();
      },
      (error: unknown) => {
        setSyncing(false);
        setFailure(error);
        gateway.noteAction('connector.sync', 'failed');
        refresh();
        onChanged();
      },
    );
  };

  const connection = connectionBadgeOf(state);
  const endpointRow = rows?.find((item) => item.row.serverName === toServerName(state.name));
  const endpointText = endpointRow === undefined
    ? undefined
    : `行配置 ${endpointRow.row.transport} · ${
      endpointRow.row.command === undefined
        ? endpointRow.row.url ?? '地址未填写'
        : `${endpointRow.row.command}${(endpointRow.row.args ?? []).length === 0 ? '' : ` ${(endpointRow.row.args ?? []).join(' ')}`}`
    } · 凭据变量 ${endpointRow.credentialEnv ?? '无'}`;
  return (
    <Dialog open title={`连接器 ${state.name}`} description="配置与运行结果分开显示：保存成功之后同步仍可能失败。" onClose={onClose}>
      {failure === undefined ? null : <ErrorNote>{describeFailure(failure)}</ErrorNote>}
      <section aria-label="配置">
        <h4>配置</h4>
        <StatusLine>{`传输方式 ${transportLabelOf(record.transport)} · 目标 ${targetOf(record)}`}</StatusLine>
        <StatusLine>
          {`凭据变量 ${record.credentialEnv ?? '无'}：只保存变量名，值从本机环境读取，界面不回显也不保存值。`}
        </StatusLine>
        <StatusLine>{`服务器名 ${toServerName(record.name)} · 行 ${state.rows.join('、') === '' ? '无' : state.rows.join('、')}`}</StatusLine>
        <StatusLine>
          <span id="wp13-detail-endpoint">{endpointText ?? '加载器里没有这一行：停用或同步失败时行会被移除。'}</span>
        </StatusLine>
      </section>
      <section aria-label="同步">
        <h4>加载器同步</h4>
        <StatusLine tone={state.sync?.status === 'failed' ? 'danger' : 'muted'}>
          <span id="wp13-detail-sync">{describeSync(state.sync)}</span>
        </StatusLine>
        <Button id="wp13-detail-resync" onClick={resync} disabled={syncing}>
          {syncing ? '正在同步' : '重新同步'}
        </Button>
      </section>
      <section aria-label="连接状态">
        <h4>连接状态</h4>
        <StatusLine>
          <span id="wp13-detail-connection">{connection.label}</span>
          {` · 工具 ${String(state.tools.length)} 个`}
        </StatusLine>
        {state.tools.length === 0
          ? <StatusLine>目录里没有这台服务器的工具。</StatusLine>
          : (
            <ScrollRegion label="工具列表">
              <ul id="wp13-detail-tools">
                {state.tools.map((tool) => <li key={tool}>{tool}</li>)}
              </ul>
            </ScrollRegion>
          )}
      </section>
      <ToolTest gateway={gateway} state={state} />
      <Button id="wp13-detail-close" onClick={onClose}>关闭</Button>
    </Dialog>
  );
}

/** 启用或停用的二次确认。 */
function ToggleConfirm({ gateway, state, next, onClose, onDone, onRefresh }: {
  readonly gateway: ConnectorsGateway;
  readonly state: ConnectorStateView;
  readonly next: boolean;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onRefresh: () => void;
}) {
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const action = next ? 'connector.enable' : 'connector.disable';

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    gateway.setEnabled(state.id, next).then(
      () => {
        setBusy(false);
        gateway.noteAction(action, 'ok');
        onDone();
      },
      (error: unknown) => {
        setBusy(false);
        setFailure(error);
        gateway.noteAction(action, 'failed');
        onRefresh();
      },
    );
  };

  return (
    <Dialog
      open
      title={next ? '启用连接器' : '停用连接器'}
      description={next
        ? '启用后立即同步加载器行，这台服务器的工具会重新出现在工具目录里。'
        : '停用会立即同步加载器行：这台服务器的工具从目录移除，宿主随后拒绝它的工具调用。配置与凭据变量名保留。'}
      onClose={onClose}
    >
      <p>{`${state.name}（服务器名 ${toServerName(state.name)}）`}</p>
      <StatusLine>{describeSync(state.sync)}</StatusLine>
      {failure === undefined ? null : <ErrorNote>{describeFailure(failure)}</ErrorNote>}
      <Button id="wp13-toggle-cancel" onClick={onClose}>取消</Button>
      <Button id="wp13-toggle-confirm" tone={next ? 'primary' : 'danger'} disabled={busy} onClick={confirm}>
        {busy ? '正在提交' : next ? '启用' : '停用'}
      </Button>
    </Dialog>
  );
}

/** 删除的二次确认。 */
function DeleteConfirm({ gateway, state, onClose, onDone, onRefresh }: {
  readonly gateway: ConnectorsGateway;
  readonly state: ConnectorStateView;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onRefresh: () => void;
}) {
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    gateway.remove(state.id).then(
      () => {
        setBusy(false);
        gateway.noteAction('connector.delete', 'ok');
        onDone();
      },
      (error: unknown) => {
        setBusy(false);
        setFailure(error);
        gateway.noteAction('connector.delete', 'failed');
        onRefresh();
      },
    );
  };

  return (
    <Dialog
      open
      title="删除连接器"
      description="删除移除配置并同步加载器行：这台服务器的工具从目录消失。本机环境变量与其它连接器不受影响。"
      onClose={onClose}
    >
      <p>{`${state.name}（传输方式 ${transportLabelOf(state.transport)}）`}</p>
      <StatusLine>{`工具 ${String(state.tools.length)} 个，建立于 ${formatTime(state.sync?.at ?? Date.now())}`}</StatusLine>
      {failure === undefined ? null : <ErrorNote>{describeFailure(failure)}</ErrorNote>}
      <Button id="wp13-delete-cancel" onClick={onClose}>取消</Button>
      <Button id="wp13-delete-confirm" tone="danger" disabled={busy} onClick={confirm}>
        {busy ? '正在删除' : '删除连接器'}
      </Button>
    </Dialog>
  );
}
