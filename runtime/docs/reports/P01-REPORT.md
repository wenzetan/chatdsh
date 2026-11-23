# P01 官方 profile 真实插件安装验证报告

环境：Node v24.19.0，pnpm 11.21.0，dsh 0.2.2-rc.3，registry `https://registry.npmmirror.com`。

## 最终安装方式

验收脚本 `runtime/scripts/verify-plugin-install.mjs` 使用 `scripts/lib/cleanup.mjs` 的 `tempHome` 在 `runtime/.run/verify-plugin-install-<时间戳>` 建立隔离的 `DSH_HOME`，再执行 `dsh plugin --profile web list` 初始化官方默认 web profile。

`runtime/package.json` 的 `verify:plugin-install` 已存在并指向 `node scripts/verify-plugin-install.mjs`，本次沿用该入口。

安装前先把 11 个包打成 tarball：

- `@chatdsh/adapter`
- `@chatdsh/bundle`
- `@chatdsh/client-pwa`
- `@chatdsh/client-telemetry`
- `@chatdsh/core-contracts`
- `@chatdsh/core-diagnostics`
- `@chatdsh/host-device-link`
- `@chatdsh/host-import`
- `@chatdsh/host-push`
- `@chatdsh/host-settings-sync`
- `@chatdsh/host-telemetry`

`core-contracts` 与 `core-diagnostics` 是宿主插件与客户端插件的传递工作区依赖，必须一起打包，否则独立 profile 的 pnpm 无法解析。

随后在 profile 的 `pnpm-workspace.yaml` 写入 `overrides`，把每个 `@chatdsh/*` 指向对应的本地 tarball。最终只执行一条安装命令：

```bash
DSH_HOME=<临时 DSH_HOME> \
  dsh plugin --profile web \
  --config.store-dir=<pnpm store> \
  add <临时 DSH_HOME>/tarballs/chatdsh-bundle-0.1.0.tgz
```

`dsh plugin add` 会把 `@chatdsh/bundle` 写入 profile 的 `dependencies`，并把组合包追加到 `dsh.profile.bundles`。profile 内没有手工创建的符号链接，本次安装路径也没有新增任何符号链接文件；本地开发所需的 adapter 解析由 pnpm 的 `overrides` 完成。

发布依赖写法同步调整：`@chatdsh/bundle` 与 5 个宿主插件的 `package.json` 把 `@chatdsh/adapter` 从 `link:../../../../dsh-adapter` 改为版本号 `0.1.0`。`pnpm pack` 会把 `workspace:*` 改写为版本号，因此组合包与全部依赖 tarball 的清单里不再出现 `link:` 或 `workspace:`。本地工作区通过 `runtime/pnpm-workspace.yaml` 的 `overrides` 把 `@chatdsh/adapter` 指向 `../dsh-adapter`，`pnpm-lock.yaml` 只增加这条 `overrides` 记录。

## dump-config 结果

安装前先执行一次 `dsh --profile web --dump-config` 作为基线，安装后再执行一次。两次退出码都是 0，标准错误都为空。安装后的输出以安装前的输出为前缀，说明组合包补丁层没有改动任何上游条目。

追加段落标题为 `# == @chatdsh/bundle`，包含以下 7 个条目：

- `chatdsh-telemetry` → `@chatdsh/host-telemetry`
- `chatdsh-device-link` → `@chatdsh/host-device-link`
- `chatdsh-push` → `@chatdsh/host-push`
- `chatdsh-import` → `@chatdsh/host-import`
- `chatdsh-settings-sync` → `@chatdsh/host-settings-sync`
- `chatdsh-client-telemetry` → `@chatdsh/client-telemetry`
- `chatdsh-client-pwa` → `@chatdsh/client-pwa`

追加段落没有任何 `disabled` 字段，脚本同时检查 `cordis.patch.yml` 不含 `disabled` 字段。

## 两次启动的遥测状态

第一次启动使用 `CHATDSH_TELEMETRY=on`，监听 `127.0.0.1` 的随机端口：

- `GET /chatdsh/telemetry/status` 返回 200，响应中 `enabled: true`。
- 带令牌打开首页返回 200。
- 首页 `__DSH_BOOT__` 模块图包含 `@chatdsh/client-telemetry` 与 `@chatdsh/client-pwa`。
- 两个模块各自声明的 `plugins/??<包名>/client.js&rev=<版本>` 地址都返回 200，内容类型为 `text/javascript`，内容包含 `__ModuleLoader__` 注册。

第二次使用同一个 profile，设置 `CHATDSH_TELEMETRY=off` 启动：

- `GET /chatdsh/telemetry/status` 返回 200，响应中 `enabled: false`、`reason: "env"`。
- `POST /chatdsh/telemetry/browser` 返回 404。

两次启动都由脚本发送 `SIGTERM` 终止并等待进程退出，随机端口随之释放。临时 `DSH_HOME` 由 `tempHome` 在进程退出时删除；设置 `CHATDSH_KEEP_RUN=1` 可以保留现场。

## upgrade-dsh 每一步的真实结果

执行 `node scripts/upgrade-dsh.mjs` 的真实结果：

- 第 1 步「读取 dsh 版本」通过，输出 `DSH 0.2.2-rc.3`。
- 第 2 步「投影并构建 dsh-adapter」通过。`scripts/link-dsh-deps.mjs` 报告 537 个链接已是最新，`tsc -b tsconfig.build.json` 退出码 0。
- 第 3 步「投影并构建 runtime 与客户端产物」失败。`scripts/link-dsh-deps.mjs` 通过，`pnpm build` 在 `packages/host/settings-sync/src/index.ts(191,17)` 与 `(196,17)` 报出 `TS2345`：`"loader/config-update"` 与 `"loader/volatile-update"` 不能赋给 `keyof Events`。脚本按设计在这一步以退出码 1 终止，并打印失败步骤与失败命令。
- 第 4 步「四项静态检查」、第 5 步「单元测试」、第 6 步「官方 profile 真实安装验证」没有被升级脚本执行，因为第 3 步已经失败。

为了记录后续步骤的真实状态，单独执行了这些命令：

- `pnpm --config.verify-deps-before-run=false check:telemetry`：退出码 1。`gateway/package.json` 出现 `chatdsh.gateway.mobile.pairing` 与 `chatdsh.gateway.push.deliver`，没有在 `docs/telemetry.md` 登记。
- `pnpm --config.verify-deps-before-run=false check:plugins`：退出码 1。读取 `runtime/e2e/profiles` 时 `ENOENT`。
- 上游包名检查 `check:upstream-names`：退出码 1。`packages/core/contracts/src/message-sources.ts` 使用 `@deepseek-ai/dsh-llm`，没有在适配层登记。
- `pnpm --config.verify-deps-before-run=false check:layering`：退出码 1。缺少角色目录 `packages/tool` 与 `packages/preset`。
- `pnpm --config.verify-deps-before-run=false test`：退出码 1。共 90 个测试，72 个通过，17 个失败，1 个跳过，耗时约 220.6 秒。失败包括 12 个测试文件从 `gateway/lib/store.js` 导入不存在的 `ShareStore`，4 个设备连续性或补传超时用例，以及 `service-contracts` 找不到 `packages/host/memory/lib/index.js`。
- `pnpm --config.verify-deps-before-run=false verify:plugin-install`：退出码 0，完整通过。

## 遗留风险

- `packages/host/settings-sync` 的类型错误会阻断 `pnpm build`，因此 `upgrade-dsh.mjs` 目前只能执行到第 3 步。该问题属于并行工作包的范围，修复后升级脚本才能继续执行静态检查、单元测试与安装验证。
- `verify-plugin-install.mjs` 依赖已经存在的 `lib` 产物。全新检出后需要先运行 `pnpm build && pnpm build:client`。当前 `pnpm build` 以非零退出码结束，但仍会写出 JavaScript 产物；这个行为在类型错误修复前不能作为稳定的构建保证。
- 四项静态检查与单元测试的失败原因不在 P01 的修改范围内，需要由对应工作包修复后，`upgrade-dsh.mjs` 才可能整体退出码 0。
- 发布时需要同时发布上述 11 个包，版本都保持 `0.1.0`。组合包 tarball 的依赖是精确版本号，缺少任意一个包都会让 npm 安装失败。
- profile 的 `overrides` 使用绝对 `file:` 路径，只适用于本次隔离验收。长期使用的 profile 应改用已发布版本或稳定的本地 registry。
- `dsh plugin add` 期间 pnpm 报告 peer dependency 警告。官方 profile 已提供运行所需的 DSH 包，服务启动、插件加载与客户端产物取回都正常；发布前仍应核对 peer 范围与实际安装版本。
- 验收脚本精确断言 `__DSH_BOOT__` 的模块地址格式 `plugins/??<包名>/client.js&rev=<版本>`，以及 `dump-config` 的段落标题与行格式。上游改变这些输出格式时，脚本需要同步调整。
- pnpm 11.21.0 在本机没有读取 `npm_config_store_dir`，直接执行 pnpm 时仍会使用默认 store。验收脚本显式传入 `--config.store-dir`，并同时设置 `pnpm_config_store_dir` 与 `npm_config_store_dir`。默认 store 位于 `runtime/.run/pnpm-store`，也可以通过 `CHATDSH_VERIFY_PNPM_STORE` 覆盖。
- 本次没有提交 git，改动保留在工作树中。
