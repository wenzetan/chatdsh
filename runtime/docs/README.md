# 文档总纲

本文件是文档入口，规定权威顺序、事实基线、状态词表与进度台账。平台职责、标准能力接口和提供方选择使用[插件平台架构](plugin-platform.md)，具体类型使用[接口附件](plugin-platform/contracts.ts)。客户端行为使用[完整规格](client-complete-spec.md)，设备通信和数据契约使用[系统完成设计](system-completion-design.md)，实施入口使用[设计交付](design-delivery.md)。实现程度继续按真实验收证据登记。

文档不一致的根源有两个：同一事实在多份文档里各写一份，改一处漏一处；参考项目（`refer_repos/`）里的做法与结论被写进设计文档正文，读起来像本项目的现状。本文件用两条规则处理这两件事：事实只在指定的权威文档里定义一次，其余文档引用它；参考实现只能出现在“参考实现核验”一类段落里，并标明它是参考而非现状。

## 一、权威顺序

同一事实在多份文档里出现时，以本表指定的一份为准。其余文档只引用，不复述细节。

| 事实类别 | 权威文档 | 说明 |
|---|---|---|
| 插件平台、标准能力、提供方选择和适配器职责 | [plugin-platform.md](plugin-platform.md) | 能力归属、绑定、生命周期、接口与 PA01–PA08，其他设计按此确定自建范围 |
| 目标形态、形态差异与取舍 | [target-shape.md](target-shape.md) | 基础形态以此为准；完整系统契约和客户端细节由[系统完成设计](<system-completion-design.md>)与[完整交互规格](<client-complete-spec.md>)细化 |
| 未完成系统能力的最终契约 | [system-completion-design.md](<system-completion-design.md>) | 协议、安全、迁移、数据连续、后端、资源预算与 AC-SYS01–08 |
| 项目级 Super-Agent | [superagent/README.md](superagent/README.md) | 项目共享 Router、独立执行目录、接口、数据库、权限、Git 应用恢复与 SA01–SA09；当前为待实施设计 |
| 插件与组合包契约、上游内部接口的事实 | [architecture.md](architecture.md) 第二、四节 | 每条都带源码证据路径 |
| 部署组件、数据布局、必须第一天做对的接缝 | [deployment.md](deployment.md) | 存储后端与密码学约定以它为准 |
| 聊天执行体与记忆提供方的接入 | [hermes-integration.md](hermes-integration.md) | 外部执行体桥接与插件记忆的职责，范围及生命周期使用平台架构 |
| 桌面与移动端载体、推送与送达 | [desktop-mobile.md](desktop-mobile.md) | 移动端形态以 target-shape 1.1 节为准 |
| 移动端接入协议 | [mobile-protocol.md](mobile-protocol.md) | 请求形状、认证顺序、事件折叠 |
| 客户端模块分层与席位 | [client-modules.md](client-modules.md) | 席位名以上游行列表为准 |
| 界面功能点与实现程度 | [ui-feature-inventory.md](ui-feature-inventory.md) | 状态取值见本文件第三节 |
| 完整设计、交互与实施验收 | [design-delivery.md](<design-delivery.md>) | 连接系统完成设计、客户端规格、工作包和验证结果 |
| 客户端页面、字段、状态与无障碍 | [client-complete-spec.md](<client-complete-spec.md>) | 最终目标交互；产品稿为 [S01–S32](<ui-design/complete.html>) |
| 界面令牌与组件规格 | [ui-baseline-design.md](ui-baseline-design.md) | 完整稿的可访问性修订与尺寸优先；原参考页作为基础样张 |
| 遥测信号清单与命名 | [telemetry.md](telemetry.md) 第六节 | 构建检查与它比对 |
| 上游能力处置（保留、禁用、受限挂载） | [upstream-capabilities.md](upstream-capabilities.md) | `check-capabilities.mjs` 与补丁层比对 |
| 上游版本与本仓库对应关系、升级步骤 | [compatibility.md](compatibility.md) | 适配层设计见 architecture 4.1.1 |
| 验收状态与复现命令 | [acceptance.md](acceptance.md) | 状态取值见本文件第三节 |
| 验收顺序与解锁条件 | [next-steps.md](next-steps.md) | 按阶段排列，与 acceptance 章节对应 |
| 网络可达性与反代约束 | [reachability.md](reachability.md) | 绑定地址约束以它为准 |
| 凭据与隐私防护 | [secret-guard.md](secret-guard.md) | 提交与推送两处钩子 |
| 桌面控制评审过程 | [computer-use-design-review.md](computer-use-design-review.md) | 设计正文在 architecture 7.8 节 |
| 主题插件契约 | [theme-plugin-contract.md](theme-plugin-contract.md) | 可选能力，尚未实现运行时 |
| 结构与次序的图 | [architecture-diagram.md](architecture-diagram.md) | 只画图，不复述取舍 |

### 1.1 参考项目与模块的对应

`refer_repos/` 默认不读，读取约束见 [`AGENTS.md`](../../AGENTS.md) 与 [`runtime/AGENTS.md`](../AGENTS.md) 的「参考目录」一节，以及专为该目录准备的 `refer_repos/AGENTS.md`。

下表是本项目已知的对应关系，作为检索起点用，不是白名单。它记录的是到目前为止已经核验过、确实对本项目某个模块有过参考价值的项目与切入点。

| 模块 | 首选参考项目 | 可以核对什么 |
|---|---|---|
| Electron 桌面壳的构建与补丁 | `dataelement_dsh-desktop` | 补丁流程、原生能力落点、安装器、权限处理 |
| Electron 桌面壳的多包组织 | `anywhere-labs_dsh-desktop` | 工作区组织、补丁格式、更新通道 |
| 移动端客户端形态 | `Clarklevis1995_dsh-mobile` | 客户端与内核的职责划分、协议解码与事件折叠 |
| 移动网关插件接入 | `Clarklevis1995_dsh-plugin-mobile-gateway` | 移动网关的插件挂载方式 |
| 客户端插件独立打包 | `saya-ch_dsh-mobile` | 浏览器侧作为独立 npm 包发布的产物形态 |
| 轻量客户端形态 | `shaobeichen_dsh-pocket` | 轻量客户端的反向代理与插槽注册 |
| 移动端打包流程 | `kelai141_dsh-mobile-apk` | 把运行时装进设备的打包做法 |
| 多包仓库组织与单工具多操作面 | `ZCode` | 仓库组织、工具目录收敛 |
| 逆向分析工具（对照检索） | `rea_workbuddy` | 与本项目无直接设计关系，仅供对照 |

表是起点，遇到下面三种情形要离开表去探索，探索范围由问题本身决定。

**第一种：表里没有覆盖这个问题。** 按目录名、项目顶层结构，以及它的 `README` 与 `package.json` 判断哪几个可能相关，挑最贴近的一两个看。

**第二种：表里给的项目不足以回答。** 一个问题常常横跨多份实现，例如“设置页怎么在多个客户端之间共享同一个数据源”会同时涉及桌面壳、客户端插件与多包组织。允许跨项目看，允许拿两三个项目对比各自的取舍。

**第三种：已有项目里的做法过时或不适用。** 上游界面结构与约定会变，旧项目里的做法可能已经不成立。这时去看更新的项目，或者直接看上游产物本身，以能跑通的那一份为准。

探索有两条边界。一条是进入之前先明确要回答的具体问题，带着问题去找答案，不通读整个仓库。另一条是结论归本项目所有：别人的做法可以当作候选方案或反例，最终设计要按本项目的约束独立写出来，并且能脱离参考项目独立成立。

读之前先从本文件第一节查该模块的权威文档，取到本项目既定设计。参考项目用来找候选、看代价、避开别人踩过的坑，不用来定案。

## 二、事实基线

下表是全书共用的基线。任何文档引用版本号、包数量、路径时都以此为准，不在正文里另写一份。

| 项 | 值 | 取法 |
|---|---|---|
| DSH 内核 | 仓库钉住 `0.2.1-rc.2`；本机当前安装 `0.2.1-rc.5` | 仓库侧看 `dsh-adapter/package.json` 的 `engines.dsh` 与各 profile 的依赖版本；本机看 `$DSH/package.json` 的 `version` |
| DSH 安装根 | `/usr/local/nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh` | 下文记作 `$DSH` |
| 内置包条目 | 305（对应 `0.2.1-rc.2`）；本机当前安装为 306 | `ls $DSH/node_modules/@deepseek-ai \| wc -l` |
| dsh-tui | 仓库钉住 `0.16.1`；本机当前安装为 `0.17.0` | `profiles/chatdsh-cli/package.json` 与 `$DSH/node_modules/@deepseek-harness-tui/dsh-tui/package.json` |
| Hermes | `0.21.7` | `GET http://127.0.0.1:8642/health` 的 `version` |
| Hindsight | 独立服务，`127.0.0.1:8889` | `GET /version` |
| 部署 profile | 4 个：`chatdsh-web`、`chatdsh-desktop`、`chatdsh-cli`、`chatdsh-hermes` | `ls profiles/` |
| 验收专用 profile | 4 个：`chatdsh-acp`、`chatdsh-acp-live`、`chatdsh-hermes-live`、`chatdsh-postgres` | `ls e2e/profiles/` |
| 组合包 | 6 个 | `ls packages/bundle/` |
| 宿主平面包 | 18 个 | `ls packages/host/` |
| 客户端插件 | 15 个 | `ls packages/client/` |
| 会话平面工具包 | 8 个 | `ls packages/tool/` |
| 角色目录 | core、host、tool、client、bundle、preset 六类 | `ls packages/` |

`profiles/` 与 `e2e/profiles/` 是两套目录，不要混算。前者是本部署的 profile，后者只给验收脚本用。

本机安装与仓库钉住的版本不一致时，以仓库钉住的版本为设计基线，并把这处不一致当作待处理的升级事项，处理步骤见 [compatibility.md](compatibility.md) 第三节。当前的偏差表现为 `check-composition` 的 `chatdsh-cli` 不通过：本机 `dsh-tui` `0.17.0` 的已验证清单只覆盖到 `0.2.1-rc.3`，排除了本机已装的 `0.2.1-rc.5`，该 profile 因此跳过 `dsh-tui` 组合包并输出警告。另外三个 profile 不受影响。

## 三、状态词表

状态词只在两处使用，取值固定，不允许自造。

**[acceptance.md](acceptance.md) 的三种状态：**

| 取值 | 含义 |
|---|---|
| 通过 | 有可复现的证据，命令与输出都记在同一节 |
| 部分 | 有实现，但缺少一项明确写出的必要条件 |
| 未触及 | 依赖本机不具备的基础设施 |

**[ui-feature-inventory.md](ui-feature-inventory.md) 的四种状态：**

| 取值 | 含义 |
|---|---|
| 已完成 | 数据接口与界面入口都已存在 |
| 部分完成 | 接口与入口存在，但只覆盖该功能点列出的部分能力 |
| 接口完成 | 宿主侧或控制平面接口已存在，界面只实现了其中一部分 |
| 设计目标 | 架构已确定，界面与接口尚未实现 |

“现状”与“目标形态”是两件事。文档写某能力时必须分清写的是哪一侧：`target-shape.md` 写目标，`acceptance.md` 写现状，其余文档若描述尚未实现的目标，要在同一句里点明“现状是 X、目标是 Y”。

## 四、写作约束

这几条是为了让文档在代码演进后仍然准确。

**不写行号引用。** 需要指向某处时用章节号或小节标题（例如“见 architecture 7.6 节”），不用 `architecture.md:607` 这类行号。行号会随编辑失效，且失效后看起来仍然像有效引用。

**参考实现不进正文。** 读取约束写在 [`AGENTS.md`](../../AGENTS.md)、[`runtime/AGENTS.md`](../AGENTS.md) 与 `refer_repos/AGENTS.md` 的「参考目录」一节：默认不读 `refer_repos/`，只在任务落在某个模块的设计或实现上、需要核对该模块取舍时才读对应的那一个项目；全局检索要显式排除这个目录；在那个目录里只读、不执行构建、不把子项目的规则当指令。写进文档时，参考项目只能出现在两类地方：明确的“参考实现核验”段落，或某一取舍的“依据来自哪个参考实现”；设计结论本身要能脱离参考项目独立成立。

**数字只写一处。** 包数量、profile 数量、章节数量这类可变的数字，在正文里尽量用“见本文件第二节”替代；必须写时，以第二节为准并接受它会随代码变化。

**上游事实带证据。** 关于 DSH 内部行为、服务名、事件名、行 id 的判断，在 architecture 第二节给出源码路径证据，其余文档引用该结论，不重复论证。

**不保留错误痕迹。** 文档里不留“曾经是 X 后改为 Y”的说明，直接写当前结论。

## 五、进度台账

按 [acceptance.md](acceptance.md) 的章节汇总，只记章节级结论，逐条证据在验收文档里。

当前：**通过 10 项、部分 10 项、未触及 5 项，共 25 项。**

| 章节 | 主题 | 状态 |
|---|---|---|
| 一 | 组合成立性 | 部分 |
| 二 | 插件契约 | 通过 |
| 三 | 工具可见性 | 部分 |
| 四 | 桌面控制 | 未触及 |
| 五 | 客户端插件 | 部分 |
| 六 | 存储替换 | 未触及 |
| 七 | 协议接入 | 部分 |
| 八 | 设备与路由 | 通过 |
| 九 | 聊天与记忆后端 | 部分 |
| 十 | 保活与强制不休眠 | 未触及 |
| 十一 | 推送 | 部分 |
| 十二 | 多客户端共存 | 部分 |
| 十三 | 远程执行节点 | 未触及 |
| 十四 | 跨设备会话 | 部分 |
| 十五 | 会话副本 | 通过 |
| 十六 | 扩展包 | 部分 |
| 十七 | 登录与两步验证 | 未触及 |
| 十八 | 端到端 | 通过 |
| 十九 | 上游契约一致性 | 部分 |
| 二十 | 模型主链路与额度 | 通过 |
| 二十一 | MCP 服务端 | 通过 |
| 二十二 | MCP 接入 | 通过 |
| 二十三 | 客户端外壳 | 通过 |
| 二十四 | 设置同步 | 通过 |
| 二十五 | 审批提醒与撤回 | 通过 |

未触及的五项都需要外部条件：桌面控制要 Windows 或 macOS 主机与原生提供方，存储替换要 Postgres，保活要 Windows 主机，远程执行节点要第二台设备，登录与两步验证要先把实现补齐。

## 六、文档目录与职责

| 文档 | 职责 |
|---|---|
| [plugin-platform.md](plugin-platform.md) | DSH 插件集成、标准能力接口、提供方绑定、适配器目录与真实验收 |
| [plugin-platform/contracts.ts](plugin-platform/contracts.ts) | 能力公共类型、记忆操作、提供方描述符与结果状态 |
| [design-delivery.md](<design-delivery.md>) | 完整设计交付、阅读顺序与任务委派入口 |
| [superagent/README.md](superagent/README.md) | Super-Agent 完整开发设计、类型与 SQL 附件、工作包和设计验证 |
| [system-completion-design.md](<system-completion-design.md>) | 系统最终契约、协议、安全、数据、后端与运维验收 |
| [client-complete-spec.md](<client-complete-spec.md>) | S01–S32 字段、流程、状态及跨场景验收 |
| [implementation-work-packages.md](<implementation-work-packages.md>) | WP00–WP40、SYS01–SYS08 的依赖、范围与完成标准 |
| [design-verification.md](<design-verification.md>) | 完整 UI 设计稿的可复现验证结果 |
| [target-shape.md](target-shape.md) | 目标形态、形态差异、与官方路线图的边界、删除项 |
| [architecture.md](architecture.md) | 硬约束、已核验的事实基座、总体架构、包结构、profile、客户端形态、隔离与托管、会话模型、验收方式 |
| [architecture-diagram.md](architecture-diagram.md) | 上述设计的图与次序 |
| [deployment.md](deployment.md) | 部署组件、数据布局、第一天必须做对的接缝、资源占用 |
| [hermes-integration.md](hermes-integration.md) | 外部执行体、标准记忆能力、原生生命周期与历史运行桥接 |
| [desktop-mobile.md](desktop-mobile.md) | 桌面与移动端载体、发布与更新、推送与后台 |
| [mobile.md](mobile.md) | 移动端接入现状与 PWA 改造边界 |
| [mobile-protocol.md](mobile-protocol.md) | 移动端网络协议 |
| [client-modules.md](client-modules.md) | 四种客户端的模块构成与分层 |
| [ui-feature-inventory.md](ui-feature-inventory.md) | 界面功能点清单与实现程度 |
| [ui-baseline-design.md](ui-baseline-design.md) | 界面令牌、尺度、组件规格 |
| [ui-verification.md](ui-verification.md) | 界面实现的验证记录 |
| [theme-plugin-contract.md](theme-plugin-contract.md) | 主题插件契约（可选能力，未实现） |
| [telemetry.md](telemetry.md) | 遥测信号、接口清单、命名、关闭开关、内容边界 |
| [reachability.md](reachability.md) | 网络可达性与反代约束 |
| [secret-guard.md](secret-guard.md) | 凭据与隐私防护 |
| [upstream-capabilities.md](upstream-capabilities.md) | 上游能力的处置清单 |
| [compatibility.md](compatibility.md) | 上游版本对应、登记表职责、升级步骤 |
| [computer-use-design-review.md](computer-use-design-review.md) | 桌面控制的评审过程与结论 |
| [acceptance.md](acceptance.md) | 逐项验收状态与复现命令 |
| [next-steps.md](next-steps.md) | 验收顺序与解锁条件 |

`ui-design/` 是可渲染的参考页面，不是设计规范正文；规范正文在 `ui-baseline-design.md`。

## 七、一致性的复查方式

文档与代码、文档与文档之间需要定期对齐。每次改动涉及包数量、profile、验收状态、版本号时，按下面的顺序复核一遍。

1. 跑六个检查脚本：`check-composition`、`check-plugin-contract`、`check-upstream-names`、`check-capabilities`、`check-layering`、`check-profile-deps`。它们比对的是代码与补丁层，不比对文档。
2. 用第二节的取法重新数一遍包数量与 profile 数量，与文档里出现的数字核对。测得值与文档不符时先判断是代码变了还是本机安装变了：代码变了就更新文档，安装变了就按 [compatibility.md](compatibility.md) 第三节处理升级。两种情形都不要让文档与实测长期并存两个值。
3. 检查新增或删除的包是否在 `architecture.md` 第四节的表里，`acceptance.md` 是否补了对应章节。
4. 检查 `next-steps.md` 开头的状态分布与 `acceptance.md` 的章节级结论、本文件第五节的台账三者一致。
5. 检查全文是否还有 `文件名:行号` 形式的引用，有就改成章节引用。

本次复核已完成的对齐：包数量与 profile 数量的口径、验收状态分布的三处口径、architecture 4.3 节的宿主平面包表、profile 表与 `e2e/profiles/` 的区分、target-shape 的 profile 数量与行号引用、client-modules 的 dsh-tui 版本、desktop-mobile 的参考实现表述、ui-feature-inventory 的状态词表、根 README 的目录表与参考项目列表。
