/**
 * 白名单设置的跨设备同步。
 *
 * 单用户下设置分两类：必须按设备不同的（路径、超时、平台能力、电源策略）与应该一致的
 * （模型选择、语言、视图偏好）。这个插件只同步后者：监听本机设置变更，按白名单命名空间
 * 过滤后上报控制平面；接收控制平面推送后写进本机 home 层（`$DSH_HOME/cordis.patch.yml`）。
 *
 * 白名单是几个命名空间，不做通用合并。控制平面地址与节点令牌缺一时插件不激活——设备形态
 * 以外这是常态。
 * @module @chatdsh/host-settings-sync
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { schema as z, Service, hostWebServerOf, loaderOf, telemetryOf, UPSTREAM_CLIENT_UI, type Context } from '@chatdsh/adapter';
import { NODE_HEADERS, type ChatdshTelemetry, type TelemetrySpan } from '@chatdsh/core-contracts';

/** 插件名。 */
export const name = 'chatdsh-settings-sync';

/** 设备侧接收控制平面推送的路径。 */
export const SETTINGS_PUSH_PATH = '/chatdsh/device/settings';

/** 白名单命名空间：只有这几类设置跨设备同步。 */
export const WHITELIST = [
  'agent-default-model',
  'client-locale',
  'client-ui-chat',
  'client-product-analytics',
  'agent-preset-registry',
] as const;

/** 白名单命名空间的取值集合。 */
export type WhitelistNamespace = typeof WHITELIST[number];

/** 一份 `!!js` 表达式在解析结果里的表示，dump 时还原成同样的标量。 */
class JsExpression {
  constructor(readonly text: string) {}
}

const JsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => new JsExpression(data),
  instanceOf: JsExpression,
  represent: (value: unknown) => (value as JsExpression).text,
});

/** 读补丁文件用的模式：把 `!!js` 标量解析成表达式节点而不是报错。 */
const PATCH_SCHEMA = yaml.JSON_SCHEMA.extend([JsType]);

/** 配置。 */
export interface SettingsSyncConfig {
  /** 控制平面地址；缺省时读环境变量 `CHATDSH_CONTROL_URL`。 */
  controlUrl: string;
  /** 节点令牌；缺省时读环境变量 `CHATDSH_NODE_TOKEN`。 */
  nodeToken: string;
  /** 本设备标识，随上报一起送出。 */
  deviceId: string;
  /** 扫描设置变化的间隔，单位毫秒。 */
  scanIntervalMs: number;
}

/** 配置 schema。 */
export const Config: z<SettingsSyncConfig> = z.object({
  controlUrl: z.string().default(process.env.CHATDSH_CONTROL_URL ?? ''),
  nodeToken: z.string().default(process.env.CHATDSH_NODE_TOKEN ?? ''),
  deviceId: z.string().default(process.env.CHATDSH_DEVICE_ID ?? 'local'),
  scanIntervalMs: z.number().default(1000),
});

/** 一条补丁行。 */
interface PatchRow {
  id: string;
  name: string;
  config?: Record<string, unknown>;
}

/**
 * home 层补丁文件的读写。
 *
 * 文件是一份顶层 YAML 数组，每个元素是 `{id, name, config}` 形式的补丁行。写入按 id 合并：
 * 已有的行只更新 `config` 里被指定的字段，没有的行追加一条。
 */
export class HomeLayer {
  /** 补丁文件路径。 */
  readonly path: string;

  constructor(homeRoot: string) {
    this.path = join(homeRoot, 'cordis.patch.yml');
  }

  /** 读现有补丁行；文件不存在时返回空数组。 */
  read(): PatchRow[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, 'utf8');
    if (text.trim() === '') return [];
    const parsed = yaml.load(text, { schema: PATCH_SCHEMA });
    if (parsed === null || parsed === undefined) return [];
    if (!Array.isArray(parsed)) throw new Error(`home 层补丁不是数组：${this.path}`);
    return parsed as PatchRow[];
  }

  /**
   * 合并一组字段到某个命名空间对应的补丁行。
   * @param namespace - 白名单命名空间，用作补丁行的 id。
   * @param moduleName - 补丁行的 `name`，用于匹配上游行。
   * @param fields - 字段名到取值的映射。
   */
  merge(namespace: string, moduleName: string, fields: Record<string, unknown>): void {
    const rows = this.read();
    let row = rows.find((entry) => entry.id === namespace);
    if (row === undefined) {
      row = { id: namespace, name: moduleName, config: {} };
      rows.push(row);
    }
    row.config = { ...(row.config ?? {}), ...fields };
    mkdirSync(join(this.path, '..'), { recursive: true });
    writeFileSync(this.path, yaml.dump(rows, { schema: PATCH_SCHEMA, lineWidth: -1 }), 'utf8');
  }
}

/** 设置服务的最小读取面：按命名空间取当前生效值。 */
interface SettingsReader {
  describe(options?: { redactSecrets?: boolean }): readonly { ns: string; value: unknown }[];
}

/**
 * 设置同步服务。
 *
 * 上报与下发两个方向都不阻塞会话：上报按 `loader/config-update` 触发，只推与上次不同的
 * 字段；下发写 home 层，不触发本机的设置写入事件，因此不会形成回声。
 */
export class ChatdshSettingsSyncService extends Service {
  /** 依赖本地 HTTP 服务（接收推送）与加载器（取命名空间对应的上游模块名）。 */
  static inject = ['webServer', 'loader'];

  /** 配置 schema。 */
  static Config: z<SettingsSyncConfig> = Config;

  private readonly home: HomeLayer;
  /** 每个命名空间上一次上报或收到时的字段快照，用于去重与防止回声。 */
  private readonly known = new Map<string, Record<string, string>>();
  private active = false;

  constructor(ctx: Context, private readonly config: SettingsSyncConfig) {
    super(ctx, name);
    this.home = new HomeLayer(process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  }

  /** 配置齐全时开始同步并注册接收端点。 */
  async [Service.init](): Promise<void> {
    if (this.config.controlUrl === '' || this.config.nodeToken === '') return;
    this.active = true;
    this.captureBaseline();

    const release = hostWebServerOf(this.ctx).register({
      kind: 'exact',
      path: SETTINGS_PUSH_PATH,
      handler: (request, response) => {
        void this.receive(request).then((result) => {
          const body = JSON.stringify(result);
          response.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
          response.end(body);
        }, (error: unknown) => {
          const body = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
          response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
          response.end(body);
        });
      },
    });
    this.ctx.effect(() => () => release(), `${name}/push-endpoint`);

    this.ctx.on('loader/config-update', () => {
      void this.report().catch(() => undefined);
    });
    // 易变字段（例如 agent-default-model 的 provider/model）在运行中直接提交给活动 fiber，
    // 不触发 config-update；这一支也监听到。
    this.ctx.on('loader/volatile-update', () => {
      void this.report().catch(() => undefined);
    });
    // loader 事件只在装配路径触发；远程设置写入走设置服务，未必经过这两条事件。再按间隔
    // 扫一次，比对快照，把差异推上去，保证任何来源的白名单变更都能同步出去。
    const timer = setInterval(() => {
      void this.report().catch(() => undefined);
    }, this.config.scanIntervalMs);
    timer.unref();
    this.ctx.effect(() => () => clearInterval(timer), `${name}/scan`);
  }

  /** 记录起点快照：初始化时只建立基线，不把现有设置当成变更推一遍。 */
  private captureBaseline(): void {
    for (const descriptor of this.describe()) {
      this.known.set(descriptor.ns, this.fieldsOf(descriptor.value));
    }
  }

  /** 取设置服务的描述；没有设置服务时返回空。 */
  private describe(): readonly { ns: string; value: unknown }[] {
    const settings = this.ctx.reflect.get('settings') as SettingsReader | undefined;
    if (settings === undefined) return [];
    try {
      return settings.describe({ redactSecrets: true });
    } catch {
      return [];
    }
  }

  /** 把一个命名空间的配置值摊平成 `字段名 → 序列化文本`。 */
  private fieldsOf(value: unknown): Record<string, string> {
    if (typeof value !== 'object' || value === null) return {};
    const out: Record<string, string> = {};
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      out[key] = JSON.stringify(field);
    }
    return out;
  }

  /** 扫描白名单命名空间，把与上次不同的字段上报控制平面。 */
  private async report(): Promise<void> {
    if (!this.active) return;
    const telemetry = telemetryOf<ChatdshTelemetry>(this.ctx);
    const whitelist = new Set<string>(WHITELIST);
    for (const descriptor of this.describe()) {
      if (!whitelist.has(descriptor.ns)) continue;
      const next = this.fieldsOf(descriptor.value);
      const previous = this.known.get(descriptor.ns) ?? {};
      for (const [key, value] of Object.entries(next)) {
        if (previous[key] === value) continue;
        await this.pushField(descriptor.ns, key, value, telemetry);
      }
      this.known.set(descriptor.ns, next);
    }
  }

  /** 上报一个字段；失败只记事件，不抛出。 */
  private async pushField(namespace: string, key: string, value: string, telemetry: ChatdshTelemetry | undefined): Promise<void> {
    const run = async (span: TelemetrySpan | undefined): Promise<void> => {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          [NODE_HEADERS.id]: this.config.deviceId,
          authorization: `Bearer ${this.config.nodeToken}`,
        };
        const response = await fetch(`${this.config.controlUrl}/chatdsh/gateway/settings`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ namespace, key, value }),
        });
        if (!response.ok) {
          span?.setAttribute('outcome', 'rejected');
          telemetry?.event('chatdsh.sync.settings.rejected', { outcome: 'rejected', 'error.code': `http-${response.status}` });
          telemetry?.counter('chatdsh_sync_settings_pushes_total', { description: '设置上报次数' }).add(1, { outcome: 'rejected' });
          return;
        }
        span?.setAttribute('outcome', 'pushed');
        telemetry?.counter('chatdsh_sync_settings_pushes_total', { description: '设置上报次数' }).add(1, { outcome: 'pushed' });
      } catch (error) {
        span?.recordException(error);
        span?.setAttribute('outcome', 'unreachable');
        telemetry?.event('chatdsh.sync.settings.failed', { outcome: 'failed', 'error.type': error instanceof Error ? error.name : 'Unknown' });
        telemetry?.counter('chatdsh_sync_settings_pushes_total', { description: '设置上报次数' }).add(1, { outcome: 'unreachable' });
      }
    };
    if (telemetry === undefined) {
      await run(undefined);
      return;
    }
    await telemetry.runSpan('chatdsh.sync.settings.push', { namespace, key }, (span) => run(span));
  }

  /** 接收控制平面推送，写 home 层；返回结果。 */
  private async receive(request: { on(event: string, listener: (chunk: Buffer) => void): void; on(event: string, listener: () => void): void }): Promise<{ ok: boolean; error?: string }> {
    const telemetry = telemetryOf<ChatdshTelemetry>(this.ctx);
    const body = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    let payload: { namespace?: unknown; key?: unknown; value?: unknown };
    try {
      payload = JSON.parse(body) as { namespace?: unknown; key?: unknown; value?: unknown };
    } catch {
      return { ok: false, error: 'invalid-json' };
    }
    if (typeof payload.namespace !== 'string' || typeof payload.key !== 'string' || typeof payload.value !== 'string') {
      return { ok: false, error: 'invalid-payload' };
    }
    const whitelist = new Set<string>(WHITELIST);
    if (!whitelist.has(payload.namespace)) {
      telemetry?.event('chatdsh.sync.settings.rejected', { outcome: 'rejected', 'error.code': 'namespace-not-whitelisted' });
      return { ok: false, error: 'namespace-not-whitelisted' };
    }
    const apply = async (span: TelemetrySpan | undefined): Promise<{ ok: boolean }> => {
      const field = JSON.parse(payload.value as string) as unknown;
      const moduleName = this.moduleNameOf(payload.namespace as string);
      this.home.merge(payload.namespace as string, moduleName, { [payload.key as string]: field });
      // 记进已知快照，避免 http 回写后若触发扫描把同一值再推回去。
      const snapshot = this.known.get(payload.namespace as string) ?? {};
      snapshot[payload.key as string] = payload.value as string;
      this.known.set(payload.namespace as string, snapshot);
      span?.setAttribute('outcome', 'applied');
      telemetry?.counter('chatdsh_sync_settings_applies_total', { description: '设置下发次数' }).add(1, { outcome: 'applied' });
      return { ok: true };
    };
    if (telemetry === undefined) return apply(undefined);
    return telemetry.runSpan('chatdsh.sync.settings.apply', { namespace: payload.namespace, key: payload.key }, (span) => apply(span));
  }

  /** 取一个命名空间对应的上游模块名：先查活动的 loader 行，再用登记表。 */
  private moduleNameOf(namespace: string): string {
    for (const entry of loaderOf(this.ctx).entries()) {
      if (entry.id === namespace) return entry.options.name;
    }
    const registry: Record<string, string> = {
      'agent-default-model': UPSTREAM_CLIENT_UI.agentDefaultModel,
      'client-locale': UPSTREAM_CLIENT_UI.locale,
      'client-ui-chat': UPSTREAM_CLIENT_UI.chat,
      'client-product-analytics': UPSTREAM_CLIENT_UI.productAnalytics,
      'agent-preset-registry': UPSTREAM_CLIENT_UI.presetRegistry,
    };
    return registry[namespace] ?? namespace;
  }
}

export { ChatdshSettingsSyncService as default };
