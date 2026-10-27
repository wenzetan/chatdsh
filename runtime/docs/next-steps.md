# 后续清单

按「缺什么条件」分组，每条写明缺的条件与条件满足后跑哪个脚本。验收的完整状态见 [acceptance.md](acceptance.md)。

当前分布：通过 4 项、部分 10 项、未触及 5 项，共 19 项。

## 需要模型凭据或自建提供方

一组可用模型凭据能解锁五项的大部分。除 `DEEPSEEK_API_KEY` 外，也可以用
`CHATDSH_PROVIDER_URL`、`CHATDSH_PROVIDER_API_KEY`、`CHATDSH_PROVIDER_MODEL`
指向任意 OpenAI 兼容提供方；界面与单轮问答已由 `node scripts/verify-provider-chat.mjs`
验过，其余项仍需真实回合。

| 项 | 缺什么 | 满足后怎么验 |
|---|---|---|
| 协议接入 | 发消息、流式事件、取消、回答审批 | `node scripts/verify-acp.mjs --profile chatdsh-acp --prompt "列出一个文件"`；脚本会打印收到的流式事件条数，为零算失败。取消与回答审批仍需真实回合 |
| 客户端插件 | 面板的真实数据交互与完整设置页断言（主界面与自建面板渲染已通过） | `node scripts/verify-client-ui.mjs` 已断言侧栏「项目」；设置页七个自建区段与面板内写操作仍需真实回合 |
| 聊天与记忆后端 | 召回结果是否真的进了系统提示、Hermes 的两条支路 | 召回与写入已可用（`node scripts/verify-memory.mjs`）；缺一次完整回合后读会话日志的系统提示段，以及 Hermes 服务（本机未部署） |
| 工具可见性 | 工具是否出现在模型目录、`restrict` 能否移除 | 一次真实回合里读模型请求的工具清单，核对工作档的七个自建工具行与文件命令工具在里面、浏览器操作不在；全量档另需核对只出现单个 `run_code` 与生成的 SDK |
| 端到端 | 浏览器层从输入到结果的完整流程 | `node scripts/verify-client-ui.mjs` 已走到预设页；完整流程要在有凭据时跑一次真实回合 |

## 需要第二台设备或第二个运行时

| 项 | 缺什么 | 满足后怎么验 |
|---|---|---|
| 身份与隔离 | 实例之间的插件清单与工作区隔离观察、B 打开 A 的会话只读 | 分派与跨账号拒绝已可用（`node scripts/verify-routing.mjs`、`node scripts/verify-routing-live.mjs`）；缺真实实例间的清单隔离观察与只读界面 |
| 远程执行节点 | 第二台执行节点 | 从 B 把聊天转成落在 A 目录上的工作会话，核对 `deviceId` 与 `cwd` 不可改 |
| 跨设备会话 | 在页面上下文里调一次 `chatdshImport.restore` | 控制平面的导入已可用（`node scripts/verify-import.mjs`）；运行时的恢复已实现并装配完成，`seedOf` 有单测，`restore` 缺一次页面内调用——远端方法只能从客户端 SDK 发起，ACP 与命令行都没有对应的通道 |
| 多客户端共存 | 两端同时提交消息的去重、审批卡片的界面收敛 | 客户端已订阅推送并刷新，缺一次真实审批与两个能进主界面的客户端 |

## 需要 Windows 或 macOS 主机

| 项 | 缺什么 | 满足后怎么验 |
|---|---|---|
| 桌面控制（Linux 层） | `@deepseek-ai/dsh-computer-use` 与 native 提供方 | 挂载后核对 59 个工具与三档白名单，检查被拒清单里的工具不在目录里 |
| 桌面控制（真机层） | Windows x64 与 macOS 14+ | 按验收清单逐条跑：点击后状态变化、管理员程序注入返回 `background_uipi_blocked`、权限与坐标映射 |
| 保活与强制不休眠 | Windows 主机与托盘常驻 | 开启后空闲超过阈值，`powercfg /requests` 出现 SYSTEM 与 DISPLAY 请求 |

## 需要 Postgres

| 项 | 缺什么 | 满足后怎么验 |
|---|---|---|
| 存储替换 | Postgres 后端与对应的存储组合包 | 把会话日志切过去，创建会话、重启运行时、按编号恢复并继续追加，核对序号连续 |

## 需要账号体系

| 项 | 缺什么 | 满足后怎么验 |
|---|---|---|
| 登录与两步验证 | 通行密钥、TOTP、设备会话有效期 | `authMode` 为 local 时未登录请求在反代前被拒；注册通行密钥后换域名需重新注册；错误验证码达阈值锁定 |

## 剩下的观察点

这一节是前面各项里还没做成的具体动作，不是独立的验收项。每行末尾都写明了它依赖的条件。

| 事 | 说明 |
|---|---|
| 扩展包 | 装卸、连接器行同步、MCP 握手都已可用（`extensions.mjs`、`verify-mcp-connection.mjs`、`verify-telemetry-sync.mjs`）；界面出现面板与工具以 `mcp__` 前缀进目录这两条要等能进主界面的会话 |
| 插件契约 | 自建包以工作区链接安装；`dsh plugin --profile … add` 从登记处拉取这条没有实跑，需要一份发布到登记处的包 |
| 通知分级 | `two-stage-with-phone` 这一档未实现；Android 客户端已接入控制平面，还需系统通知通道才能验证手机兜底 |
| 连接器的 MCP 行 | 生成与同步计划已可用，真正插入加载器后的效果要一次运行时交互才能观察 |
