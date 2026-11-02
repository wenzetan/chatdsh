/**
 * 模型设置面板：提供方目录、模型清单、额度、用量与默认模型。
 *
 * 数据经宿主接口取得：`chatdshModelProviders` 给出目录、清单、额度、用量与默认模型，
 * 默认模型写入走设置服务的 `agent-default-model` 命名空间。面板只读注册信息；提供方的
 * 增删由控制平面写入配置后重启运行时生效。模型清单不支持时明确说明来源不足，不编造模型
 * 标识；首轮之后的会话模型固定，面板上写明这条规则。
 * @module @chatdsh/client-model-provider
 */

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Badge, Button, EmptyState, ErrorNote, Field, List, Panel, Row, Skeleton, StatusLine } from '@chatdsh/core-ui-kit';

import { createModelGateway, ModelCallError, type CatalogView, type ModelProviderGateway, type ProviderView, type QuotaView, type StatusView, type UsageView } from './gateway.ts';

export { createModelGateway, ModelCallError } from './gateway.ts';
export type * from './gateway.ts';

/** 设置页区段席位名，与浏览器侧共用同一个约定。 */
export const SECTION_SLOT = 'settings.section';

/** 区段标识。 */
export const SECTION_ID = 'chatdsh-model-provider';

/** 浏览器侧依赖：只等席位服务。 */
export const inject = ['slots', 'remote'];

/** 由 `apply` 装好的数据入口；区段在挂载时取用。 */
let panelGateway: ModelProviderGateway | undefined;

/** 取数据入口；没有装好时按同源接口现建一个。 */
function gatewayOf(): ModelProviderGateway {
  panelGateway ??= createModelGateway();
  return panelGateway;
}

/** 把服务状态说成一句话。 */
export function formatProviderSummary(status: StatusView): string {
  if (status.state === 'disabled') return '还没有模型提供方；部署配置注册之后这里会列出目录。';
  if (status.state === 'read-failed') {
    return `读取 ${status.errorProvider ?? '提供方'} 的模型清单失败（${status.errorCode ?? '未知错误'}）。`;
  }
  if (status.reason === 'credential-missing') return `${String(status.providers)} 个提供方已注册，凭据没有设置，调用会被拒绝。`;
  if (status.reason === 'route-unregistered') return `${String(status.providers)} 个提供方已配置，路由还没有注册到模型运行时。`;
  if (status.reason === 'catalog-unsupported') return `${String(status.providers)} 个提供方已注册；适配器没有发布模型目录。`;
  return `${String(status.providers)} 个模型提供方已注册。`;
}

/** 清单来源的说明。 */
export function formatCatalogSource(catalog: CatalogView): string {
  if (catalog.source === 'adapter') return '模型目录由适配器发布。';
  if (catalog.source === 'config') return '适配器没有发布模型目录，清单来自部署配置声明的模型，未经适配器确认。';
  return '该提供方不支持模型目录；界面不列出任何模型标识。';
}

/** 额度读数的说明。 */
export function formatQuota(quota: QuotaView): string {
  if (quota.state === 'unsupported') {
    if (quota.reason === 'router-unavailable') return '额度守卫未启用：运行时没有装载模型路由器。';
    return '该提供方的路由没有注册，额度不可读。';
  }
  const parts = [
    quota.limit === undefined ? '不限制上限' : `上限 ${String(quota.limit)}`,
    `已用 ${String(quota.used ?? 0)}`,
    quota.remaining === undefined ? '剩余不受限' : `剩余 ${String(quota.remaining)}`,
  ];
  if (quota.allowed === false) parts.push('当前拒绝原因：额度不足');
  if (quota.measuredAt !== undefined) parts.push(`读取于 ${new Date(quota.measuredAt).toLocaleString()}`);
  return parts.join('；');
}

/** 用量读数的说明。 */
export function formatUsage(usage: UsageView): string {
  const parts = [
    `输入 ${String(usage.inputTokens ?? 0)} token`,
    `输出 ${String(usage.outputTokens ?? 0)} token`,
    `请求 ${String(usage.requests ?? 0)} 次`,
  ];
  if (usage.persisted === false) parts.push('用量尚未写进存储');
  if (usage.updatedAt !== undefined) parts.push(`更新于 ${new Date(usage.updatedAt).toLocaleString()}`);
  return parts.join('；');
}

/** 提供方行的状态。 */
function availabilityBadge(provider: ProviderView) {
  if (!provider.registered) return <Badge tone="warn">路由未注册</Badge>;
  if (!provider.credential.configured) return <Badge tone="warn">凭据未设置</Badge>;
  if (!provider.available) return <Badge>不可用</Badge>;
  return <Badge tone="ok">可用</Badge>;
}

/** 默认模型编辑区。 */
function DefaultModelEditor({ gateway, providers, status, onSaved }: {
  readonly gateway: ModelProviderGateway;
  readonly providers: readonly ProviderView[];
  readonly status: StatusView;
  readonly onSaved: (selection: { provider: string; model: string; reasoningEffort?: string }) => void;
}) {
  const [provider, setProvider] = useState(status.default?.provider ?? providers[0]?.provider ?? '');
  const [model, setModel] = useState(status.default?.model ?? '');
  const [effort, setEffort] = useState(status.default?.reasoningEffort ?? '');
  const [catalog, setCatalog] = useState<CatalogView | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (provider === '') {
      setCatalog(undefined);
      return undefined;
    }
    let cancelled = false;
    gateway.models(provider).then(
      (value) => {
        if (cancelled) return;
        setCatalog(value);
        setModel((current) => current === '' && value.models[0] !== undefined ? value.models[0].id : current);
      },
      (failure: unknown) => {
        if (!cancelled) setCatalog(undefined);
        if (!cancelled) setNotice(failure instanceof ModelCallError ? `${failure.message}（${failure.code}）` : String(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [gateway, provider]);

  const efforts = useMemo(() => {
    const entry = catalog?.models.find((item) => item.id === model);
    return entry?.reasoningEfforts ?? [];
  }, [catalog, model]);

  const save = async (): Promise<void> => {
    setFailed(undefined);
    setNotice(undefined);
    try {
      const revision = await gateway.defaultRevision();
      await gateway.saveDefault({
        provider,
        model,
        ...(effort === '' ? {} : { reasoningEffort: effort }),
      }, revision);
      onSaved({ provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) });
      setNotice(`默认模型已保存：${provider} / ${model}${effort === '' ? '' : ` / ${effort}`}。新默认模型只影响之后创建的会话。`);
    } catch (failure) {
      const message = failure instanceof ModelCallError ? `${failure.message}（${failure.code}）` : String(failure);
      setFailed(message);
    }
  };

  if (providers.length === 0) {
    return <EmptyState>没有可选择的提供方；默认模型保持部署配置里的取值。</EmptyState>;
  }
  return (
    <section aria-label="默认模型" data-chdsh-default-model>
      <Field label="默认提供方" help="首轮之后会话固定 provider、model 与 preset，这里的选择只影响新建会话。">
        <select id="chdsh-model-provider" value={provider} onChange={(event: ChangeEvent<HTMLSelectElement>) => { setProvider(event.target.value); setModel(''); }}>
          {providers.map((item) => <option key={item.provider} value={item.provider}>{item.displayName}（{item.provider}）</option>)}
        </select>
      </Field>
      <Field label="默认模型" help={catalog === undefined ? '正在读取模型清单。' : formatCatalogSource(catalog)}>
        <select id="chdsh-model-name" value={model} onChange={(event: ChangeEvent<HTMLSelectElement>) => setModel(event.target.value)}>
          {model !== '' && (catalog?.models ?? []).every((item) => item.id !== model)
            ? <option value={model}>{model}（当前默认）</option>
            : null}
          {(catalog?.models ?? []).map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}{item.contextWindow === undefined ? '' : ` · 窗口 ${String(item.contextWindow)}`}
            </option>
          ))}
        </select>
      </Field>
      <Field label="推理强度" help="适配器没有披露可选强度时保持默认。">
        <select id="chdsh-model-effort" value={effort} onChange={(event: ChangeEvent<HTMLSelectElement>) => setEffort(event.target.value)}>
          <option value="">沿用模型默认</option>
          {efforts.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </Field>
      <Button tone="primary" onClick={() => { void save(); }}>保存默认模型</Button>
      {notice === undefined ? null : <StatusLine>{notice}</StatusLine>}
      {failed === undefined ? null : <ErrorNote>{failed}</ErrorNote>}
    </section>
  );
}

/** 设置页区段：提供方、模型清单、额度、用量与默认模型。 */
export function ModelProviderSection({ gateway }: { readonly gateway?: ModelProviderGateway } = {}) {
  const active = gateway ?? gatewayOf();
  const [status, setStatus] = useState<StatusView | undefined>(undefined);
  const [providers, setProviders] = useState<readonly ProviderView[] | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [catalog, setCatalog] = useState<CatalogView | undefined>(undefined);
  const [quota, setQuota] = useState<QuotaView | undefined>(undefined);
  const [usage, setUsage] = useState<UsageView | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const [detailError, setDetailError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    Promise.all([active.status(), active.list(), active.defaults()]).then(
      ([state, listed, defaults]) => {
        if (cancelled) return;
        setStatus(defaults.selection === undefined ? state : { ...state, default: defaults.selection });
        setProviders(listed);
      },
      (failure: unknown) => {
        if (!cancelled) setFailed(failure instanceof ModelCallError ? `${failure.message}（${failure.code}）` : String(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active]);

  const inspect = async (provider: string): Promise<void> => {
    setSelected(provider);
    setCatalog(undefined);
    setQuota(undefined);
    setUsage(undefined);
    setDetailError(undefined);
    try {
      const [nextCatalog, nextQuota, nextUsage] = await Promise.all([
        active.models(provider),
        active.quota(provider),
        active.usage(provider),
      ]);
      setCatalog(nextCatalog);
      setQuota(nextQuota);
      setUsage(nextUsage);
    } catch (failure) {
      setDetailError(failure instanceof ModelCallError ? `${failure.message}（${failure.code}）` : String(failure));
    }
  };

  if (failed !== undefined) {
    return <Panel title="模型设置"><StatusLine tone="danger">模型状态暂不可用：{failed}</StatusLine></Panel>;
  }
  if (status === undefined || providers === undefined) {
    return <Panel title="模型设置"><Skeleton rows={3} /></Panel>;
  }
  return (
    <Panel title="模型设置" subtitle={formatProviderSummary(status)} count={String(status.providers)}>
      <p data-chdsh-session-model-note>
        会话模型在首轮之后固定：provider、model 与 preset 不再变化，新的默认模型只影响之后创建的会话。
      </p>
      {providers.length === 0 ? (
        <EmptyState>{formatProviderSummary(status)}</EmptyState>
      ) : (
        <List>
          {providers.map((provider) => {
            const summary = status.catalog?.find((entry) => entry.provider === provider.provider);
            return (
              <Row
                key={provider.provider}
                dot={provider.available ? 'ok' : 'warn'}
                title={<>{provider.displayName} <span>· {provider.provider}</span></>}
                badge={availabilityBadge(provider)}
                meta={(
                  <>
                    端点 {provider.baseUrl === '' ? '未配置' : provider.baseUrl}；
                    凭据 {provider.credential.env === undefined ? '不需要环境变量' : `${provider.credential.env}（${provider.credential.configured ? '已设置' : '未设置'}）`}；
                    声明模型 {String(provider.declaredModels.length)} 个
                    {summary === undefined ? '' : `；清单来源 ${summary.source}`}
                  </>
                )}
                actions={<Button onClick={() => { void inspect(provider.provider); }}>{selected === provider.provider ? '重新读取' : '查看模型与额度'} {provider.provider}</Button>}
              />
            );
          })}
        </List>
      )}
      {selected === undefined ? null : (
        <section aria-label="模型清单" data-chdsh-provider-detail={selected}>
          <h4>{selected} 的模型</h4>
          {detailError !== undefined ? <StatusLine tone="danger">这个提供方的模型与额度暂时读不到：{detailError}</StatusLine> : null}
          {detailError !== undefined ? null : catalog === undefined ? <Skeleton rows={2} /> : (
            <>
              <StatusLine>{formatCatalogSource(catalog)}</StatusLine>
              {catalog.models.length === 0 ? <EmptyState>{formatCatalogSource(catalog)}</EmptyState> : (
                <List>
                  {catalog.models.map((model) => (
                    <Row
                      key={model.id}
                      title={model.name}
                      meta={(
                        <>
                          标识 {model.id}；
                          上下文 {model.contextWindow === undefined ? '适配器没有披露' : `${String(model.contextWindow)} token（来源 ${model.contextSource}）`}；
                          推理强度 {model.reasoningEfforts === undefined || model.reasoningEfforts.length === 0 ? '适配器没有披露' : model.reasoningEfforts.join('、')}
                        </>
                      )}
                    />
                  ))}
                </List>
              )}
            </>
          )}
          {detailError !== undefined || quota === undefined ? null : <p data-chdsh-quota>{formatQuota(quota)}</p>}
          {detailError !== undefined || usage === undefined ? null : <p data-chdsh-usage>{formatUsage(usage)}</p>}
        </section>
      )}
      <DefaultModelEditor
        gateway={active}
        providers={providers}
        status={status}
        onSaved={(selection) => setStatus((current) => current === undefined ? current : { ...current, default: selection })}
      />
    </Panel>
  );
}

/**
 * 注册设置页区段。
 * @param ctx - 客户端根上下文。
 */
export async function apply(ctx: { slots: ClientSlots }): Promise<void> {
  panelGateway = createModelGateway();
  ctx.slots.inject(SECTION_SLOT, () => ctx.slots.register({
    name: SECTION_SLOT,
    id: SECTION_ID,
    order: 46,
    label: () => '模型设置',
    locale: 'chatdsh.model-provider',
  }, ModelProviderSection));
}

/** 席位服务的最小形状。 */
interface ClientSlots {
  inject(key: string, callback: () => () => void): () => void;
  register(spec: { name: string; id?: string; order?: number; label?: () => string; locale?: string }, Component: () => unknown): () => void;
}
