/**
 * 主题插件浏览器侧入口：把界面基础设计带给上游界面。
 *
 * 三件事：注入令牌与映射样式，让上游外壳与自建面板共用同一套画布、分层、字号与状态色；
 * 向 `ctx.theme` 注册一个可被用户选择的 `chatdsh` 主题，主题的令牌覆盖与样式来自同一份
 * 设计取值；订阅主题服务的 `theme/change`，每次生效主题或配色基线变化时上报一条日志、
 * 一个 span 与一个计数器。注册本身不改动用户当前的配色偏好，只在用户主动切换时生效。
 * @module @chatdsh/client-theme
 */

import { installThemeStyles } from './apply-styles.ts';

/** 浏览器侧依赖：只要主题服务与席位服务，模块加载顺序由模块图保证。 */
export const inject = ['theme', 'slots'];

/** 注册到主题目录的标识。 */
export const THEME_ID = 'chatdsh';

/** 上报遥测的同源中继端点。 */
const RELAY_PATH = '/chatdsh/telemetry/browser';

/** 中继要求的来源校验头；跨站表单无法携带自定义头。 */
const CSRF_HEADER = 'x-chatdsh-csrf';

/** 本插件在遥测规范里的 instrumentation scope。 */
const SCOPE = '@chatdsh/client-theme';

/** 一条 OTLP 属性。 */
interface OtlpAttribute {
  readonly key: string;
  readonly value: { readonly stringValue: string };
}

/** 把一对键值编成 OTLP 属性。 */
function attribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

/** 资源属性：形态、服务名与产生信号的包。 */
function resource(): { attributes: OtlpAttribute[] } {
  return {
    attributes: [
      attribute('service.name', 'chatdsh-browser'),
      attribute('chatdsh.surface', 'browser'),
      attribute('chatdsh.component', SCOPE),
    ],
  };
}

/** 生成随机十六进制标识，供 span 的 trace 与 span 标识使用。 */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 把一份 OTLP 载荷交给同源中继。
 *
 * 浏览器侧不持有 OpenObserve 凭据，中继只校验来源并转发。上报失败不打断界面：拒绝只在本
 * 次调用上落空，界面与主题状态不受影响。
 * @param signal - 载荷类型，中继据此选择 OTLP 出口。
 * @param payload - OTLP/HTTP JSON 载荷。
 */
function post(signal: 'logs' | 'traces' | 'metrics', payload: unknown): void {
  void fetch(RELAY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chatdsh-signal': signal, [CSRF_HEADER]: '1' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => undefined);
}

/**
 * 记录一次主题插件的界面动作。
 *
 * 编成 OTLP 日志交给同源中继，形状与 `client-telemetry` 生成的一致。
 * @param action - 动作名。
 * @param outcome - 结果。
 * @param extra - 该动作特有的属性，键必须在 `docs/telemetry.md` 第六节登记过。
 */
function noteAction(action: string, outcome: 'ok' | 'failed', extra: readonly OtlpAttribute[] = []): void {
  post('logs', {
    resourceLogs: [{
      resource: resource(),
      scopeLogs: [{
        scope: { name: SCOPE },
        logRecords: [{
          timeUnixNano: String(Date.now() * 1_000_000),
          severityNumber: outcome === 'ok' ? 9 : 13,
          severityText: outcome === 'ok' ? 'INFO' : 'WARN',
          body: { stringValue: 'chatdsh.client.ui.action' },
          attributes: [
            attribute('action', action),
            attribute('outcome', outcome),
            ...extra,
          ],
        }],
      }],
    }],
  });
}

/** 主题快照里本插件读取的部分：生效主题的标识与配色基线。 */
interface ActiveTheme {
  readonly id: string;
  readonly colorScheme: 'light' | 'dark';
}

/**
 * 上报一次主题切换：日志事件、覆盖切换耗时的 span 与可聚合的计数器。
 * @param previous - 切换前的生效主题。
 * @param next - 切换后的生效主题。
 * @param startedAt - 处理本次切换的起点，毫秒时间戳。
 */
function reportSwitch(previous: ActiveTheme, next: ActiveTheme, startedAt: number): void {
  noteAction('theme-switch', 'ok', [
    attribute('theme.id', next.id),
    attribute('previous.id', previous.id),
    attribute('color_scheme', next.colorScheme),
  ]);

  const endedAt = Date.now();
  post('traces', {
    resourceSpans: [{
      resource: resource(),
      scopeSpans: [{
        scope: { name: SCOPE },
        spans: [{
          traceId: randomHex(16),
          spanId: randomHex(8),
          name: 'chatdsh.theme.switch',
          kind: 1,
          startTimeUnixNano: String(startedAt * 1_000_000),
          endTimeUnixNano: String(endedAt * 1_000_000),
          status: { code: 1 },
          attributes: [
            attribute('theme.id', next.id),
            attribute('previous.id', previous.id),
            attribute('color_scheme', next.colorScheme),
            attribute('outcome', 'ok'),
            attribute('duration', String(endedAt - startedAt)),
          ],
        }],
      }],
    }],
  });

  post('metrics', {
    resourceMetrics: [{
      resource: resource(),
      scopeMetrics: [{
        scope: { name: SCOPE },
        metrics: [{
          name: 'chatdsh_theme_switch_total',
          unit: '1',
          sum: {
            aggregationTemporality: 1,
            isMonotonic: true,
            dataPoints: [{
              asDouble: 1,
              timeUnixNano: String(endedAt * 1_000_000),
              attributes: [
                attribute('theme_id', next.id),
                attribute('previous_id', previous.id),
                attribute('color_scheme', next.colorScheme),
              ],
            }],
          },
        }],
      }],
    }],
  });
}

/** 浏览器侧主题服务的可用面。 */
interface ThemeFace {
  register(definition: {
    id: string;
    colorScheme: 'light' | 'dark';
    tokens: Record<string, string>;
  }): () => void;
  /** 当前不可变快照；生效主题与配色基线由 `active` 给出。 */
  getTheme(): { active: ActiveTheme };
}

/** 浏览器侧上下文。 */
interface ClientFace {
  theme: ThemeFace;
  /** 订阅主题服务的变更事件，返回退订函数。 */
  on(event: 'theme/change', listener: (snapshot: { active: ActiveTheme }) => void): () => void;
}

/** 两套配色下都成立的品牌取值，供注册主题覆盖。 */
const BRAND_TOKENS: Record<string, { light: string; dark: string }> = {
  '--dsw-alias-brand-primary': { light: '#3d56e8', dark: '#4d6bfe' },
  '--dsw-alias-button-primary-fill': { light: '#3d56e8', dark: '#3d56e8' },
};

/**
 * 注册主题、注入样式并订阅切换事件。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientFace): void {
  installThemeStyles();
  ctx.theme.register({
    id: THEME_ID,
    colorScheme: 'dark',
    tokens: {
      '--dsw-alias-brand-primary': BRAND_TOKENS['--dsw-alias-brand-primary']!.dark,
      '--dsw-alias-button-primary-fill': BRAND_TOKENS['--dsw-alias-button-primary-fill']!.dark,
    },
  });
  // 注册与字号调整都会发 `theme/change`；只有生效主题或配色基线变化才算一次切换。
  let active = ctx.theme.getTheme().active;
  ctx.on('theme/change', (snapshot) => {
    const previous = active;
    const next = snapshot.active;
    if (next.id === previous.id && next.colorScheme === previous.colorScheme) return;
    active = next;
    reportSwitch(previous, next, Date.now());
  });
  noteAction('theme-install', 'ok');
}
