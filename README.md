# ChatDSH 工作区

面向官方 DSH（deepseek-harness）的跨设备互联插件集与轻量中继服务端。用户直接使用官方 DSH 运行时与官方客户端（Web 端与 Desktop 端），通过 `dsh plugin add` 安装纯附加组合包 `@chatdsh/bundle`，配合自托管的轻量中继服务端实现公网跨设备切换、离线只读会话副本、本机恢复继续、白名单设置同步、审批通知推送与移动端 PWA 入口。

## 目录构成

| 目录 | 内容 |
|---|---|
| [`dsh-adapter/`](dsh-adapter/) | 适配层 `@chatdsh/adapter`：DSH 顶层稳定 API 的唯一接触面（7 个 peer 依赖） |
| [`runtime/`](runtime/) | 运行时侧工作区：3 个核心包、5 个宿主插件、2 个客户端插件、1 个纯附加组合包 `@chatdsh/bundle`、轻量中继服务端 `@chatdsh/gateway`、校验脚本、单元测试与技术文档 |
| [`refer_repos/`](refer_repos/) | 参考项目本地快照，不纳入版本管理 |

## 文档与交付入口

- 文档总纲与事实基线：[`runtime/docs/README.md`](runtime/docs/README.md)
- 目标架构设计：[`runtime/docs/architecture.md`](runtime/docs/architecture.md)
- 实现说明与工作包交付清单（P01–P06）：[`runtime/docs/implementation-guide.md`](runtime/docs/implementation-guide.md)
- 遥测信号清单与关闭规范：[`runtime/docs/telemetry.md`](runtime/docs/telemetry.md)
- DSH 兼容性与升级验证步骤：[`runtime/docs/compatibility.md`](runtime/docs/compatibility.md)
- 凭据与隐私防护：[`runtime/docs/secret-guard.md`](runtime/docs/secret-guard.md)
- 适配层说明：[`dsh-adapter/README.md`](dsh-adapter/README.md)

## 参考项目

`refer_repos/` 保存开发过程中的参考实现快照，登记处位于 [`runtime/refer-repos.json`](runtime/refer-repos.json)，不纳入版本管理。

```sh
node runtime/scripts/clone-refer-repos.mjs               # 拉取清单里的全部仓库
node runtime/scripts/clone-refer-repos.mjs --only dsh-Go # 只拉取指定仓库
node runtime/scripts/clone-refer-repos.mjs --list        # 打印清单
```

| 目录 | 上游 | 作用 |
|---|---|---|
| `dataelement_dsh-desktop` | [dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop) | Electron 桌面端构建与权限核对 |
| `anywhere-labs_dsh-desktop` | [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) | 多包工作区与通道更新核对 |
| `Clarklevis1995_dsh-mobile` | [Clarklevis1995/dsh-mobile](https://github.com/Clarklevis1995/dsh-mobile) | 移动端客户端与内核职责划分 |
| `Clarklevis1995_dsh-plugin-mobile-gateway` | [Clarklevis1995/dsh-plugin-mobile-gateway](https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway) | 移动网关插件接入方式 |
| `saya-ch_dsh-mobile` | [saya-ch/dsh-mobile](https://github.com/saya-ch/dsh-mobile) | 浏览器侧独立 npm 包形态与窄屏抽屉布局 |
| `shaobeichen_dsh-pocket` | [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket) | 轻量客户端反向代理与插槽注册 |
| `kelai141_dsh-mobile-apk` | [kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk) | 移动设备本地运行环境核对 |
| `dsh-Go` | [ccch1mneyyy/dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) | 远程连接协议与插件界面边界核对 |
| `ds-harness-remote` | [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote) | 主机常驻远程隧道、多路复用流与端到端加密对照 |
| `ZCode` | [zai-org/ZCode](https://github.com/zai-org/ZCode) | 多包仓库组织方式 |
| `rea_workbuddy` | 无远端 | 协议与认证对照材料，本地快照 |
