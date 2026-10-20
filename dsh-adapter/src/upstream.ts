/**
 * 上游包名与行 id 的唯一登记处。
 *
 * 这些名字在业务代码与配置清单里出现时是字符串，改名不会在编译期报错，只会在运行期
 * 变成「加载器找不到这一行」或「面板挂不上」。把它们收在这里，上游改名时只改这一处，
 * 校验脚本再据此核对各处的源码与清单。
 *
 * 这个模块只含字符串常量，不引任何上游包，因此可以被浏览器侧与纯函数模块引用，
 * 不会把上游的依赖带进来。
 * @module @chatdsh/adapter/upstream
 */

/** 上游的内置组合包，profile 的 `dsh.profile.bundles` 列它们。 */
export const UPSTREAM_BUNDLES = {
  /** 单机通用组合：会话、工具、设置与存储。 */
  base: '@deepseek-ai/dsh-base',
  /** Web 形态的前端产物与浏览器侧模块图。 */
  webApp: '@deepseek-ai/dsh-web-app',
  /** 无界面的运行时组合。 */
  headless: '@deepseek-ai/dsh-headless',
  /** ACP 协议入口。 */
  acpApp: '@deepseek-ai/dsh-acp-app',
} as const;

/** 上游的客户端界面包，客户端插件的 `dsh.client.inject` 列它们。 */
export const UPSTREAM_CLIENT_UI = {
  /** 面板渲染器，宿主侧与浏览器侧都通过它。 */
  renderer: '@deepseek-ai/dsh-client-ui-renderer',
  /** 设置页的区段容器。 */
  settings: '@deepseek-ai/dsh-client-ui-settings',
  /** 侧栏的容器。 */
  sidebar: '@deepseek-ai/dsh-client-ui-sidebar',
} as const;

/** 上游的工具行：行 id → 包名。会话预设按行 id 挂载它们。 */
export const UPSTREAM_TOOL_ROWS = {
  'tool-bash': '@deepseek-ai/dsh-tool-bash',
  'tool-pwsh': '@deepseek-ai/dsh-tool-pwsh',
  'tool-fs': '@deepseek-ai/dsh-tool-fs',
  'tool-fs-search': '@deepseek-ai/dsh-tool-fs-search',
  'skill-filesystem': '@deepseek-ai/dsh-skill-filesystem',
  'tool-skill': '@deepseek-ai/dsh-tool-skill',
  'tool-jobs': '@deepseek-ai/dsh-tool-jobs',
  'tool-todo': '@deepseek-ai/dsh-tool-todo',
  'tool-web': '@deepseek-ai/dsh-tool-web',
} as const;

/** 上游的人格与指令行：行 id → 包名。会话预设按行 id 挂载它们。 */
export const UPSTREAM_AGENT_ROWS = {
  /** 人格行。 */
  persona: '@deepseek-ai/dsh-persona',
  /** 指令行。 */
  'agent-instructions': '@deepseek-ai/dsh-agent-instructions',
  /** 时间上下文行。 */
  'time-context': '@deepseek-ai/dsh-time-context',
  /** 预设注册行。 */
  preset: '@deepseek-ai/dsh-agent-preset',
} as const;

/** 上游的 MCP 客户端包，连接器把记录同步成这一行的加载器条目。 */
export const UPSTREAM_MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';

/**
 * 上游的投影表包名，业务包对它做类型增强。
 *
 * 声明合并必须写上游的真实包名，写成别名会挂不上，因此这个字符串出现在业务包里。
 * 登记在这里，上游改名时校验脚本能指出所有需要跟着改的地方。
 */
export const UPSTREAM_PROJECTION_TYPES = '@deepseek-ai/dsh-session-projection';

/** 上游的审批服务包名，业务包对它做类型增强。 */
export const UPSTREAM_APPROVAL_TYPES = '@deepseek-ai/dsh-user-approval';

/**
 * 补丁层与 profile 里引用到的上游行：行 id → 包名。
 *
 * 补丁层按 `id` 与 `name` 成对匹配上游的行：`name` 写错时整条补丁被跳过，改名的行
 * 因此不会被静默忽略 —— 但也不会报错，只是不生效。登记在这里，校验脚本据此核对
 * 各处补丁层写的名字。
 */
export const UPSTREAM_ROWS = {
  /** 上下文溢出的落盘阈值。 */
  'spill-policy': '@deepseek-ai/dsh-spill-policy',
  /** 工具结果的裁剪策略。 */
  'tool-result-pruner': '@deepseek-ai/dsh-compaction-tool-result-pruner',
  /** 浏览器侧栏。 */
  'ui-sidebar-browser': '@deepseek-ai/dsh-client-ui-sidebar-browser',
  /** 会话日志的 JSONL 后端。 */
  'session-persistence-jsonl': '@deepseek-ai/dsh-session-persistence-jsonl',
  /** 会话查询的 SQLite 实现。 */
  'session-query-sqlite': '@deepseek-ai/dsh-session-query-sqlite',
  /** 预设注册表。 */
  'agent-preset-registry': '@deepseek-ai/dsh-agent-preset-registry',
  /** DeepSeek 账号平台。 */
  'deepseek-account': '@deepseek-ai/dsh-deepseek-account-platform',
  /** 走账号的模型适配器。 */
  'llm-deepseek-account': '@deepseek-ai/dsh-llm-deepseek-account',
  /** 账号接口控制器。 */
  'account-controller': '@deepseek-ai/dsh-api-account-controller',
  /** 设置页的账号区段。 */
  'ui-settings-account': '@deepseek-ai/dsh-client-ui-settings-account',
  /** 设置页的通用区段。 */
  'ui-settings-general': '@deepseek-ai/dsh-client-ui-settings-general',
  /** 浏览器侧的 DeepSeek 接口。 */
  'web-deepseek-api': '@deepseek-ai/dsh-web-deepseek-api',
  /** 浏览器侧的 DeepSeek 搜索。 */
  'web-search-deepseek': '@deepseek-ai/dsh-web-search-deepseek',
} as const;

/** 全部登记过的上游包名，校验脚本据此核对各处清单。 */
export const UPSTREAM_PACKAGE_NAMES: readonly string[] = [
  ...Object.values(UPSTREAM_BUNDLES),
  ...Object.values(UPSTREAM_CLIENT_UI),
  ...Object.values(UPSTREAM_TOOL_ROWS),
  ...Object.values(UPSTREAM_AGENT_ROWS),
  UPSTREAM_MCP_CLIENT,
  UPSTREAM_PROJECTION_TYPES,
  UPSTREAM_APPROVAL_TYPES,
  ...Object.values(UPSTREAM_ROWS),
];
