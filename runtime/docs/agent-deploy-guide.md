# AI Agent 自动化部署与接入指南

本文件面向执行部署任务的 AI Agent，定义从环境探测、中继容器部署、公网或内网穿透配置，到本机官方 DSH 插件安装与持久服务接入的完整流程。

## 强制安全与确认边界

1. **只读探测先行**：先采集本机网卡、内网穿透工具、反向代理、端口占用与 `dsh` 运行状态，再向用户提出聚焦的问题。
2. **修改外部配置与持久服务前必须征得同意**：修改反向代理配置、Tailscale Serve/Funnel 规则，或修改 `systemd`、`launchd`、`pm2`、`supervisord` 等持久服务文件并重启服务之前，必须向用户展示具体文件路径、拟修改内容与重启影响，取得明确同意后再执行。
3. **凭据隔离**：配对口令保存在仓库根目录 `.env`（权限 `0600`），设备节点令牌保存在 `$DSH_HOME/chatdsh-device.env`（权限 `0600`），禁止写入 `cordis.patch.yml` 或任何全局可读的服务单元文件。
4. **以真实探测结果验收**：每一步通过实际命令输出与 HTTP 接口结果核对，禁止跳过检查或假定连通。

## 第一阶段：探测宿主机网络与穿透环境

在中继宿主机依次执行以下只读命令，整理本机事实：

```sh
# 1. 检查 Docker 与 Docker Compose
docker --version && docker compose version

# 2. 检查网卡与已分配地址（Linux 使用 ip，macOS 使用 ifconfig）
ip -br addr 2>/dev/null || ifconfig

# 3. 检查常见内网穿透与虚拟组网工具
for cmd in tailscale cloudflared frpc frps zerotier-cli wg easytier-core npc ngrok; do
  command -v "$cmd" >/dev/null 2>&1 && printf '已安装: %s\n' "$cmd"
done
tailscale status 2>/dev/null || true
wg show 2>/dev/null || true

# 4. 检查现有反向代理与 80/443/3170 端口监听情况
for cmd in nginx caddy traefik haproxy openresty; do
  command -v "$cmd" >/dev/null 2>&1 && printf '反向代理: %s\n' "$cmd"
done
ss -tlnp 2>/dev/null | grep -E ':(80|443|3170)\b' || lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ':(80|443|3170)\b' || true
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null || true
```

记录探测到的关键信息：

- 是否存在虚拟网卡（如 `tailscale0` / `utun` 承载 Tailscale、`wg*` 承载 WireGuard、`zt*` 承载 ZeroTier）以及活跃的穿透进程；
- 是否存在正在运行或已安装的反向代理（宿主机进程或 Docker 容器）；
- `3170` 端口是否已被占用（占用时可改用其他宿主机绑定端口 `CHATDSH_GATEWAY_BIND_PORT`）。

## 第二阶段：向用户确认域名与联网方式

将第一阶段探测到的网卡、内网穿透工具与反向代理情况简洁告知用户，并询问以下两项必填信息：

1. **中继对外访问域名（必填）**：例如 `relay.example.com` 或完整精确 origin `https://relay.example.com`（Tailscale Serve 场景下为设备对应的 HTTPS 地址，形如 `https://node-a.example.ts.net`）。不允许带路径、查询参数、片段或内嵌凭据。
2. **中继联网方式**（结合本机探测结果给出清晰选项）：
   - **公网域名 + 反向代理（Nginx / Caddy / Traefik 等）**：中继容器绑定本机 `127.0.0.1:3170`，由前置反向代理终止 TLS 并转发至 `http://127.0.0.1:3170`。
   - **Tailscale（Tailscale Serve / Funnel）**：由 Tailscale 为 `http://127.0.0.1:3170` 自动签发 HTTPS 证书并提供转发（`tailscale serve` 供 tailnet 内访问，`tailscale funnel` 允许公网访问）。
   - **其他内网穿透或组网方案（Cloudflare Tunnel、FRP、ZeroTier、WireGuard、EasyTier 等）**：确认穿透工具将目标域名指向 `http://127.0.0.1:3170`（或跨网卡转发时确认 `CHATDSH_GATEWAY_BIND_HOST` 与防火墙边界）。

## 第三阶段：部署中继容器并完成网络指引

### 3.1 启动 Docker Compose 中继容器

取得用户确认的域名后，在仓库根目录执行：

```sh
bash scripts/relay-up.sh --domain '<用户确认的域名或精确 origin>'
```

若宿主机 `3170` 端口被占用，可在执行前指定 `CHATDSH_GATEWAY_BIND_PORT=<空闲端口>`。

脚本会自动完成以下动作：

- 将精确 origin 写入仓库根目录 `.env` 的 `CHATDSH_PUBLIC_URL`；
- 检查 `.env` 中是否已配置 `CHATDSH_PAIRING_CODE`，缺失时生成 24 字节随机 base64url 口令并保存（权限 `0600`，下次运行自动复用）；
- 通过 [docker-compose.yml](../../docker-compose.yml) 构建并启动 `relay` 容器；
- 探活本机 `http://127.0.0.1:<端口>/healthz` 并探测 `<对外域名>/healthz`。

### 3.2 按联网方式协助完成网络接入

中继容器仅提供本机 HTTP 端口，HTTPS 证书与公网路由由所选联网方式承担：

- **公网反向代理**：
  - 提醒用户将域名 A / AAAA（或 CNAME）记录解析到服务器公网 IP；
  - 若用户同意由 Agent 配置宿主机 Nginx / Caddy / Traefik，先展示完整配置内容并征得同意后再写入与重载。转发配置必须包含：
    - 目标上游：`http://127.0.0.1:<端口>`；
    - 开启 WebSocket 升级（`Upgrade`、`Connection`）与 HTTP/1.1；
    - 关闭响应缓冲（`proxy_buffering off`），放宽读超时（如 `3600s`），请求体上限不小于 `16m`；
    - 覆盖长连接路径：`/chatdsh/gateway/device-link`、`/d/<deviceId>/api/remote.mux`、`/chatdsh/gateway/events`。
- **Tailscale**：
  - 征得用户同意后，按用户选择的暴露范围执行：
    - 仅 tailnet 内访问：`tailscale serve --bg http://127.0.0.1:<端口>`
    - 允许公网访问：`tailscale funnel --bg http://127.0.0.1:<端口>`
- **其他内网穿透**：
  - 按用户使用的穿透工具（`cloudflared`、`frpc` 等）说明或协助配置目标上游 `http://127.0.0.1:<端口>`，确认支持 WebSocket 升级与流式响应；修改其配置文件前同样需先征得用户同意。

完成网络配置后验证外部连通性：

```sh
curl -fsS '<对外域名>/healthz'
```

若用户选择稍后自行处理域名解析或网关配置，明确保留以下提醒与接入命令：

- 域名解析目标与反向代理指向地址 `http://127.0.0.1:<端口>`；
- 后续随时在中继宿主机重新打印设备接入命令的方式：`bash scripts/relay-up.sh --print-join-command`。

## 第四阶段：询问是否代劳安装 DSH 插件与接入中继

中继就绪后，向用户询问：**是否需要由 Agent 代劳在当前设备上安装 `@chatdsh/bundle` 插件并完成中继配对接入？**

- **用户选择自行操作**：给出由 `bash scripts/relay-up.sh --print-join-command` 输出的一行命令 `bash scripts/device-join.sh --relay '<对外域名>' --code '<配对口令>'` 并结束。
- **用户确认由 Agent 代劳**：严格按以下步骤执行。

### 4.1 探测本机 DSH 与持久化服务

在执行任何修改前，先检查本机是否已有运行中的 DSH 进程或持久化服务：

```sh
# 1. 检查 DSH 可执行文件与版本
command -v dsh && dsh --version

# 2. 检查当前运行中的 DSH 进程与参数
pgrep -af '(^|/)dsh(\s|$)' || true

# 3. 检查 Linux systemd 系统级与用户级持久服务
systemctl list-unit-files '*dsh*' 2>/dev/null || true
systemctl --user list-unit-files '*dsh*' 2>/dev/null || true
grep -rn 'dsh' /etc/systemd/system "${HOME}/.config/systemd/user" 2>/dev/null || true

# 4. 检查其他守护进程管理工具
launchctl list 2>/dev/null | grep -i dsh || true
pm2 list 2>/dev/null || true
supervisorctl status 2>/dev/null | grep -i dsh || true
```

### 4.2 存在持久化服务时的确认与变更流程

若探测到 `systemd`（或其他守护进程管理器）正在托管 `dsh`：

1. **读取现有服务文件**，确认它实际使用的 `DSH_HOME`、`--profile`、`--port`、工作目录与现有环境变量来源。
2. **向用户汇报并征求明确同意**（未获同意前禁止修改任何服务文件，也禁止重启服务）：
   - 列出发现的服务名称、服务文件绝对路径与当前运行状态；
   - 明确说明拟执行的变更：
     1. 针对该服务对应的 `DSH_HOME` 与 profile 安装 `@chatdsh/bundle` 并完成中继配对，生成权限为 `0600` 的凭据文件 `<DSH_HOME>/chatdsh-device.env`；
     2. 在该服务文件中添加 `EnvironmentFile=<DSH_HOME>/chatdsh-device.env`（不将明文节点令牌写入服务单元正文），使重启后的持久服务自动携带 `CHATDSH_CONTROL_URL`、`CHATDSH_DEVICE_ID` 与 `CHATDSH_NODE_TOKEN`；
     3. 执行 `daemon-reload` 并重启该服务，同时提示重启会中断当前进行中的会话连接。
3. **取得用户明确同意后执行**：
   - 若本仓库尚未编译产物，先构建适配层与运行时：
     ```sh
     cd dsh-adapter && pnpm install && node scripts/link-dsh-deps.mjs && pnpm build && cd ../runtime && pnpm install && node scripts/link-dsh-deps.mjs && pnpm build && pnpm build:client && cd ..
     ```
   - 以该服务一致的 `DSH_HOME` 与 `--profile` 执行安装与配对（带 `--no-start`，不额外拉起第二个 `dsh` 进程）：
     ```sh
     DSH_HOME='<服务使用的 DSH_HOME>' bash scripts/device-join.sh \
       --profile '<服务使用的 profile>' \
       --relay '<对外域名>' \
       --code '<配对口令>' \
       --no-start
     ```
     （若对外域名尚未完成公网解析但中继在本机运行，可额外附加 `--pair-url http://127.0.0.1:<端口>` 完成首次配对，写入凭据中的 `CHATDSH_CONTROL_URL` 仍保持对外域名。）
   - 修改已获用户同意的服务文件，引用 `<DSH_HOME>/chatdsh-device.env`；
   - 重新加载配置并重启服务（如 `systemctl daemon-reload && systemctl restart <服务名>` 或对应的 `--user` 命令）；
   - 验证服务运行正常且已连上中继：
     ```sh
     curl -fsS '<对外域名或本机中继入口>/chatdsh/gateway/devices'
     ```
     确认目标设备出现在列表中且 `online` 为 `true`（若公网解析尚未生效，说明待解析与反向代理生效后设备长连接会自动重连上线）。

### 4.3 不存在持久化服务时的接入流程

若本机未托管持久 `dsh` 服务：

1. 确认目标 `DSH_HOME`（默认 `~/.dsh`）与 profile（默认 `web`），必要时先完成本地仓库构建。
2. 执行一行接入命令：
   ```sh
   bash scripts/device-join.sh --relay '<对外域名>' --code '<配对口令>' --no-start
   ```
3. 执行 `dsh --profile web --dump-config` 确认退出码为 0 且配置树包含 `@chatdsh/bundle` 条目、无补丁警告。
4. 询问用户是否立即在前台或后台启动 DSH；后续本机再次启动直接执行 `bash scripts/device-join.sh` 即可复用已安装的插件与设备凭据。
