# 后续清单

后续 agent 委派使用[实施工作包](<implementation-work-packages.md>)，包含 WP00–WP40 与 SYS01–SYS08 的依赖、范围和真实验收。设计入口为[完整交付](<design-delivery.md>)，客户端为[完整设计稿](<ui-design/complete.html>)。下文保留已实现能力的验证条件；新能力实施顺序与完成标准使用完整工作包。

平台能力开发采用[PA01–PA08](plugin-platform.md#12-实施与验收)。标准接口与 DSH 映射、提供方真实入口、生命周期和绑定共同验证后，领域界面及 Super-Agent 才能使用对应能力。社区插件的清单检查只证明声明成立，适配器和实际业务调用仍需交付。

项目级 Super-Agent 的开发使用 [SA01–SA09](superagent/implementation.md)，接口、数据库、调度、执行器和 Git 应用规则从[设计入口](superagent/README.md)读取。该能力当前为设计目标，完成实现后按 AC-SA01–27 分别登记真实结果。

按验收顺序分组，每组写明缺什么条件与条件满足后跑哪个脚本。顺序是先收口主链路，再做跨设备与客户端形态，最后是平台相关项。验收的完整状态见 [acceptance.md](acceptance.md)。

当前分布：通过 10 项、部分 10 项、未触及 5 项，共 25 项。逐章台账见[文档总纲](README.md)第五节，逐条证据见 [acceptance.md](acceptance.md)。

## 前置：把本机安装恢复成仓库钉住的版本

本机全局 DSH 已升到 `0.2.1-rc.5`，随装的 `dsh-tui` 是 `0.17.0`；仓库钉住 `0.2.1-rc.2` 与 `dsh-tui` `0.16.1`。两者不一致的后果是 `check-composition` 的 `chatdsh-cli` 不通过，条目数从 117 掉到 97。两条处理路径任选其一：把本机安装恢复到 `0.2.1-rc.2`，或按 [compatibility.md](compatibility.md) 第三节把仓库升级到 `0.2.1-rc.5` 并同时在已验证清单里确认 `dsh-tui` 的可用版本。处理完成后重跑 `node scripts/check-composition.mjs`，四个 profile 全部通过才算解除。

## 第一阶段：收口主链路

主链路是其它验收的前置：没有真实回合，工具可见性、端到端、客户端交互都无法判定；没有真实记忆回合，记忆注入与聊天后端组合都无法判定。

一组可用模型凭据能解锁这一组的大部分。除 `DEEPSEEK_API_KEY` 外，也可以用 `CHATDSH_PROVIDER_URL`、`CHATDSH_PROVIDER_API_KEY`、`CHATDSH_PROVIDER_MODEL` 指向任意 OpenAI 兼容提供方；界面与单轮问答已由 `node scripts/verify-provider-chat.mjs` 验过，其余项仍需真实回合。

| 项 | 缺什么 | 满足后怎么验 |
|---|---|---|
| 真实模型回合 | 一组可用凭据 | 跑 `node scripts/verify-provider-chat.mjs` 确认基础链路，再在会话里发一条消息走完整回合 |
| 工具可见性 | 一次真实回合里读模型请求的工具清单 | 核对工作档的七个自建工具行与文件命令工具在里面、浏览器操作不在；全量档另需核对只出现单个 `run_code` 与生成的 SDK |
| 端到端 | 浏览器层从输入到结果的完整流程 | `node scripts/verify-client-ui.mjs` 已走到预设页；完整流程要在有凭据时跑一次真实回合 |
| 协议接入 | 发消息、流式事件、取消、回答审批 | `node scripts/verify-acp.mjs --profile chatdsh-acp --prompt "列出一个文件"`；脚本会打印收到的流式事件条数，为零算失败。取消与回答审批仍需真实回合 |
| 客户端插件 | 面板的真实数据交互与完整设置页断言（主界面与自建面板渲染已通过） | `node scripts/verify-client-ui.mjs` 已断言侧栏「项目」；设置页七个自建区段与面板内写操作仍需真实回合 |
| 聊天与记忆后端 | Hermes 的两条支路；记忆召回注入已由 `node scripts/verify-memory.mjs` 跑通 | 记忆侧已有真实服务与真实模型回合证据；Hermes 两条支路需要 Hermes 服务（本机未部署） |

## 第二阶段：跨设备与远程执行节点

| 项 | 缺什么 | 满足后怎么验 |
|---|---|---|
| 设备与路由 | 实例之间的插件清单与工作区隔离观察、跨设备会话的两个显式动作 | 按设备分派已可用（`node scripts/verify-routing.mjs`、`node scripts/verify-routing-live.mjs`）；缺真实实例间的清单隔离观察，以及在远程继续与在本机继续两个动作的界面 |
| 远程执行节点 | 第二台执行节点 | 从 B 把聊天转成落在 A 目录上的工作会话，核对 `deviceId` 与 `cwd` 不可改 |
| 跨设备会话 | 在页面上下文里调一次 `chatdshImport.restore` | 控制平面的导入已可用（`node scripts/verify-import.mjs`）；运行时的恢复已实现并装配完成，`seedOf` 有单测，`restore` 缺一次页面内调用——远端方法只能从客户端 SDK 发起，ACP 与命令行都没有对应的通道 |
| 多客户端共存 | 两端同时提交消息的去重、审批卡片的界面收敛 | 客户端已订阅推送并刷新，缺一次真实审批与两个能进主界面的客户端 |

## 第三阶段：移动端 PWA

移动端形态从 Android 原生改为 PWA，复用控制平面托管外壳与官方发布的前端产物；控制平面的配对与 `/ws/mobile` 接口保留。

| 项 | 缺什么 | 满足后怎么验 |
|---|---|---|
| PWA 外壳 | 移动布局、`manifest` 安装入口、Service Worker | 用移动浏览器打开控制平面地址，安装到主屏后外壳可加载、左栏聚合会话、右栏 iframe 指向 `/d/<deviceId>/` |
| 配对链路 | PWA 走 `POST /chatdsh/gateway/mobile/pair` 与 `/ws/mobile` | 设置 `CHATDSH_PAIRING_CODE` 后配对，令牌换启动路径，业务通道可用 |
| Web Push | 推送服务订阅与 Service Worker 展示 | 审批请求产生后，后台的 PWA 收到通知；应用被系统回收后的送达由推送服务决定，界面如实交代 |

## 第四阶段：需要 Windows 或 macOS 主机

| 项 | 缺什么 | 满足后怎么验 |
|---|---|---|
| 桌面控制（Linux 层） | `@deepseek-ai/dsh-computer-use` 与 native 提供方 | 挂载后核对 59 个工具与三档白名单，检查被拒清单里的工具不在目录里 |
| 桌面控制（真机层） | Windows x64 与 macOS 14+ | 按验收清单逐条跑：点击后状态变化、管理员程序注入返回 `background_uipi_blocked`、权限与坐标映射 |
| 保活与强制不休眠 | Windows 主机与托盘常驻 | 开启后空闲超过阈值，`powercfg /requests` 出现 SYSTEM 与 DISPLAY 请求 |

## 第五阶段：需要 Postgres 与登录层

| 项 | 缺什么 | 满足后怎么验 |
|---|---|---|
| 存储替换 | Postgres 后端与对应的存储组合包 | 把会话日志切过去，创建会话、重启运行时、按编号恢复并继续追加，核对序号连续 |
| 登录与两步验证 | 通行密钥、TOTP、设备会话有效期 | `authMode` 为 local 时未登录请求在反代前被拒；注册通行密钥后换域名需重新注册；错误验证码达阈值锁定 |

## 剩下的观察点

这一节是前面各项里还没做成的具体动作，不是独立的验收项。每行末尾都写明了它依赖的条件。

| 事 | 说明 |
|---|---|
| 扩展包 | 装卸、连接器行同步、MCP 握手都已可用（`extensions.mjs`、`verify-mcp-connection.mjs`、`verify-telemetry-sync.mjs`）；界面出现面板与工具以 `mcp__` 前缀进目录这两条要等能进主界面的会话 |
| 插件契约 | 自建包以工作区链接安装；`dsh plugin --profile … add` 从登记处拉取这条没有实跑，需要一份发布到登记处的包。本轮定为不对外发布，这条不列为验收项 |
| 记忆与移动端拆包 | 两者要从 `bundle-hosted` 与 profile 补丁层拆成独立包，记在 [target-shape.md](target-shape.md) 第十二节 |
| 通知分级 | `two-stage-with-phone` 这一档未实现；PWA 接入 Web Push 后手机兜底才可验证 |
| 连接器的 MCP 行 | 生成与同步计划已可用，真正插入加载器后的效果要一次运行时交互才能观察 |
