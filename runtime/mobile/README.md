# ChatDSH Android 客户端

Android 应用以 [Clarklevis1995/dsh-mobile](https://github.com/Clarklevis1995/dsh-mobile) 为上游，本仓库在它之上做适配。源码分成三层，每层职责固定。

| 路径 | 内容 | 版本管理 |
|---|---|---|
| `mobile/base/` | 上游仓库 Android 子树的原样快照 | 纳入 |
| `mobile/overlay/` | 本仓库接管的完整文件与接管清单 | 纳入 |
| `mobile/android/` | 把 base 与 overlay 合成的构建目录 | 不纳入 |

`mobile/base/` 与 `mobile/upstream.json` 记录的上游 tag 一一对应，任何本仓库的改动都不写进这一层。合成由 `scripts/sync-mobile-base.mjs` 完成：先原样复制 base，再用 `overlay/files/` 下的同名文件覆盖。

## 为什么这样分层

上游是活跃项目，2026-10 一个月内从 v1.7.7 走到 v1.7.11，改动覆盖 `shared/` 的协议层、`androidApp/` 的界面与缓存。把适配做成「整文件接管」而不是逐行补丁，有三个直接好处：

- 上游升级时只需要替换 `mobile/base/`，不必重放一串补丁片段。补丁片段在上游改动同一处时会静默失败，整文件接管不会。
- 每个接管文件对应的上游原文摘要记在 `overlay/manifest.json` 里。上游改过同一个文件时，摘要对不上，同步脚本直接报冲突并指出路径，由人判断是把上游改动合进接管文件、还是放弃接管。没有这一步，上游的修复会被覆盖掉且没人发现。
- 接管范围有清单可查。新加一个接管文件必须登记原因，避免接管范围无声扩散。

## 上游升级

```bash
# 1. 看上游有没有新版
node runtime/scripts/check-mobile-upstream.mjs --online

# 2. 把 upstream.json 里的 tag 换成新版，重新导出子树到 mobile/base
#    导出范围以 upstream.json 的 subtree 与 excluded 为准

# 3. 核对版本记录与新快照是否自洽，并检查接管文件的上游原文有没有变
node runtime/scripts/check-mobile-upstream.mjs

# 4. 摘要漂移时，逐个把上游改动合进 overlay/files 下的接管文件，然后重建基线
node runtime/scripts/sync-mobile-base.mjs --record

# 5. 合成并构建
node runtime/scripts/sync-mobile-base.mjs
node runtime/scripts/build-android.mjs
```

第 3 步失败时脚本会列出每个冲突路径与两边的摘要前缀。把冲突处理完之后才允许跑 `--record`，否则会把没合入的上游改动直接记成已合并。

## 构建

```bash
cd runtime
node scripts/build-android.mjs
```

构建脚本依次做四件事：合成 `mobile/android`、读取 `mobile/version.properties` 的版本号、调用 Gradle 产出 release APK、把产物复制成 `.run/apk/chatdsh<版本号>.apk`，并确保下载服务在 `CHATDSH_APK_BIND` 指定的地址上运行（缺省只监听回环）。

签名密钥在首次构建时生成到 `.run/android-signing/chatdsh-release.keystore`，后续构建复用同一把密钥，保证覆盖安装。

## 上游与本仓库的职责边界

| 事项 | 归属 |
|---|---|
| DSH 协议解码、事件折叠、会话状态机、投影、历史同步 | 上游 `shared/`，本仓库不修改 |
| 界面结构、Compose 组件、导航、会话页与设置页 | 上游 `androidApp/`，本仓库按设计令牌与接入方式接管必要文件 |
| 控制平面地址与配对码输入、设备令牌保存、启动路径换取 | 本仓库 `overlay/` |
| 配色令牌、字号与间距 | 本仓库按 [`docs/ui-baseline-design.md`](../docs/ui-baseline-design.md) 接管 `DshTheme.kt` |
| 构建、签名、版本号、产物分发 | 本仓库 `scripts/` |
| 移动端遥测上报 | 本仓库 `overlay/`，端点见 [`docs/mobile-protocol.md`](../docs/mobile-protocol.md) |
