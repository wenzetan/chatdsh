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

### Recommended: AI Agent Guided Deployment & Onboarding

The recommended way to deploy ChatDSH is to let an AI Agent with terminal access (such as official DSH, Claude Code, or Codex) follow [`runtime/docs/agent-deploy-guide.md`](runtime/docs/agent-deploy-guide.md):

```text
Please read runtime/docs/agent-deploy-guide.md and follow it to deploy the ChatDSH relay server and connect my local DSH instance.
```

The Agent follows a safe, interactive four-stage workflow:

1. **Network & Tunnel Inspection**: Probes host network interfaces, existing tunneling tools (Tailscale, Cloudflare Tunnel, FRP, WireGuard, ZeroTier), and active reverse proxies before asking you for the required public domain and preferred connectivity method.
2. **Relay Container Deployment & Network Checklist**: Runs `bash scripts/relay-up.sh` to start the Docker Compose relay (auto-generating and persisting a random pairing secret with `0600` permissions), checks public reachability, and asks for confirmation before modifying any reverse proxy or tunnel config.
3. **Optional DSH Plugin Installation with Persistent-Service Gate**: Asks whether you want the Agent to install `@chatdsh/bundle` and pair your local DSH. If you confirm, it first checks for persistent DSH services (`systemd` / `systemctl`, `launchd`, `pm2`, `supervisorctl`). Whenever a persistent service is found, the Agent must show the service file path, proposed `EnvironmentFile` update, and restart impact, and obtain your explicit approval before editing or restarting the service.

### Manual CLI Setup

#### 1. Prerequisites

- Relay host: Docker & Docker Compose, Bash, and `curl` (no host Node.js required)
- Client devices: Node.js 22+, pnpm 11.21.0, Official DSH (`@deepseek-ai/dsh`, verified baseline `0.2.2-rc.3`)

#### 2. Start the Relay in One Command (Docker Compose)

```sh
bash scripts/relay-up.sh
```

On first run, the script prompts for the public relay domain (required, e.g. `relay.example.com` or `https://relay.example.com`), checks `.env` for `CHATDSH_PAIRING_CODE`, automatically generates and saves a random secret (`0600` permissions, reused on subsequent runs), and starts the relay container via [`docker-compose.yml`](docker-compose.yml).

Once `/healthz` is ready, the script checks public reachability (printing DNS and reverse-proxy forwarding instructions to `http://127.0.0.1:3170` if not yet configured) and outputs a copy-pasteable one-line device join command. To print that command again anytime, run on the relay host:

```sh
bash scripts/relay-up.sh --print-join-command
```

Terminate TLS in front of `127.0.0.1:3170` with a reverse proxy such as Nginx, Caddy, or Tailscale Serve with WebSocket upgrades enabled and response buffering disabled (see [`runtime/docs/deployment.md`](runtime/docs/deployment.md)).

#### 3. Install, Pair & Start DSH on a Device in One Command

If installing from a fresh source checkout, build once first:

```sh
cd dsh-adapter && pnpm install && node scripts/link-dsh-deps.mjs && pnpm build && cd ../runtime && pnpm install && node scripts/link-dsh-deps.mjs && pnpm build && pnpm build:client && cd ..
```

Then run the one-line command printed by `relay-up.sh`:

```sh
bash scripts/device-join.sh --relay https://relay.example.com --code '<pairing-code-from-relay-up>'
```

This single command installs `@chatdsh/bundle` into the official `web` profile, pairs the device with the relay (saving credentials to `$DSH_HOME/chatdsh-device.env` with `0600` permissions), and starts official DSH connected to the relay. Subsequent starts on the same device only require `bash scripts/device-join.sh`.

Once connected, open `/` on the relay for the mobile PWA, open `/d/<deviceId>/` to interact with a live online device through the official DSH interface, or use the Remote panel in your local official DSH sidebar.

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
| `rea_workbuddy` | Local snapshot (no remote) | Protocol and authentication reference material |
