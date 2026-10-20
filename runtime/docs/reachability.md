# 网络可达性与 Tailscale

目标是把 ChatDSH 的全部组件与全部客户端放进同一个 tailnet：控制平面、运行时、Hermes、Hindsight 在服务侧，浏览器、桌面壳、手机在客户端侧，两端通过 MagicDNS 名互通，不依赖公网暴露。首期以 Tailscale 为目标，其他内网穿透方案通过统一接缝接入。

本文件用占位形式书写：tailnet 名统一写作 `example.ts.net`，主机名写作 `node-a`、`host-a`、`sub-a`，设备名写作 `win-a`、`node-b` 这类通用名，地址用示例私网段。真实的 tailnet 名、设备名与地址不写入版本库，也不写进提交信息。

## 一、本机现状

Tailscale 版本 1.102.1，本机节点 MagicDNS 名形如 `node-a.example.ts.net`，MagicDNS 已启用。tailnet 内共 10 台节点，覆盖 Linux、Windows 与 Android。

`tailscale serve status` 显示本机已经在用 Serve 暴露多个本地服务，共 13 条条目，其中与本项目直接相关的一条把 `http://127.0.0.1:3080` 暴露出去——那是 DSH 自身的 web，不是 ChatDSH 的组件。

Serve 使用的主机名（`host-a`）与 `tailscale status --json` 里的 `Self.DNSName`（`node-a`）不一致，两者属于同一台机器、同一个 Tailscale 节点，是节点改名前后留下的两个名字。这一处实测本身就说明了节点名不适合做对外入口：节点改名之后旧条目与新条目的名字不同，客户端保存的地址随之失效。带 svc 标记的条目用的是服务名机制，它允许一个节点挂多个域名，且域名独立于节点身份。ChatDSH 的对外入口固定用 service 名，节点名只作本地排障。

给 ChatDSH 新增一个 service 名与现有条目可以并存，不需要整理旧条目。

ZeroTier（接口名形如 `zt0`，`198.51.100.1/24`）与 EasyTier（接口 `tun0`，`203.0.113.1/24`）在本机同时运行，两者都已具备可用地址。

## 二、Tailscale 解决现有方案的两个痛点

早期的一份隧道配置笔记记录了两条实测结论，它们直接决定客户端能否正常使用 DSH 的 Web 界面。

**浏览器会话 cookie 绑定 authority。** DSH 用 authority 绑定的签名 cookie，名字形如 `dsh-auth-<b64url(sha256(authority))>`。协议、主机、端口任何一项变化，cookie 就不再匹配，用户需要重新登录。局域网地址与 EasyTier 地址都可能变化，MagicDNS 名是稳定的。

**明文 HTTP 的局域网地址不是 secure context。** 浏览器只把 `http://localhost` 当作 secure context，把明文 HTTP 的局域网地址不当，结果是剪贴板与 WebCrypto 不可用，表现为「能连上但难用」。那份笔记的做法是给每台客户端配置 SSH 本地转发到 `127.0.0.1:3080` 绕开这一点。Tailscale 的 HTTPS 在不需要任何客户端侧隧道配置的前提下解决同一个问题。

## 三、首期方案：最短路径

首期按「一个全新用户只用 Tailscale」的最短路径设计，不做配对、不做 ACL、不做证书管理。

1. 安装并启动 ChatDSH，控制平面开两个 TLS 监听：回环 `27777` 供 Serve 转发，EasyTier 接口 `27778` 供反代以 mTLS 接入；运行时只绑回环。
2. 启动器检测 Tailscale：可用就新增一条 Serve 条目，把控制平面暴露为 `https://chatdsh.example.ts.net`；原先指向 `3080` 的条目保持不动，那是 DSH 自身的 web。Tailscale 不可用就退回仅回环访问，并在界面上说明原因。
3. 客户端设备安装 Tailscale 客户端，登录同一个 tailnet。
4. 打开该地址即进入，不需要配对码，不需要输入密码。

运行时继续只绑回环，由控制平面反向代理。Hermes 与 Hindsight 同机时走回环，分机部署时走 tailnet 地址。

HTTPS 证书由 Tailscale 提供。Serve 要求 tailnet 已启用 HTTPS 证书，未启用时 `tailscale serve` 会弹出交互式提示请求代为启用。启动器无法驱动交互式提示，因此未启用证书时应当给出明确的操作指引而不是静默失败。

登录身份取自 Serve 注入的来源身份头部，控制平面读它建立会话。首期不启用应用级配对，**访问权等同于 tailnet 成员资格**：tailnet 内的任何设备都能访问，撤销要通过移除节点实现。ACL 与 tailnet 外的访问都排在后续。

这套做法在本机已有先例：OpenClaw 网关支持自动配置 Tailscale Serve（`gateway.tailscale.mode` 的 `serve` 模式，网关保持绑定回环，由 Tailscale 提供 HTTPS、路由与身份头部）。

域名定下后再改动会导致所有浏览器 cookie 失效一次，所以上线前一次定好。

## 四、身份

Tailscale Serve 在转发的请求上注入来源身份头部。从 tailnet 内另一台设备分别访问 service 名与节点名两种入口（后者只作对照），返回同一组头部：

| 头部 | 实测取值形态 | 用途 |
|---|---|---|
| `host` | 用户访问的域名 | DSH 的 authority 判定 |
| `tailscale-headers-info` | `https://tailscale.com/s/serve-headers` | 说明这些头由 Tailscale 注入，指向官方可信条件说明 |
| `tailscale-user-login` | 形如 `<用户名>@<身份提供方>` | 账号的稳定标识 |
| `tailscale-user-name` | 用户名 | 显示名 |
| `tailscale-user-profile-pic` | 头像地址 | 界面展示 |
| `x-forwarded-for` | 发起请求设备的 tailnet 地址 | 设备识别与审计来源 |
| `x-forwarded-host` | 与 `host` 一致 | 反代透传 |
| `x-forwarded-proto` | `https` | 反代透传 |

四条结论。

**对外只用 service 名。** 入口固定在 `https://chatdsh.example.ts.net`，节点名不做对外入口。节点名随节点改名会变（实测中同一台机器上出现过两个不同的节点名），service 名独立于节点身份，换机器或改节点名都不影响客户端保存的地址与 cookie。节点名入口保留给本地排障，不写进任何客户端配置。

**Host 保留原始域名。** service 名入口的 `host` 是用户访问的 service 域名，Serve 不改写它，因此 DSH 的 authority 绑定 cookie 与用户看到的域名一致，反代不需要改写 Host。

**身份头只在跨设备访问时出现。** 本机访问自己的 tailnet 名字时这组头缺失，因为它无法确定对端身份。所以登录实现必须在真实客户端场景下验证，本机自测不能作为依据。

**登录以 `tailscale-user-login` 为账号稳定标识。** 首次出现该值时为它建账号，`tailscale-user-name` 作显示名，`x-forwarded-for` 作设备识别与审计来源。撤销通过 tailnet 移除节点或撤销 service host 实现。这个值形如 `<用户名>@<身份提供方>`，绑定在具体身份提供方上，换 IdP 或换账号会得到新值，因此账号表需要允许一个账号关联多个 login，或提供一次显式的账号迁移。

可信前提：这些头由本机 Tailscale 守护进程注入，只有在校验请求确实来自 Serve 时才可信。控制平面绑 EasyTier 接口之后，Serve 之外还有一条反代入口，因此校验分两类：带 `tailscale-headers-info` 且 `x-forwarded-for` 落在 tailnet 地址段的请求信任身份头；从 EasyTier 网段直连的请求要求应用级认证，即反代注入的认证头或配对令牌，缺失时拒绝。接入其他可达性提供方时身份头不可用，那时只能依据 `x-forwarded-for` 落在预期地址段内做粗判，或者恢复应用级配对。

即使用上 Tailscale 身份，账号体系与控制平面的授权判定保持不变，Tailscale 身份只是登录环节的一个来源。

## 五、可达性提供方的接缝

把「如何让客户端到达控制平面」抽象成一个提供方接口，首期只实现 Tailscale，其余按同一形状补齐：

| 提供方 | 对外地址 | TLS | 来源身份 | 状态 |
|---|---|---|---|---|
| `tailscale` | MagicDNS 名 | Serve 自动证书 | Serve 注入的头部 | 首期 |
| `easytier` | `tun0` 地址 | 需自签或反代 | 无 | 后续，本机已在运行 |
| `zerotier` | `zt0` 地址 | 需自签或反代 | 无 | 后续，本机已在运行 |
| `cloudflared` | 隧道域名 | Cloudflare 证书 | 无 | 后续 |
| `frp` | 自有域名 | 反代 | 无 | 后续 |
| `manual` | 用户自备反代 | 用户提供 | 无 | 兜底 |

接口需要提供四件事：对外可达的地址、TLS 材料（或说明由外部终止）、请求来源的身份（可能为空）、以及与诊断相关的状态。控制平面在启动时按配置选择实现，客户端配置由控制平面下发，用户不需要为每种方案各配一遍。

已落地的部分：`@chatdsh/contracts` 里的 `AccessProvider` 接口与两个实现（`tailscaleProvider`、`manualProvider`），控制平面通过 `CHATDSH_ACCESS_PROVIDER` 选择，缺省为 `tailscale`。`manual` 用于用户自备反代、没有 Serve 注入头部的场景，此时所有请求都归到 `local` 账号。接 easytier 或 zerotier 时实现同一个接口，判定逻辑不用动。

## 六、域名解析与反代约束

公网域名只承担「方便记忆的名字」这一个作用，它的 DNS 记录指向私有网络地址，反向代理只监听私有接口。这样对公网而言目标地址不可路由，即使有人知道域名也连不上。

具体形状：`<自定义域名>` 的 A 或 AAAA 记录指向 tailnet 的 service 虚拟地址或 EasyTier 的接口地址；反代监听该私有接口上的端口，转发到控制平面的 mTLS 监听；客户端必须已经加入对应网络（装 Tailscale 客户端或 EasyTier），DNS 解析才指向一个它能路由的地址。

三条强制约束。

**反代不得监听公网地址。** 绑定地址只能是私有网络接口或回环，不能是 `0.0.0.0` 或公网网卡。启动时按本地地址表校验绑定值，命中公网地址段即拒绝启动并报出具体地址。

**不得在路由器上为该端口做端口映射。** 这条超出程序能检查的范围，写进部署说明并由使用者保证。它一旦被违反，前面所有的网络层信任都失去意义。

**反代对其客户端负有认证责任。** 它把服务暴露给了私有网络内的其他设备，那些设备可能是他人共用网络里的机器。反代要么只服务自己，要么对客户端做认证并把结果以受控头部传给控制平面。

对公网隐藏地址让「网络成员资格即可信」成为唯一的安全边界，这与内网穿透方案的固有限制一致。它能做到的极限是：知道谁在网络里，不知道谁在操作那台机器。

## 七、两条链路与传输协议的环境差异

接入分两条链路，两者面对的环境不同，协议选择要分开判断。

**用户侧链路**是浏览器、桌面壳、手机到控制平面，这一条受局域网与隧道环境影响，上面的 TLS、authority、ACL 讨论都针对它。

**服务侧内部链路**是 Hermes 的平台插件适配器到控制平面，首期两端同机走回环，不经过任何代理。

内部链路的传输形态抽象成接口，首期实现 SSE 加 POST，两侧都走 `ctx.webServer.register`；跨机场景再补一个 WebSocket 实现，因为那时的环境对两种协议不再等价。逐环境的差异如下。

明文 HTTP 加局域网地址：两种协议都能用，不受 secure context 限制（受限的是剪贴板与 WebCrypto 这类浏览器 API，与协议无关）。

公网反向代理：SSE 是长响应流，反代必须关掉响应缓冲（`proxy_buffering off` 与 `X-Accel-Buffering: no`）并调大读超时，否则连接看起来是通的而内容不流动；WebSocket 需要透传 `Upgrade` 与 `Connection` 头并同样调大超时。配置量相当，SSE 的失效方式更隐蔽。

CDN 与隧道：有缓冲的边缘网络会打断长响应流。实测记录在 `saya-ch` 里——Cloudflare 快速隧道不支持 SSE，而 WebSocket 可用。所以「SSE 穿代理更容易」这个判断在带缓冲的边缘网络下不成立。

内网穿透：Tailscale Serve 与 cloudflared 对两者都支持，它们是本地反向代理，没有缓冲问题；FRP 是 TCP 层转发，两者都可用；免费隧道（Cloudflare 快速隧道、Pinggy 这类）对 SSE 有缓冲与硬超时风险。

两种协议都要处理心跳与重连。中间设备普遍有 60 秒空闲超时，`pocket` 每 30 秒发 Ping 帧，`saya-ch` 周期性写 `: heartbeat` 注释帧。重连都要自己实现，指数退避是常见做法；SSE 的自动重连属于浏览器 `EventSource` 的特性，Python 适配器用不上。

## 八、多机部署

Hermes 与 Hindsight 可以放在 tailnet 内的其他设备上。此时控制平面通过 tailnet 地址访问它们，而不是回环。同样的做法适用于把运行时放到算力更强的机器上：控制平面与运行时的连接改为 tailnet 地址，其余逻辑不变。

## 九、已完成的两项实测

**Host 头行为已确认。** 在 `9443` 上挂一个回显服务，用 `tailscale serve --https=9443` 与 `--service=svc:chatdsh --https=443` 各暴露一次，从另一台 tailnet 设备访问，两条路径都保留了用户访问的原始域名，并附带 `x-forwarded-host` 与 `x-forwarded-proto`。DSH 的 authority 绑定 cookie 因此在 Serve 后面保持一致，反代不需要改写 Host。

**身份头部已确认。** 同一组实测里拿到了 `tailscale-user-login`、`tailscale-user-name`、`tailscale-user-profile-pic` 与 `tailscale-headers-info`，取值形态见第四节。本机访问自己时不注入这组头部，所以必须从真实客户端验证。

**service 名的启用条件。** 创建 service 与批准 host 是两步：管理后台创建 `svc:chatdsh` 之后，节点上执行 `tailscale serve --service=svc:chatdsh` 会提示 `approval from an admin is required`，需要在后台批准该 host，域名才会解析到 service 的虚拟地址。host 自身无法访问自己的 service 虚拟地址（`tailscale ping` 返回 `no matching peer`，虚拟地址 ping 不通），验证必须从其他节点发起。

首期之后的补法：tailnet 外的访问需要恢复配对流程，细粒度撤销需要在控制平面按设备记录令牌，多设备与多人共用需要 tailnet ACL 区分管理入口与客户端入口。
