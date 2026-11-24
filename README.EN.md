# ChatDSH

[中文](README.md) | English

ChatDSH is a cross-device plugin bundle and self-hosted lightweight relay server for the official DSH (DeepSeek Harness). Users run the official DSH runtime and official Web/Desktop clients directly, install the append-only plugin bundle `@chatdsh/bundle` via `dsh plugin add`, and pair devices with a self-hosted `@chatdsh/gateway` relay to enable remote device switching, offline read-only session replicas, local session resume and fork, allowlisted preference synchronization, approval push notifications, and a built-in mobile PWA.

![ChatDSH System Architecture](assets/architecture.en.jpg)

## Key Capabilities

- **Append-Only Plugin Delivery**: `@chatdsh/bundle` adds ChatDSH host and client plugins exclusively through `insert` rules in `cordis.patch.yml`, leaving upstream DSH configuration untouched. All client plugins target the `platform: "web"` contract so the same build runs in both official DSH Web and official DSH Desktop clients.
- **Outbound Multiplexed Tunnel**: Devices behind NAT or firewalls initiate outbound WebSocket connections to the relay via `@chatdsh/host-device-link` (v2 framed protocol supporting up to 128 concurrent logical channels per link, window-based flow control, heartbeat timeouts, and generation replacement). Clients access live remote DSH sessions through `/d/<deviceId>/*` and `/d/<deviceId>/api/remote.mux`.
- **Loopback Same-Origin Relay Proxy**: When a browser connects to a cross-origin relay URL, `@chatdsh/host-device-link` exposes loopback-only allowlisted proxy endpoints that strip sensitive headers, enforce CSRF checks on pairing, and preserve trace propagation.
- **Offline Read-Only Replicas & Local Resume**: Each device's local `$DSH_HOME` remains the authoritative store for session logs. `@chatdsh/host-push` persists sync intents and streams full event envelopes to the relay SQLite database, allowing offline timeline browsing and local session resume or fork on another device via `@chatdsh/host-import`.
- **Allowlisted Preference Sync**: `@chatdsh/host-settings-sync` synchronizes only five portable preference namespaces (default model, locale, chat view, analytics toggle, and preset registry), keeping local paths and machine-specific parameters on each device.
- **Built-In Mobile PWA & Approval Alerts**: The relay serves an installable mobile PWA at `/` with online device status, aggregated sessions, structured read-only timelines, and IndexedDB offline drafts. Approval requests trigger notifications over SSE and Web Push and are automatically withdrawn once decided.
- **Integrated Observability**: Built on OpenTelemetry (targeting local OpenObserve by default) with W3C `traceparent` propagation across browser, relay, and device boundaries. Telemetry can be disabled immediately without restarting via environment variables, settings, CLI flags, or runtime toggles.

## Repository Structure

| Path | Description |
|---|---|
| [`dsh-adapter/`](dsh-adapter/) | `@chatdsh/adapter`: narrow compatibility boundary wrapping 7 direct DSH `peerDependencies` and 13 registered upstream package names |
| [`runtime/packages/core/`](runtime/packages/core/) | Shared core libraries: `@chatdsh/core-contracts`, `@chatdsh/core-diagnostics`, `@chatdsh/core-remote-client` |
| [`runtime/packages/host/`](runtime/packages/host/) | Device-side host plugins: `telemetry`, `device-link`, `push`, `import`, `settings-sync` |
| [`runtime/packages/client/`](runtime/packages/client/) | Client plugins (`platform: "web"`): `telemetry`, `pwa`, `remote` |
| [`runtime/packages/bundle/chatdsh/`](runtime/packages/bundle/chatdsh/) | `@chatdsh/bundle`: append-only bundle installing all ChatDSH host and client plugins in one command |
| [`runtime/gateway/`](runtime/gateway/) | `@chatdsh/gateway`: standalone lightweight relay server hosting device tunnels, prefix routing, replicas, push hub, settings sync, and the mobile PWA |
| [`runtime/docs/`](runtime/docs/) | Architecture, deployment, telemetry, compatibility, and secret-guard documentation |
| [`runtime/scripts/`](runtime/scripts/) | Build tooling, static checks, upstream upgrade verification, and end-to-end verification scripts |
| [`runtime/e2e/unit/`](runtime/e2e/unit/) | Unit and regression test suites |

## Quick Start

<details>
<summary><strong>Preferred: Manual CLI Setup (Zero Clone, Prebuilt GitHub Image &amp; Plugin Bundle)</strong> (Click to expand)</summary>

GitHub Actions automatically builds and publishes two artifacts on every `main` push and version tag:
- **Multi-arch Relay Image**: `ghcr.io/wenzetan/chatdsh-relay:latest` (`linux/amd64` and `linux/arm64`)
- **Prebuilt Plugin Archive**: `chatdsh-plugin-bundle.tar.gz` with `SHA256SUMS.txt` on GitHub Releases (containing `@chatdsh/bundle` and all 12 workspace packages)

#### 1. Prerequisites

- Relay host: Docker & Docker Compose, Bash, and `curl` (no git clone, no host Node.js required)
- Client devices: Node.js 22+, Official DSH (`@deepseek-ai/dsh`, verified baseline `0.2.2-rc.5`), Bash & `curl` on Linux/macOS or PowerShell 5.1 / 7+ on Windows (no git clone, no local build required)

#### 2. Start the Relay via One Remote Command (Docker Compose + GHCR Image)

```sh
curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/relay-up.sh | bash
```

The script fetches [`docker-compose.yml`](docker-compose.yml) and management scripts into `~/.chatdsh/relay` (customizable via `--dir`), prompts for the public relay domain on first run (required, e.g. `relay.example.com` or `https://relay.example.com`), generates and saves a random pairing secret (`0600` permissions, reused on subsequent runs), and pulls `ghcr.io/wenzetan/chatdsh-relay:latest` to start the relay container. The host port binds to `127.0.0.1` by default (pass `--bind-host <tunnel-interface-ip>` for a specific VPN/tunnel interface; wildcard addresses `0.0.0.0` and `::` are rejected), and pairing approval is enabled by default (`CHATDSH_PAIRING_APPROVAL=required`).

Once `/healthz` is ready, the script checks public reachability (printing DNS and reverse-proxy forwarding instructions to `http://127.0.0.1:3170` if not yet configured) and outputs the one-line device join command. To print that command again or update to the latest image on the relay host:

```sh
bash ~/.chatdsh/relay/relay-up.sh --print-join-command
# Pull the latest image and restart: bash ~/.chatdsh/relay/relay-up.sh
```

Terminate TLS in front of `127.0.0.1:3170` with a reverse proxy such as Nginx, Caddy, or Tailscale Serve with WebSocket upgrades enabled and response buffering disabled (for public exposure, enable `CHATDSH_ACCESS_MODE=required` or reverse-proxy authentication; see [`runtime/docs/deployment.md`](runtime/docs/deployment.md)).

#### 3. Install, Pair & Start DSH on a Device via One Remote Command

On any device with official DSH installed, run (no git clone required; downloads the prebuilt plugin archive from GitHub Releases, verifies SHA-256, and prompts silently for the pairing secret so it never enters shell history):

**Linux / macOS (Shell):**

```sh
curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/device-join.sh | bash -s -- --relay https://relay.example.com
```

**Windows (PowerShell — for Windows clients):**

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/device-join.ps1))) -Relay https://relay.example.com
```

The client submits a pending request and waits for approval. On the relay host, inspect and approve it:

```sh
bash ~/.chatdsh/relay/relay-approve.sh list
bash ~/.chatdsh/relay/relay-approve.sh approve <requestId>
```

Once approved, the script claims the one-time device token, saves credentials to `$DSH_HOME/chatdsh-device.env` (`0600` on Linux/macOS, current-user ACL on Windows), saves a reusable launcher under `~/.dsh/`, and starts official DSH. Subsequent starts on the same device only require:
- Linux / macOS: `bash ~/.dsh/chatdsh-device-join.sh`
- Windows (PowerShell): `powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\chatdsh-device-join.ps1"`

After all devices are onboarded, run `bash ~/.chatdsh/relay/relay-up.sh --disable-pairing` on the relay host to close the pairing endpoint.

Once connected, open `/` on the relay for the mobile PWA, open `/d/<deviceId>/` to interact with a live online device through the official DSH interface, or use the Remote panel in your local official DSH sidebar.

> [!TIP]
> Developers building locally from a cloned checkout can build `dsh-adapter/` and `runtime/`, then run `bash scripts/relay-up.sh --build` and `bash scripts/device-join.sh --from-local --relay <relay-url>`. See [`runtime/docs/deployment.md`](runtime/docs/deployment.md).

</details>

<details>
<summary><strong>Alternative: AI Agent Guided Deployment &amp; Onboarding</strong> (Click to expand)</summary>

> [!WARNING]
> Even with prompt constraints and redaction rules in place, granting an AI Agent terminal access still carries a risk of secret or domain leakage through unexpected command output, imperfect instruction adherence, or retained conversation context. Manual CLI Setup above is the preferred method; only use AI Agent guided deployment if you understand and accept this risk.

If you accept the risk above, you can send the following prompt to an AI Agent with terminal access (such as official DSH, Claude Code, or Codex) to follow [`runtime/docs/agent-deploy-guide.md`](runtime/docs/agent-deploy-guide.md):

```text
Please read https://raw.githubusercontent.com/wenzetan/chatdsh/main/runtime/docs/agent-deploy-guide.md (or local runtime/docs/agent-deploy-guide.md) and follow its zero-leakage rules to deploy the ChatDSH relay server using the remote scripts and prebuilt GitHub image/plugin bundle, then connect my local DSH instance. Before starting or recreating the relay container, always inspect the host interfaces and explicitly ask me to confirm the host bind address (127.0.0.1 for a same-host reverse proxy, or a specific tunnel/LAN interface IP for external-gateway forwarding; never silently default to 127.0.0.1 and never bind 0.0.0.0). If an existing relay container or installed plugin is already present, always check for newer prebuilt image and plugin archive versions with --check-update and explicitly ask whether I want to update and restart; never skip silently. Never print any secrets, tokens, pairing codes, .env contents, or real domains into the conversation context (avoid docker compose config / docker inspect / systemctl show / ps eww / curl -v); reference environment files/variables directly in services, and prompt me to print secrets or approve pairing requests manually.
```

The Agent follows a redacted, approval-gated workflow:

1. **Zero-Leakage Boundary, Network Inspection & Bind-Address Confirmation**: Never prints `.env`, device credential files, pairing secrets, or real domains into context; probes host network interfaces, tunneling tools (Tailscale, Cloudflare Tunnel, FRP, WireGuard, ZeroTier), active reverse proxies, and existing container port bindings, then **explicitly asks you to confirm the host bind address** (`127.0.0.1` for a same-host reverse proxy/tunnel, or a specific tunnel/LAN interface IP when an external gateway forwards to this host; never silently defaults to `127.0.0.1` and never binds `0.0.0.0`) before guiding you to record your domain and bind address locally.
2. **Redacted Relay Deployment, Image Update Check & Pairing Approval**: When an existing `chatdsh-relay` container is detected, runs `relay-up.sh --check-update` first to compare the running image digest against the latest GHCR prebuilt image; whenever a newer image is available, asks whether you want to pull the update and recreate/restart the container (preserving `.env` and persistent volume). Starts or updates with `curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/relay-up.sh | bash -s -- --redact-secrets` (`CHATDSH_PAIRING_APPROVAL=required` by default, auto-generating and persisting a random pairing secret with `0600` permissions without echoing secrets or domains), references environment files in reverse proxy/tunnel configs with your approval, and instructs you to run `bash ~/.chatdsh/relay/relay-up.sh --print-join-command` manually when needed.
3. **Optional DSH Plugin Installation/Upgrade with Persistent-Service Gate**: Asks whether you want the Agent to download the prebuilt plugin bundle from GitHub Releases, install `@chatdsh/bundle`, and pair your local DSH; if the plugin is already installed, runs `device-join.sh --check-update` first and asks whether to upgrade in place (`--remote --install-only`, preserving existing device credentials without re-pairing). If you confirm, it first checks for persistent DSH services (`systemd` / `systemctl`, `launchd`, `pm2`, `supervisorctl`). Whenever a persistent service is found, the Agent must show the service file path, run user, proposed changes, and restart impact, and obtain your explicit approval before editing or restarting the service. Once all devices are paired, run `bash ~/.chatdsh/relay/relay-up.sh --disable-pairing` to close the pairing endpoint.

</details>

<details>
<summary><strong>Complete Uninstallation (Manual CLI / AI Agent Guided)</strong> (Click to expand)</summary>

Complete uninstallation removes all ChatDSH relay containers, images, deployment files, device-side `@chatdsh/bundle` packages, workspace `overrides`, and pairing credentials while keeping the official DSH runtime and all local session logs intact.

#### Option 1: Manual CLI Uninstallation (Preferred)

1. **Remove the plugin and credentials on each device**:

   Linux / macOS (Shell):
   ```sh
   curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/uninstall.sh | bash -s -- --device
   # For multiple profiles (e.g. web and desktop):
   # curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/uninstall.sh | bash -s -- --device --profile web --profile desktop
   ```

   Windows (PowerShell — for Windows clients):
   ```powershell
   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/uninstall.ps1))) -Device
   # For multiple profiles (e.g. web and desktop):
   # & ([scriptblock]::Create((irm https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/uninstall.ps1))) -Device -Profile web,desktop
   ```
   If official DSH runs under `systemd`, also remove any `chatdsh-device.env` drop-in (such as `/etc/systemd/system/dsh.service.d/chatdsh-device.conf`) and reload/restart the service:
   ```sh
   sudo rm -f /etc/systemd/system/dsh.service.d/chatdsh-device.conf
   sudo systemctl daemon-reload && sudo systemctl restart dsh.service
   ```

2. **Remove the relay container, images, volume, and deployment directory on the relay host**:
   ```sh
   # Remove relay container, local images, ~/.chatdsh/relay, and the persistent data volume (irreversible)
   curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/uninstall.sh | bash -s -- --relay --purge-relay-data
   # Omit --purge-relay-data to keep the SQLite/VAPID data volume
   ```
   (If the relay and device share one host, run `curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/uninstall.sh | bash -s -- --all --purge-relay-data` to clean both.)

3. **Remove external network rules**: Delete any Nginx, Caddy, Tailscale Serve, Cloudflare Tunnel, or FRP rules previously added for the relay port.

#### Option 2: AI Agent Guided Uninstallation (Alternative)

> [!WARNING]
> As with deployment, granting an AI Agent terminal access carries secret-leakage and unintended-modification risks; use this option only if you accept that risk.

Send the following prompt to an AI Agent with terminal access to follow Phase 6 of [`runtime/docs/agent-deploy-guide.md`](runtime/docs/agent-deploy-guide.md):

```text
Please read Phase 6 of https://raw.githubusercontent.com/wenzetan/chatdsh/main/runtime/docs/agent-deploy-guide.md, follow its zero-leakage rules (never print secrets, .env contents, or real domains), and completely uninstall ChatDSH and remove all of its changes from this host and official DSH. First confirm the uninstall scope with me (device plugin / relay server / whether to purge the relay volume), inspect any persistent services referencing chatdsh-device.env, show exact file paths and proposed removals for my approval before modifying or restarting services, and verify official DSH loads cleanly with no ChatDSH leftovers.
```

</details>

## Documentation

Detailed technical documentation is maintained in Chinese under `runtime/docs/`:

- Documentation Index & Baseline: [`runtime/docs/README.md`](runtime/docs/README.md)
- System Architecture: [`runtime/docs/architecture.md`](runtime/docs/architecture.md)
- Deployment, Environment Variables, VAPID, Backup & Upgrade: [`runtime/docs/deployment.md`](runtime/docs/deployment.md)
- AI Agent Deployment & Onboarding Guide: [`runtime/docs/agent-deploy-guide.md`](runtime/docs/agent-deploy-guide.md)
- Telemetry Specification & Signal Registry: [`runtime/docs/telemetry.md`](runtime/docs/telemetry.md)
- DSH Compatibility & Upgrade Verification: [`runtime/docs/compatibility.md`](runtime/docs/compatibility.md)
- Credential & Privacy Hooks: [`runtime/docs/secret-guard.md`](runtime/docs/secret-guard.md)
- Adapter Package Guide: [`dsh-adapter/README.md`](dsh-adapter/README.md)
- Runtime Workspace Guide: [`runtime/README.md`](runtime/README.md)

## Verification

Run the full build, static contract checks, unit tests, and end-to-end verification suite from `runtime/`:

```sh
cd runtime
node_modules/.bin/tsc -b tsconfig.build.json --force
pnpm --config.verify-deps-before-run=false build:client
pnpm --config.verify-deps-before-run=false check:telemetry
pnpm --config.verify-deps-before-run=false check:plugins
node scripts/check-upstream-names.mjs
pnpm --config.verify-deps-before-run=false check:layering
pnpm --config.verify-deps-before-run=false test
pnpm --config.verify-deps-before-run=false verify:plugin-install
pnpm --config.verify-deps-before-run=false verify:device-link
pnpm --config.verify-deps-before-run=false verify:routing
pnpm --config.verify-deps-before-run=false verify:settings-sync
pnpm --config.verify-deps-before-run=false verify:approval-notify
pnpm --config.verify-deps-before-run=false verify:import
pnpm --config.verify-deps-before-run=false verify:receipt-sync
pnpm --config.verify-deps-before-run=false verify:multi-client
pnpm --config.verify-deps-before-run=false verify:mobile-telemetry
```

Install the local Git privacy hooks after cloning:

```sh
cd runtime && bash scripts/install-hooks.sh
```

## References & Acknowledgements

### Upstream & Open-Source Foundations

We are grateful to the following open-source projects and tools that power ChatDSH:

- **[DeepSeek Harness (`@deepseek-ai/dsh`)](https://www.npmjs.com/package/@deepseek-ai/dsh)** & **Cordis**: Core agent runtime, session persistence, official Web/Desktop clients, and plugin architecture.
- **[OpenTelemetry](https://opentelemetry.io/)** & **[OpenObserve](https://openobserve.ai/)**: Standard OTLP logging, distributed tracing, metrics, and self-hosted observability backend.
- **[Zod](https://zod.dev/)** & **[esbuild](https://esbuild.github.io/)**: Schema validation for shared contracts and fast client plugin bundling.

### Ecosystem Reference Projects

Special thanks to the following DSH community and open-source projects whose designs informed ChatDSH's trade-offs across desktop integration, mobile UX, remote tunneling, and monorepo organization. Local snapshot metadata is registered in [`runtime/refer-repos.json`](runtime/refer-repos.json) (not committed to Git):

| Project | Repository | Contribution to Design Decisions |
|---|---|---|
| `dataelement_dsh-desktop` | [dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop) | Electron desktop packaging and permission model reference |
| `anywhere-labs_dsh-desktop` | [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) | Multi-package workspace layout and update channels |
| `Clarklevis1995_dsh-mobile` | [Clarklevis1995/dsh-mobile](https://github.com/Clarklevis1995/dsh-mobile) | Mobile client and runtime responsibility boundary |
| `Clarklevis1995_dsh-plugin-mobile-gateway` | [Clarklevis1995/dsh-plugin-mobile-gateway](https://github.com/Clarklevis1995/dsh-plugin-mobile-gateway) | Mobile gateway plugin integration pattern |
| `saya-ch_dsh-mobile` | [saya-ch/dsh-mobile](https://github.com/saya-ch/dsh-mobile) | Standalone browser-side npm package layout and narrow-screen drawer UI |
| `shaobeichen_dsh-pocket` | [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket) | Lightweight client reverse proxy and UI slot registration |
| `kelai141_dsh-mobile-apk` | [kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk) | On-device mobile runtime packaging reference |
| `dsh-Go` | [ccch1mneyyy/dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) | Remote connection protocol and plugin UI boundary reference |
| `ds-harness-remote` | [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote) | Resident host remote tunnel, multiplexed streams, and E2E encryption comparison |
| `ZCode` | [zai-org/ZCode](https://github.com/zai-org/ZCode) | Multi-package repository structure |
