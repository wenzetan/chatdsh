# 兼容性与 DSH 升级流程

本文件规定 `@chatdsh/adapter` 与 `@chatdsh/bundle` 跟随 DSH 上游版本的依赖策略与验收命令。

## 一、依赖与版本策略

1. **零精确版本锁定**：`@chatdsh/adapter` 的 `peerDependencies` 对全部 `@deepseek-ai/dsh-*` 包声明 `>=0.2.0-0`（`@deepseek-ai/cordis` 为 `>=4.0.0`，`@deepseek-ai/schemastery` 为 `>=3.18.0`），不在任何业务插件中写死 `engines.dsh` 区间。
2. **极窄上游接触面**：仅依赖 7 个顶层稳定 DSH 包，且 `@chatdsh/bundle` 补丁层只使用 `insert`，不禁用也不覆写任何上游内部条目。
3. **验证基线**：本机当前实测基线为 `@deepseek-ai/dsh` `0.2.2-rc.3`、Node `>=22`、`pnpm@11.21.0`。

## 二、跟随 DSH 升级步骤

当上游发布新版 `@deepseek-ai/dsh` 后，按以下顺序执行：

```bash
# 1. 更新本机全局 DSH
npm install -g @deepseek-ai/dsh@next

# 2. 更新依赖投影、编译适配层并运行适配层单测
cd dsh-adapter
node scripts/link-dsh-deps.mjs
pnpm build && pnpm test

# 3. 更新运行时依赖投影、编译全部包与客户端产物
cd ../runtime
node scripts/link-dsh-deps.mjs
pnpm build && pnpm build:client

# 4. 运行静态检查、单元测试与官方 profile 真实安装验证
pnpm check:telemetry
pnpm check:plugins
pnpm check:upstream-names
pnpm check:layering
pnpm test
pnpm verify:plugin-install
```

若上述任一步骤失败，根据报错定位 `@chatdsh/adapter` 中受影响的服务签名或上游包名，仅在 `dsh-adapter/` 内完成适配后重跑完整检查。

## 三、官方 profile 真实安装验收要求

升级验收必须覆盖用户真实的安装路径，具体由 `runtime/scripts/verify-plugin-install.mjs`（P01 交付）执行：

1. 在临时隔离的 `DSH_HOME` 中初始化官方默认 `web` profile。
2. 执行真实的 `dsh plugin --profile web add <仓库内 @chatdsh/bundle 绝对路径>`。
3. 运行 `dsh --profile web --dump-config`，断言退出码为 0、零补丁警告、包含全部 ChatDSH 宿主与客户端行。
4. 启动真实 `dsh --profile web --no-open` 实例，核对宿主侧端点就绪、浏览器模块图包含全部 `@chatdsh/client-*` 产物且产物 HTTP 可取回。
5. 以 `CHATDSH_TELEMETRY=off` 再次启动并核对状态端点报告 `enabled: false` 与 `reason: "env"`、上报端点返回 404。
