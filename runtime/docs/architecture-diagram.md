# 设计架构图

本文件把[架构设计](architecture.md)的文字设计画成图。每一节一幅图，图的节点与连线对应架构文档里的实体名、注册点与服务名，事实基线与架构文档同一份：`@deepseek-ai/dsh` 0.2.1-rc.2，Hermes 0.21.7，Hindsight 独立服务。

图的分工：架构文档说明设计与取舍，本文件说明结构与次序；每个专题的原论述留在架构文档与它引用的专题文档里，本文件不重复展开。

## 一、总体平面

四个平面。客户端平面只与控制平面对话，运行时平面只绑回环，数据平面分权威日志与只读副本两份。

```mermaid
flowchart TB
  subgraph C["客户端平面"]
    B["浏览器界面<br/>dsh-web-frontend 外壳"]
    E["Electron 壳<br/>主进程与渲染进程"]
    M["移动端应用"]
    T["命令行<br/>dsh-tui 插件"]
    X["外部程序<br/>MCP 客户端"]
  end
  subgraph P["控制平面 @chatdsh/gateway"]
    PROXY["反向代理与身份注入"]
    ACC["账号、会话归属、工作区成员"]
    DEV["设备注册与订阅"]
    SCH["定时任务调度"]
    PUSH["跨设备推送中枢"]
    SYNC["会话日志只读副本"]
    SHARE["分享快照服务端渲染"]
    SWITCH["chatBackend 与 memoryBackend 开关"]
    POOL["运行时进程池"]
    SUP["Hermes 生命周期托管与 Hindsight 探活"]
    POWER["强制不休眠电源策略"]
    EXT["扩展包安装记录与分发"]
  end
  subgraph R["运行时平面"]
    RT["每账号一个 DSH 进程<br/>只绑回环"]
    HS["Hermes 实例（可选）"]
  end
  subgraph D["数据平面"]
    LOG["权威会话日志<br/>JSONL zstd 或 Postgres"]
    IDX["工作区与检索索引<br/>SQLite FTS5 或 Postgres"]
    OBJ["附件与制品<br/>本地目录或对象存储"]
    MEM["记忆 bank<br/>Hindsight 或 Hermes 内置"]
    CP["控制平面 SQLite 或 Postgres<br/>账号、设备、任务、副本"]
    HST["Hermes state.db"]
  end
  B -->|"HTTPS 与 SSE"| PROXY
  E -->|"HTTPS 与 SSE"| PROXY
  M -->|"HTTPS 与 WebSocket"| PROXY
  T -->|"回环 HTTPS"| PROXY
  X -->|"MCP 协议"| RT
  PROXY -->|"回环，注入身份头部"| RT
  PROXY -->|"回环或 tailnet"| HS
  POOL -->|"按需启停"| RT
  SUP -->|"按 chatBackend 启停"| HS
  RT --> LOG
  RT --> IDX
  RT --> OBJ
  RT -->|"memoryBackend 为 hindsight 时"| MEM
  RT -->|"按 seq 追加只读副本"| SYNC
  RT -->|"事件信封与用量"| PROXY
  HS -->|"chatBackend 为 hermes 时"| MEM
  HS --> HST
  SWITCH -->|"下发配置与 bundles"| POOL
  ACC --> CP
  DEV --> CP
  SCH --> CP
  SYNC --> CP
  EXT --> CP
```

隔离分两层。账号与租户落在进程边界上，每账号一个 DSH 进程、一份 `$DSH_HOME`，进程内的授权层恒为 owner。工作区落在目录与归属判定上，会话创建时把工作区根目录写进 `cwd`，会话日志按 `cwd` 的项目键分目录存放。

## 二、控制平面的模块构成

`@chatdsh/gateway` 是独立 Node 服务，模块之间只经接口通信，存储访问走接口，单机落 SQLite。

```mermaid
flowchart LR
  subgraph ENTRY["接入层"]
    TLS1["回环 TLS 监听<br/>27777 供 Serve 转发"]
    TLS2["EasyTier TLS 监听<br/>27778 供反代 mTLS"]
    SHAREIN["分享访问"]
    HIN["Hermes 平台适配器接收端点"]
  end
  subgraph CORE["核心层"]
    AUTH["会话校验与设备令牌"]
    ROUTE["归属判定与设备路由"]
    IDINJ["身份头部注入"]
    SW["后端开关与电源策略"]
    SCHED["任务表与到期判定"]
    DELIV["设备订阅与投递分级"]
    SYNCW["副本写入与水位"]
    EXTW["扩展安装记录"]
  end
  subgraph OUT["对外能力"]
    PROXY2["反向代理到运行时"]
    PUSHW["WebSocket 与本地通知投递"]
    SHAREV["只读快照渲染"]
    POOLW["进程池与空闲回收"]
    HERMW["Hermes 启停与探活"]
    HINW["Hindsight 探活与降级标记"]
  end
  STORE[("存储接口：SQLite 或 Postgres")]
  TLS1 --> AUTH
  TLS2 --> AUTH
  SHAREIN --> SHAREV
  HIN --> DELIV
  AUTH --> ROUTE
  ROUTE --> IDINJ
  ROUTE --> POOLW
  IDINJ --> PROXY2
  SW --> POOLW
  SW --> HERMW
  SCHED -->|"唤醒运行时并投递消息"| POOLW
  SCHED -->|"直接推送"| DELIV
  DELIV --> PUSHW
  SYNCW --> SHAREV
  EXTW --> STORE
  POOLW --> STORE
  HERMW --> HINW
  HINW --> STORE
  AUTH --> STORE
  SCHED --> STORE
  DELIV --> STORE
  SYNCW --> STORE
```

控制平面不承载 agent 执行，也不写权威会话日志。它持有执行节点推送来的只读副本，承担跨设备浏览、会话导入与移动端冷读。

## 三、配置树的叠加顺序

配置树按固定顺序叠加，后写的层胜出。补丁覆盖整行 `config`，每行必须重述它拥有的全部键。

```mermaid
flowchart TB
  A["各组合包的 dsh.bundle.patch<br/>按 dsh.profile.bundles 的顺序展开"] --> B["profile 自身的 cordis.patch.yml"]
  B --> C["$DSH_HOME/cordis.patch.yml"]
  C --> D["--patch 覆盖层"]
  D --> E["遥测开关与启动参数"]
  E --> F["组合后的加载器条目树<br/>行 id 全局唯一"]
```

条目上的操作只有 `config`、`disabled`、`inject`、`intercept`、`isolate` 六项。`name` 是匹配校验条件，写错或 `id` 未匹配只打印警告，因此替换某个既有行的实现包要禁用该行再插入等价行。

## 四、三个平面的装配点

同一批自建包分别在三个平面各挂一次，依赖方向单向，插件之间经 `ctx` 服务名互相发现。

```mermaid
flowchart TB
  CONTR["@chatdsh/core-contracts<br/>只有类型与校验 schema"]
  PLUG["@chatdsh/core-* 与 @chatdsh/host-*<br/>注册 ctx 服务与加载器行"]
  PRESET["@chatdsh/preset-* 与 @chatdsh/tool-*<br/>会话平面挂载的工具"]
  CLIN["@chatdsh/client-*<br/>声明 dsh.client"]
  BUND["@chatdsh/bundle-*<br/>声明 dsh.bundle.patch"]
  PROF["profile 的 dsh.profile.bundles"]
  GW["@chatdsh/gateway"]
  CONTR --> PLUG
  CONTR --> PRESET
  CONTR --> CLIN
  PLUG --> BUND
  PRESET --> BUND
  CLIN --> BUND
  BUND --> PROF
  GW --> CONTR
```

三个平面对应的加载时机与注册点如下。

```mermaid
flowchart TB
  subgraph HOST["宿主平面：随进程加载一次"]
    H1["core-identity 注册 ctx.provide，取身份供分派与审计"]
    H2["core-telemetry 注册 ctx.chatdshTelemetry，唯一遥测出口"]
    H3["core-session-index 写 ctx.sessionProjections"]
    H4["host-projects 扩展 ctx.storageDomain"]
    H5["host-artifacts 用 ctx.storageDomain 与 ctx.attachments"]
    H6["host-assistants 写 dsh-agent-preset-registry"]
    H7["host-connectors 生成 MCP 客户端行并注册授权流"]
    H8["host-push 上报会话事件"]
    H9["host-usage 取每轮用量"]
    H10["host-approval 折叠审批投影，写 plugin 记录并回传应答"]
    H11["host-import 提供导入恢复的远端方法"]
    H12["host-memory 在 agent/pre-step 召回与写入"]
  end
  subgraph SESS["会话平面：随会话挂载 preset"]
    S1["tool-bash 或 tool-pwsh，按平台二选一"]
    S2["tool-fs、tool-fs-search、tool-skill"]
    S3["tool-jobs、tool-todo、tool-web"]
    S4["自建工具行 artifact、project、image、research、connector、share"]
    S5["tool-browser 默认不挂进 preset"]
    S6["chatBackend 为 hermes 时聊天会话用空 preset"]
  end
  subgraph CLI["客户端平面：浏览器产物"]
    C1["client-projects、client-artifacts、client-memory"]
    C2["client-assistants、client-connectors"]
    C3["client-account、client-share、client-approval"]
    C4["client-telemetry"]
  end
  HOST --> SESS
  SESS --> CLI
```

桌面控制的两行留在宿主平面，因为 `dsh-computer-use` 的注册位是整棵运行时共用的单例，同一运行时第二次注册直接抛出异常，提供方又把工具注册进宿主工具表。

## 五、组合包的组合方式

存储、聊天后端、记忆后端、桌面壳与命令行各自成组合包，由 profile 的 bundles 列表选择。组合包之间不表达「基础」关系，同一组合包在列表里只出现一次。

当前实现的组合包六个：`bundle-hosted`、`bundle-worker`、`bundle-desktop`、`bundle-storage-jsonl`、`bundle-memory-hindsight`、`preset-chat`。图中 `bundle-storage-postgres` 与 `bundle-chat-hermes` 尚未实现。

```mermaid
flowchart TB
  DSHB["@deepseek-ai/dsh-base"] --> STORE
  HOSTB["@chatdsh/bundle-hosted"] --> STORE
  PBASE["@chatdsh/preset-chat"] --> STORE
  subgraph STORE["存储后端：二选一"]
    JS["bundle-storage-jsonl<br/>单机与桌面"]
    PG["bundle-storage-postgres<br/>团队版"]
  end
  subgraph CHAT["聊天后端：按 chatBackend"]
    HERB["bundle-chat-hermes<br/>chatBackend 为 hermes 时加入"]
    DSHB2["不加入即 chatBackend 为 dsh<br/>聊天由 DSH 的 agent 执行"]
  end
  subgraph MEM["记忆后端：按 memoryBackend"]
    HINB["bundle-memory-hindsight<br/>memoryBackend 为 hindsight 时加入"]
    HERMEM["memoryBackend 为 hermes<br/>记忆随 Hermes 内置"]
    NONE["不加入即 memoryBackend 为 none"]
  end
  subgraph FORM["形态专属"]
    WEBAPP["dsh-web-app<br/>Web 与桌面"]
    DESKB["bundle-desktop"]
    TUI["dsh-tui<br/>命令行"]
    WORKB["bundle-worker"]
    HEADL["dsh-headless<br/>长任务"]
  end
  WEBAPP --> STORE
  DESKB --> FORM
  TUI --> FORM
  WORKB --> FORM
  HEADL --> FORM
  STORE --> CHAT
  STORE --> MEM
  CHAT --> FORM
  MEM --> FORM
```

四个 profile 的实际 bundles 如下。

```mermaid
flowchart LR
  P1["chatdsh-web"] --> L1["dsh-base、dsh-web-app、bundle-hosted、preset-chat"]
  P2["chatdsh-desktop"] --> L2["dsh-base、dsh-web-app、bundle-storage-jsonl、bundle-hosted、bundle-desktop、preset-chat"]
  P3["chatdsh-cli"] --> L3["dsh-base、dsh-tui"]
  P4["chatdsh-worker"] --> L4["dsh-base、dsh-headless、bundle-hosted、bundle-memory-hindsight、bundle-worker"]
```

## 六、客户端模块加载次序

浏览器侧的启动协议由 `window.__DSH_BOOT__` 与 `window.__ModuleLoader__` 两个全局量构成。引导顺序是硬约束：注册队列先于 bootstrap 脚本，bootstrap 注册先于模块系统创建。

```mermaid
sequenceDiagram
  participant H as 运行时 dsh-client-modules
  participant P as 浏览器 HTML
  participant M as window.__ModuleLoader__
  participant C as createClientModuleSystem
  participant E as 客户端插件模块
  H->>H: 扫描加载器树中声明 dsh.client 的包
  H->>H: 按模块图排序，生成 window.__DSH_BOOT__
  H->>H: bootInjections 生成按执行顺序排列的头部注入行
  H-->>P: 首页内嵌注入行与模块图
  P->>M: 建立注册队列 window.__ModuleLoader__
  P->>M: 执行 bootstrap 脚本并注册模块
  P->>C: 调用 create() 建立模块系统
  C->>C: 按模块图解析依赖
  C->>E: 请求 /plugins/id/client.js
  E-->>C: 返回 window.__ModuleLoader__ 形态的产物
  C->>E: 实例化并挂载界面席位
```

自建的九行客户端条目必须落在 profile 自己的补丁层：模块图按加载器条目的来源目录解析包元数据，组合包插入的行会以组合包所在目录为基准，自建包只安装在 profile 的 `node_modules` 里。

## 七、一次会话回合

消息进入运行时，经 agent 循环、工具执行与模型调用，事件写进权威日志，同时按 `seq` 推给控制平面形成只读副本。

```mermaid
sequenceDiagram
  participant CL as 客户端
  participant GW as 控制平面
  participant RT as 运行时
  participant PR as 会话投影
  participant AG as agent 循环
  participant TL as 工具执行
  participant LM as 模型调用
  participant LG as 权威会话日志
  participant SY as 控制平面副本
  CL->>GW: 提交消息，带 requestId 与 traceparent
  GW->>GW: 校验应用会话，判定归属与设备
  GW->>RT: 转发请求，注入身份头部与 traceparent
  RT->>PR: agent/pre-step 注入项目指令与记忆召回
  RT->>AG: 追加用户消息，开启回合
  AG->>LM: 请求模型，stream 入口做额度检查
  LM-->>AG: 流式事件
  AG->>TL: 调用工具
  TL->>TL: guard 与审批瀑布判定
  TL-->>AG: 工具结果
  AG->>LG: 追加表面事件与工具记录
  AG->>SY: 推送事件信封与同步水位
  SY-->>CL: 广播给该账号的订阅端
  AG->>PR: 折叠回合用量
  AG->>GW: 回合结束上报
```

会话日志的写入语义固定：事件序号从 0 连续且永不重写，撕裂的物理尾部不返回给读者，读取路径对未知词汇关闭式拒绝，`append` 尽力而为而 `flush` 是耐久屏障。写句柄是单写者所有权，已有活跃所有者时以 `SessionAlreadyOwnedError` 拒绝。

分叉的语义也在这一层。`SessionStore.fork` 复制含边界的前缀，在切点补一条 `inherited: true` 的 `session/end-seed`，合成闭合事件占用切点之后的序号，因此新会话的第一条事件序号取持久化日志当前末端。客户端保存的游标因此是 `(sessionId, fork 标识, seq)` 三元组。

## 八、数据落盘布局

数据根下先分租户，再分账号，每账号一份 `$DSH_HOME`。租户目录从第一天就存在，单机下只有一个 `default`。

当前实现的落盘只有三处：控制平面的 SQLite 库（图中 `gateway` 那一支）、各账号的 `$DSH_HOME`（含 `profiles` 与 `sessions`）、以及 `logs`。租户目录、`objects`、`hermes` 与 `chat` 四个子目录尚未实现——附件与制品走存储域，不落在文件系统里。

```mermaid
flowchart TB
  R["数据根"] --> G["gateway：控制平面 SQLite 库、密钥、设备与订阅、任务表、会话日志副本"]
  R --> T["tenants/default：单机下唯一的租户"]
  R --> L["logs：带租户与账号标记"]
  R --> O["objects：附件与制品"]
  T --> A["accounts/accountId：每个账号一个运行时的数据"]
  A --> H["harness：即 DSH_HOME，含 profiles、sessions、settings.yaml"]
  A --> M["hermes：HERMES_HOME，chatBackend 为 hermes 时存在"]
  A --> C["chat：聊天会话的专用 cwd，不构成工作区"]
  A --> W["workspaces/workspaceId：各工作区的根目录"]
  H --> S["sessions/projectKey/sessionDir/session.v版本.jsonl.zstd"]
  H --> PR["profiles/名称：manifest 与 cordis.patch.yml"]
```

## 九、聊天后端与记忆后端的四种组合

两个开关互相独立，不互相推导。`chatBackend` 为 `dsh` 时 `memoryBackend` 只能是 `hindsight` 或 `none`。

```mermaid
flowchart TB
  START["两个独立开关"] --> C1{"chatBackend"}
  C1 -->|"hermes"| C2{"memoryBackend"}
  C1 -->|"dsh"| C3{"memoryBackend"}
  C2 -->|"hermes"| R1["聊天与记忆都由 Hermes 内置承载"]
  C2 -->|"hindsight"| R2["聊天走 Hermes，记忆走 Hindsight 的 bank"]
  C2 -->|"none"| R3["聊天走 Hermes，记忆不启用"]
  C3 -->|"hindsight"| R4["聊天与工作会话都由 DSH 执行，记忆走 Hindsight"]
  C3 -->|"none"| R5["聊天与工作会话都由 DSH 执行，记忆不启用"]
```

工作会话始终由 DSH 的 agent 执行，不随这两个开关变化。关闭某个后端属于正常配置，不留下失败的服务、不产生告警日志、不占端口。

## 十、四种形态的进程模型

```mermaid
flowchart TB
  subgraph WEB["Web 形态"]
    W1["浏览器界面"] --> W2["控制平面"]
    W2 --> W3["每账号一个 DSH 进程，随机回环端口"]
  end
  subgraph DESK["桌面形态"]
    D1["启动器：单实例锁、launch-root、拉起控制平面"] --> D2["控制平面：回环 27777 与 EasyTier 27778"]
    D2 --> D3["每账号一个 DSH 进程"]
    D2 --> D4["Hermes 实例，可选"]
    D2 -->|"反向代理并注入身份"| D5["渲染进程"]
    D5 -->|"HTTP 与 SSE"| D2
  end
  subgraph CLIM["命令行形态"]
    C1["dsh-tui"] --> C2["控制平面"]
    C2 --> C3["运行时"]
    C4["非交互模式"] --> C5["dsh --profile headless"]
  end
  subgraph MOB["移动端形态"]
    M1["原生应用"] --> M2["控制平面"]
    M2 --> M3["运行时或远程执行节点"]
  end
```

四种形态的客户端都只与控制平面对话。移动端的三条路线里，设备本地跑完整运行时的形态在 iOS 上不允许存在，手机直连同一台电脑上运行时的形态承载不了互不信任的多个人，因此产品主线是原生应用连控制平面。

## 十一、远程执行节点

执行节点在 NAT 之后无法被直连，因此它主动向控制平面建立长连接，这条连接同时承担指令下发、事件接收与路由。

```mermaid
flowchart LR
  GW2["控制平面"]
  DEVD["设备表：deviceId、syncScope、能力声明"]
  CL2["客户端 B"]
  RA["执行节点 A 的 DSH 进程"]
  WA["节点 A 的工作区目录"]
  LA["节点 A 的本地权威日志"]
  RB["执行节点 B 的 DSH 进程"]
  WB["节点 B 的工作区目录"]
  LB["节点 B 的本地权威日志"]
  CP2[("控制平面的只读副本")]
  CL2 -->|"发消息，按 deviceId 路由"| GW2
  CL2 -->|"打开节点 A 的会话只读"| GW2
  CL2 -->|"选择继续并导入"| GW2
  GW2 -->|"已建立的长连接"| RA
  GW2 -->|"已建立的长连接"| RB
  RA -->|"事件推送与同步水位"| GW2
  RB -->|"事件推送与同步水位"| GW2
  GW2 --> CP2
  RA --> WA
  RA --> LA
  RB --> WB
  RB --> LB
  GW2 -.->|"deviceId 与 cwd 写入后不可改"| DEVD
```

设备离线时该节点上工作区的会话只读并明确报设备离线，不改路由、不排队、不回退到宿主机执行。导入读的是控制平面持有的副本，因此源设备离线时仍可导入。

## 十二、审批与通知分级

应答路径只有一个写入者，处理结果作为会话事件广播，各端卡片据此收敛。

```mermaid
sequenceDiagram
  participant AG as agent 或 Hermes
  participant RT as 运行时
  participant GW as 控制平面
  participant D1 as 第一级设备
  participant D2 as 其余在线设备
  AG->>RT: 产生审批请求
  RT->>RT: 首个应答进入处理中，回传审批来源
  RT->>GW: 写入 plugin 记录作为会话事件
  GW->>D1: 第一级投递
  GW->>D2: 等待阈值后投递
  D1->>RT: 应答
  RT->>RT: 其余并发应答返回已被处理
  RT->>GW: 处理结果广播
  GW->>D2: 卡片收敛为已处理并撤回通知
```

审批与提问卡片都要求真实回合或真实的工具执行。没有回合的场景自建投影与事件。

## 十三、遥测管道与上下文传播

宿主进程、桌面主进程、命令行与移动端各自在进程内建立 exporter 直发 OTLP/HTTP；浏览器不持有凭据，经运行时同源端点上报。

```mermaid
flowchart TB
  S1["控制平面 chatdsh-gateway"]
  S2["运行时宿主平面 chatdsh-runtime"]
  S3["会话平面与工具 chatdsh-runtime"]
  S5["桌面主进程 chatdsh-desktop"]
  S6["移动端 chatdsh-mobile"]
  S7["命令行 chatdsh-cli"]
  S8["长任务 chatdsh-worker"]
  S9["MCP 服务端 chatdsh-mcp"]
  SVC["ctx.chatdshTelemetry<br/>统一服务契约：event、log、counter、histogram、gauge、span、inject、extract"]
  EX1["进程内 OTLP exporter"]
  S4["浏览器客户端 chatdsh-browser"]
  RELAY["运行时同源中继，browser 上报端点"]
  OBS[("OpenObserve：chatdsh_logs、chatdsh_traces、chatdsh 指标流")]
  S1 --> SVC
  S2 --> SVC
  S3 --> SVC
  S5 --> SVC
  S6 --> SVC
  S7 --> SVC
  S8 --> SVC
  S9 --> SVC
  S4 -->|"同源上报"| RELAY
  RELAY --> SVC
  SVC --> EX1
  EX1 -->|"OTLP/HTTP JSON"| OBS
  SVC -.->|"开关关闭时不构造 SDK 与 exporter"| OFF["关闭态：无出站连接、不生成 traceparent"]
```

跨组件边界的上下文载体如下。缺一项就会出现断链。

```mermaid
flowchart LR
  B2["浏览器"] -->|"HTTP 头 traceparent"| G2["控制平面"]
  G2 -->|"HTTP 头 traceparent，透传不重写"| R2["运行时"]
  R2 -->|"环境变量 TRACEPARENT"| SUB["工具子进程"]
  R2 -->|"Remote 信封字段"| CL3["其他客户端"]
  G2 -->|"SSE 与 WebSocket 每批事件"| B2
  GW3["任务表列 traceparent"] -->|"延迟执行时还原"| R2
  M3["MCP 客户端"] -->|"params._meta.traceparent"| M4["MCP 服务端"]
  DT["桌面主进程"] -->|"消息字段 traceparent"| DR["渲染进程"]
  MB3["移动端"] -->|"HTTP 头 traceparent"| G2
```

## 十四、构建与验收的对应关系

每一张图对应一组可执行的检查。

```mermaid
flowchart TB
  G1["第三节 配置树"] --> V1["check-composition：退出码、警告为空、条目 id 唯一"]
  G2b["第四节 装配点"] --> V2["check-plugin-contract：engines.dsh、dsh.client、dsh.bundle.patch、dsh.profile.bundles"]
  G2b --> V3["check-profile-deps：profile 依赖覆盖组合包插入的全部自建插件"]
  G3["第六节 客户端加载"] --> V4["verify-client-asset：产物可取回、条目图包含自建包"]
  G3 --> V5["verify-client-ui：真实 Chrome 走完首次进入流程"]
  G4["第七节 会话回合"] --> V6["verify-acp：创建会话、恢复会话、核对投影落盘"]
  G5["第九节 开关组合"] --> V7["verify-memory：对 Hindsight 做写入与召回"]
  G6["第十一节 执行节点"] --> V8["verify-routing 与 verify-routing-live：反代落到各自运行时"]
  G6 --> V9["verify-import：带 parentSession 的导入与跨账号拒绝"]
  G6 --> V10["verify-isolation：归属隔离与跨账号拒绝"]
  G6 --> V11["verify-multi-client 与 verify-receipt-sync：序列一致与已读水位"]
  G7["第十三节 遥测"] --> V12["check-telemetry：包内声明、源码与文档清单三处一致"]
  G7 --> V13["verify-telemetry-sync：连接器同步与导出核对"]
  G8["第十二节 审批与推送"] --> V14["verify-schedule：到期任务执行与定时推送"]
```

各项验收的当前状态与所缺条件记在[验收状态](acceptance.md)与[后续清单](next-steps.md)。

上游的引用面不在这些图里，它由架构文档第四节的适配层承担。上游包名、事件名与服务名的取值都收在 `@chatdsh/adapter`，`check-upstream-names` 核对本仓库各处出现的上游包名都在适配层的登记处出现过。上游发版时改适配层一处，检查脚本指出其余需要跟着改的位置。