# ChatDSH 客户端主题插件契约

本文件定义 ChatDSH 客户端的主题系统契约。本系统承接 `@deepseek-ai/dsh-client-ui-theme` 的设计架构，支持用户通过安装独立的客户端插件整套替换界面视觉主题与设计令牌（Design Tokens）。

## 一、架构职责与层级

在客户端分层架构中，主题系统属于 L1 基础插件层，通过 cordis 服务 `ctx.theme` 暴露给所有界面席位：

- **主题运行时（ThemeRuntime）**：管理主题注册表、当前生效的主题偏好（明亮、暗黑、跟随系统或具体主题标识符）、字体尺寸与字体族配置；计算合并后的样式快照，并向运行环境分发变更事件。
- **主题插件（Theme Plugins）**：以标准客户端插件形式提供，在自身 `apply(ctx)` 入口中调用 `ctx.theme.register(definition)` 注册完整的主题方案，或者调用 `ctx.theme.overrideTokens(source, overrides)` 提供局部令牌覆盖。
- **呈现适配器（Theme Presenter）**：订阅 `theme/change` 事件，将当前激活主题的 CSS 变量注入到文档根节点，并在 `body` 元素上维护 `data-color-scheme` 与 `data-theme-id` 属性。

## 二、包结构与清单声明

每个主题插件作为独立的 npm 包发布，在 `package.json` 中声明 `dsh.client` 元数据：

```json
{
  "name": "@chatdsh/theme-deepseek-dark",
  "version": "0.1.0",
  "description": "ChatDSH 的 DeepSeek 官方蓝黑风格主题插件",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js"
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-theme"
      ],
      "immediately": true
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5"
  }
}
```

## 三、接口契约定义

### 3.1 核心类型

```typescript
export type ThemeColorScheme = 'light' | 'dark';

export type ThemeTokens = Record<string, string>;

export interface ThemeDefinition {
  /** 主题全局唯一标识符，例如 deepseek-dark */
  id: string;
  /** 主题人类可读显示名称 */
  name: string;
  /** 基础调色板类型，用于决定系统组件的基础对比基线 */
  colorScheme: ThemeColorScheme;
  /** CSS 自定义属性变量名到颜色值的键值表 */
  tokens: ThemeTokens;
}

export interface ThemeTokenModes {
  light: string;
  dark: string;
}

export type ThemeTokenOverrides = Record<string, ThemeTokenModes>;

export interface ThemeSnapshot {
  preference: string;
  active: ThemeDefinition;
  themes: readonly ThemeDefinition[];
  revision: number;
}
```

### 3.2 服务上下文扩展

```typescript
declare module '@deepseek-ai/cordis' {
  interface Context {
    theme: ThemeRuntime;
  }
  interface Events {
    'theme/change'(snapshot: ThemeSnapshot): void;
  }
}
```

### 3.3 ThemeRuntime 方法定义

- `getTheme(): ThemeSnapshot`：获取当前不可变的主题快照对象。
- `setTheme(id: string): void`：切换当前生效的主题；持久化保存用户配置，并触发 `theme/change` 事件与遥测记录。
- `register(definition: ThemeDefinition): () => void`：向全局主题目录注册新的主题方案；返回注销函数。
- `overrideTokens(source: string, overrides: ThemeTokenOverrides): () => void`：注册局部的令牌层叠覆盖；返回注销函数。

## 四、标准化设计令牌（Design Tokens）

所有界面组件禁止直接书写十六进制硬编码颜色，统一引用下述标准化 CSS 变量：

| 令牌名称 | 语义职责 | 典型值（DeepSeek 蓝黑） |
|---|---|---|
| `--chatdsh-bg` | 应用主视口画布底色 | `#0E0E10` |
| `--chatdsh-panel` | 一级面板与卡片容器背景 | `#17181C` |
| `--chatdsh-panel-2` | 二级沉底面板与侧边栏底色 | `#1B1D22` |
| `--chatdsh-code-bg` | 代码块与终端深色背景 | `#121317` |
| `--chatdsh-line` | 弱结构分割线 | `#24262C` |
| `--chatdsh-line-2` | 强交互控件外边框 | `#30333B` |
| `--chatdsh-ink` | 一级主要标题与高亮正文文字 | `#F3F5F9` |
| `--chatdsh-ink-2` | 二级标准常规正文文字 | `#C7CCD6` |
| `--chatdsh-muted` | 次要描述与辅助信息说明文字 | `#9AA1AD` |
| `--chatdsh-faint` | 极低对比度提示与未激活状态文字 | `#858D9A` |
| `--chatdsh-brand` | 品牌标志与图标核心高亮色 | `#4D6BFE` |
| `--chatdsh-brand-text` | 黑色背景上的高可读性品牌文字颜色 | `#6B84FF` |
| `--chatdsh-brand-fill` | 品牌主按钮与行动点实色填充背景 | `#3D56E8` |
| `--chatdsh-brand-fill-down` | 品牌按钮按下激活态背景颜色 | `#3549C9` |
| `--chatdsh-brand-soft` | 品牌色弱背景光晕与选中底色 | `rgba(77, 107, 254, 0.13)` |
| `--chatdsh-bubble` | 用户输入气泡背景 | `#2E3F9E` |
| `--chatdsh-bubble-ink` | 用户输入气泡内部文字 | `#E6EAFF` |
| `--chatdsh-ok` | 成功、验证通过状态色 | `#3FB37F` |
| `--chatdsh-warn` | 警告、等待授权状态色 | `#E8B04B` |
| `--chatdsh-danger` | 错误、失败、危险动作状态色 | `#FF7B7B` |

## 五、遥测规范

主题切换操作接入 OpenObserve 遥测：
- 指标：`chatdsh_theme_switch_total{theme_id, previous_id, color_scheme}`
- Span 名称：`chatdsh.theme.switch`，记录属性包含耗时与目标主题标识符。
