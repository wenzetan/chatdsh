# Super-Agent 设计附件验证记录

验证日期为 2026-11-09，运行环境为 Linux x64、Node v24.19.0、SQLite 3.53.3、Git 2.43.0。所有验证数据位于 `runtime/.verify/superagent-design/`，该目录已被版本管理忽略。验证脚本使用真实 SQLite 与 Git；生产实现的验收范围使用 [AC-SA01–27](implementation.md)。

## 1. 已执行的设计检查

| 检查 | 实际结果与覆盖范围 |
|---|---|
| TypeScript 严格检查 | contracts.ts 通过，包含用户接口、角色工具、执行端口、枚举和固定默认额度 |
| SQLite 与契约检查 | verify.mjs 的 103 项检查通过；实际建表、外键、单 Router、活动尝试、一层子代理、消息来源去重、目标预算、内部成果范围、依赖 DAG、人工决定、审阅单次消费与动作绑定、应用阶段与错误码登记 |
| SHA-1 Git 实验 | 空仓库没有占位提交；原生树合并、对象传递、文本与二进制、重命名、原暂存意图与未暂存内容保留、已应用输入、下游依赖、空树、实际重叠冲突与过期引用比较交换拒绝全部通过 |
| SHA-256 Git 实验 | 同一组 Git 条件全部通过，实际 Git 对象使用 64 字符标识 |
| 索引元数据实验 | 两种对象格式均保留 intent-to-add、未受影响的 assume-unchanged；原生 Git 读取第四版与共享索引，原索引字节不变，结果树与候选一致 |
| Super-Agent 本地链接 | verify_links.py 通过，检查 21 份文档中的 504 个本地链接 |
| 现有设计文档检查 | check-design-docs.py 通过，检查 5 份既有设计文档中的 312 个链接 |
| 既有遥测声明检查 | check-telemetry.mjs 通过，检查 77 个包；Super-Agent 新信号保持设计登记状态 |

SQL 检查的报告保存于 `schema-xxhWWO/report.json`，数据库为同目录 state.sqlite。成功的 Git 报告分别保存于 `git-IXfyeJ/report.json` 与 `git-Z5FksT/report.json`，索引报告分别为这两个目录下的 `index-flags-NAxqJ8/report.json` 与 `index-flags-UdG3W8/report.json`。这些报告的 productionAcceptance 均为 false，保存路径相对于本节的验证数据目录。

Git 实验中的输入是独立验证仓库里的文本、二进制与重命名数据，提交使用独立验证身份。内部计算提交保存在独立计算仓库，源实验仓库最终历史只有基础数据与批准成果两个提交。脚本关闭该独立仓库的签名和钩子，以直接验证所规定的树、索引、文件与引用算法；生产钩子、签名、执行器与中断恢复仍按对应 AC 使用真实环境验收。

## 2. 复现命令

下列命令的工作目录为 `runtime/`：

```bash
node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module NodeNext --moduleResolution NodeNext --types node docs/superagent/contracts.ts
node docs/superagent/verify.mjs
python3 docs/superagent/verify_links.py
python3 scripts/check-design-docs.py
node scripts/check-telemetry.mjs
```

链接检查使用 markdown-it-py 解析 Markdown，核对本目录全部 Markdown 与相关设计入口的本地链接。依赖缺失时直接安装该库；不会改用自行编写的 Markdown 解析器。每次执行 SQLite 检查都新建独立目录，不覆盖已有证据。

Git 实验分为 prepare、stage、merge、apply 四个动作，分别显示待提交的实际差异。使用 [verify_git.mjs](verify_git.mjs)：

```bash
node docs/superagent/verify_git.mjs prepare sha1
```

阅读[提交信息模板](../prompts/git-commit-message.md)，将该步骤输出的完整差异放入模板的 Diff 部分，生成当前验证数据的提交信息，再将完整信息作为 stage 的一个参数：

```bash
node docs/superagent/verify_git.mjs stage '<生成的完整提交信息>'
```

对 stage 输出的全部计算输入差异同样使用提交模板，生成内部计算提交信息，再执行：

```bash
node docs/superagent/verify_git.mjs merge '<生成的完整提交信息>'
```

merge 输出最终批准成果的实际差异，对该差异使用提交模板生成成果提交信息，再执行：

```bash
node docs/superagent/verify_git.mjs apply '<生成的完整提交信息>'
```

完成一个仓库后，以 `prepare sha256` 开始第二个仓库并重复 stage、merge、apply。每个阶段失败直接结束，报告只在全部断言通过后产生。脚本自行清除影响本机 Git 的命令环境配置，验证期间只操作自己创建的独立目录。

对当前实验仓库执行索引元数据检查；也可以在 index 后传入已有独立 Git 实验目录的绝对路径，脚本只接受本项目验证目录中的数据：

```bash
node docs/superagent/verify_git.mjs index
```

## 3. 功能验收范围

本次交付包括设计文档、类型附件、SQL 附件和设计检查脚本。运行时尚未提供 Super-Agent 用户端点、Engine、执行器与客户端组件，现有包、profile 和功能通过记录保持实际状态。

生产验收需要真实 DSH 与模型、Linux/macOS/Windows 执行器、真实 HTTP 身份通道、逐阶段进程中断、钩子与签名、LFS 与子模块、客户端 DOM 交互和遥测查询。实施工作包规定每项验证的证据与完成条件，设计附件检查不会替代这些结果。
