# 部署与运行

本文件面向单机与家庭服务器部署：安装官方 DSH、装入 `@chatdsh/bundle`、启动轻量中继、完成设备配对，并说明反向代理、TLS、Web Push、遥测开关、数据备份与 DSH 升级步骤。环境变量取值以 `gateway/src` 与 `packages/host/*`、`packages/client/*` 的实现为准。面向 AI Agent 执行自动化探测、部署与持久服务接入的操作流程见 [agent-deploy-guide.md](agent-deploy-guide.md)。

## 一、前置条件

| 项目 | 要求 |
|---|---|
| Node.js | 22 及以上 |
| pnpm | 11.21.0（`runtime/package.json` 的 `packageManager`） |
| 官方 DSH | `@deepseek-ai/dsh`，本机基线 `0.2.2-rc.3` |
| 中继端口 | 默认 `127.0.0.1:3170` |
| 设备运行时 | 每个设备一个官方 `dsh --profile web` 实例，各自独立的 `DSH_HOME` |

设备与中继之间是设备主动拨出的出站长连接。中继不需要访问设备的内网地址，家庭服务器只需要一个可被设备访问的域名与 TLS 入口。

## 二、构建顺序

新检出的仓库按以下顺序构建。适配层必须先于运行时工作区构建。

```sh
cd dsh-adapter
pnpm install
node scripts/link-dsh-deps.mjs
pnpm build
pnpm test

cd ../runtime
pnpm install
node scripts/link-dsh-deps.mjs
pnpm build
pnpm build:client
```

依赖已经预装的环境可以直接执行：

```sh
cd runtime
node_modules/.bin/tsc -b tsconfig.build.json --force
pnpm --config.verify-deps-before-run=false build:client
pnpm --config.verify-deps-before-run=false check:telemetry
pnpm --config.verify-deps-before-run=false check:plugins
node scripts/check-upstream-names.mjs
pnpm --config.verify-deps-before-run=false check:layering
pnpm --config.verify-deps-before-run=false test
```

客户端产物由 `scripts/build-client.mjs` 写入 `packages/client/*/lib/client.js`。官方 profile 通过 `dsh plugin --profile web add` 装入 `@chatdsh/bundle` 后，宿主与客户端插件都从这些产物加载。

## 三、启动轻量中继（默认 Docker Compose）

在仓库根目录执行一行命令拉起中继容器（宿主机只需安装 Docker、Docker Compose、Bash 与 `curl`）：

```sh
bash scripts/relay-up.sh
```

首次运行行为：

1. 通过命令行询问对外域名（必填，例如 `relay.example.com` 或 `https://relay.example.com`），规范化为精确 origin 并写入根目录 `.env`。
2. 检查 `.env` 中是否已有 `CHATDSH_PAIRING_CODE`；未配置时自动生成 24 字节随机配对口令（base64url 编码）并持久化保存到 `.env`（文件权限 `0600`），后续再次运行直接复用。
3. 执行 `docker compose --env-file .env -f docker-compose.yml up -d --build` 启动容器，并等待 `GET http://127.0.0.1:3170/healthz` 返回 `{"ok":true,"service":"chatdsh-gateway",...}`。
4. 就绪后输出一条可在设备端直接复制执行的一行接入命令，以及后续再次打印该命令的方式：

```sh
bash scripts/relay-up.sh --print-join-command
```

默认环境变量模板见 [`.env.example`](../../.env.example)。容器内固定监听 `0.0.0.0:3170`，数据持久化在命名卷 `chatdsh-relay-data`（挂载点 `/data`），宿主机默认仅绑定 `127.0.0.1:3170` 供反向代理转发。监听通配地址时必须设置精确 `CHATDSH_PUBLIC_URL`（不含路径、查询串、片段与登录凭据）。

如需在宿主机直接以 Node 进程运行（不使用容器）：

```sh
cd runtime
DSH_HOME=/srv/chatdsh \
CHATDSH_GATEWAY_HOST=127.0.0.1 \
CHATDSH_GATEWAY_PORT=3170 \
CHATDSH_PUBLIC_URL=https://relay.example.com \
CHATDSH_PAIRING_CODE='替换为随机口令' \
node gateway/lib/main.js
```

## 四、设备一行安装插件并配对启动

复制上一步 `relay-up.sh` 输出的命令并在设备端执行：

```sh
bash scripts/device-join.sh --relay https://relay.example.com --code '<中继配对口令>'
```

该命令自动依次完成：

1. 将当前仓库的 `@chatdsh/bundle` 打包并经官方 `dsh plugin --profile web add` 安装到官方 `web` profile（可通过 `--profile desktop` 指定桌面端，或 `--bundle @chatdsh/bundle` 指定远端包）。
2. 调用 `POST <中继地址>/chatdsh/gateway/devices/pair` 完成设备配对，并将 `CHATDSH_CONTROL_URL`、`CHATDSH_DEVICE_ID` 与 `CHATDSH_NODE_TOKEN` 写入 `$DSH_HOME/chatdsh-device.env`（权限 `0600`）。节点令牌只通过运行环境变量注入，不进入配置树，也不出现在 `dsh --dump-config` 输出里。
3. 注入配对凭据启动官方 DSH 运行时。

后续在同一台设备上重启 DSH 时无需再次传入配对口令，直接执行：

```sh
bash scripts/device-join.sh
```

如需接入新设备，在中继宿主机重新打印配对接入命令即可：

```sh
bash scripts/relay-up.sh --print-join-command
```

设备连接成功后，`GET /chatdsh/gateway/devices` 会列出该设备并标记 `online: true`。配对码在 `.env` 中持久化；如需轮换配对码，修改 `.env` 中的 `CHATDSH_PAIRING_CODE` 后重新执行 `bash scripts/relay-up.sh`。缺少 `CHATDSH_PAIRING_CODE` 时配对端点返回 `404 pairing-disabled`。

手机端使用独立入口：

```sh
curl -fsS -X POST http://127.0.0.1:3170/chatdsh/gateway/mobile/pair \
  -H 'content-type: application/json' \
  -d '{"code":"替换为配对码","deviceName":"phone","platform":"android"}'
```

## 五、访问入口

| 入口 | 用途 |
|---|---|
| `/` | 中继自带的 PWA：设备列表、会话列表、离线只读副本、审批角标、Web Push 订阅与离线草稿 |
| `/d/<deviceId>/` | 经中继访问目标设备的官方 DSH 界面；HTTP 请求沿设备出站长连接转发 |
| `/d/<deviceId>/api/remote.mux` | 官方 Remote 流式调用的 WebSocket 隧道；只允许这一条升级路径 |
| `/d/<deviceId>/chatdsh/*` | 目标设备宿主插件提供的端点，例如遥测状态与身份端点 |
| `/chatdsh/gateway/events` | 中继通知与审批事件的 SSE 流 |
| `/chatdsh/gateway/notifications/vapid` | 读取 Web Push 公钥与 subject |

设备离线时 `/d/<deviceId>/` 的 HTTP 请求返回 `409 device-offline`，WebSocket 升级同样返回 `409`。升级路径不在白名单内时返回 `403 path-invalid`。未知设备返回 `404 device-not-found`，不会回退到默认运行时。

PWA 的根路径由中继生成，不需要单独部署静态站点。Service Worker、清单与图标由中继的 PWA 静态入口提供。

## 六、环境变量全清单

### 6.1 共用数据根

| 变量 | 默认值 | 行为 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | 中继与设备运行时的数据根。中继数据库、设备会话、意图库、访问主密钥与 VAPID 密钥都在这一层之下 |

### 6.2 轻量中继

| 变量 | 默认值 | 行为 |
|---|---|---|
| `CHATDSH_GATEWAY_HOST` | `127.0.0.1` | 监听地址。取 `0.0.0.0` 或 `::` 时必须同时配置 `CHATDSH_PUBLIC_URL` |
| `CHATDSH_GATEWAY_PORT` | `3170` | 监听端口 |
| `CHATDSH_GATEWAY_DB` | `$DSH_HOME/gateway/gateway.sqlite` | SQLite 文件路径 |
| `CHATDSH_PUBLIC_URL` | 未设置 | 对外精确 origin。用于浏览器遥测来源校验与对外链接；监听通配地址时必填 |
| `CHATDSH_PAIRING_CODE` | 未设置 | 节点与手机配对口令。缺失或为空时配对端点返回 `404 pairing-disabled` |
| `CHATDSH_PUSH_MODE` | `two-stage` | 通知投递模式。只有精确取值 `all-at-once` 切换为一次性投递，其他取值按 `two-stage` |
| `CHATDSH_PUSH_ESCALATION_MS` | `120000` | 两阶段投递的升级等待时间，单位毫秒 |
| `CHATDSH_ACCESS_MODE` | `disabled` | 中继访问策略。`disabled` 允许受信任网络直接进入；`required` 要求访问口令认证。只接受这两个取值，其他取值在启动时直接报错 |
| `CHATDSH_VERSION` | `0.1.0` | 中继版本，写入健康检查与遥测资源属性 |
| `CHATDSH_PWA_VERSION` | `CHATDSH_VERSION` 的值 | PWA 版本 |
| `CHATDSH_ENVIRONMENT` | `local` | 遥测资源属性 `deployment.environment` |
| `CHATDSH_VAPID_SUBJECT` | `mailto:chatdsh@localhost` | Web Push 的 VAPID subject |
| `CHATDSH_VAPID_PUBLIC_KEY` | 未设置 | 65 字节未压缩 P-256 公钥的 base64url；与私钥同时设置时使用该对密钥 |
| `CHATDSH_VAPID_PRIVATE_KEY` | 未设置 | P-256 私钥标量的 base64url；与公钥同时设置时使用该对密钥 |

`CHATDSH_VAPID_PUBLIC_KEY` 与 `CHATDSH_VAPID_PRIVATE_KEY` 只设置其中一项时，中继按“未配置”处理，生成一对新密钥并存入 SQLite。公钥与私钥要成对设置。

### 6.3 设备宿主插件

| 变量 | 默认值 | 行为 |
|---|---|---|
| `CHATDSH_CONTROL_URL` | 设备长连接与设置同步为空；会话上报在未设置时为 `http://127.0.0.1:3170` | 中继地址。设备长连接与设置同步在空值时停用；会话上报显式设为空值时不会回退默认端口 |
| `CHATDSH_NODE_TOKEN` | 空 | 配对得到的节点令牌。设备长连接与设置同步在空值时停用；只有环境变量入口，不进入配置树 |
| `CHATDSH_DEVICE_ID` | 设备长连接为空；会话上报与设置同步为 `local` | 本设备标识。设备长连接在空值时不注册本机身份端点，也不建立连接 |
| `CHATDSH_PUSH_INTENT_DB` | `$DSH_HOME/push/replica-intents.sqlite` | 副本补传意图数据库路径 |

设备长连接需要 `CHATDSH_CONTROL_URL`、`CHATDSH_DEVICE_ID` 与 `CHATDSH_NODE_TOKEN` 三项同时齐全。设置同步需要 `CHATDSH_CONTROL_URL` 与 `CHATDSH_NODE_TOKEN` 同时齐全。

### 6.4 遥测

| 变量 | 默认值 | 行为 |
|---|---|---|
| `CHATDSH_TELEMETRY` | 未设置 | 取 `off` 时关闭遥测 |
| `DSH_TELEMETRY_DISABLED` | 未设置 | 取任意非空值时关闭遥测 |
| `CHATDSH_TELEMETRY_ENDPOINT` | `http://127.0.0.1:5080` | OTLP/HTTP 根地址；别名 `OO_URL` |
| `CHATDSH_TELEMETRY_ORG` | `default` | OTLP 组织；别名 `OO_ORG` |
| `CHATDSH_TELEMETRY_USER` | 未设置 | HTTP Basic 用户名；别名 `OO_USER` |
| `CHATDSH_TELEMETRY_PASSWORD` | 未设置 | HTTP Basic 口令；别名 `OO_PASS` |
| `CHATDSH_TELEMETRY_DEBUG` | 未设置 | 取 `1` 时进入调试模式 |
| `CHATDSH_TELEMETRY_TRACE_SAMPLE_RATIO` | `1` | 追踪采样比例，取值 0 到 1 |

缺少用户名或口令时，导出请求不带认证，采集端拒绝后按导出失败计数，业务路径继续运行。设置文件 `telemetry.enabled: false`、启动参数 `--no-telemetry`、设置页开关与 `chatdsh telemetry off` 同样可以关闭遥测，任一来源关闭即关闭。

### 6.5 副本连续性进程

`gateway/src/replica-continuity` 是一套独立的副本连续性服务入口，不随 `chatdsh-gateway` 主进程启动。需要单独运行时使用以下变量。

| 变量 | 默认值 | 行为 |
|---|---|---|
| `CHATDSH_REPLICA_HOST` | `127.0.0.1` | 监听地址 |
| `CHATDSH_REPLICA_PORT` | `3189` | 监听端口 |
| `CHATDSH_REPLICA_DB` | `$DSH_HOME/replica/replica.sqlite` | SQLite 文件路径 |
| `CHATDSH_REPLICA_DEVICES` | 空 | 设备令牌表，格式为 `deviceId:token,deviceId:token` |

## 七、VAPID 与 Web Push

首次启动中继时，如果没有同时提供 `CHATDSH_VAPID_PUBLIC_KEY` 与 `CHATDSH_VAPID_PRIVATE_KEY`，通知存储会生成一对 P-256 密钥并写入 SQLite 的 `push_vapid` 表。公钥通过 `GET /chatdsh/gateway/notifications/vapid` 读取，响应只包含 `publicKey` 与 `subject`，私钥不离开服务端。

推荐让中继首次启动时自动生成密钥；需要固定密钥、迁移部署或轮换时，再按下面的格式提供环境变量。

需要自带密钥时，公钥使用 65 字节未压缩点格式：首字节 `0x04`，随后是 32 字节 X 坐标与 32 字节 Y 坐标，整体做 base64url 编码。私钥使用 P-256 标量的 base64url 编码。两者同时写入 `CHATDSH_VAPID_PUBLIC_KEY` 与 `CHATDSH_VAPID_PRIVATE_KEY`。

浏览器侧在 PWA 页面点击开启通知，页面申请通知权限、调用 `pushManager.subscribe`，把订阅端点与 `p256dh`、`auth` 提交到中继。订阅状态由中继保存，审批提醒使用同一个订阅发送；订阅过期或推送服务返回失效时，中继清理记录并计数。

## 八、反向代理与 TLS

中继默认只监听回环地址，由反向代理终止 TLS。Nginx 示例：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name relay.example.com;

    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:3170;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

注意事项：

- `/d/<deviceId>/api/remote.mux` 与 `/chatdsh/gateway/events` 都是长连接，反向代理必须允许 WebSocket 升级并关闭响应缓冲。
- 副本上报单次请求体上限为 4 MiB，设备前缀转发上限为 8 MiB；代理的 `client_max_body_size` 要高于这两个值。
- `CHATDSH_PUBLIC_URL` 必须与浏览器实际访问的 origin 完全一致，包含协议与端口。经过反向代理后不要让它指向内网地址。
- 中继端口不要直接暴露到公网。需要监听通配地址时，启动会强制要求 `CHATDSH_PUBLIC_URL`。
- 设备侧的官方 DSH Web 服务只接受具体地址，不接受通配地址；中继与设备运行时可以放在同一台机器上，各自使用不同端口。

## 九、遥测开关

默认配置指向本机 OpenObserve `http://127.0.0.1:5080`，组织为 `default`。开启遥测时，中继与宿主插件通过 OTLP/HTTP 上报日志、追踪与指标，跨中继与设备链路传播 `traceparent`。

关闭方式：

```sh
CHATDSH_TELEMETRY=off dsh --profile web --no-open
DSH_TELEMETRY_DISABLED=1 dsh --profile web --no-open
dsh --profile web --no-open --no-telemetry
chatdsh telemetry off
```

也可以在设置文件写入 `telemetry.enabled: false`，或在设置页关闭。关闭后不构造 SDK 对象、不创建 exporter 与 HTTP 代理、不注册上报端点、不生成也不传播 `traceparent`。`GET /chatdsh/telemetry/status` 报告 `enabled: false` 与关闭原因；`POST /chatdsh/telemetry/browser` 返回 404。开启与关闭都不要求重启进程。

本机 OpenObserve 探针：

```sh
OO_USER='登录邮箱' OO_PASS='登录口令' node scripts/telemetry-probe.mjs
```

探针向日志、追踪、指标各写一条并查询回来。`CHATDSH_TELEMETRY=off` 或 `DSH_TELEMETRY_DISABLED` 非空时探针直接退出，不写入任何数据。

## 十、数据目录与备份

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/gateway/gateway.sqlite` | 中继数据库：设备、副本、已读回执、通知、订阅、白名单设置与 VAPID 密钥 |
| `$DSH_HOME/gateway/gateway.sqlite-wal` / `-shm` | SQLite 预写日志与共享内存 |
| `$DSH_HOME/access/master.key` | 中继访问控制主密钥 |
| 各设备自己的 `$DSH_HOME` | 设备会话日志、`cordis.patch.yml`、`push/replica-intents.sqlite` 与设备本地数据 |

备份步骤：

1. 停止中继与设备运行时，确保 SQLite 不再写入。
2. 复制整个 `$DSH_HOME`；至少复制 `gateway/`、`access/` 与各设备的会话目录。
3. 恢复时保持目录权限，只让运行中继与设备运行时的系统用户读取。

中继数据库保存的是只读副本与通知状态，设备本地会话日志才是会话的权威来源。备份中继可以恢复跨设备浏览与通知；备份设备数据根可以恢复会话本身。VAPID 密钥存于中继数据库，恢复后原有浏览器订阅继续有效。

## 十一、升级到新版 DSH

升级前先备份 `$DSH_HOME`，然后按 [compatibility.md](compatibility.md) 的步骤执行：

```sh
npm install -g @deepseek-ai/dsh@next
node runtime/scripts/upgrade-dsh.mjs
```

`upgrade-dsh.mjs` 顺序执行适配层投影与构建、运行时构建、客户端产物构建、四项静态检查、单元测试与官方 profile 真实安装验证。任何一步失败都会以非零退出并打印失败步骤。

升级后重新把组合包装入官方 `web` profile，并核对配置树：

```sh
DSH_HOME=/srv/dsh-device-a dsh plugin --profile web add /path/to/@chatdsh/bundle
DSH_HOME=/srv/dsh-device-a dsh --profile web --dump-config
```

`--dump-config` 应包含组合包追加的全部条目，且没有 `disabled: true` 覆盖上游条目。随后启动一次 `dsh --profile web --no-open`，核对客户端插件产物与遥测状态端点。

## 十二、常见状态码

| 状态码 | 错误码 | 含义 |
|---|---|---|
| 400 | `namespace-not-whitelisted` | 设置写入的命名空间不在白名单 |
| 400 | `pairing-code-invalid` 之外的参数错误 | 配对请求字段不合法 |
| 401 | `pairing-code-invalid` | 配对码不匹配 |
| 403 | `path-invalid` | WebSocket 升级路径不在白名单 |
| 404 | `pairing-disabled` | 中继未配置配对码 |
| 404 | `device-not-found` | 设备标识未登记 |
| 409 | `device-offline` | 目标设备当前没有出站长连接 |
| 413 | `payload-too-large` | 请求体超过端点上限 |
