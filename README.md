# ChatDSH 工作区

以 DSH（deepseek-harness）为内核的自托管插件集成平台。用户选择插件，ChatDSH 通过提供方适配器和标准能力接口，将能力提供给会话、项目 Super-Agent、自动化及各端界面。运行时与适配层位于同一个 Git 仓库，第三方插件保持原生包和数据格式。

## 目录构成

| 目录 | 内容 |
|---|---|
| [`runtime/`](runtime/) | 运行时侧全部内容：六个角色的包（core、host、tool、client、bundle、preset）、控制平面服务、桌面壳、移动端接入、部署 profile、文档、脚本与校验、调试容器、验收测试 |
| [`dsh-adapter/`](dsh-adapter/) | 适配层 `@chatdsh/adapter`：DSH 内部 API 的唯一接触面 |
| [`refer_repos/`](refer_repos/) | 参考项目快照，本地检索用，不纳入版本管理 |

`runtime` 与 `dsh-adapter` 的同级层级有实际约束：`runtime/profiles` 下的 profile 以 `link:` 协议引用适配层，链接目标按同级关系解析，改动目录层级会让 profile 装不出依赖。容器环境也按同样的结构复制仓库，见 [`runtime/dev/README.md`](runtime/dev/README.md)。

## 从哪里开始读

- 文档总纲（权威顺序、事实基线、状态词表、进度台账）：[`runtime/docs/README.md`](runtime/docs/README.md)
- 插件平台、标准能力接口与提供方接入：[平台架构](runtime/docs/plugin-platform.md)
- 目标形态与取舍：[`runtime/docs/target-shape.md`](runtime/docs/target-shape.md)
- 总体设计与各子系统设计：[`runtime/docs/architecture.md`](runtime/docs/architecture.md)
- 项目 Super-Agent 的完整开发契约：[`runtime/docs/superagent/README.md`](runtime/docs/superagent/README.md)
- 完整设计与委派入口：[设计交付](<runtime/docs/design-delivery.md>)
- 客户端完整 UI 设计稿：[S01–S32 设计画板](<runtime/docs/ui-design/complete.html>)
- 客户端交互与验收：[完整规格](<runtime/docs/client-complete-spec.md>)
- 实施任务与依赖：[WP00–WP40 / SYS01–SYS08](<runtime/docs/implementation-work-packages.md>)
- 客户端界面基础设计：[`runtime/docs/ui-baseline-design.md`](runtime/docs/ui-baseline-design.md)
- 适配层的设计与版本约定：[`dsh-adapter/README.md`](dsh-adapter/README.md)
- 逐项验收状态：[`runtime/docs/acceptance.md`](runtime/docs/acceptance.md)
- 后续清单与解锁条件：[`runtime/docs/next-steps.md`](runtime/docs/next-steps.md)

## 本机的开发调试环境

调试用的 dsh 运行时、Hermes、Hindsight 各自跑在独立容器里，端口与宿主上已经在跑的实例错开，两套环境可以并存。编排文件在 [`runtime/dev/`](runtime/dev/)，说明见 [`runtime/dev/README.md`](runtime/dev/README.md)。

## 参考项目

社区插件的接口核查使用固定源码提交。平台的适配方式、数据所有权和自动生命周期的执行组件依据实际接口确定。下表记录源码事实，标准适配器的真实运行验收在对应实现交付时完成。

| 项目与固定源码 | 包版本 | 对平台设计的作用与接口证据 |
|---|---|---|
| [FuRongJun-1999/dsh-memory](https://github.com/FuRongJun-1999/dsh-memory/tree/39eab08f2a087ffe03c6b80cb5d7dd1a385014ed) | `@furongjun1999/dsh-memory@0.10.2` | 记忆保留原生 MCP 操作与写入审核，核查 `README.md`、`package.json`、`dsh/cordis.patch.yml`、`src/index.ts` 和 `src/bridge.ts`。MIT |
| [csyangwen/dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve/tree/44b6b3eb65a1d50ceba0afb2c13acdd4a8b81423) | `dsh-memory-evolve@0.1.0`，安装固定提交 | 记忆、技能、协作和通知分别声明能力与绑定，管理 API 按版本适配，核查 `README.md`、`package.json`、`cordis.patch.yml`、`lib/index.js` 和 `lib/api.js`。MIT |
| [Phant0Meow/dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory/tree/a518bea4cacb1c55a100dc3cf9d8f05205646bb4) | `meow-memory@0.32.6` | 自动注入、反思与 dream 需要明确生命周期的执行组件，标准管理操作按公开入口支持，核查 `README.md`、`package.json`、`cordis.patch.yml` 与 `src/index.ts`。MIT |
| [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon/tree/455dd1c017d82c4f75af1b9510d383c059b0690e) | `dsh-mnemon@0.5.44` | 复用原生 Source/Strategy 组合与管理 Remote，扩展注册和数据查询分别适配，核查 `README.md`、`package.json`、`cordis.patch.yml`、`src/core/runtime.ts`、`src/sdk/service.ts`、`src/host/remote-rpc.ts` 和 `src/host/rpc.ts`。MIT |
| [Yuuyuko-uu/dsh-fish-memory](https://github.com/Yuuyuko-uu/dsh-fish-memory/tree/9b49f20279835c1fce3e2f924a48ef0da2fd5a75) | `dsh-fish-memory@1.6.0` | 会话与工作区的原生范围需要显式映射，核查 `README.md`、`package.json`、`cordis.patch.yml`、`lib/index.js` 与 `LICENSE`。源码许可证为 Yuuyuko-uu 插件许可 1.2，包含再分发时的作者标注及衍生作品要求 |
| [Ryu6Zero/dsh-hindsight](https://github.com/Ryu6Zero/dsh-hindsight/tree/200eab8ab5cf395e86d0ddb3cc809061f6ee09c4) | `dsh-hindsight@0.4.0` | 标准记忆调用复用公开的 `HindsightClient` 与 `createClient`，核查 `README.md`、`package.json`、`cordis.patch.yml` 和 `src/index.ts`。MIT |

以上快照的原生清单已通过本机 DSH 对仓库基线与当前安装版本的声明检查。检查未执行社区插件、安装脚本或外部记忆服务，不构成运行期兼容保证。完整版本规则见[平台架构](runtime/docs/plugin-platform.md)。

公开设计资料与执行依赖：

- [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) —— 项目协调与执行任务的职责划分、持久投递和独立执行会话的设计参考。
- [anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime) —— Linux 与 macOS 任务进程的文件及网络权限执行依赖；项目策略与独立会话约束由 ChatDSH 定义。
- [bytecodealliance/cap-std](https://github.com/bytecodealliance/cap-std) —— 受信任文件辅助程序的目录访问依赖，用于成果封存和应用时的路径权限约束。
- [Git merge-tree 官方文档](https://git-scm.com/docs/git-merge-tree/2.43.0) —— 审阅候选采用显式基准的原生树合并，覆盖依赖、重命名与用户未提交修改。

`refer_repos/` 下的项目是开发过程中的参考实现，本地共 9 个快照。其中对程序设计产生过正面作用的有：

- [Clarklevis1995/dsh-mobile](refer_repos/Clarklevis1995_dsh-mobile) —— 移动端形态的实现参考，客户端与内核之间的职责划分参考自此。
- [Clarklevis1995/dsh-plugin-mobile-gateway](refer_repos/Clarklevis1995_dsh-plugin-mobile-gateway) —— 移动网关插件的接入方式参考。
- [saya-ch/dsh-mobile](refer_repos/saya-ch_dsh-mobile) —— 浏览器侧作为独立 npm 包发布的做法，客户端插件的产物形态参考自此。
- [dataelement/dsh-desktop](refer_repos/dataelement_dsh-desktop) —— Electron 桌面端的构建与补丁流程参考自此。
- [anywhere-labs/dsh-desktop](refer_repos/anywhere-labs_dsh-desktop) —— 桌面端的多包工作区组织方式参考自此。
- [shaobeichen/dsh-pocket](refer_repos/shaobeichen_dsh-pocket) —— 轻量客户端的形态参考。
- [kelai141/dsh-mobile-apk](refer_repos/kelai141_dsh-mobile-apk) —— 移动端打包流程参考。
- [ZCode](refer_repos/ZCode) —— 多包仓库的组织方式参考。
- [rea_workbuddy](refer_repos/rea_workbuddy) —— 逆向分析工具的本地快照，供对照检索。

这些仓库保留在本地供检索，不纳入本项目的版本管理。设计结论以 `runtime/docs/` 为准，参考实现只用于核验取舍。
