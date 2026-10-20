# ChatDSH 工作区

以 DSH（deepseek-harness）为运行内核的自托管 ChatGPT 对应物的开发工作区。这个目录本身不是一个 Git 仓库，下面的每个子目录各自独立。

## 目录构成

| 目录 | 内容 | 版本管理 |
|---|---|---|
| [`chatdsh-main/`](chatdsh-main/) | 主仓库：插件、组合包、预设、客户端插件、控制平面服务、部署 profile、文档与校验脚本 | 独立 Git 仓库 |
| [`chatdsn-adapter/`](chatdsn-adapter/) | 适配层 `@chatdsh/adapter`：DSH 内部 API 的唯一接触面 | 独立 Git 仓库 |
| [`refer_repos/`](refer_repos/) | 参考项目快照，本地检索用 | 各项目自带 Git 仓库，不纳入本项目版本管理 |

两个仓库同级的目录层级有实际约束：主仓库的 profile 目录以 `link:` 协议引用适配层，链接目标按同级关系解析，改动目录层级会让 profile 装不出依赖。容器环境也按同样的结构复制仓库，见 [`chatdsh-main/dev/README.md`](chatdsh-main/dev/README.md)。

## 从哪里开始读

- 主仓库的总体设计与各子系统设计：[`chatdsh-main/docs/architecture.md`](chatdsh-main/docs/architecture.md)
- 适配层的设计与版本约定：[`chatdsn-adapter/README.md`](chatdsn-adapter/README.md)
- 逐项验收状态：[`chatdsh-main/docs/acceptance.md`](chatdsh-main/docs/acceptance.md)
- 后续清单与解锁条件：[`chatdsh-main/docs/next-steps.md`](chatdsh-main/docs/next-steps.md)

## 本机的开发调试环境

调试用的 dsh 运行时、Hermes、Hindsight 各自跑在独立容器里，端口与宿主上已经在跑的实例错开，两套环境可以并存。编排文件在 [`chatdsh-main/dev/`](chatdsh-main/dev/)，说明见 [`chatdsh-main/dev/README.md`](chatdsh-main/dev/README.md)。

## 参考项目

`refer_repos/` 下的项目是开发过程中的参考实现，其中对程序设计产生过正面作用的有：

- [Clarklevis1995/dsh-mobile](refer_repos/Clarklevis1995_dsh-mobile) —— 移动端形态的实现参考，客户端与内核之间的职责划分沿用自此。
- [saya-ch/dsh-mobile](refer_repos/saya-ch_dsh-mobile) —— 浏览器侧作为独立 npm 包发布的做法，客户端插件的产物形态参考自此。
- [dataelement/dsh-desktop](refer_repos/dataelement_dsh-desktop) —— Electron 桌面端的构建与补丁流程参考自此。
- [anywhere-labs/dsh-desktop](refer_repos/anywhere-labs_dsh-desktop) —— 桌面端的多包工作区组织方式参考自此。
- [shaobeichen/dsh-pocket](refer_repos/shaobeichen_dsh-pocket) —— 轻量客户端的形态参考。
- [kelai141/dsh-mobile-apk](refer_repos/kelai141_dsh-mobile-apk) —— 移动端打包流程参考。
- [ZCode](refer_repos/ZCode) —— 多包仓库的组织方式参考。

这些仓库保留在本地供检索，不纳入本项目的版本管理。
