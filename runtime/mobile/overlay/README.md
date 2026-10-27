# 适配层

这一层放本仓库接手维护的上游文件，以及本仓库独有的新增文件。路径与 `mobile/base/` 内的相对路径一致，`scripts/sync-mobile-base.mjs` 按路径覆盖。

## 清单条目

`manifest.json` 的 `entries` 每项必须写清三件事：`path`、`reason`，以及该文件与上游的关系。

| 字段 | 含义 |
|---|---|
| `path` | 相对 `mobile/base` 的路径 |
| `reason` | 为什么必须由本仓库接管；不写清楚就无法判断上游升级后还要不要继续接管 |
| `upstreamSha256` | 接管时上游同名文件的摘要；由 `--record` 写入，用于检测上游漂移 |
| `added` | 本仓库独有的新增文件，上游没有同名文件，不参与漂移比对 |

## 接管判断

能不改就不改：上游的协议解码、事件折叠、会话状态机、投影与历史同步都不在本层。只有在下面几种情况下才接管整文件。

- 上游的连接与鉴权模型与本仓库的控制平面不兼容，且差异必须落在客户端代码里。
- 配色、字号、间距按本仓库的界面基础设计实现，而上游把取值写在代码里。
- 上游缺少本仓库必须有的能力，比如遥测上报。
- 构建与签名方式必须换成本仓库的方式。

相邻的做法是在文件里加最小改动。上游一个文件动辄上千行，整文件接管会让上游的每一处修复都要人工搬运；能落在新增文件里就不接管整文件。

## 上游漂移

上游升级后先跑 `node scripts/sync-mobile-base.mjs --check`。被接管文件的上游原文若已改变，脚本列出冲突路径与两边的摘要前缀并退出非零。

处理顺序固定：先读上游那一版的改动，把上游的修复合进 `overlay/files` 里的接管文件，确认行为仍然正确，再跑 `--record` 更新基线。反过来做会把没合入的上游改动记成已合并，之后再也发现不了。

`--record` 在有条目被跳过时拒绝写盘，避免清单被静默截断。

## 当前接管范围

| 文件 | 性质 | 接管原因 |
|---|---|---|
| `androidApp/build.gradle.kts` | 接管 | 版本号取自 `mobile/version.properties`，签名换成本仓库的 release 密钥 |
| `androidApp/.../ui/DshTheme.kt` | 接管 | 配色按 [`docs/ui-baseline-design.md`](../../docs/ui-baseline-design.md) 的令牌重写，保留上游接口名 |
| `androidApp/.../platform/ControlPlanePairing.kt` | 新增 | 与控制平面配对、保存设备令牌、换取运行时启动路径 |
| `androidApp/.../telemetry/MobileTelemetry.kt` | 新增 | 按 [`docs/mobile-protocol.md`](../../docs/mobile-protocol.md) 第三节上报移动端信号 |
