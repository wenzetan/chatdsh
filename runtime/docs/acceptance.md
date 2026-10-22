# 验收状态

逐项对照[架构文档第十二节](architecture.md)的验收方式，记录当前状态与复现命令。状态只有三种：**通过**（有可复现的证据）、**部分**（有实现但缺少一项必要条件）、**未触及**（依赖本机不具备的基础设施）。

复现前先准备环境：

```bash
export PATH=/usr/local/nvm/versions/node/v24.19.0/bin:$PATH
export DSH_HOME=/workspace/chatdsh/runtime/.run/dsh-home
node scripts/link-dsh-deps.mjs
./node_modules/.bin/tsc -b tsconfig.build.json
node scripts/build-client.mjs
node scripts/sync-profiles.mjs
```

## 一、组合成立性

**通过。** `node scripts/check-composition.mjs` 对每个 profile 检查退出码、警告输出与条目 id 唯一性，并附带核对配置模式文档能否产出。四个 profile 全部通过。

```bash
node scripts/check-composition.mjs
```

最近一次结果：

```
chatdsh-cli：通过（条目 117 个，重复 0 个，配置模式文档 有，投影警告 12 条）
chatdsh-desktop：通过（条目 214 个，重复 0 个，配置模式文档 有，投影警告 9 条）
chatdsh-web：通过（条目 214 个，重复 0 个，配置模式文档 有，投影警告 9 条）
chatdsh-worker：通过（条目 113 个，重复 0 个，配置模式文档 有，投影警告 0 条）
```

`chatdsh-cli` 挂载了 `@deepseek-ai/dsh-experimental-ralph-bundle`。dsh-tui 0.16.1 的补丁层按 id 关闭 `tool-ralph`，该行由这个可选组合包插入；补丁目标缺失时启动器会打印 `patch: entry "tool-ralph" not found`。profile 的补丁层再把整组 `optional-ralph` 关闭，命令行形态不暴露重复执行能力。

配置模式导出（`--dump-config-schema`）在当前上游版本上总会返回非零并打印投影限制的警告，内置 profile 同样如此；检查判定的是模式文档能否产出。

## 二、插件契约

**通过。** 自建包都声明了 `engines.dsh`；客户端插件声明了 `dsh.client`，产物经 `./client` 子路径提供。清单声明这一半有脚本可查：

```bash
node scripts/check-plugin-contract.mjs
```

```
插件 26 个、客户端插件 13 个、组合包 6 个、profile 5 个、纯库 0 个
插件契约检查通过
```

这一轮新增的包是 `host/model-provider`、`host/context-insights`、`host/skills`、`tool/skill-manage`、`client/model-provider`、`client/context-insights`、`client/skills`、`client/automation`，另有同级的 `hermes-adapter`、`hindsight-adapter` 与 `forge-bridge`。它们的接口与验收命令见 [兼容性与升级](compatibility.md) 与对应包的源码注释。

检查四类声明：插件包的 `engines.dsh`、客户端插件的 `dsh.client` 与 `./client` 子路径、组合包的 `dsh.bundle.patch` 及其指向的文件是否存在、profile 的 `dsh.profile.bundles`。

`dsh plugin --profile chatdsh-web add` 没有实际跑过——本部署的包以工作区链接形式安装，不是从登记处拉取。

## 三、工具可见性

**部分。** 宿主平面注册的工具进入预设的行列表，`chatdsh` 预设的 `plugins` 列出全部自建工具行：制品写入、项目读写、分享建立、连接器列举、检索展开、图像生成六个默认挂载，浏览器操作一个按需挂载。这一层由契约检查覆盖：

```bash
node scripts/check-plugin-contract.mjs
```

```
工具 7 个；预设挂载 6 个：tool-artifact、tool-project、tool-share、tool-connector、tool-research、tool-image
插件契约检查通过
```

`ctx.tools.restrict` 与预设差异移除工具这两条没有验证：需要一次真实的会话与模型调用。

## 四、桌面控制

**未触及。** 两层的共同前提是 `@deepseek-ai/dsh-computer-use` 与 native 提供方，本机没有安装；Linux 层要求宿主挂载后核对 59 个工具与三档白名单，真机层要求 Windows x64 与 macOS 14 及以上。

## 五、客户端插件

**部分。** 产物可取回、条目图包含自建包、界面里出现自建内容这三条都有脚本化证据。

```bash
node scripts/verify-client-asset.mjs --profile chatdsh-web --package @chatdsh/client-projects
node scripts/verify-client-ui.mjs
```

九个客户端包都能在模块图里找到并取回产物。界面验收用真实 Chrome 走完首次进入的流程（欢迎页、密钥页、工作区页），在预设选择页断言自建预设的说明文字出现——这一条已经成立。

面板本身的渲染没有断言成功：没有模型凭据时界面停在「选择一个工作区」，进不到主界面，侧栏与设置页都不渲染。脚本把这一步记为「未进入主界面，面板渲染未断言」，不作为失败条件。

客户端插件的 `inject` 有两处，语义不同：`package.json` 的 `dsh.client.inject` 写模块包名、管模块图排序；浏览器产物导出的 `inject` 写服务名、是运行时真正等待的依赖。两处都写错会让面板永久停在 pending。

## 六、存储替换

**未触及。** 当前只有 JSONL 一种会话日志后端，`bundle-storage-jsonl` 显式钉住 `session-persistence-jsonl`。

需要一份 Postgres 实现与对应的存储组合包。条件满足后：造一个 Postgres 实例，把存储组合包换掉，跑一遍「创建会话 → 重启运行时 → 按编号恢复并继续追加」，核对事件序号连续、没有重写；再把旧 JSONL 日志按 `seq` 顺序导入一次，确认导入后行为一致。

## 七、协议接入

**部分。** 创建会话、恢复会话与投影落盘有端到端证据。验收 profile 用独立的数据根，先建立链接再运行：

```bash
ln -sfn /workspace/chatdsh/runtime/e2e/profiles/chatdsh-acp /workspace/chatdsh/runtime/.run/verify-home/profiles/chatdsh-acp
DSH_HOME=/workspace/chatdsh/runtime/.run/verify-home node scripts/verify-acp.mjs --profile chatdsh-acp --cwd /workspace/chatdsh/runtime
```

脚本断言会话落盘后，投影缓存里存在全部 `chatdsh*` 投影单元（会话索引、用量、审批），并打印它们的值。

## 八、身份与隔离

**部分。** 控制平面按请求头识别账号，三条隔离规则有脚本化证据：

```bash
node scripts/verify-isolation.mjs
```

```
alice 上报副本：200
bob 读同一会话的副本：403（水位 null）
bob 上报同一会话：403
bob 查询 alice 的归属表：403
验收通过
```

本轮修掉一处真实缺口：副本的读接口原先只查了写入侧归属，同一会话的副本水位能被别的账号读到；现在读写两侧都按归属表拒绝。

「两个账号各自一个运行时进程」这一条现在有实现与证据。配置项 `CHATDSH_RUNTIME_ROUTES` 接受「账号标识或登录名 → 运行时地址」的对象，反代按账号标识与登录名依次匹配，都没命中时回落到 `CHATDSH_RUNTIME_URL`。格式不合法或取值不是字符串时启动失败，不做静默回退。

```bash
node scripts/verify-routing.mjs
```

```
alice 落到 {"runtime":"a","path":"/probe"}
bob 落到 {"runtime":"b","path":"/probe"}
carol 的状态 404，0 字节
多运行时分派验收通过
```

验收里用两个轻量替身冒充两个运行时，两个账号分别命中自己的目标；未配置分派的账号回落到默认地址，没有落到替身上。

同一件事在真实实例上也验过：

```bash
node scripts/verify-routing-live.mjs
```

```
实例 a 已启动：http://127.0.0.1:3091/
实例 b 已启动：http://127.0.0.1:3092/
控制平面已就绪：http://127.0.0.1:3191
alice 两次：2727265b5726/200 与 2727265b5726/200
bob 两次：bc2ac2d0becf/200 与 bc2ac2d0becf/200
双运行时分派验收通过
```

两个 `dsh` 实例各用独立数据根，分别以 `chatdsh-web` 与 `chatdsh-desktop` 形态启动（后者多启用一个侧栏面板，页面内联的启动条目因此不同）。同一账号的两次请求指纹一致、两个账号的指纹不同，说明反代确实按归属分派到了各自的实例。

架构文档还要求「在 A 里改插件清单与工作区路径，B 不受影响」，这一条没有验。实例各自的 `$DSH_HOME` 决定了配置与存储相互独立，但要验证「改一个实例的清单」还需要一个能修改单实例清单并观察到生效的手段：`--patch` 覆盖层不参与 `dsh --dump-config` 的装配，带着它启动也观察不到某个插件被禁用的迹象（见「已知限制」）。

## 九、聊天与记忆后端

**部分。** 记忆接入层的召回、写入与降级有真实服务证据（Hindsight 在本机运行）：

```bash
node scripts/verify-memory.mjs
```

```
Hindsight 地址：http://127.0.0.1:8889
探活：可用
写入：{"items":1}（17645 毫秒）
召回：4 条
  - 蓝鲸的体长记录为三十米。
记忆后端验收通过
```

探活、写入、召回三段都走真实的 Hindsight。写入用同步方式，耗时约 18 秒——异步写入只要几十毫秒但整合完成后才可召回，验收里用同步换取确定性。

```bash
node --test e2e/unit/memory.test.mjs
```

四种组合的启动与切换没有验证：`chatBackend: hermes` 需要 Hermes 实例，本机没有。

## 十、保活与强制不休眠

**未触及。** 强制不休眠与托盘常驻都只在 Windows 上实现，本机是 Linux。

需要一台 Windows 主机。条件满足后：开启强制不休眠，让机器空闲超过系统睡眠阈值，`powercfg /requests` 里应当出现本程序的 `SYSTEM` 与 `DISPLAY` 请求且机器不睡眠；关闭设置后两条请求消失。托盘常驻下关闭窗口进程仍在、通知与定时任务照常；选择退出后进程消失、通知停止。

## 十一、定时与推送

**通过。** 到期任务执行、离线队列补发、两段式通知与升级都有端到端证据：

```bash
node scripts/verify-schedule.mjs
```

```
登记任务：200 {"id":"c56218f1…","action":"notify","payload":"验收用通知",…}
任务状态：{…,"executedAt":1792434384621,"outcome":"delivered"}
设备收到定时推送 1 条
定时与推送验收通过
```

登记一个 1.5 秒后到期的通知任务，设备订阅事件流。到期后任务被执行、结果记为 `delivered`，设备收到一条定时推送。

```bash
# 到期任务与投递结果
curl -s -X POST http://127.0.0.1:3170/chatdsh/gateway/schedule \
  -H 'Content-Type: application/json' -d '{"action":"wake","delayMs":1000}'
curl -s http://127.0.0.1:3170/chatdsh/gateway/schedule

# 两段式通知（阈值设小便于观察）
CHATDSH_PUSH_ESCALATION_MS=2000 node gateway/lib/main.js
```

## 十二、多客户端共存

**部分。** 事件流一致与已读同步有脚本化证据：

```bash
node scripts/verify-multi-client.mjs      # 两端读同一副本，序列一致、补齐正确、重复上报幂等
node scripts/verify-receipt-sync.mjs      # 一端上报已读，同账号的另一端收到带新水位的通知
```

```
客户端 A 读到序号 [0,1,2]
客户端 B 读到序号 [0,1,2]
补齐后读到序号 [0,1,2,3,4]，水位 4

上报已读：200
已读记录：[{"deviceId":"device-a","readUpToSeq":3,…}]
订阅 A 收到已读通知 1 条，订阅 B 收到 1 条
```

回执按 `x-chatdsh-device-id` 区分设备；两个订阅在验收里用不同的设备标识，记录分得开。副本追加事件时也会向同账号的在线设备广播一条 `kind: "replica"` 的通知，这是跨端实时一致性的数据来源——审批的 `approval/decided` 随会话事件进入副本，其他设备据此刷新后投影里已经没有待处理条目。

副本层的一面已经验过：同一序号带不同内容再来一次时先到者胜（`verify-multi-client.mjs` 里序号 4 的字节数保持 4，没有被后来的 99 覆盖），重复上报也不产生重复记录。会话层的「两端同时提交消息时两条都保留」需要一次真实回合，没有验。仍缺的：审批在另一端的呈现——`client-approval` 把审批记录列在设置页的区段里，客户端订阅了推送并在收到通知后刷新，但设置页要进主界面才能打开，无法观察两端的同一条记录是否同步；以及「通知先到最近活跃的一台，超过阈值才推给全部在线设备」在真实客户端上的阈值表现。

## 十三、远程执行节点

**未触及。** 本机只有一个执行节点。

需要第二台设备，或同一台机器上第二个独立的执行节点进程。条件满足后：从 B 把聊天转成落在 A 目录上的工作会话，核对 `deviceId` 与 `cwd` 写入后不可改；在 B 发消息由 A 执行并写 A 本地的会话日志，事件流回到 B；A 离线时该会话只读且明确报设备离线。

## 十四、跨设备会话

**部分。** 副本的按序号连续、断线补齐、只读镜像有证据（副本查询接口与分享快照）；控制平面侧的导入也有：

```bash
node scripts/verify-import.mjs
```

```
导入结果：200 {"sessionId":"4410f1ef-…","parentSession":"abcdef01-…","watermark":2,"imported":3}
新会话副本序号：[0,1,2]，水位 2
归属记录：cwd=/work/b parent=abcdef01-…
跨账号导入：403
```

导入在控制平面上建一条带 `parentSession` 的新会话，从源会话的副本复制事件，取请求里的工作目录与当前设备标识。源设备是否在线不参与这一步——读的是控制平面保存的副本，因此「源设备离线时导入仍可用」成立。

没有做的部分：客户端侧的「只读打开」界面与输入框禁用。

运行时侧已经具备恢复能力，装进 `bundle-hosted` 后挂在每个 profile 上（配置树里能看到 `chatdsh-import` 这一行，启动零激活警告）：

- `chatdshImport.seedOf(records)`：把控制平面副本还原成会话种子，六个单测覆盖
- `chatdshImport.restore({ sessionId, sourceSessionId, cwd, records })`：调 `ctx.sessions.create(id, { seed, meta: { cwd, parentSession, createdAt } })` 建本地会话

`restore` 没有端到端验证。远端方法的调用通道走客户端 SDK（`ctx.remote.<service>.<method>`），在浏览器页面里发起，命令行无法直接构造——查过 `dsh-typert-protocol`、`dsh-api-remotes`、`dsh-host-webserver` 的产物，都没有暴露可直接 `curl` 的 HTTP 路由。要验证它，需要一个能进到主界面的客户端，在页面上下文里调一次。环境里缺模型凭据，界面停在密钥页之前，因此这一条停在「类型层面接线正确、运行时装配完成」。

## 十五、会话副本

**通过。**

```bash
curl -s "http://127.0.0.1:3170/chatdsh/gateway/replica?sessionId=<id>"
```

返回按 `seq` 连续的事件、水位与事件本体；设备重连时按水位补齐。

## 十六、扩展包

**部分。** 安装与卸载、连接器的加载器行同步都有脚本化证据；界面出现面板这一条没有。

扩展包的装卸：

```bash
node scripts/extensions.mjs install packages/bundle/worker --profile chatdsh-web   # 落盘阈值 12500 → 4000
node scripts/extensions.mjs remove  @chatdsh/bundle-worker --profile chatdsh-web     # 恢复 12500
```

装与卸对称：一次往返之后 profile 的 `dependencies` 指纹回到装卸前的值（`b2afa2beee5d → a81c3fc75b44 → b2afa2beee5d`），`bundles` 回到 4 项。安装时会读组合包的补丁层，把其中引用的自建插件一并补进依赖；卸载时收回这些依赖，别的在装组合包还在用的保留。

连接器把记录同步成加载器行：

```bash
node scripts/verify-telemetry-sync.mjs
```

```
运行时已启动
收到 1 个 trace 请求、1 个 log 请求
请求体里出现 chatdsh.connectors.sync：是
请求体里出现同步日志：是，connectors synced create=1 update=0 remove=0
```

数据根里预置一条启用的连接器记录，启动时同步依次做了「读记录、算计划、建行」，日志正文给出了三类动作的条数——创建 1 条、更新 0 条、删除 0 条。这条链路此前只有单元测试覆盖 `planMcpSync`，从没在运行时里执行过。

没有验证的部分：界面上出现连接器面板、MCP 服务器连上之后其工具以 `mcp__` 前缀进入工具目录（需要一次真实的 MCP 连接与能进主界面的客户端）。

MCP 连接本身已经验过：

```bash
node scripts/verify-mcp-connection.mjs
```

```
运行时已启动
探针收到的请求：["server/discover","initialize","notifications/initialized","tools/list"]
MCP 连接验收通过
```

数据根里放一条指向探针服务器的连接器记录（`e2e/fixtures/mcp-probe.mjs`，stdio 上的 JSON-RPC），启动后 MCP 客户端依次发起发现、握手、初始化通知与工具列表拉取。这条链路从「记录存在」一直到「服务器被真实调用」都通了；剩下没验的是拉回来的工具是否以 `mcp__` 前缀出现在模型可见的工具目录里，那要一次能进主界面的会话。

```bash
node scripts/extensions.mjs list    --profile chatdsh-web
node scripts/extensions.mjs install packages/bundle/worker --profile chatdsh-web
node scripts/extensions.mjs remove  @chatdsh/bundle-worker   --profile chatdsh-web
```

安装后 `bundles` 从 4 项变 5 项，配置树里 `spill-policy` 的 `maxInlineTokens` 从 12500 变成组合包声明的 4000，导入警告为空；卸载后回到 12500，条目数与组合检查恢复原样。脚本按真实路径计算依赖的相对路径——数据根里的 profile 是符号链接，用链接路径算会多出一级。

界面出现面板与 MCP 工具以 `mcp__` 前缀进入目录这两条没有验证：前者需要浏览器，后者需要一次真实的 MCP 服务器连接。

## 十七、登录与两步验证

**未触及。** 控制平面目前只有 `authMode` 为 `tailscale` 一种形态，应用级登录与两步验证所需的字段与实现都没有。

需要账号体系与通行密钥。条件满足后：`authMode` 为 `local` 时未经应用登录的请求在反代前被拒绝且不进入运行时；注册通行密钥后换域名需要重新注册；`twoFactor` 为 `totp` 时错误验证码连续失败达到阈值后锁定；设备会话 30 天有效，到期前 7 天内任一操作顺延 30 天，单台设备失效不影响其他设备。

## 十八、端到端

**通过。** 端到端验收用真实进程与真实依赖，不用替身：

```bash
export PATH=/usr/local/nvm/versions/node/v24.19.0/bin:$PATH
node scripts/verify-llm-router-live.mjs
```

模型主链路是这一轮新增的端到端项：

```
控制平面模型入口通过：200，可见文本 4 个字符，结束原因 stop
非流式上游通过：可见文本 4 个字符，结束原因 stop
路由器模型调用通过：可见文本 4 个字符，结束原因 stop，上游请求增加 1 次
运行时装配通过：http://127.0.0.1:3099/，路由器插件无激活告警
额度拒绝通过：402，错误码 quota-exceeded，上游请求未增加
模型主链路验收通过
```

这条脚本做五件事：起一个观测代理记录发往测试模型网关的请求数；起控制平面，断言入口把流式上游响应翻译成 DSH 分块并带回可见文本与 `stop`；让代理强制上游返回非流式 JSON，断言入口同样翻译出可见文本；用路由器导出的适配器走完整链路完成一次真实模型调用；最后把控制平面换到额度耗尽的实例，断言 402、`quota-exceeded`，且上游请求数不增加。凭据只从 `deploy/.env` 或环境变量读，脚本不打印请求体与模型输出原文。

控制平面入口与路由器另有单元验收：

```bash
node --test e2e/unit/gateway-llm-http.test.mjs
node --test e2e/unit/llm-router.test.mjs
```

它们覆盖真实 HTTP 入口的鉴权顺序与额度前置检查、请求结构到 OpenAI 消息的翻译、上游增量到 DSH 分块的翻译、额度守卫按账号计数、错误码映射，以及路由器服务的 `static inject` 与配置校验。

## 十九、上游契约一致性

**部分。** 三处直接依赖上游内部结构的实现已修正并加了针对性用例；上游包名与版本声明已收拢到适配层，脚本可查；其余接触面尚未逐项核验。

修掉的三处：

**审批的应答关联键。** 上游 `approval/request` 水位事件带的是 `agent`、`toolName`、`callId`、`reason`，没有 `id`——`id` 只存在于会话日志的 `approval/asked` 与 `approval/decided` 两条审计事件里，由审批服务在提出问题时生成，请求方看不到。原先的等待表用 `request.id` 作键，所有请求都落在空字符串上，客户端的应答永远打不中，`takeOver` 模式实际不可用。现在关联键取 `callId`，这是上游明确保证的稳定关联点；没有 `callId` 的请求按失败关闭处理，与上游「没有应答器即失败关闭」的语义一致。

```bash
node --test e2e/unit/approval-answer.test.mjs
```

**审批的待处理列表读面。** 投影的折叠是按会话驱动的，事件本身不带会话标识，原先从事件里取会话标识永远取不到，`pending` 与 `stats` 两个远端方法因此恒返回空。现在改从投影注册表的读面取状态，重启后恢复的会话也会在第一次读取时折叠出来。

**连接器的加载器条目标识。** 加载器在条目缺标识时自己生成一个随机值，生成出来的标识与同步计划里的对不上：下一轮同步会把同一台服务器当成新的再建一次，停用的连接器也永远匹配不到要移除的旧行。现在建行时显式给出标识。

```bash
node --test e2e/unit/connector-mcp.test.mjs
```

顺带修掉的两处接口误用：`host-import` 与 `host-connectors` 把计数器声明成「带属性即计数」，实际契约是取到句柄后调 `add`，这两个指标此前从未加过数；`host-memory` 的召回耗时记在累加计数器上，改为分布记录。

**上游包名的收拢。** 上游包名在源码与配置清单里出现时是字符串：补丁层按 `name` 匹配上游的行，名字写错时整条补丁被跳过，只是不生效；客户端插件的 `dsh.client.inject` 写错时面板永久停在 pending。这些名字原先散落在三个插件的源码、八份补丁层与八份客户端清单里，上游改名时要逐处排查。现在全部登记在适配层的 `UPSTREAM_PACKAGE_NAMES`，脚本核对各处出现的上游包名都在登记处出现过；适配层的单元测试再核对登记的包在 DSH 安装里真实存在。

```bash
node scripts/check-upstream-names.mjs
```

```
适配层登记的上游包名 36 个
上游包名收拢检查通过
```

**版本声明的收敛。** 上游判定兼容性时 `engines.dsh` 单独决定结果，peerDependencies 不参与。三十五个业务包的 `engines.dsh` 原先各自写精确版本 `0.2.1-rc.2`，上游每次发版都要改三十五个文件；现在统一写成 `>=0.2.1-rc.2 <0.3.0-0`，上游在 0.2.x 内发新版时业务包不需要改动。业务包也不再声明上游包的 peer 依赖——它们不直接 import 上游包，这些引用已经全部经由适配层转出，留在清单里只会在升级时多出要改的位置。唯一保留的例外是模块增强：`import type {} from '@deepseek-ai/dsh-session-projection'` 这类写法必须写真实包名才能挂到上游接口上，因此 `host-approval`、`core-session-index`、`host-usage` 三个包保留对应的 peer 声明。

适配层自身的 `engines.dsh` 与 peer 依赖仍写精确版本：它直接引用上游内部结构，版本要逐一核对。升级上游时的顺序是：先改适配层的版本声明与实现，跑适配层的测试，再按新内核版本回归 `runtime` 的验收脚本。

尚未核验的部分：宿主平面插件对上游事件名、`ctx` 服务名与内置行 id 的依赖面还没有逐项核验，升级上游版本时这些引用是首要风险点。

## 已知限制

**补丁覆盖层与配置转储的关系。** `dsh --patch <文件>` 是顶层选项（`--help` 里可见，位置要在应用参数之前）。但 `dsh --dump-config` 装配时只合入各组合包与 profile 的补丁层（`dsh-app-boot` 里是 `applyEntryPatches([], structuredClone(layers.flat()))`），不含 overlay——给 `tool-web` 写 `disabled: true` 之后转储没有任何变化，也没有警告。用转储核对覆盖层会得到假阴性，覆盖层是否生效只能在运行时观察，而当前还没找到合适的观察点。

**Hermes 承载聊天的验证边界。** `bundle-chat-hermes` 与 `host-chat-hermes` 已建立：组合包通过 `check-composition`（chatdsh-hermes 215 条），事件形状通过上游 `materializeAppendBatch` 与 `validateStoredEvents` 校验。`send` 的服务层写入已由 `e2e/unit/hermes-send.test.mjs` 覆盖：真实 Cordis 上下文、真实 JSONL 会话持久化、真实 Hermes 测试容器，断言两轮发送的 12 条事件与序号连续。Remote 方法经页面上下文的调用已经打通：`e2e/fixtures/client-remote-bridge` 手写自建服务的 descriptor 并 `$mount`，再用 `ctx.inject(['remote.chatdshHermesChat'])` 暴露命名空间；`scripts/verify-hermes-send-page.mjs` 在页面上下文创建会话并调用 `send`，断言 6 条事件与助手文本。产品客户端插件也按同一方案接入了各自的贡献，见下一条。

**记忆的自动写入优先使用模型摘要，模型不可用时退回规则抽取。** 插件在 `turn/end` 后读本回合的 user/message 与 assistant/message；配置 `summaryProvider` 与 `summaryModel` 时用 `ctx.llm.stream` 生成摘要，流式块同时兼容 `text` 与 `delta` 字段，输出按 4000 字符截断。调用失败或输出为空时退回 `composeTurnMemory`，并记录 `chatdsh.memory.degraded`（`operation: turn-summary`）；两个字段都缺省时保持规则抽取。同一会话的同一回合只写一次，写入链路与 bank 选择不变。真实回合已验证：`chatdsh-acp-live` 跑一次 prompt 后，Hindsight 文档的 `original_text` 是模型摘要而不是带「用户：」「助手：」前缀的规则文本，`acct:local` bank 收到写入并进入整合。

**共享工作区的记忆写入已接通。** 项目记录增加了 `shared` 标记，`project` 工具的 `set` 可以写入；回合写入时按 cwd 读项目记录，把 `shared` 传给 `banksFor`，共享工作区写组 bank，私有工作区写账号 bank。

**自建 Remote 面板已接通客户端贡献。** 新增 `@chatdsh/core-remote-client` 构造器，九个产品客户端插件在 `apply` 里手写 descriptor、`$mount` 后用 `ctx.inject` 等命名空间就绪再注册面板。`scripts/verify-remote-namespaces.mjs` 在真实页面里断言十个自建命名空间全部挂载，并对每个命名空间做一次只读调用，全部返回成功。审批、制品、助手、连接器等服务的 `remove` 与 Remote 命名空间服务自带方法冲突，宿主导出名改为 `delete`。

**面板组件与网关 HTTP 分支没有自动化测试。** 客户端面板已补上真实点击交互：`scripts/verify-connector-toggle-ui.mjs` 在设置页连接器区段点击「停用」，断言界面变成「（已停用）」且存储记录同步；设置页各面板的远程结果按 `{ ok, value }` 解包，模型提供方、技能、连接器区段均能渲染。网关的 webhook 路由已由 `gateway-webhook-http.test.mjs` 覆盖真实 HTTP 请求、鉴权顺序与落库。服务层的依赖注入由 `e2e/unit/service-contracts.test.mjs` 守住，这一轮它抓出 `host/context-insights` 与 `host/model-provider` 都漏了 `static inject`。

**主题插件契约不在本次验收范围。** [theme-plugin-contract.md](theme-plugin-contract.md) 定义了一套 `ctx.theme` 服务与主题插件的接入方式（`ctx.theme.register`、`ctx.theme.overrideTokens`、`theme/change` 事件、呈现适配器注入 CSS 变量）。架构文档第十二节没有对应条目，代码里也没有实现这套运行时。它描述的是可选能力的扩展点：启用时要先实现 `ctx.theme` 运行时与呈现适配器，再按该契约写主题插件。

**与部署文档的接缝差距。** [deployment.md](deployment.md) 第三节列出的是「必须从第一天就做对」的接缝。当前实现有几处尚未按最终形态落地：

- 账号表只有 `id`、`login`、`created_at` 三列，文档要求从一开始就带 `tailscaleLogin`、`passwordHash`、`totpSecret`、`webauthnCredentials`、`recoveryCodes`、`authMode`、`twoFactor`、`lastAuthenticatedAt`。
- 时间戳存整数毫秒，文档要求 UTC ISO 8601 文本。换 Postgres 时两种格式要先统一才能迁移。
- 副本的 90 天不活跃回收没有实现；副本用量的三维统计（工作区、会话、设备）与按维度清理入口也没有。

这几条在单机自托管下不影响使用——没有登录层就不需要那些账号字段，不换 Postgres 也不需要格式统一。它们会在启用登录层或切换存储后端时变成一次数据迁移。

**模型凭据。** 本机没有 `DEEPSEEK_API_KEY`；模型调用验收走宿主上的测试模型网关，密钥来自 `deploy/.env` 的 `CHATDSH_TEST_GATEWAY_API_KEY`，不依赖 DeepSeek 平台账号。

**浏览器驱动。** 本机装有 Chrome，可以通过调试协议驱动；第五项的界面验收用它走完了首次进入流程并断言了自建预设。缺的是 Playwright 一类的完整界面自动化，以及能进主界面的真实回合。

## 二十、模型主链路与额度

**通过。** `@chatdsh/host-llm-router` 把控制平面的模型入口注册成 DSH 的模型适配器，`stream()` 入口做额度检查；控制平面新增 `POST /chatdsh/gateway/llm`，按账号读 SQLite 额度账本，把 DSH 请求翻译成 OpenAI 兼容请求，并把上游 SSE 翻译回 DSH 分块。

```bash
node scripts/verify-llm-router-live.mjs
```

最近一次结果：

```
控制平面模型入口通过：200，可见文本 4 个字符，结束原因 stop
路由器模型调用通过：可见文本 4 个字符，结束原因 stop，上游请求增加 1 次
运行时装配通过：http://127.0.0.1:3099/，路由器插件无激活告警
额度拒绝通过：402，错误码 quota-exceeded，上游请求未增加
模型主链路验收通过
```

上游响应按 `content-type` 分流：`text/event-stream` 逐帧翻译，`application/json` 整段翻译成同样的一组分块，其余类型回 502 并保留上游原文。`e2e/unit/gateway-llm-http.test.mjs` 覆盖三种分支。上游非 2xx 的响应按原状态码、原 `content-type` 与原响应体回传给调用方，入口不解析也不重组错误体。`e2e/unit/gateway-llm-http.test.mjs` 断言 402 的响应体与 `content-type` 原样到达，`e2e/unit/llm-router.test.mjs` 断言 `LlmUpstreamError` 带 `body`、`contentType` 与 `upstreamCode`，消息里是上游原文；`code` 只用于重试与遥测分支。

额度拒绝有两条独立证据。控制平面侧由 `e2e/unit/gateway-llm-http.test.mjs` 断言 402、`quota-exceeded` 与上游请求数为零；运行时侧由 `e2e/unit/llm-router.test.mjs` 断言 `LlmQuotaError` 同时带 `QUOTA` 与 `quota-exceeded`，且在发出请求之前抛出。上游返回 402、429 或额度类错误码时映射成 `QUOTA`，不进入可恢复失败的重试路径。

额度账本落在控制平面的 `llm_quota` 表，按账号累计，进程重启不丢。启动初值由 `CHATDSH_LLM_QUOTA_USED` 给出，上限由 `CHATDSH_LLM_QUOTA_LIMIT` 给出，留空表示不限制。

运行时装配的回归点：路由器服务把 `llm` 写在 `static inject` 上，`e2e/unit/llm-router.test.mjs` 断言这条依赖清单。

## 二十一、MCP 服务端

**通过。** `@chatdsh/host-mcp-server` 把宿主工具目录暴露为 MCP 服务端。协议入口是一条独立的 HTTP 路由 `/mcp`，用 Bearer 令牌鉴权，不经过 `remoteAccess.decide()`；工具目录按调用方的会话归属过滤后再暴露，工具执行交给同一个 `ctx.tools` 注册表。

```bash
node scripts/verify-mcp-server.mjs
```

最近一次结果：

```
运行时已启动：http://127.0.0.1:3095/
MCP 握手通过：协议版本 chatdsh，工具 1 个
MCP 工具调用通过：返回 50 个字符
MCP 服务端验收通过
```

这条脚本起一个真实的 `chatdsh-web` 运行时并打开协议入口，用标准 MCP 客户端完成握手、列举与调用，同时断言没有令牌的请求返回 401。协议层另有单元验收：

```bash
node --test e2e/unit/mcp-server.test.mjs
```

它覆盖初始化协商、工具目录列举、工具调用、未鉴权拒绝、未知方法与未知工具的错误码、按作用域与会话过滤目录，以及标准 MCP 客户端的完整握手。协议 schema 与版本常量复用 `@modelcontextprotocol/core`，不另写一份。

默认关闭。打开时配置 `enabled: true`、`path` 与 `tokenEnv`；令牌缺失时插件在构造阶段抛出，运行时会报告这一行未激活，不会留下半个可用的协议入口。

## 二十二、MCP 接入

**通过。** MCP 接入把外部 MCP 服务的能力接进执行器。协议细节不由本项目实现：`@chatdsh/host-connectors` 只做配置分发，连接、握手、工具注册与重连交给 DSH 原生的 `dsh-mcp-client` 插件。

配置是全局注册的。控制平面的 `mcp_servers` 记录这个账号下有哪些 MCP，`mcp_endpoints` 按设备保存连接参数。任一设备上报的服务器其他设备都能读到，因此 A 端配置的 MCP 在 B 端也看得见；同一台服务器在不同设备上可以是不同的连接方式。

```bash
node scripts/verify-mcp-registry.mjs
```

最近一次结果：

```
设备 A 上报通过：注册 1 台服务器，端点 1 段
设备 B 读取与上报通过：同一服务器 2 段端点，设备 device-a、device-b
按记录真实接入通过：2 个工具（resolve-library-id、query-docs）
单设备移除通过：另一段端点保留，全局注册仍在
MCP 注册表验收通过
```

这条脚本起真实控制平面，用两台设备标识上报与读取，再用设备 B 的记录经标准 MCP 客户端真实连接 context7 并列举工具。另有单元验收：

```bash
node --test e2e/unit/gateway-mcp-registry.test.mjs
node --test e2e/unit/mcp-config.test.mjs
```

覆盖全局注册、按设备端点、覆盖式上报、单设备移除后全局注册的保留与清理、账号隔离、凭据只存环境变量名，以及 VSCode `mcp.json` 格式的解析与端点转加载器配置。

配置格式沿用 VSCode 的 `mcp.json`：

```json
{
  "servers": {
    "context7": { "type": "http", "url": "https://mcp.context7.com/mcp" },
    "notes": { "type": "stdio", "command": "npx", "args": ["-y", "notes-mcp"], "credentialEnv": "NOTES_TOKEN" }
  }
}
```

启用状态与凭据值都不进控制平面：是否接入由各端自己决定，凭据只同步环境变量名，值留在各端环境里。某台服务器在 A 端能连、B 端因网络条件连不上时，B 端记录仍在，工具目录里没有它的工具，其他端不受影响。

**MCP 服务端设计保留、默认关闭。** `@chatdsh/host-mcp-server` 把本执行器的工具目录暴露给外部程序，当前没有消费方，`chatdsh-web` 的补丁层把它设为 `enabled: false`。协议层与验收命令见第二十一节。
