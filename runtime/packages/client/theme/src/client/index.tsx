/**
 * 主题插件浏览器侧入口：把界面基础设计带给上游界面。
 *
 * 两件事：注入令牌与映射样式，让上游外壳与自建面板共用同一套画布、分层、字号与状态色；
 * 向 `ctx.theme` 注册一个可被用户选择的 `chatdsh` 主题，主题的令牌覆盖与样式来自同一份
 * 设计取值。注册本身不改动用户当前的配色偏好，只在用户主动切换时生效。
 * @module @chatdsh/client-theme
 */

import { installThemeStyles } from './apply-styles.ts';

/** 浏览器侧依赖：只要主题服务与席位服务，模块加载顺序由模块图保证。 */
export const inject = ['theme', 'slots'];

/** 注册到主题目录的标识。 */
export const THEME_ID = 'chatdsh';

/** 上报一次界面动作的中继端点。 */
const RELAY_PATH = '/chatdsh/telemetry/browser';

/**
 * 记录一次主题插件的界面动作。
 *
 * 浏览器侧不持有 OpenObserve 凭据，编成 OTLP 日志交给同源中继；中继只转发不解析，形状与
 * `client-telemetry` 生成的一致。上报失败不打断界面。
 * @param action - 动作名。
 * @param outcome - 结果。
 */
function noteAction(action: string, outcome: 'ok' | 'failed'): void {
  void fetch(RELAY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chatdsh-signal': 'logs', 'x-chatdsh-csrf': '1' },
    body: JSON.stringify({
      resourceLogs: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'chatdsh-browser' } },
            { key: 'chatdsh.surface', value: { stringValue: 'browser' } },
          ],
        },
        scopeLogs: [{
          scope: { name: '@chatdsh/client-theme' },
          logRecords: [{
            timeUnixNano: String(Date.now() * 1_000_000),
            severityNumber: outcome === 'ok' ? 9 : 13,
            severityText: outcome === 'ok' ? 'INFO' : 'WARN',
            body: { stringValue: 'chatdsh.client.ui.action' },
            attributes: [
              { key: 'action', value: { stringValue: action } },
              { key: 'outcome', value: { stringValue: outcome } },
            ],
          }],
        }],
      }],
    }),
    keepalive: true,
  }).catch(() => undefined);
}

/** 浏览器侧主题服务的可用面。 */
interface ThemeFace {
  register(definition: {
    id: string;
    colorScheme: 'light' | 'dark';
    tokens: Record<string, string>;
  }): () => void;
  getTheme(): { active: { id: string } };
}

/** 浏览器侧上下文。 */
interface ClientFace {
  theme: ThemeFace;
}

/** 两套配色下都成立的品牌取值，供注册主题覆盖。 */
const BRAND_TOKENS: Record<string, { light: string; dark: string }> = {
  '--dsw-alias-brand-primary': { light: '#3d56e8', dark: '#4d6bfe' },
  '--dsw-alias-button-primary-fill': { light: '#3d56e8', dark: '#3d56e8' },
};

/**
 * 注册主题并注入样式。
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
  noteAction('theme-install', 'ok');
}
