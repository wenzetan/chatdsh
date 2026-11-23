# AI Agent 自动化部署与接入指南

> [!WARNING]
> 本方式属于次选部署方案。尽管本指南与提示词已加入防泄露与命令限制约束，向 AI Agent 授予宿主机终端权限仍存在模型未完全遵守约束、命令异常输出带出敏感内容或上下文留存凭据的泄露风险。建议优先使用 [README.md](../../README.md) 中的手动命令行部署；仅在用户明确知悉并接受该风险的前提下，再执行本指南。

本文件面向执行部署任务的 AI Agent，定义从环境探测、中继容器部署、公网或内网穿透配置、配对审批，到本机官方 DSH 插件安装与持久服务接入的完整流程。

## 零泄露红线与强制安全边界

1. **严禁任何密钥与真实域名进入上下文**：
   - 禁止在命令输出、工具返回、日志或对话回复中打印 `CHATDSH_PAIRING_CODE`、`CHATDSH_NODE_TOKEN`、`CHATDSH_PUBLIC_URL`、VAPID 私钥、TLS 私钥、真实域名、公网 IP 或 tailnet 域名。
   - 禁止执行任何会展开环境变量、凭据或真实域名的命令，包含但不限于：`cat .env`、`cat $DSH_HOME/chatdsh-device.env`、`env`、`printenv`、`docker compose config`、`docker inspect`、`systemctl show --property=Environment`、`ps eww`、`curl -v`、`bash scripts/relay-up.sh --print-join-command`。
   - 仅允许以布尔检查方式确认配置键是否存在（例如 `grep -q '^CHATDSH_PUBLIC_URL=.\+' .env`）。
   - 用户需要查看配对口令或完整设备接入命令时，必须提示用户**在自己的本地终端手动执行** `bash scripts/relay-up.sh --print-join-command`。
   - 中继、反向代理与持久服务使用密钥或域名时，一律通过环境变量文件（`.env`、`$DSH_HOME/chatdsh-device.env`、`EnvironmentFile=`、`${CHATDSH_PUBLIC_URL}`）间接引用，不在命令行参数、服务单元正文或上下文中展开明文。
2. **宿主机监听地址严禁放行到 `0.0.0.0` 或 `::`**：
   - `CHATDSH_GATEWAY_BIND_HOST` 只允许设为 `127.0.0.1`（供本机反向代理、`tailscale serve`、`cloudflared`、`frpc` 转发）或目标内网穿透/虚拟组网网卡（如 `tailscale0`、`wg0`、`zt*`）的具体单网卡 IP，禁止向全网卡通配地址暴露容器端口。
3. **默认启用配对审批并按需关闭配对口令**：
   - 容器默认 `CHATDSH_PAIRING_APPROVAL=required`，任何客户端提交配对申请后均进入 `pending` 状态，必须由中继宿主机管理员执行 `bash scripts/relay-approve.sh approve <requestId>` 明确放行后才会签发一次性设备令牌。
   - 全部目标设备配对完成后，提醒用户执行 `bash scripts/relay-up.sh --disable-pairing` 清空静态配对口令以关闭配对入口（后续新增设备时再执行 `--rotate-pairing-code`）。
4. **修改外部配置与持久服务前必须征得同意**：
   - 修改反向代理配置、Tailscale Serve/Funnel 规则，或修改 `systemd`、`launchd`、`pm2`、`supervisord` 等持久服务文件并重启服务之前，必须向用户展示具体文件路径、拟修改内容与重启影响，取得明确同意后再执行。
5. **以真实探测结果验收**：通过本机 `http://<绑定地址>:<端口>/healthz` 与返回状态码核对结果，禁止跳过检查或假定连通。

## 第一阶段：探测宿主机网络与穿透环境

在中继宿主机执行只读探测，识别可用网卡类型、内网穿透工具与现有反向代理（禁止输出真实公网 IP 或 tailnet 域名明文）：

```sh
# 1. 检查 Docker 与 Docker Compose
docker --version && docker compose version

# 2. 检查网卡名称（仅列出接口名，不回显具体公网或 tailnet 地址）
ip -o link show 2>/dev/null | awk -F': ' '{print $2}' || ifconfig -l

# 3. 检查常见内网穿透与虚拟组网工具是否已安装及运行状态
for cmd in tailscale cloudflared frpc frps zerotier-cli wg easytier-core npc ngrok; do
  command -v "$cmd" >/dev/null 2>&1 && printf '已安装穿透/组网工具: %s\n' "$cmd"
done
systemctl is-active tailscaled cloudflared frpc zerotier-one 2>/dev/null || true

# 4. 检查现有反向代理与 80/443/3170 端口占用
for cmd in nginx caddy traefik haproxy openresty; do
  command -v "$cmd" >/dev/null 2>&1 && printf '已安装反向代理: %s\n' "$cmd"
done
ss -tln 2>/dev/null | grep -E ':(80|443|3170)\b' | awk '{print $1, $4}' || true
docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null || true
```

## 第二阶段：引导用户配置域名（不进入上下文）并确认联网方式

将第一阶段探测到的网卡类型、内网穿透工具与反向代理情况简洁告知用户，并完成以下确认：

1. **由用户本人在本地终端写入域名与监听地址（不发进对话）**：
   - 仅检查存在性，不打印键值：
     ```sh
     grep -q '^CHATDSH_PUBLIC_URL=.\+' .env 2>/dev/null && echo "configured" || echo "missing"
     ```
   - 若为 `missing`，请用户在自己的终端执行以下命令录入必填域名并生成随机配对口令：
     ```sh
     bash scripts/relay-up.sh --prepare-only --redact-secrets
     ```
   - 若用户需要让中继绑定到特定内网穿透网卡 IP（例如 WireGuard / ZeroTier / Tailscale 网卡的私有 IP）而非 `127.0.0.1`，请用户在本地终端附加 `--bind-host <该穿透网卡的具体 IP>` 或直接写入 `.env` 中的 `CHATDSH_GATEWAY_BIND_HOST`（严禁填 `0.0.0.0` 或 `::`，脚本会自动拒绝通配地址）。
2. **向用户确认中继联网方式与访问保护**：
   - **公网域名 + 反向代理（Nginx / Caddy / Traefik 等）**：宿主机仅监听 `127.0.0.1:3170`，前置反向代理终止 TLS 并转发至 `http://127.0.0.1:3170`。**公网暴露必须提醒用户开启 `CHATDSH_ACCESS_MODE=required` 或在反向代理层启用身份认证（Cloudflare Access、OIDC 网关或 mTLS）**，防止未授权访客访问 PWA 与 `/d/<deviceId>/`。
   - **Tailscale（Tailscale Serve / Funnel）**：推荐 `tailscale serve --bg http://127.0.0.1:3170` 仅限 tailnet 私有访问；若选择公网 Funnel，同样要求启用 `CHATDSH_ACCESS_MODE=required`。
   - **其他内网穿透或组网方案（Cloudflare Tunnel、FRP、ZeroTier、WireGuard、EasyTier 等）**：穿透服务转发到 `127.0.0.1:3170` 或仅绑定该穿透服务的专用网卡 IP，严禁放行 `0.0.0.0`。

## 第三阶段：部署中继容器并完成网络指引

### 3.1 以脱敏模式拉起 Docker Compose 中继容器

确认 `.env` 中 `CHATDSH_PUBLIC_URL` 已就绪后，在仓库根目录执行：

```sh
bash scripts/relay-up.sh --redact-secrets
```

脚本直接读取 `.env` 中的配置（默认 `CHATDSH_PAIRING_APPROVAL=required`），校验 `CHATDSH_GATEWAY_BIND_HOST` 非通配地址，缺失 `CHATDSH_PAIRING_CODE` 时自动生成 24 字节随机口令并保存为 `0600` 权限，启动 [docker-compose.yml](../../docker-compose.yml) 中的 `relay` 容器并探活，全程不向标准输出打印密钥与真实域名。

### 3.2 按联网方式协助完成网络接入（引用变量，不展开明文）

- **公网反向代理**：提醒用户配置 DNS 解析与 HTTPS 转发到 `http://<绑定地址>:<端口>`（开启 WebSocket 升级 `Upgrade`/`Connection`、关闭响应缓冲 `proxy_buffering off`、请求体上限 `>= 16m`，覆盖 `/chatdsh/gateway/device-link`、`/d/<deviceId>/api/remote.mux`、`/chatdsh/gateway/events`）。若由 Agent 协助配置，先展示使用环境变量引用的模板变更并取得同意后再写入与重载。
- **Tailscale**：征得用户同意后执行 `tailscale serve --bg http://127.0.0.1:<端口>`（或用户明确要求公网时 `tailscale funnel --bg http://127.0.0.1:<端口>`）。
- **其他内网穿透**：按用户使用的工具配置上游指向 `http://<绑定地址>:<端口>` 并支持 WebSocket，修改配置前先征得同意。

## 第四阶段：询问是否代劳安装 DSH 插件、审批放行与持久服务接入

中继就绪后，向用户询问：**是否需要由 Agent 代劳在当前设备上安装 `@chatdsh/bundle` 插件并完成中继配对接入？**

- **用户选择自行操作**：提示用户在宿主机终端手动运行 `bash scripts/relay-up.sh --print-join-command` 获取接入步骤（跨机设备使用 `bash scripts/device-join.sh --relay <对外域名>` 后通过隐藏输入粘贴口令，不留 Shell 历史），提交申请后在宿主机运行 `bash scripts/relay-approve.sh list` 与 `bash scripts/relay-approve.sh approve <requestId>` 审批放行。
- **用户确认由 Agent 代劳**：严格按以下步骤执行。

### 4.1 探测本机 DSH 与持久化服务

```sh
command -v dsh && dsh --version
pgrep -af '(^|/)dsh(\s|$)' || true
systemctl list-unit-files '*dsh*' 2>/dev/null || true
systemctl --user list-unit-files '*dsh*' 2>/dev/null || true
grep -rl 'dsh' /etc/systemd/system "${HOME}/.config/systemd/user" 2>/dev/null || true
launchctl list 2>/dev/null | grep -i dsh || true
pm2 list 2>/dev/null || true
supervisorctl status 2>/dev/null | grep -i dsh || true
```

### 4.2 存在持久化服务时的确认与变更流程

若探测到 `systemd`（或其他守护进程管理器）正在托管 `dsh`：

1. **核对服务运行用户与配置结构**：确认服务使用的 `User=`、`DSH_HOME`、`--profile` 与 `--port`（不读取或打印已有敏感环境变量值）。
2. **向用户汇报并征求明确同意**（未获同意前禁止修改服务文件，也禁止重启服务）：
   - 列出服务名称、服务文件绝对路径、运行用户（`User=`）与当前状态；
   - 说明拟执行的变更：安装 `@chatdsh/bundle` 并完成中继配对（需在中继宿主机审批放行），生成权限为 `0600` 且属主与服务运行用户一致的 `<DSH_HOME>/chatdsh-device.env`；在服务文件（通常 `0644` 全局可读）中仅添加 `EnvironmentFile=<DSH_HOME>/chatdsh-device.env`（严禁写入明文 `Environment=CHATDSH_NODE_TOKEN=...`）；最后重载并重启服务（会中断当前会话）。
3. **取得用户明确同意后执行**：
   - 如尚未构建产物，先编译 `dsh-adapter` 与 `runtime`；
   - **同机存在 `.env` 时**执行安装与配对（零命令行传密，等待中继审批）：
     ```sh
     DSH_HOME='<服务使用的 DSH_HOME>' bash scripts/device-join.sh \
       --profile '<服务使用的 profile>' \
       --from-relay-env .env \
       --pair-url 'http://<绑定地址>:<中继端口>' \
       --redact-secrets \
       --no-start
     ```
     脚本打印 `requestId` 后，**请用户确认并在中继宿主机执行审批放行**（`bash scripts/relay-approve.sh list` 与 `bash scripts/relay-approve.sh approve <requestId>`），放行后客户端自动领取一次性凭据并写入 `<DSH_HOME>/chatdsh-device.env`（`0600`）。
   - 核对 `<DSH_HOME>/chatdsh-device.env` 权限为 `0600` 且属主与服务 `User=` 一致；
   - 按用户同意的方案在服务文件中添加 `EnvironmentFile=<DSH_HOME>/chatdsh-device.env`，重载并重启服务；
   - 通过本机中继入口仅核对设备在线状态（不输出域名与令牌）。

### 4.3 不存在持久化服务时的接入流程

1. 确认目标 `DSH_HOME`（默认 `~/.dsh`）与 profile（默认 `web`），必要时先构建本地产物。
2. 同机执行 `bash scripts/device-join.sh --from-relay-env .env --pair-url 'http://<绑定地址>:<中继端口>' --redact-secrets --no-start`，跨机由用户在自己终端通过隐藏输入配对。
3. 由用户在中继宿主机执行 `bash scripts/relay-approve.sh approve <requestId>` 放行配对。
4. 核对 `dsh --profile web --dump-config >/dev/null` 退出码为 0。

## 第五阶段：配对完成后的收尾加固

全部目标设备完成配对后，向用户提示以下收尾操作：

1. **关闭静态配对口令**：在宿主机执行 `bash scripts/relay-up.sh --disable-pairing`，使配对端点返回 `404 pairing-disabled`；后续需要新增设备时执行 `bash scripts/relay-up.sh --rotate-pairing-code` 重新启用。
2. **数据卷与凭据备份**：妥善加密备份容器数据卷 `chatdsh-relay-data`（包含 `gateway.sqlite` 与 `access/master.key`）及设备端 `$DSH_HOME/chatdsh-device.env`；设备丢失或怀疑凭据泄露时立即吊销设备并轮换配对口令。
