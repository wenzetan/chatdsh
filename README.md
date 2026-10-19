# ChatDSH

以 DSH（deepseek-harness）为运行内核的自托管 ChatGPT 对应物，覆盖 Web 端、命令行、Windows 桌面与移动端四种形态。

## 文档

| 文件 | 内容 |
|---|---|
| [architecture.md](docs/architecture.md) | 总体架构：硬约束、插件与组合包契约、各子系统设计、验收方式 |
| [deployment.md](docs/deployment.md) | 部署形态与兼容接缝：单机组件、数据布局、多租户扩展 |
| [desktop-mobile.md](docs/desktop-mobile.md) | 桌面与移动端载体 |
| [client-modules.md](docs/client-modules.md) | 四种客户端的模块构成与分层 |
| [reachability.md](docs/reachability.md) | 网络可达性与 Tailscale 接入 |
| [hermes-integration.md](docs/hermes-integration.md) | Hermes 记忆系统接入 |
| [computer-use-design-review.md](docs/computer-use-design-review.md) | 桌面控制方案的独立评审记录 |
| [telemetry.md](docs/telemetry.md) | 遥测与调试接口：信号清单、命名规范、上下文传播、关闭开关、内容边界、验收方式 |
| [secret-guard.md](docs/secret-guard.md) | 凭据与隐私防护：钩子、规则、占位约定、历史泄露清理 |
| [prompts/git-commit-message.md](docs/prompts/git-commit-message.md) | 提交信息提示词模板 |

## 开始之前

克隆之后先启用随仓库分发的钩子：

```sh
bash scripts/install-hooks.sh
```

钩子在提交与推送两个环节拦截凭据与隐私数据，依赖 `gitleaks` 与 `python3`。缺依赖时钩子直接失败，不会静默放行。规则、占位约定与误报处理见[凭据与隐私防护](docs/secret-guard.md)。

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
