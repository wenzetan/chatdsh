# 兼容性与升级

本文件记录上游版本与本仓库的对应关系、登记表的职责，以及升级 DSH 内核时要跑的命令。验收证据在[验收状态](acceptance.md)，适配层的设计在[架构设计](architecture.md) 4.1.1 节。

## 一、兼容矩阵

| DSH 内核 | 已验证的 dsh-tui | chatdsh-web | chatdsh-desktop | chatdsh-worker | chatdsh-cli |
|---|---|---|---|---|---|
| `0.2.1-rc.2` | `0.16.1` | 通过 | 通过 | 通过 | 通过 |

`dsh-tui` 的版本由内核版本决定：它内部有一份已验证版本清单，内核落在清单外时启动页会报告版本漂移。`chatdsh-cli` 的 profile 声明 `0.16.1`，并在 bundles 里挂上 `@deepseek-ai/dsh-experimental-ralph-bundle`，因为 dsh-tui 0.16.1 的补丁层按 id 关闭 `tool-ralph`，这一行由该组合包插入。

业务包的 `engines.dsh` 统一写 `>=0.2.1-rc.2 <0.3.0-0`：0.2.x 内的新版不需要改业务包；跨到 0.3.0 才需要一次显式回归。

## 二、登记表职责

上游包名、行 id 与事件名都登记在 `dsh-adapter` 里，业务包只从适配层取。改动时按名字的类别跑对应脚本：

| 名字类别 | 登记位置 | 校验脚本 |
|---|---|---|
| 上游包名 | `dsh-adapter/src/upstream.ts` 的 `UPSTREAM_PACKAGE_NAMES` | `pnpm check:upstream-names` |
| 补丁层行 id | `UPSTREAM_ROWS`、`UPSTREAM_TOOL_ROWS`、`UPSTREAM_AGENT_ROWS` | `pnpm check:surface` |
| 上游事件名 | `dsh-adapter/src/events.ts` | `dsh-adapter` 的单元测试 |
| 安装面 | 不登记，由安装决定 | `pnpm check:surface` |

`check:surface` 核对三件事：登记表里的包在 DSH 安装里存在（四个按需装入的提供方组合包在允许清单里）；每个补丁行的 `name:` 都能在登记表里找到来源；能力清单的每一行都有来源。需要在别的机器上跑时，设置 `CHATDSH_DSH_INSTALL` 指向 DSH 安装根，或用 `--allow-missing` 追加允许缺席的包名。

## 三、升级步骤

```bash
cd runtime
node scripts/upgrade-dsh.mjs --dry-run          # 打印当前版本与五步计划
node scripts/upgrade-dsh.mjs --to <版本> --apply  # 改适配层、构建、核对包名
```

脚本按顺序做五步：读 `dsh --version`；改 `dsh-adapter/package.json` 的 `engines.dsh` 与精确版本 peer；提示上游改名时要改登记表（改名前脚本无法自动判断）；构建适配层；构建运行时并跑 `check:upstream-names`。任一步失败即停，已完成的步骤会打印出来。

随后手工跑完这几条，全部退出码为零才算升级完成：

```bash
pnpm build && pnpm build:client && pnpm test
pnpm check:telemetry && pnpm check:plugins && pnpm check:upstream-names
pnpm check:profiles && pnpm check:layering && pnpm check:capabilities && pnpm check:surface
node scripts/check-composition.mjs
node scripts/verify-telemetry-sync.mjs
node scripts/verify-memory.mjs
```

升级 `dsh-tui` 时先确认它的已验证清单覆盖新内核，再改 `profiles/chatdsh-cli/package.json` 的版本号，然后用 pnpm 更新该 profile 的锁文件并重跑组合检查。
