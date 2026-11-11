# Super-Agent 开发设计

本目录规定项目级 Super-Agent 的产品契约，适用于 Web、桌面、PWA 和本机 CLI。执行、编排、记忆和制品通过[平台标准能力](../plugin-platform.md)接入 DSH 原生服务与所选插件，平台维护项目归属、人工决定和成果应用规则。当前业务实现尚未接入，设计附件检查只证明相应设计条件，功能通过情况由真实系统验收决定。

## 1. 开发输入

| 文件 | 权威内容 |
|---|---|
| [architecture.md](architecture.md) | 产品规则、组件职责、配置、生命周期与客户端流程 |
| [coordination.md](coordination.md) | Router 唤醒、目标预算、任务分派、输入投递与角色提示词 |
| [protocol.md](protocol.md) | 接口路径、调用身份、请求校验、事件与错误 |
| [contracts.ts](contracts.ts) | 接口类型、枚举、固定默认值与执行端口 |
| [storage.md](storage.md) | 事务、写入顺序、授权、迁移与备份 |
| [schema.sql](schema.sql) | 设备侧数据库第一版结构、索引和数据库约束 |
| [execution.md](execution.md) | 各平台执行器、目录与网络权限、进程管理和 Git 算法 |
| [implementation.md](implementation.md) | SA01–SA09 写入范围、依赖和逐项验收 |
| [verification.md](verification.md) | 设计附件验证的真实命令、覆盖范围与结果 |

开发按 SA01–SA09 的依赖执行，每个工作包同步交付遥测与验收。本文档采用[现有系统契约](../system-completion-design.md)、[客户端通用规则](../client-complete-spec.md)和[遥测规范](../telemetry.md)。本目录负责 Super-Agent 的具体行为；普通会话继续采用原契约。

## 2. 必须保持的产品行为

1. 项目默认使用 `single-session`，允许设置默认 `super-agent`；本次选择优先于项目默认值。普通会话独立执行，历史与自动记忆默认不进入 Router。
2. 每项目一个 Super-Agent 主会话和一个有效 Router。重复进入、多个窗口、并发启用均返回同一项目主会话。
3. Git 工作目录可以启用，尚无提交的仓库也可以启用。非 Git 目录置灰并显示原因。项目无需自动初始化仓库或创建占位提交。
4. 根 Worker 的初始代码取任务创建时的 `HEAD`；无提交时取空代码基准。原目录的未提交代码不自动纳入。
5. 每个 Worker 使用独立工作目录和独立 Git 索引、引用；参考目录直接指向项目登记的原始目录，多任务实时共享、只读、按需读取。
6. Router 可以在用户目标、权限与预算内自动分派 Worker；Worker 可以创建一层子代理，子代理无法继续创建子代理。
7. 跨任务使用未应用成果时必须询问用户，授权绑定成果版本与消费任务。同一任务内的子代理继承已授权输入。
8. 成果进入待审阅状态。用户明确选择“应用”或“应用并提交”。后一操作只提交本次审阅的成果，推送另行授权。
9. 运行时、插件或执行器中断后，执行中和排队任务等待用户决定恢复范围。读取状态和核验实际操作可以自动进行，继续执行需要用户决定。
10. 客户端关闭不停止已受理任务。客户端离线的新输入仅保留草稿，恢复连接不自动重发。

## 3. 现有实现的接入位置

| 位置 | 接入要求 |
|---|---|
| [项目存储](../../packages/host/projects/src/domain.ts) | 为既有路径身份增加持久 `projectId` 和默认执行模式；项目身份映射保留至明确清理 |
| [项目上下文](../../packages/host/projects/src/index.ts) | 根据受信任的任务归属解析项目，独立目录获得正确项目说明 |
| [创建会话](../../packages/client/shell/src/client/api.ts) | 普通模式调用原创建接口；Super-Agent 模式调用项目进入接口 |
| [标准记忆能力](../plugin-platform.md#6-记忆标准接口) | 宿主解析角色，提供方适配器同时约束标准调用、原生监听与后台整理，执行项目授权范围 |
| [模型额度](../../packages/host/llm-router/src/quota.ts) | 增加设备侧原子预留、结算和请求次数限制 |
| [会话血缘](../architecture.md)第二节 | `parentSession` 保留历史分叉含义；任务归属采用本目录的独立关联字段 |
| [版本规则](../compatibility.md) | 适配仓库基线版本并验证所需能力，禁止将本机较新接口视为基线已具备 |

现有包数量、profile 数量和功能验收台账保持实际值。新增包与能力在实施交付时登记，设计文件不改变现有通过记录。
