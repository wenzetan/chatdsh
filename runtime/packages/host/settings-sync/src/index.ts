/**
 * 白名单设置的跨设备同步。
 *
 * 单用户下设置分两类：必须按设备不同的（路径、电源、超时、平台能力）与应该一致的
 * （模型选择、语言、视图偏好）。这个插件只同步后者：监听本机设置变更，按白名单字段
 * 过滤后上报控制平面；接收控制平面推送与轮询快照后写进本机 home 层
 * （`$DSH_HOME/cordis.patch.yml`）。
 *
 * 冲突用最后写入者胜，时间取控制平面的接收时刻。字段来源、有效值、作用范围与作用设备由
 * `/chatdsh/device/settings/form` 读出；写入携带表单版本，版本落后时拒绝并返回最新版本与
 * 当前值。控制平面地址与节点令牌缺一时插件不激活——设备形态以外这是常态。
 * @module @chatdsh/host-settings-sync
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { schema as z, Service, hostWebServerOf, telemetryOf, UPSTREAM_CLIENT_UI, type Context } from '@chatdsh/adapter';
import { NODE_HEADERS, settingsWriteResultSchema, type ChatdshTelemetry } from '@chatdsh/core-contracts';
import { SettingsForm, type SettingsDescriptorView } from './form.ts';
import { HomeLayer } from './home.ts';
import { DEVICE_FIELD_KEYWORDS, DEVICE_FIELDS, fieldsOfNamespace, isSyncField, isSyncNamespace, SYNC_FIELDS, SYNC_NAMESPACES } from './scope.ts';
import { adopts, sameValue, SettingsSyncStore, textOf, type DeviceRecord, type FieldRecord, type SyncState } from './state.ts';
import { SettingsTelemetry } from './telemetry.ts';

export { HomeLayer };
export { SettingsForm } from './form.ts';
export { SettingsSyncStore } from './state.ts';
export { DEVICE_FIELDS, SYNC_FIELDS, SYNC_NAMESPACES } from './scope.ts';

/** 插件名。 */
export const name = 'chatdsh-settings-sync';

/** 设备侧接收控制平面推送的路径。 */
export const SETTINGS_PUSH_PATH = '/chatdsh/device/settings';

/** 设备侧读写设置表单的路径。 */
export const SETTINGS_FORM_PATH = '/chatdsh/device/settings/form';

/** 设备侧读取最新版本的路径。 */
export const SETTINGS_LATEST_PATH = '/chatdsh/device/settings/latest';

/** 设备侧读取作用范围的路径。 */
export const SETTINGS_SCOPES_PATH = '/chatdsh/device/settings/scopes';

/** 设备侧读取同步状态的路径。 */
export const SETTINGS_SYNC_PATH = '/chatdsh/device/settings/sync';

/** 白名单命名空间：只有这几类设置跨设备同步。 */
export const WHITELIST = SYNC_NAMESPACES;

/** 白名单命名空间的取值集合。 */
export type WhitelistNamespace = typeof SYNC_NAMESPACES[number];

/** 配置。 */
export interface SettingsSyncConfig {
  /** 控制平面地址；缺省时读环境变量 `CHATDSH_CONTROL_URL`。 */
  controlUrl: string;
  /** 节点令牌；缺省时读环境变量 `CHATDSH_NODE_TOKEN`。 */
  nodeToken: string;
  /** 本设备标识，随上报一起送出。 */
  deviceId: string;
  /** 扫描本地设置与控制平面快照的间隔，单位毫秒。 */
  scanIntervalMs: number;
}

/** 配置 schema。 */
export const Config: z<SettingsSyncConfig> = z.object({
  controlUrl: z.string().default(process.env.CHATDSH_CONTROL_URL ?? ''),
  nodeToken: z.string().default(process.env.CHATDSH_NODE_TOKEN ?? ''),
  deviceId: z.string().default(process.env.CHATDSH_DEVICE_ID ?? 'local'),
  scanIntervalMs: z.number().default(1000),
});

/** 设置服务的读取面：按命名空间取生效值、用户层与版本。 */
interface SettingsReader {
  describe(options?: { redactSecrets?: boolean }): readonly SettingsDescriptorView[];
}

/** 加载器的最小读取面：取活动条目的模块名。 */
interface LoaderReader {
  entries(): Iterable<{ id: string; options: { name: string } }>;
}

/** 控制平面快照里的一行设置。 */
interface SnapshotRow {
  key: string;
  value: string;
  updatedAt: number;
}

/** 上层模块名登记表：加载器里没有对应行时使用。 */
const MODULE_NAMES: Record<string, string> = {
  'agent-default-model': UPSTREAM_CLIENT_UI.agentDefaultModel,
  'client-locale': UPSTREAM_CLIENT_UI.locale,
  'client-ui-chat': UPSTREAM_CLIENT_UI.chat,
  'client-product-analytics': UPSTREAM_CLIENT_UI.productAnalytics,
  'agent-preset-registry': UPSTREAM_CLIENT_UI.presetRegistry,
};

/** 取一个取值对象的字段表；非对象时返回空表。 */
function fieldsOfValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** 读一个 JSON 请求体。 */
async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error('请求体超过上限');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  return JSON.parse(text) as unknown;
}

/** 写一个 JSON 应答。 */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  response.end(text);
}

/**
 * 设置同步服务。
 *
 * 上报、轮询与下发三个方向都串行执行，写 home 层与合并记录在同一个原子步骤里完成：先写
 * home 层再改记录，home 层写失败时记录保持原样，下一轮重试。上报与轮询都不阻塞会话。
 */
export class ChatdshSettingsSyncService extends Service {
  /** 依赖本地 HTTP 服务（接收推送与提供表单接口）。 */
  static inject = ['webServer'];

  /** 配置 schema。 */
  static Config: z<SettingsSyncConfig> = Config;

  private readonly home: HomeLayer;
  private readonly store: SettingsSyncStore;
  private readonly form: SettingsForm;
  private state: SyncState | undefined;
  /** 每个命名空间上一次观察到的设置服务取值，用于识别本机变更与避免回声。 */
  private readonly observed = new Map<string, Map<string, string>>();
  private queue: Promise<unknown> = Promise.resolve();
  private recorder: SettingsTelemetry | undefined;
  /** 每类拉取失败最近一次上报的取值，用于连续失败去重。 */
  private readonly reported = new Map<string, string>();
  private active = false;
  private scanScheduled = false;

  constructor(ctx: Context, private readonly config: SettingsSyncConfig) {
    super(ctx, name);
    const homeRoot = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    this.home = new HomeLayer(homeRoot);
    this.store = new SettingsSyncStore(homeRoot, config.deviceId);
    this.form = new SettingsForm({
      store: this.store,
      deviceId: config.deviceId,
      describe: () => this.describe(),
      homeFields: (namespace) => this.home.fieldsOf(namespace),
    });
  }

  /** 遥测记录器，按需取当前的遥测出口。 */
  private get telemetry(): SettingsTelemetry {
    if (this.recorder === undefined) this.recorder = new SettingsTelemetry(telemetryOf<ChatdshTelemetry>(this.ctx));
    return this.recorder;
  }

  /** 配置齐全时载入记录、继承控制平面设置并注册接口。 */
  async [Service.init](): Promise<void> {
    if (this.config.controlUrl === '' || this.config.nodeToken === '') return;
    this.active = true;
    this.state = this.store.load();
    this.captureObserved();
    await this.exclusive(async () => {
      await this.pull();
      await this.refreshDevices();
      this.refreshFiltered();
      this.persist();
    });
    this.registerRoutes();

    this.ctx.on('loader/config-update', () => {
      void this.scan().catch((error: unknown) => this.telemetry.failed(error instanceof Error ? error.name : 'Unknown'));
    });
    // 易变字段（例如 agent-default-model 的 provider/model）在运行中直接提交给活动 fiber，
    // 不触发 config-update；这一支也监听到。
    this.ctx.on('loader/volatile-update', () => {
      void this.scan().catch((error: unknown) => this.telemetry.failed(error instanceof Error ? error.name : 'Unknown'));
    });
    // loader 事件只在装配路径触发；远程设置写入走设置服务，未必经过这两条事件。再按间隔
    // 扫一次，把本机变更上报并把控制平面的新值拉下来，保证任何来源都收敛到同一份记录。
    const timer = setInterval(() => {
      void this.scan().catch((error: unknown) => this.telemetry.failed(error instanceof Error ? error.name : 'Unknown'));
    }, this.config.scanIntervalMs);
    timer.unref();
    this.ctx.effect(() => () => clearInterval(timer), `${name}/scan`);
  }

  /** 记录起点观察值：初始化时只建立基线，不把现有设置当成变更推一遍。 */
  private captureObserved(): void {
    for (const descriptor of this.describe()) {
      const snapshot = new Map<string, string>();
      for (const [field, value] of Object.entries(fieldsOfValue(descriptor.value))) {
        if (value !== undefined) snapshot.set(field, textOf(value));
      }
      this.observed.set(descriptor.ns, snapshot);
    }
  }

  /** 取设置服务的描述；没有设置服务时返回空。 */
  private describe(): readonly SettingsDescriptorView[] {
    const settings = this.ctx.reflect.get('settings') as SettingsReader | undefined;
    if (settings === undefined) return [];
    return settings.describe({ redactSecrets: true });
  }

  /** 取一个命名空间对应的上游模块名：先查活动的加载器行，再用登记表。 */
  private moduleNameOf(namespace: string): string {
    const loader = this.ctx.reflect.get('loader') as LoaderReader | undefined;
    if (loader !== undefined) {
      for (const entry of loader.entries()) {
        if (entry.id === namespace) return entry.options.name;
      }
    }
    return MODULE_NAMES[namespace] ?? namespace;
  }

  /** 串行执行一次会改动记录的任务。 */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 取已经载入的同步记录。 */
  private requireState(): SyncState {
    if (this.state === undefined) throw new Error('同步记录尚未载入');
    return this.state;
  }

  /** 写回同步记录。 */
  private persist(): void {
    this.store.save(this.requireState());
  }

  /** 一轮扫描：上报本机变更、拉取控制平面快照、刷新设备列表与被过滤字段统计。 */
  private async scan(): Promise<void> {
    if (!this.active || this.scanScheduled) return;
    this.scanScheduled = true;
    try {
      await this.exclusive(async () => {
        await this.pushLocalChanges();
        await this.pull();
        await this.refreshDevices();
        this.refreshFiltered();
        this.persist();
      });
    } finally {
      this.scanScheduled = false;
    }
  }

  /** 把本机改过的白名单字段上报控制平面。 */
  private async pushLocalChanges(): Promise<void> {
    const state = this.requireState();
    for (const descriptor of this.describe()) {
      const namespace = descriptor.ns;
      if (!isSyncNamespace(namespace)) continue;
      const observed = this.observed.get(namespace) ?? new Map<string, string>();
      for (const [field, value] of Object.entries(fieldsOfValue(descriptor.value))) {
        if (!isSyncField(namespace, field) || value === undefined) continue;
        const text = textOf(value);
        if (observed.get(field) === text) continue;
        const record = state.namespaces[namespace]?.fields[field];
        if (record !== undefined && sameValue(record.value, value)) {
          observed.set(field, text);
          continue;
        }
        const receipt = await this.pushField(namespace, field, value);
        if (receipt === undefined) continue;
        this.form.commit(state, namespace, { [field]: { value, updatedAt: receipt, source: 'device' } });
        observed.set(field, text);
        this.persist();
      }
      this.observed.set(namespace, observed);
    }
  }

  /** 上报一个字段；返回控制平面的接收时刻，失败时返回空。 */
  private async pushField(namespace: string, key: string, value: unknown): Promise<number | undefined> {
    const telemetry = this.telemetry;
    return telemetry.push(namespace, key, async (span) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        [NODE_HEADERS.id]: this.config.deviceId,
        authorization: `Bearer ${this.config.nodeToken}`,
        ...telemetry.carrierOf(),
      };
      let response: Response;
      try {
        response = await fetch(`${this.config.controlUrl}/chatdsh/gateway/settings`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ namespace, key, value: textOf(value) }),
        });
      } catch (error) {
        span?.recordException(error);
        telemetry.pushOutcome(span, 'unreachable');
        telemetry.failed(error instanceof Error ? error.name : 'Unknown');
        return undefined;
      }
      if (!response.ok) {
        telemetry.pushOutcome(span, 'rejected');
        telemetry.rejected(`http-${response.status}`);
        return undefined;
      }
      const body = (await response.json()) as { updatedAt?: unknown };
      if (typeof body.updatedAt !== 'number' || !Number.isInteger(body.updatedAt)) {
        telemetry.pushOutcome(span, 'rejected');
        telemetry.rejected('invalid-receipt');
        return undefined;
      }
      telemetry.pushOutcome(span, 'pushed');
      return body.updatedAt;
    });
  }

  /** 拉取控制平面快照并按接收时刻合并。 */
  private async pull(): Promise<void> {
    const state = this.requireState();
    const snapshot = await this.fetchSnapshot();
    if (snapshot === undefined) return;
    for (const [namespace, rows] of Object.entries(snapshot)) {
      if (!isSyncNamespace(namespace)) continue;
      for (const row of rows) {
        if (!isSyncField(namespace, row.key)) continue;
        const parsed = this.parseRemoteValue(row.value);
        if (parsed === undefined) continue;
        const entry: FieldRecord = { value: parsed, updatedAt: row.updatedAt, source: 'control-plane' };
        await this.applyRemote(state, namespace, row.key, entry);
      }
    }
  }

  /** 解析控制平面存下的取值文本。 */
  private parseRemoteValue(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      this.telemetry.failed(error instanceof Error ? error.name : 'Unknown');
      return undefined;
    }
  }

  /** 应用一个字段：先写 home 层再合并记录，写入失败时记录保持原样。 */
  private async applyRemote(state: SyncState, namespace: string, field: string, entry: FieldRecord): Promise<void> {
    const current = state.namespaces[namespace]?.fields[field];
    if (!adopts(current, entry)) return;
    const telemetry = this.telemetry;
    await telemetry.apply(namespace, field, async (span) => {
      this.home.merge(namespace, this.moduleNameOf(namespace), { [field]: entry.value });
      this.form.commit(state, namespace, { [field]: entry });
      telemetry.applyOutcome(span, 'applied');
    });
  }

  /** 读控制平面的白名单设置快照。 */
  private async fetchSnapshot(): Promise<Record<string, SnapshotRow[]> | undefined> {
    const telemetry = this.telemetry;
    const headers: Record<string, string> = {
      [NODE_HEADERS.id]: this.config.deviceId,
      authorization: `Bearer ${this.config.nodeToken}`,
      ...telemetry.carrierOf(),
    };
    try {
      const response = await fetch(`${this.config.controlUrl}/chatdsh/gateway/settings`, { headers });
      if (!response.ok) {
        this.reportFailure('snapshot', 'rejected', `http-${response.status}`);
        return undefined;
      }
      const body = (await response.json()) as { namespaces?: unknown };
      if (typeof body.namespaces !== 'object' || body.namespaces === null) {
        this.reportFailure('snapshot', 'failed', 'ProtocolError');
        return undefined;
      }
      this.reported.delete('snapshot');
      return body.namespaces as Record<string, SnapshotRow[]>;
    } catch (error) {
      this.reportFailure('snapshot', 'failed', error instanceof Error ? error.name : 'Unknown');
      return undefined;
    }
  }

  /**
   * 记录一次拉取失败，连续相同的失败只记一条。
   *
   * 控制平面长时间不可达时每一轮扫描都会失败；按通道去重避免同一原因的重复事件淹没查询
   * 结果，恢复成功后清掉记录，下次失败重新记。
   * @param channel - 失败所在的通道。
   * @param kind - 任务被拒绝还是传输失败。
   * @param code - 错误码或异常类型。
   */
  private reportFailure(channel: string, kind: 'rejected' | 'failed', code: string): void {
    const key = `${kind}:${code}`;
    if (this.reported.get(channel) === key) return;
    this.reported.set(channel, key);
    if (kind === 'rejected') this.telemetry.rejected(code);
    else this.telemetry.failed(code);
  }

  /** 刷新控制平面登记的设备列表，供作用设备列表使用。 */
  private async refreshDevices(): Promise<void> {
    const state = this.requireState();
    const telemetry = this.telemetry;
    const headers: Record<string, string> = {
      [NODE_HEADERS.id]: this.config.deviceId,
      authorization: `Bearer ${this.config.nodeToken}`,
      ...telemetry.carrierOf(),
    };
    try {
      const response = await fetch(`${this.config.controlUrl}/chatdsh/gateway/devices`, { headers });
      if (!response.ok) {
        this.reportFailure('devices', 'rejected', `http-${response.status}`);
        return;
      }
      const body = (await response.json()) as { devices?: unknown };
      if (!Array.isArray(body.devices)) {
        this.reportFailure('devices', 'failed', 'ProtocolError');
        return;
      }
      const devices: DeviceRecord[] = [];
      for (const entry of body.devices as { id?: unknown; name?: unknown; platform?: unknown; online?: unknown }[]) {
        if (typeof entry.id !== 'string') continue;
        devices.push({
          deviceId: entry.id,
          name: typeof entry.name === 'string' ? entry.name : entry.id,
          platform: typeof entry.platform === 'string' ? entry.platform : 'unknown',
          online: entry.online === true,
        });
      }
      state.devices = devices;
      state.devicesAt = Date.now();
      this.reported.delete('devices');
    } catch (error) {
      this.reportFailure('devices', 'failed', error instanceof Error ? error.name : 'Unknown');
    }
  }

  /** 统计不参与同步的字段数量：白名单之外命名空间的全部字段，与白名单命名空间里白名单之外的字段。 */
  private refreshFiltered(): void {
    const state = this.requireState();
    const byNamespace: Record<string, number> = {};
    const count = (namespace: string, fields: readonly string[]): void => {
      let filtered = 0;
      for (const field of fields) {
        const sync = isSyncNamespace(namespace) && isSyncField(namespace, field);
        if (!sync) filtered += 1;
      }
      if (filtered > 0) byNamespace[namespace] = (byNamespace[namespace] ?? 0) + filtered;
    };
    for (const descriptor of this.describe()) count(descriptor.ns, Object.keys(fieldsOfValue(descriptor.value)));
    for (const row of this.home.read()) count(row.id, Object.keys(row.config ?? {}));
    const total = Object.values(byNamespace).reduce((sum, value) => sum + value, 0);
    state.filtered = { total, byNamespace, at: Date.now() };
  }

  /** 注册表单、最新版本、作用范围、同步状态与推送接收五条路由。 */
  private registerRoutes(): void {
    this.register(SETTINGS_FORM_PATH, async (request, response) => {
      if (request.method === 'GET') {
        const namespace = new URL(request.url ?? SETTINGS_FORM_PATH, 'http://local').searchParams.get('ns') ?? '';
        const view = this.form.read(this.requireState(), namespace);
        if (view === undefined) {
          sendJson(response, 404, { error: 'object-not-found' });
          return;
        }
        sendJson(response, 200, view);
        return;
      }
      if (request.method === 'POST') {
        await this.writeForm(request, response);
        return;
      }
      sendJson(response, 405, { error: 'method-not-allowed' });
    });

    this.register(SETTINGS_LATEST_PATH, async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      const namespace = new URL(request.url ?? SETTINGS_LATEST_PATH, 'http://local').searchParams.get('ns') ?? '';
      const latest = this.form.latest(this.requireState(), namespace);
      if (latest === undefined) {
        sendJson(response, 404, { error: 'object-not-found' });
        return;
      }
      sendJson(response, 200, latest);
    });

    this.register(SETTINGS_SCOPES_PATH, async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      sendJson(response, 200, { namespaces: scopeTable(), deviceFieldKeywords: DEVICE_FIELD_KEYWORDS });
    });

    this.register(SETTINGS_SYNC_PATH, async (request, response) => {
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      sendJson(response, 200, this.syncStatus());
    });

    this.register(SETTINGS_PUSH_PATH, async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method-not-allowed' });
        return;
      }
      const result = await this.receive(request);
      sendJson(response, result.status, result.body);
    });
  }

  /** 注册一条精确路径的路由。 */
  private register(path: string, handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): void {
    const release = hostWebServerOf(this.ctx).register({ kind: 'exact', path, handler });
    this.ctx.effect(() => () => release(), `${name}${path}`);
  }

  /** 同步状态：白名单、各命名空间版本、设备列表与被过滤字段统计。 */
  private syncStatus(): Record<string, unknown> {
    const state = this.requireState();
    const namespaces: Record<string, unknown> = {};
    for (const [namespace, record] of Object.entries(state.namespaces)) {
      namespaces[namespace] = {
        revision: record.revision,
        updatedAt: record.updatedAt,
        fields: Object.entries(record.fields).map(([field, entry]) => ({
          field,
          source: entry.source,
          updatedAt: entry.updatedAt,
        })),
      };
    }
    return {
      deviceId: this.config.deviceId,
      whitelist: { namespaces: SYNC_NAMESPACES, fields: SYNC_FIELDS, deviceFields: DEVICE_FIELDS },
      namespaces,
      devices: state.devices,
      devicesAt: state.devicesAt,
      filtered: state.filtered,
    };
  }

  /** 处理一次表单写入。 */
  private async writeForm(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const telemetry = this.telemetry;
    const payload = (await readJson(request, 64 * 1024)) as { namespace?: unknown; revision?: unknown; fields?: unknown } | undefined;
    if (payload === undefined || typeof payload.namespace !== 'string' || payload.namespace === '') {
      telemetry.pushOutcome(undefined, 'rejected');
      telemetry.rejected('request-invalid');
      sendJson(response, 400, { ...settingsWriteResultSchema.parse({ outcome: 'rejected', code: 'request-invalid' }), reason: 'namespace-invalid' });
      return;
    }
    const namespace = payload.namespace;
    const revision = payload.revision;
    const fields = payload.fields;
    await this.exclusive(async () => {
      const state = this.requireState();
      const check = this.form.check(state, namespace, revision, fields);
      if (!check.ok) {
        const reason = typeof check.body.reason === 'string' ? check.body.reason : undefined;
        const outcome = check.status === 409 ? 'conflict' : 'rejected';
        telemetry.pushOutcome(undefined, outcome);
        telemetry.rejected(reason ?? (outcome === 'conflict' ? 'revision-conflict' : 'request-invalid'));
        sendJson(response, check.status, check.body);
        return;
      }
      const receipts: Record<string, FieldRecord> = {};
      for (const [field, value] of Object.entries(check.fields)) {
        const receipt = await this.pushField(namespace, field, value);
        if (receipt === undefined) {
          sendJson(response, 502, { ...settingsWriteResultSchema.parse({ outcome: 'rejected', code: 'internal-error' }), reason: 'control-plane-unreachable' });
          return;
        }
        receipts[field] = { value, updatedAt: receipt, source: 'device' };
      }
      for (const [field, entry] of Object.entries(receipts)) {
        await telemetry.apply(namespace, field, async (span) => {
          this.home.merge(namespace, this.moduleNameOf(namespace), { [field]: entry.value });
          telemetry.applyOutcome(span, 'applied');
        });
      }
      const committed = this.form.commit(state, namespace, receipts);
      this.persist();
      const applied = settingsWriteResultSchema.parse({
        outcome: 'applied',
        revision: committed.revision,
        fields: Object.keys(receipts),
      });
      sendJson(response, 200, { ...applied, values: this.form.latest(state, namespace)?.values ?? {} });
    });
  }

  /** 接收控制平面推送，写 home 层；返回应答状态与应答体。 */
  private async receive(request: IncomingMessage): Promise<{ status: number; body: Record<string, unknown> }> {
    const telemetry = this.telemetry;
    const payload = (await readJson(request, 64 * 1024)) as { namespace?: unknown; key?: unknown; value?: unknown; updatedAt?: unknown } | undefined;
    if (payload === undefined || typeof payload.namespace !== 'string' || payload.namespace === '' || typeof payload.key !== 'string' || payload.key === '' || typeof payload.value !== 'string') {
      telemetry.rejected('invalid-payload');
      return { status: 400, body: { ok: false, error: 'invalid-payload' } };
    }
    if (typeof payload.updatedAt !== 'number' || !Number.isInteger(payload.updatedAt)) {
      telemetry.rejected('invalid-receipt');
      return { status: 400, body: { ok: false, error: 'invalid-receipt' } };
    }
    if (!isSyncNamespace(payload.namespace)) {
      telemetry.rejected('namespace-not-whitelisted');
      return { status: 400, body: { ok: false, error: 'namespace-not-whitelisted' } };
    }
    if (!isSyncField(payload.namespace, payload.key)) {
      telemetry.rejected('field-not-whitelisted');
      return { status: 400, body: { ok: false, error: 'field-not-whitelisted' } };
    }
    const parsed = this.parseRemoteValue(payload.value);
    if (parsed === undefined) {
      telemetry.rejected('invalid-value');
      return { status: 400, body: { ok: false, error: 'invalid-value' } };
    }
    const namespace = payload.namespace;
    const field = payload.key;
    const entry: FieldRecord = { value: parsed, updatedAt: payload.updatedAt, source: 'control-plane' };
    return this.exclusive(async () => {
      const state = this.requireState();
      await this.applyRemote(state, namespace, field, entry);
      this.persist();
      const record = state.namespaces[namespace];
      return {
        status: 200,
        body: { ok: true, namespace, key: field, revision: record?.revision ?? 0 },
      };
    });
  }
}

/** 作用范围表：白名单命名空间的同步字段与设备范围字段。 */
function scopeTable(): { namespace: string; scope: 'client' | 'device'; fields: { field: string; scope: 'client' | 'device'; synced: boolean }[] }[] {
  const names = new Set<string>([...SYNC_NAMESPACES, ...Object.keys(DEVICE_FIELDS)]);
  return [...names].map((namespace) => ({
    namespace,
    scope: isSyncNamespace(namespace) ? 'client' : 'device',
    fields: fieldsOfNamespace(namespace),
  }));
}

export { ChatdshSettingsSyncService as default };
