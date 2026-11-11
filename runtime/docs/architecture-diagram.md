# 设计架构图

本文件表达[插件平台架构](plugin-platform.md)的结构与调用次序。提供方职责和接口语义使用平台契约，DSH 装载事实使用[架构设计](architecture.md)，设备与数据行为使用[系统完成设计](system-completion-design.md)。这些图表示目标结构，真实状态使用[验收记录](acceptance.md)。

## 一、产品与标准能力

```mermaid
flowchart TB
  WEB[Web、桌面与 PWA]
  CLI[本机 CLI]
  GW[访问认证、设备路由与只读索引]
  PRODUCT[会话、Super-Agent、自动化与领域界面]
  API[ctx.chatdshCapabilities]
  INTEGRATIONS[DSH、社区插件与外部服务适配器]
  CORE[DSH Agent、Cordis、工具与会话存储]
  PLUGIN[用户选择的原生插件]
  DATA[提供方原生数据]
  WEB --> GW
  GW --> PRODUCT
  CLI --> PRODUCT
  PRODUCT --> API
  API --> INTEGRATIONS
  INTEGRATIONS --> CORE
  INTEGRATIONS --> PLUGIN
  CORE -->|装载| PLUGIN
  PLUGIN --> DATA
```

## 二、安装与能力绑定

```mermaid
sequenceDiagram
  participant U as 用户
  participant P as 平台插件页
  participant D as DSH 插件管理
  participant L as Cordis Loader
  participant A as 提供方适配器
  participant C as 标准能力服务
  U->>P: 选择原生插件与精确版本
  P->>D: 原生安装与依赖解析
  D->>D: 清单兼容与依赖锁定
  D-->>P: 安装完成，原生行保持停用
  U->>P: 选择领域提供方和作用范围
  P->>C: 按 revision 提交绑定
  C->>C: 验证操作、角色、范围和冲突
  alt 原生插件需要重启
    C-->>P: 等待重启与实际装载
  else 可以生效
    C->>L: 发布配置并唯一装载
    L->>A: 启动并核验公开接口
    A->>C: 注册实际操作与资源
    C-->>P: 发布新的绑定版本
  end
```

## 三、配置与依赖

```mermaid
flowchart TB
  B[原生 bundle patch，按 profile 顺序]
  P[profile cordis.patch.yml]
  H[DSH_HOME cordis.patch.yml]
  O[启动参数与遥测关闭来源]
  L[原生 Loader 条目与服务]
  C[标准能力契约]
  A[提供方适配器]
  U[产品消费者]
  S[能力注册和绑定解析]
  B --> P --> H --> O --> L
  A -->|依赖| C
  U -->|依赖| C
  S -->|依赖| C
  A -->|注册操作| S
  L -->|装载| A
```

## 四、标准记忆调用

```mermaid
sequenceDiagram
  participant U as 界面或真实 Agent
  participant C as 标准记忆服务
  participant A as 所选插件适配器
  participant P as 插件公开服务或 API
  participant D as 原生存储
  U->>C: 范围、操作参数与业务操作标识
  C->>C: 验证身份、归属和绑定快照
  C->>C: 检查操作能力并解析原生范围
  C->>A: 经过授权的调用与截止时间
  A->>P: 原生操作
  P->>D: 检索或写入
  D-->>P: 原生结果与提交状态
  P-->>A: 记录或原生操作标识
  A->>A: 校验并转换结果
  A-->>C: 标准结果或明确错误
  C-->>U: 保留来源、绑定版本和实际状态
```

受理状态未知时查询原操作。插件不支持原生幂等或取消时显示限制，不自动重放写入。

## 五、自动生命周期与项目范围

```mermaid
flowchart TB
  B[每个范围的记忆绑定]
  O{生命周期负责人}
  N[原生插件监听与后台任务]
  P[平台安排原生公开操作]
  M[用户或 Agent 显式调用]
  R[宿主验证普通会话、Router、Worker 与子代理范围]
  G{原生行为满足范围约束}
  Y[允许对应能力参与]
  F[拒绝启用冲突组合]
  B --> O
  O -->|native| N
  O -->|platform| P
  O -->|manual| M
  N --> R
  P --> R
  M --> R
  R --> G
  G -->|通过| Y
  G -->|失败| F
```

平台安排或显式模式要求对应原生自动行为已经关闭。未应用成果保持在任务记录和成果数据中，经过人工决定后才可以进入共享记忆。

## 六、设备、数据与客户端

```mermaid
flowchart LR
  SHELL[Web、桌面、PWA 共用外壳]
  FRAME[一个活动设备 iframe]
  GW[控制平面与只读会话副本]
  A[设备 A 的 DSH 与能力服务]
  B[设备 B 的 DSH 与能力服务]
  LA[设备 A 的权威日志与工作区]
  LB[设备 B 的权威日志与工作区]
  MA[提供方 A 的原生数据]
  MB[提供方 B 的原生数据]
  SYNC[提供方明确支持的共享或同步]
  SHELL --> GW
  SHELL --> FRAME
  FRAME --> GW
  GW -->|按会话归属| A
  GW -->|按会话归属| B
  A --> LA
  B --> LB
  A --> MA
  B --> MB
  MA --> SYNC
  MB --> SYNC
  A -->|只读副本| GW
  B -->|只读副本| GW
```

项目关联只保存原生范围映射，实际共享依赖提供方。离线输入保留草稿，已受理任务在所属设备执行，绑定切换不自动迁移原生数据。

## 七、遥测与关闭

```mermaid
flowchart TB
  C[能力分派与适配器]
  T[ctx.chatdshTelemetry]
  H[host-telemetry 与 core-diagnostics]
  O[OpenObserve]
  S{任一关闭来源生效}
  OFF[无 SDK、exporter、端点与 traceparent]
  C --> T --> S
  S -->|关闭| OFF
  S -->|启用| H --> O
```

提供方内部不支持上下文传播时标明追踪边界。插件自身遥测必须遵守部署关闭和内容限制，标准调用日志不记录记忆、提示词与结果正文。

## 八、验收依赖

```mermaid
flowchart TB
  C[PA01 标准契约与 DSH 映射]
  R[PA02 注册、绑定和权限]
  L[PA03 原生装载与生命周期]
  A[PA04 提供方真实适配]
  U[PA05 产品消费者]
  S[PA06 Super-Agent 角色与成果规则]
  D[PA07 数据和升级]
  P[PA08 发行组合]
  C --> R
  R --> L
  R --> A
  L --> U
  A --> U
  U --> S
  A --> D
  S --> P
  D --> P
```

原生清单、真实装载、标准操作和真实模型服务分别提供证据。每个提供方的完成条件使用[平台实施契约](plugin-platform.md#12-实施与验收)，结构检查使用现有组合、插件、依赖和遥测检查脚本。
