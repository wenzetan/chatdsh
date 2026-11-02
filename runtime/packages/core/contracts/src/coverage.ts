/**
 * 字段到 S01–S32 的契约清单。
 *
 * 每一行说明某个场景的哪些字段由本包的哪个模块承载，以及该字段目前的状态。`pending`
 * 表示字段已在契约里保留位置、实现由后续工作包承担，并写明承担它的工作包。
 * @module @chatdsh/core-contracts/coverage
 */

/** 承载字段的契约模块。 */
export const CONTRACT_MODULES = [
  'errors',
  'primitives',
  'operations',
  'client-state',
  'pagination',
  'content-scope',
  'drafts',
  'fork',
  'access',
  'notifications',
  'devices',
  'memory-groups',
  'exports',
  'settings',
  'navigation',
  'shares',
  'approvals',
  'questions',
  'artifact-versions',
  'automation-delivery',
  'data-management',
  'telemetry',
  'session-events',
  'tool-tiers',
  'model-backend',
  'mcp',
  'artifacts',
  'automation',
  'approval',
] as const;

/** 承载字段的契约模块取值。 */
export type ContractModule = (typeof CONTRACT_MODULES)[number];

/** 已实施的字段。 */
export interface ImplementedField {
  /** 字段或契约项名称。 */
  readonly field: string;
  /** 承载它的契约模块。 */
  readonly module: ContractModule;
  /** 已实施。 */
  readonly status: 'implemented';
}

/** 待实施的字段。 */
export interface PendingField {
  /** 字段或契约项名称。 */
  readonly field: string;
  /** 承载它的契约模块。 */
  readonly module: ContractModule;
  /** 待实施。 */
  readonly status: 'pending';
  /** 承担该字段实施的工作包与说明。 */
  readonly note: string;
}

/** 一条字段登记。 */
export type ContractField = ImplementedField | PendingField;

/** 一个场景的契约覆盖。 */
export interface ScenarioCoverage {
  /** 场景编号。 */
  readonly scenario: string;
  /** 场景标题。 */
  readonly title: string;
  /** 该场景的字段登记。 */
  readonly fields: readonly ContractField[];
}

/** 字段到场景的契约清单。 */
export const CONTRACT_COVERAGE: readonly ScenarioCoverage[] = [
  {
    scenario: 'S01',
    title: '工作会话',
    fields: [
      { field: '会话列表分页与排序', module: 'pagination', status: 'implemented' },
      { field: '共同读取与呈现状态矩阵', module: 'client-state', status: 'implemented' },
      { field: '写操作的六个状态与迁移', module: 'client-state', status: 'implemented' },
      { field: '内容读取状态与只读原因', module: 'content-scope', status: 'implemented' },
      { field: '待处理审批计数', module: 'approvals', status: 'implemented' },
      { field: '消息反馈的类型、原因与说明', module: 'questions', status: 'pending', note: '由 WP07 会话呈现工作包实施' },
      { field: '上下文占用读数与阈值标注', module: 'content-scope', status: 'pending', note: '由 WP09 业务宿主工作包提供读数' },
    ],
  },
  {
    scenario: 'S02',
    title: '新建会话与设备目录',
    fields: [
      { field: '创建会话的操作标识与摘要', module: 'operations', status: 'implemented' },
      { field: '会话归属的设备与目录', module: 'session-events', status: 'implemented' },
      { field: '目录列举的父级、当前位置与越界错误', module: 'errors', status: 'pending', note: '由 WP14 文件与附件工作包实施' },
      { field: '标题长度上限与服务端限制回传', module: 'primitives', status: 'pending', note: '由 WP03 控制平面客户端基础实施' },
    ],
  },
  {
    scenario: 'S03',
    title: '跨设备继续与离线',
    fields: [
      { field: '继续会话的两种方式与 fork 表单', module: 'fork', status: 'implemented' },
      { field: 'fork 预估的事件数、字符数、附件缺失与压缩损失', module: 'fork', status: 'implemented' },
      { field: '副本可用状态与读取时间', module: 'content-scope', status: 'implemented' },
      { field: '写租约占用方与等待入口', module: 'fork', status: 'implemented' },
      { field: '离线发送结果与草稿保留', module: 'drafts', status: 'implemented' },
    ],
  },
  {
    scenario: 'S04',
    title: '审批',
    fields: [
      { field: '审批卡片字段与优先级', module: 'approvals', status: 'implemented' },
      { field: '决定的工具调用标识与状态版本', module: 'approvals', status: 'implemented' },
      { field: '扩大范围的再次确认', module: 'approvals', status: 'implemented' },
      { field: '全局列表的过滤与分页', module: 'approvals', status: 'implemented' },
      { field: '决定撤回同关联键通知', module: 'notifications', status: 'implemented' },
      { field: '审批审计事件', module: 'approval', status: 'implemented' },
    ],
  },
  {
    scenario: 'S05',
    title: '提问、计划、目标、子代理与工作流',
    fields: [
      { field: '提问 schema 与逐项校验', module: 'questions', status: 'implemented' },
      { field: '提问状态机与失效应答', module: 'questions', status: 'implemented' },
      { field: '计划批准与修改意见', module: 'questions', status: 'pending', note: '由 WP08 审批提问计划工作包实施' },
      { field: '目标的暂停、恢复、清除', module: 'approvals', status: 'pending', note: '由 WP07 会话呈现工作包实施' },
      { field: '子代理目录与父子关系', module: 'pagination', status: 'pending', note: '由 WP09 业务宿主工作包实施' },
      { field: '工作流节点依赖与作业退出码', module: 'pagination', status: 'pending', note: '由 WP09 业务宿主工作包实施' },
    ],
  },
  {
    scenario: 'S06',
    title: '命令面板与引导',
    fields: [
      { field: '命令描述、分组与禁用原因', module: 'navigation', status: 'implemented' },
      { field: '最近使用命令只存标识', module: 'navigation', status: 'implemented' },
      { field: '首次引导步骤与进度', module: 'navigation', status: 'implemented' },
      { field: '快捷键录入、作用域与冲突', module: 'settings', status: 'pending', note: '由 WP30 设置界面工作包实施' },
    ],
  },
  {
    scenario: 'S07',
    title: '输入、引用、技能、附件与录音',
    fields: [
      { field: '草稿引用对象种类与失效标注', module: 'drafts', status: 'implemented' },
      { field: '已确认附件元数据与重新选择标注', module: 'drafts', status: 'implemented' },
      { field: '附件元数据与内容摘要', module: 'artifacts', status: 'implemented' },
      { field: '录音状态与转写确认', module: 'drafts', status: 'pending', note: '由 WP14 文件与附件工作包实施' },
      { field: '在线发送队列的暂停与恢复', module: 'operations', status: 'pending', note: '由 WP07 会话呈现工作包实施' },
    ],
  },
  {
    scenario: 'S08',
    title: '文件、终端与受限网页',
    fields: [
      { field: '终端会话标识、连接状态与重连', module: 'devices', status: 'pending', note: '由 WP14 文件与附件工作包实施' },
      { field: '文件树操作与路径权限错误', module: 'errors', status: 'pending', note: '由 WP14 文件与附件工作包实施' },
      { field: '受限网页的宿主隔离与下载策略', module: 'navigation', status: 'pending', note: '由 WP33 桌面控制工作包实施' },
    ],
  },
  {
    scenario: 'S09',
    title: '制品、图片与 PDF',
    fields: [
      { field: '制品版本列表与不可改写', module: 'artifact-versions', status: 'implemented' },
      { field: '删除范围含全部版本与占用空间', module: 'artifact-versions', status: 'implemented' },
      { field: '受限预览的脚本与宿主访问禁用', module: 'artifact-versions', status: 'implemented' },
      { field: 'PDF 页码、目录、搜索与文本层', module: 'artifact-versions', status: 'pending', note: '由 WP12 制品与查看器工作包实施' },
    ],
  },
  {
    scenario: 'S10',
    title: '项目',
    fields: [
      { field: '项目保存的版本冲突', module: 'settings', status: 'implemented' },
      { field: '项目默认助手的持久化字段', module: 'settings', status: 'pending', note: '由 WP09 业务宿主工作包补充持久化' },
      { field: '项目路径创建后只读', module: 'settings', status: 'pending', note: '由 WP10 项目界面工作包实施' },
    ],
  },
  {
    scenario: 'S11',
    title: '助手与技能',
    fields: [
      { field: '助手保存的版本冲突与原定义保留', module: 'settings', status: 'implemented' },
      { field: '助手档位与工具行', module: 'tool-tiers', status: 'implemented' },
      { field: '技能启停与目录计数', module: 'pagination', status: 'pending', note: '由 WP11 助手与技能工作包实施' },
    ],
  },
  {
    scenario: 'S12',
    title: '记忆与记忆组',
    fields: [
      { field: '记忆配置视图与 revision', module: 'memory-groups', status: 'implemented' },
      { field: '记忆组关联与显示名', module: 'memory-groups', status: 'implemented' },
      { field: 'bank 目录与检索结果', module: 'memory-groups', status: 'implemented' },
      { field: '待写入与废弃记录的计数', module: 'memory-groups', status: 'implemented' },
      { field: '召回超时的降级结果', module: 'memory-groups', status: 'implemented' },
    ],
  },
  {
    scenario: 'S13',
    title: '连接器与 MCP',
    fields: [
      { field: '连接器记录与条件字段', module: 'mcp', status: 'implemented' },
      { field: 'MCP 端点按设备分组', module: 'mcp', status: 'implemented' },
      { field: '加载器同步状态与实际配置差异', module: 'errors', status: 'pending', note: '由 WP13 连接器界面工作包实施' },
      { field: '工具测试的结构化结果', module: 'mcp', status: 'pending', note: '由 WP13 连接器界面工作包实施' },
    ],
  },
  {
    scenario: 'S14',
    title: '自动化、webhook 与设备定时任务',
    fields: [
      { field: '投递记录、事件标识与去重结果', module: 'automation-delivery', status: 'implemented' },
      { field: '投递状态机与未确认结果', module: 'automation-delivery', status: 'implemented' },
      { field: '定时任务的互斥时间方式与时区', module: 'automation-delivery', status: 'implemented' },
      { field: '自动化触发与动作记录', module: 'automation', status: 'implemented' },
      { field: 'cron 表达式的成熟解析依赖', module: 'primitives', status: 'pending', note: '由 WP17 自动化宿主引入 cron 解析库后转为已实施' },
    ],
  },
  {
    scenario: 'S15',
    title: '分享与公开快照',
    fields: [
      { field: '分享范围与默认过滤项', module: 'shares', status: 'implemented' },
      { field: '分享列表不显示内部序号与副本水位', module: 'shares', status: 'implemented' },
      { field: '公开快照的只读与无交互', module: 'shares', status: 'implemented' },
      { field: '撤销结果与失效原因', module: 'shares', status: 'implemented' },
      { field: '生成前的完整预览', module: 'shares', status: 'implemented' },
    ],
  },
  {
    scenario: 'S16',
    title: '通知中心与系统通知',
    fields: [
      { field: '通知字段与已读状态', module: 'notifications', status: 'implemented' },
      { field: '已读标记的幂等结果', module: 'notifications', status: 'implemented' },
      { field: '通知设置的两阶段等待', module: 'notifications', status: 'implemented' },
      { field: '推送订阅与权限状态', module: 'notifications', status: 'implemented' },
      { field: '验证通知的受理与接收两个结果', module: 'notifications', status: 'implemented' },
    ],
  },
  {
    scenario: 'S17',
    title: '设备、配对与撤销',
    fields: [
      { field: '访问客户端与执行节点分组', module: 'devices', status: 'implemented' },
      { field: '配对码载荷与有效期', module: 'devices', status: 'implemented' },
      { field: '节点令牌只在建立时返回', module: 'devices', status: 'implemented' },
      { field: '撤销结果与会话保留', module: 'devices', status: 'implemented' },
      { field: '链路检查结果', module: 'devices', status: 'implemented' },
    ],
  },
  {
    scenario: 'S18',
    title: '访问认证、双因素与恢复',
    fields: [
      { field: '访问策略与认证方式', module: 'access', status: 'implemented' },
      { field: '密码、通行密钥、TOTP 与恢复码登录', module: 'access', status: 'implemented' },
      { field: '访问会话列表与续期窗口', module: 'access', status: 'implemented' },
      { field: '敏感动作的再次认证', module: 'access', status: 'implemented' },
      { field: '恢复码集合只展示一次', module: 'access', status: 'implemented' },
    ],
  },
  {
    scenario: 'S19',
    title: '通用、外观与快捷键',
    fields: [
      { field: '设置区段与作用范围', module: 'settings', status: 'implemented' },
      { field: '跨设备同步的命名空间白名单', module: 'settings', status: 'implemented' },
      { field: '主题令牌与外观切换', module: 'settings', status: 'pending', note: '由 WP02 组件与主题工作包实施' },
      { field: '多窗口偏好同步与草稿独立', module: 'drafts', status: 'implemented' },
    ],
  },
  {
    scenario: 'S20',
    title: '模型、提供方与额度',
    fields: [
      { field: '模型提供方注册信息', module: 'model-backend', status: 'implemented' },
      { field: '额度拒绝的错误码', module: 'errors', status: 'implemented' },
      { field: '默认模型设置与作用范围', module: 'settings', status: 'implemented' },
      { field: '本地执行的来源标记', module: 'session-events', status: 'pending', note: '由 WP09 业务宿主工作包与 SYS05 实施' },
    ],
  },
  {
    scenario: 'S21',
    title: '插件安装、组合与清单',
    fields: [
      { field: '按设备的插件清单', module: 'pagination', status: 'pending', note: '由 WP04 设备实时通道工作包实施' },
      { field: '安装阶段与失败原因', module: 'errors', status: 'pending', note: '由 WP04 设备实时通道工作包实施' },
    ],
  },
  {
    scenario: 'S22',
    title: '外壳、运行参数、检索、子代理与日志',
    fields: [
      { field: '运行参数写入与冲突', module: 'settings', status: 'implemented' },
      { field: '设备范围设置的设备标识约束', module: 'settings', status: 'implemented' },
      { field: '日志导出与清理范围', module: 'data-management', status: 'implemented' },
      { field: '子代理并发与工具允许范围字段', module: 'settings', status: 'pending', note: '由 WP30 设置界面工作包补充字段清单' },
    ],
  },
  {
    scenario: 'S23',
    title: '设置冲突',
    fields: [
      { field: '冲突视图中作用设备与变更时间', module: 'settings', status: 'implemented' },
      { field: '敏感字段只比较配置状态', module: 'settings', status: 'implemented' },
      { field: '逐字段采用服务器值或编辑值', module: 'settings', status: 'implemented' },
      { field: '过期版本的写入被拒绝', module: 'operations', status: 'implemented' },
    ],
  },
  {
    scenario: 'S24',
    title: '用量、副本清理、血缘与删除收件箱',
    fields: [
      { field: '用量行的会话数与副本字节', module: 'data-management', status: 'implemented' },
      { field: '清理预估与实际释放', module: 'data-management', status: 'implemented' },
      { field: '删除收件箱与恢复结果', module: 'data-management', status: 'implemented' },
      { field: '归属详情与继承内容范围', module: 'data-management', status: 'implemented' },
      { field: '对外形状不含副本水位', module: 'content-scope', status: 'implemented' },
    ],
  },
  {
    scenario: 'S25',
    title: '诊断与遥测',
    fields: [
      { field: '遥测开关状态与关闭原因', module: 'telemetry', status: 'implemented' },
      { field: '脱敏诊断导出清单', module: 'data-management', status: 'pending', note: '由 WP37 诊断与遥测集成工作包实施' },
    ],
  },
  {
    scenario: 'S26',
    title: 'PWA 安装、权限与离线草稿',
    fields: [
      { field: '草稿恢复与清理', module: 'drafts', status: 'implemented' },
      { field: '缓存范围排除私有接口与令牌', module: 'drafts', status: 'pending', note: '由 WP31 PWA 工作包实施' },
      { field: '更新激活前的草稿保存', module: 'drafts', status: 'pending', note: '由 WP31 PWA 工作包实施' },
    ],
  },
  {
    scenario: 'S27',
    title: '移动会话与导航',
    fields: [
      { field: '导航消息与选中确认', module: 'navigation', status: 'implemented' },
      { field: '阅读位置与草稿保持', module: 'drafts', status: 'implemented' },
      { field: '抽屉导航与系统返回逐层关闭', module: 'navigation', status: 'pending', note: '由 WP31 PWA 工作包实施' },
    ],
  },
  {
    scenario: 'S28',
    title: '桌面控制与系统权限',
    fields: [
      { field: '权限向导的授权状态', module: 'errors', status: 'pending', note: '由 WP33 桌面控制工作包实施' },
      { field: '控制租约与审计记录', module: 'devices', status: 'pending', note: '由 WP33 桌面控制工作包实施' },
    ],
  },
  {
    scenario: 'S29',
    title: '桌面菜单、托盘、更新与恢复',
    fields: [
      { field: '更新阶段与校验失败', module: 'operations', status: 'pending', note: '由 WP32 桌面生命周期工作包实施' },
      { field: '启动恢复的阶段与退出码', module: 'operations', status: 'pending', note: '由 WP32 桌面生命周期工作包实施' },
      { field: '电源策略按设备保存', module: 'settings', status: 'implemented' },
      { field: '关闭窗口时的草稿保护', module: 'drafts', status: 'implemented' },
    ],
  },
  {
    scenario: 'S30',
    title: '第二窗口与分屏',
    fields: [
      { field: '窗口标识与独立草稿', module: 'drafts', status: 'implemented' },
      { field: '同一已接收操作按标识去重', module: 'operations', status: 'implemented' },
      { field: '分屏与分隔条布局', module: 'navigation', status: 'pending', note: '由 WP34 第二窗口工作包实施' },
    ],
  },
  {
    scenario: 'S31',
    title: '打印与导出',
    fields: [
      { field: '导出源、格式与内容范围', module: 'exports', status: 'implemented' },
      { field: '附件可下载、缺失、需要源设备', module: 'exports', status: 'implemented' },
      { field: '打印去掉导航与交互按钮', module: 'exports', status: 'implemented' },
      { field: '导出任务的取消、失败与下载失效', module: 'exports', status: 'implemented' },
    ],
  },
  {
    scenario: 'S32',
    title: 'CLI 与非交互',
    fields: [
      { field: '非交互退出码与 JSON 行输出', module: 'errors', status: 'pending', note: '由 WP36 命令行工作包实施' },
      { field: '本机会话列举范围', module: 'pagination', status: 'pending', note: '由 WP36 命令行工作包实施' },
      { field: '遥测开关命令', module: 'telemetry', status: 'implemented' },
    ],
  },
];

/** 全部场景编号，按声明顺序。 */
export const COVERAGE_SCENARIOS: readonly string[] = CONTRACT_COVERAGE.map((entry) => entry.scenario);

/**
 * 按场景取契约覆盖。
 * @param scenario - 场景编号，例如 `S01`。
 * @returns 该场景的覆盖；不存在时抛出。
 */
export function coverageOf(scenario: string): ScenarioCoverage {
  const found = CONTRACT_COVERAGE.find((entry) => entry.scenario === scenario);
  if (found === undefined) throw new Error(`未登记的场景：${scenario}`);
  return found;
}

/** 待实施字段的合计。 */
export function pendingFields(): readonly ContractField[] {
  return CONTRACT_COVERAGE.flatMap((entry) => entry.fields.filter((field) => field.status === 'pending'));
}
