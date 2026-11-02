/**
 * 主题切换遥测测试的页面装配。
 *
 * 页面里执行的是主题插件本身的源码（由 esbuild 按浏览器形态打包），外面套一层主题服务的
 * 浏览器侧接口面：`register`、`getTheme` 与 `theme/change` 事件。事件名、快照形状与切换入口
 * 取自 `.dsh-deps/@deepseek-ai/dsh-client-ui-theme/lib/types/client/index.d.ts`，测试在启动
 * 浏览器之前核对该声明文件仍然发布同名事件与同名方法，因此这里的一层只承担本机缺少上游
 * 浏览器运行时这一件事。
 * @module client-complete-wp02-theme-telemetry-harness
 */

import { apply } from '../../packages/client/theme/src/client/index.tsx';

/** 一套配色基线的取值。 */
type ColorScheme = 'light' | 'dark';

/** 可注册主题的定义，字段与上游 `ThemeDefinition` 一致。 */
interface ThemeDefinition {
  id: string;
  colorScheme: ColorScheme;
  tokens: Record<string, string>;
}

/** 上游 `ThemeSnapshot` 里测试用到的那部分。 */
interface ThemeSnapshot {
  preference: string;
  fontSizes: Record<string, number>;
  active: { id: string; colorScheme: ColorScheme };
  themes: readonly ThemeDefinition[];
  revision: number;
}

/** 上游注册表自带的两个主题：界面基础设计的亮色与暗色基线。 */
const registry = new Map<string, ThemeDefinition>([
  ['light', { id: 'light', colorScheme: 'light', tokens: {} }],
  ['dark', { id: 'dark', colorScheme: 'dark', tokens: {} }],
]);

/** 已订阅 `theme/change` 的监听者。 */
const listeners = new Set<(snapshot: ThemeSnapshot) => void>();

/** 当前持久化的偏好，取值为主题标识或 `system`。 */
let preference = 'light';

/** 字号状态；本测试只用来证明快照变化不等于主题切换。 */
let fontSize = 14;

/** 变更计数，与上游一样随每次发布递增。 */
let revision = 0;

/** 按当前偏好解析出生效主题。 */
function resolvedId(): string {
  if (preference !== 'system') return preference;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 当前快照；每次发布重新构造。 */
let snapshot: ThemeSnapshot = build();

function build(): ThemeSnapshot {
  const active = registry.get(resolvedId());
  if (active === undefined) throw new Error(`主题注册表里没有 ${resolvedId()}`);
  return {
    preference,
    fontSizes: { text: fontSize },
    active: { id: active.id, colorScheme: active.colorScheme },
    themes: [...registry.values()],
    revision,
  };
}

/** 递增计数并广播新快照，语义与上游 `publish` 一致。 */
function publish(): void {
  revision += 1;
  snapshot = build();
  for (const listener of listeners) listener(snapshot);
}

/** 主题服务面：注册、读取与切换入口。 */
const theme = {
  register(definition: ThemeDefinition): () => void {
    if (definition.id === 'system') throw new Error('system 是偏好取值，不是可注册的主题标识');
    if (registry.has(definition.id)) throw new Error(`主题 ${definition.id} 已经注册`);
    registry.set(definition.id, definition);
    publish();
    return () => {
      if (registry.delete(definition.id)) publish();
    };
  },
  getTheme(): ThemeSnapshot {
    return snapshot;
  },
};

/** 客户端根上下文的最小接口面，事件名与上游 `Events` 声明一致。 */
const ctx = {
  theme,
  on(event: string, listener: (next: ThemeSnapshot) => void): () => void {
    if (event !== 'theme/change') throw new Error(`主题插件订阅了未登记的事件：${event}`);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

apply(ctx);

/** 测试驱动面。 */
interface Harness {
  /** 当前生效主题与变更计数。 */
  current(): { id: string; colorScheme: ColorScheme; revision: number };
  /** 切换偏好，等价于上游 `setTheme`。 */
  switchTo(id: string): { id: string; colorScheme: ColorScheme; revision: number };
  /** 只改字号，等价于上游 `setFontSize`：会发布新快照，生效主题不变。 */
  tapFontSize(px: number): { id: string; colorScheme: ColorScheme; revision: number };
}

(globalThis as unknown as { __chatdshTheme: Harness }).__chatdshTheme = {
  current: () => ({ ...snapshot.active, revision: snapshot.revision }),
  switchTo: (id) => {
    if (id !== 'system' && !registry.has(id)) throw new Error(`主题 ${id} 未注册`);
    preference = id;
    publish();
    return { ...snapshot.active, revision: snapshot.revision };
  },
  tapFontSize: (px) => {
    fontSize = px;
    publish();
    return { ...snapshot.active, revision: snapshot.revision };
  },
};
