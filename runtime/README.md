# ChatDSH

以 DSH（deepseek-harness）为运行内核的自托管 ChatGPT 对应物，覆盖 Web 端、命令行、Windows 桌面与移动端四种形态。

## 文档

| 文件 | 内容 |
|---|---|
| [architecture.md](docs/architecture.md) | 总体架构：硬约束、插件与组合包契约、各子系统设计、验收方式 |
| [architecture-diagram.md](docs/architecture-diagram.md) | 设计架构图：平面构成、配置叠加、装配点、加载次序、会话回合、数据布局、遥测管道与验收对应 |
| [deployment.md](docs/deployment.md) | 部署形态与兼容接缝：单机组件、数据布局、多租户扩展 |
| [desktop-mobile.md](docs/desktop-mobile.md) | 桌面与移动端载体 |
| [client-modules.md](docs/client-modules.md) | 四种客户端的模块构成与分层 |
| [reachability.md](docs/reachability.md) | 网络可达性与 Tailscale 接入 |
| [hermes-integration.md](docs/hermes-integration.md) | 聊天后端与记忆接入：Hermes 与 Hindsight 的可选组合、四种形态、插件划分 |
| [computer-use-design-review.md](docs/computer-use-design-review.md) | 桌面控制方案的独立评审记录 |
| [telemetry.md](docs/telemetry.md) | 遥测与调试接口：信号清单、命名规范、上下文传播、关闭开关、内容边界、验收方式 |
| [secret-guard.md](docs/secret-guard.md) | 凭据与隐私防护：钩子、规则、占位约定、历史泄露清理 |
| [prompts/git-commit-message.md](docs/prompts/git-commit-message.md) | 提交信息提示词模板 |
| [../dsh-adapter/README.md](../dsh-adapter/README.md) | 适配层 `@chatdsh/adapter`：上游内部 API 的唯一接触面，位于仓库根下与 `runtime` 同级 |

## 开始之前

克隆之后先启用随仓库分发的钩子：

```sh
bash scripts/install-hooks.sh
```

钩子在提交与推送两个环节拦截凭据与隐私数据，依赖 `gitleaks` 与 `python3`。缺依赖时钩子直接失败，不会静默放行。规则、占位约定与误报处理见[凭据与隐私防护](docs/secret-guard.md)。

## 从源码构建与运行

前置：Node 22 及以上、pnpm 10、本机已安装 DSH（`dsh --version` 有输出）。

```sh
pnpm install                          # 工作区依赖
node scripts/link-dsh-deps.mjs        # 把 DSH 安装里的依赖投影到 .dsh-deps，供类型检查与本地加载
pnpm build                            # 编译全部包
DSH_HOME="$HOME/.dsh" node scripts/sync-profiles.mjs --install   # 把仓库 profile 接到数据根并安装依赖
dsh --profile chatdsh-web --no-open   # 启动单机 Web 形态
```

`.dsh-deps` 只放符号链接，不复制文件；`pnpm install` 之后需要重新执行一次投影脚本。`sync-profiles.mjs` 在数据根里为每个 profile 建立指向仓库的符号链接，因此 profile 的依赖声明与补丁层始终是仓库里的那一份。

浏览器侧的插件产物要单独打包：

```sh
node scripts/build-client.mjs        # 把 packages/client 下每个包打成 window.__ModuleLoader__ 形态
```

调试用的容器环境在 [`dev/`](dev/)，编排与说明见 [dev/README.md](dev/README.md)。dsh 运行时、Hermes、Hindsight 各自跑在独立容器里，端口与宿主上已经在跑的实例错开。

校验方式：

```sh
node scripts/check-composition.mjs         # 逐个 profile：退出码、警告为空、条目 id 唯一、配置模式文档
node scripts/check-telemetry.mjs           # 包内遥测声明、源码与文档清单三处一致
node scripts/check-profile-deps.mjs        # profile 的依赖覆盖它引用的组合包插入的全部自建插件
node scripts/check-plugin-contract.mjs     # 四类清单声明：engines.dsh、dsh.client、dsh.bundle.patch、dsh.profile.bundles
node scripts/check-upstream-names.mjs       # 源码、补丁层与客户端清单里的上游包名都在适配层登记过
node --test 'e2e/unit/*.test.mjs'          # 单元测试：协议构造、呈现格式化、启动编排、真实外部服务
node scripts/verify-client-asset.mjs --profile chatdsh-web --package @chatdsh/client-projects
node scripts/telemetry-probe.mjs            # 向本机 OpenObserve 写日志、追踪、指标各一条再查询核对，需 OO_USER 与 OO_PASS
```

端到端的验收脚本各自独立，跑完都会留下一份可复现的输出（`pnpm verify:<名字>` 是同一批命令的快捷入口）：

| 脚本 | 验的是什么 | 跑之前要准备什么 |
|---|---|---|
| `verify-acp.mjs` | 用 ACP 客户端创建会话、恢复会话，并核对投影落盘 | `--profile chatdsh-acp --cwd <目录>`，数据根里要装好该 profile |
| `verify-client-asset.mjs` | 客户端产物可取回、条目图包含自建包 | `--profile chatdsh-web --package <包名>` |
| `verify-client-ui.mjs` | 真实 Chrome 走完首次进入流程，界面里出现自建预设 | 数据根里装好 `chatdsh-web`；需要本机有 Chrome |
| `verify-isolation.mjs` | 两个账号的归属隔离与跨账号拒绝 | 无 |
| `verify-multi-client.mjs` | 两端读同一副本的序列一致、补齐与幂等 | 无 |
| `verify-receipt-sync.mjs` | 一端上报已读，另一端收到带新水位的通知；副本变更广播 | 无 |
| `verify-import.mjs` | 从副本导入带 `parentSession` 的新会话，跨账号被拒绝 | 无 |
| `verify-routing.mjs` | 两个账号的反代分别落到各自的运行时 | 无 |
| `verify-routing-live.mjs` | 同上，但用两个真实实例 | 本机能起两个 `dsh` 实例 |
| `verify-mcp-connection.mjs` | 连接器记录驱动的 MCP 客户端完成握手并拉取工具列表 | 无 |
| `verify-telemetry-sync.mjs` | 启动时的连接器同步把记录转成加载器行，并核对导出的遥测 | 无 |
| `verify-schedule.mjs` | 到期任务被执行，设备收到定时推送 | 无 |
| `verify-memory.mjs` | 对 Hindsight 做写入与召回 | 本机 Hindsight 可达（默认 `127.0.0.1:8889`） |

这些脚本与单元测试都通过 `scripts/lib/cleanup.mjs` 的 `tempHome` 分配临时数据根，正常结束、异常退出、信号中断三种情况下都会删除。排查问题时设 `CHATDSH_KEEP_RUN=1` 保留现场。

`.run` 下另有四个长期条目：`pnpm-store` 是 `.npmrc` 指向的包存储，`dsh-home` 是 `pnpm verify:*` 的数据根，`verify-home` 是早期 ACP 验收留下的数据根（脚本现在自建临时根，这个目录可以删掉），`acp-client.mjs` 是 ACP 验收用的客户端脚本。

其中几个脚本会启动 `dsh` 进程（`verify-acp`、`verify-client-ui`、`verify-mcp-connection`、`verify-telemetry-sync`、`verify-routing-live`）。可执行文件由 `scripts/lib/dsh.mjs` 定位：先看 `DSH_BIN`，再找与当前 node 同目录的 `dsh`，最后看 `PATH`，因此 `pnpm verify:*` 与 `node scripts/…` 都能用。数据根里要装好对应的 profile——`verify-acp` 需要 `chatdsh-acp`，其余 Web 形态的脚本需要 `chatdsh-web`。

各项验收的当前状态与「缺什么条件、条件满足后跑哪个脚本」见 [docs/acceptance.md](docs/acceptance.md) 与 [docs/next-steps.md](docs/next-steps.md)。

扩展包（声明了 `dsh.bundle.patch` 或 `dsh.client` 的别的包）可以从命令行装进某个 profile：

```sh
node scripts/extensions.mjs list    --profile chatdsh-web
node scripts/extensions.mjs install packages/bundle/worker --profile chatdsh-web
node scripts/extensions.mjs remove  @chatdsh/bundle-worker   --profile chatdsh-web
```

安装写两处：`bundles` 列表与 `dependencies`；补丁层的内容由扩展包自己提供。装卸之后都要在 profile 目录执行一次 `pnpm install`，再跑组合检查。

配置转储只组合配置、不导入模块，因此插件包漏装不会在转储里暴露，只在运行时表现为「未激活」；依赖校验脚本把这一项提前到构建期。客户端验收脚本则启动一个真实的 Web 形态运行时，用启动行里的凭据换取会话、取回首页，核对目标包在 `window.__DSH_BOOT__` 的条目图里，再按它自己的产物地址请求一次。

逐项验收状态记在 [`docs/acceptance.md`](docs/acceptance.md)：对照架构文档第十二节的十八条，加上上游契约一致性一条，写明哪些有可复现证据、哪些缺一项必要条件、哪些依赖本机不具备的基础设施。

端到端验收用 ACP 协议驱动一个只含 dsh-base 与自建组合包的 profile，真实创建会话后核对自建投影：

```sh
(cd e2e/profiles/chatdsh-acp && pnpm install --no-frozen-lockfile)
node scripts/verify-acp.mjs --profile chatdsh-acp --cwd "$PWD"
```

脚本自建数据根并把 profile 目录链接进去，`initialize`、`session/new`（可选 `session/prompt`）之后从该数据根的投影缓存读回 `chatdsh*` 单元；退出码 0 表示会话创建、插件激活与投影折叠都成立。发消息需要模型凭据，缺少凭据时脚本会如实报告模型侧错误，并把会话创建与投影核对的结论单独给出。

## 环境注意事项

**`GIT_CONFIG_COUNT` 会干扰 `git` 命令。** 部分工具链通过 `GIT_CONFIG_COUNT` 环境变量向 `git` 注入配置。如果这个变量存在但配套的 `GIT_CONFIG_KEY_n` 或 `GIT_CONFIG_VALUE_n` 不成对，`git` 会报「键名没有包含一个小节名称」或「无法解析命令行中的配置」并直接退出。

排查方式：

```sh
env | grep GIT_CONFIG
```

确认是自己需要的注入就保持，是残留就清掉再执行命令：

```sh
env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git <子命令>
```

**钩子的 `core.hooksPath` 是本地配置。** 它不随仓库分发，`git clone` 之后必须在每台机器上执行一次 `scripts/install-hooks.sh`。新克隆的仓库在启用之前没有防护。

**gitleaks 需要单独安装。** 它不在 Node 依赖里。安装方式见 <https://github.com/gitleaks/gitleaks#installing>。
