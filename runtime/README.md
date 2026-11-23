# ChatDSH 运行时工作区

本目录包含面向官方 DSH（Web 端与 Desktop 端）的纯附加插件集 `@chatdsh/bundle`、轻量中继服务端 `@chatdsh/gateway`、共享核心包、校验脚本与文档。

## 文档入口

- 总纲与事实基线：[`docs/README.md`](docs/README.md)
- 总体架构：[`docs/architecture.md`](docs/architecture.md)
- 实现说明与工作包交付（P01–P06）：[`docs/implementation-guide.md`](docs/implementation-guide.md)
- 遥测规范与信号清单：[`docs/telemetry.md`](docs/telemetry.md)
- 升级与兼容验证：[`docs/compatibility.md`](docs/compatibility.md)
- 凭据与隐私防护：[`docs/secret-guard.md`](docs/secret-guard.md)

## 开始之前

克隆仓库后启用隐私与凭据检查钩子：

```sh
bash scripts/install-hooks.sh
```

## 构建与校验

前置条件：Node 22 及以上、`pnpm@11.21.0`、本机已安装 `@deepseek-ai/dsh`。

```sh
# 1. 构建顶层适配层
(cd ../dsh-adapter && pnpm install && node scripts/link-dsh-deps.mjs && pnpm build && pnpm test)

# 2. 安装依赖、投影 DSH 类型、编译全部包与客户端产物
pnpm install
node scripts/link-dsh-deps.mjs
pnpm build
pnpm build:client

# 3. 静态检查与单元测试
pnpm check:telemetry
pnpm check:plugins
pnpm check:upstream-names
pnpm check:layering
pnpm test
```

## 启动轻量中继服务端

```sh
CHATDSH_GATEWAY_HOST=127.0.0.1 \
CHATDSH_GATEWAY_PORT=3170 \
CHATDSH_PAIRING_CODE=<一次性配对码> \
node gateway/lib/main.js
```

## 环境注意事项

- **`GIT_CONFIG_COUNT` 环境变量**：部分环境注入不完整的 `GIT_CONFIG_COUNT` 会导致 `git` 退出，执行命令前可使用 `env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 git <子命令>`。
- **隐私钩子**：`core.hooksPath` 属于本地配置，克隆后需运行 `bash scripts/install-hooks.sh`，并确保本机已安装 `gitleaks` 与 `python3`。
