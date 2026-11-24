#!/usr/bin/env bash
# ChatDSH 完全卸载脚本：停止并移除中继容器/镜像/部署文件，以及从官方 DSH profile 彻底卸载 @chatdsh/bundle
# 并清理全部 ChatDSH 产生的配置与凭据文件，保留官方 DSH 本体及用户会话日志不受影响。
#
# 远程免克隆执行（兼容 zsh / bash / fish / sh）：
#   仅卸载设备插件与凭据：curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/uninstall.sh | bash -s -- --device
#   仅卸载中继容器与配置：curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/uninstall.sh | bash -s -- --relay --purge-relay-data
#   本机全部完全卸载：    curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/uninstall.sh | bash -s -- --all --purge-relay-data

set -euo pipefail

print_help() {
  cat <<'EOF'
用法：
  curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/uninstall.sh | bash -s -- [选项]
  bash scripts/uninstall.sh [选项]

作用范围（至少指定其一）：
  --device                 移除设备端 @chatdsh/bundle 插件、overrides、设备凭据与辅助文件（不触碰官方 DSH 会话日志）
  --relay                  停止并移除中继容器、网络、本地镜像与部署目录（默认保留数据卷，加 --purge-relay-data 一并删除）
  --all                    同时执行 --device 与 --relay

附加选项：
  --purge-relay-data       同时删除中继持久化数据卷 chatdsh-relay-data（含 SQLite 副本、配对表与 VAPID 密钥，不可恢复）
  --profile <名称>         目标官方 DSH profile（默认 web，可多次传入例如 --profile web --profile desktop）
  --relay-dir <目录>       中继部署目录（默认 ~/.chatdsh/relay）
  --container <名称>       中继容器名称（默认 chatdsh-relay）
  --project <名称>         Docker Compose 项目名（默认 chatdsh）
  --keep-images            卸载中继时保留本地 Docker 镜像
  -h, --help               显示帮助信息
EOF
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

resolve_dsh_bin() {
  if [ -n "${DSH_BIN:-}" ] && [ -x "${DSH_BIN}" ]; then
    printf '%s' "$DSH_BIN"
    return 0
  fi
  local node_bin
  if node_bin="$(command -v node 2>/dev/null)"; then
    local beside
    beside="$(dirname "$node_bin")/dsh"
    if [ -x "$beside" ]; then
      printf '%s' "$beside"
      return 0
    fi
  fi
  command -v dsh 2>/dev/null || true
}

clean_workspace_overrides() {
  local workspace_file="$1"
  local dsh_bin="$2"
  [ -f "$workspace_file" ] || return 0
  command -v node >/dev/null 2>&1 || return 0

  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const { createRequire } = require("node:module");
    const workspaceFile = process.argv[1];
    const dshBin = process.argv[2];

    const candidates = [];
    if (dshBin) {
      try {
        const realBin = fs.realpathSync(dshBin);
        candidates.push(path.resolve(path.dirname(realBin), "..", "package.json"));
      } catch {}
    }
    const repoRuntimePkg = path.resolve(process.cwd(), "runtime", "package.json");
    if (fs.existsSync(repoRuntimePkg)) candidates.push(repoRuntimePkg);

    let YAML = null;
    for (const anchor of candidates) {
      if (!fs.existsSync(anchor)) continue;
      try {
        YAML = createRequire(anchor)("yaml");
        break;
      } catch {}
    }
    if (!YAML) {
      throw new Error("未找到 yaml 解析库，无法安全清理 pnpm-workspace.yaml");
    }

    const text = fs.readFileSync(workspaceFile, "utf8");
    if (text.trim() === "") process.exit(0);
    const doc = YAML.parseDocument(text);
    const overrides = doc.get("overrides");
    if (overrides && typeof overrides === "object" && Array.isArray(overrides.items)) {
      let removed = 0;
      for (const pair of [...overrides.items]) {
        const key = String(pair.key && pair.key.value !== undefined ? pair.key.value : pair.key);
        if (key.startsWith("@chatdsh/")) {
          doc.deleteIn(["overrides", key]);
          removed += 1;
        }
      }
      const remaining = doc.get("overrides");
      if (remaining && Array.isArray(remaining.items) && remaining.items.length === 0) {
        doc.delete("overrides");
      }
      if (removed > 0) {
        fs.writeFileSync(workspaceFile, String(doc), "utf8");
        console.log("已从 " + workspaceFile + " 清理 " + removed + " 条 @chatdsh/* overrides 登记。");
      }
    }
  ' "$workspace_file" "$dsh_bin"
}

read_profile_store_dir() {
  local profile_dir="$1"
  local dsh_home="$2"
  local dsh_bin="$3"
  if [ -n "${pnpm_config_store_dir:-}" ]; then
    printf '%s' "$pnpm_config_store_dir"
    return 0
  fi
  if [ -n "${npm_config_store_dir:-}" ]; then
    printf '%s' "$npm_config_store_dir"
    return 0
  fi
  if [ -n "${CHATDSH_PNPM_STORE:-}" ]; then
    printf '%s' "$CHATDSH_PNPM_STORE"
    return 0
  fi
  local modules_yaml="${profile_dir}/node_modules/.modules.yaml"
  if [ -f "$modules_yaml" ] && command -v node >/dev/null 2>&1; then
    local detected
    detected="$(node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const { createRequire } = require("node:module");
      const modulesYaml = process.argv[1];
      const dshBin = process.argv[2];
      const candidates = [];
      if (dshBin) {
        try {
          const realBin = fs.realpathSync(dshBin);
          candidates.push(path.resolve(path.dirname(realBin), "..", "package.json"));
        } catch {}
      }
      const repoRuntimePkg = path.resolve(process.cwd(), "runtime", "package.json");
      if (fs.existsSync(repoRuntimePkg)) candidates.push(repoRuntimePkg);
      for (const anchor of candidates) {
        if (!fs.existsSync(anchor)) continue;
        try {
          const YAML = createRequire(anchor)("yaml");
          const parsed = YAML.parse(fs.readFileSync(modulesYaml, "utf8"));
          if (parsed && typeof parsed.storeDir === "string" && parsed.storeDir.trim() !== "") {
            const raw = parsed.storeDir.trim();
            const base = path.basename(raw);
            console.log(/^v\d+$/.test(base) ? path.dirname(raw) : raw);
            process.exit(0);
          }
        } catch {}
      }
    ' "$modules_yaml" "$dsh_bin" 2>/dev/null || true)"
    if [ -n "$detected" ]; then
      printf '%s' "$detected"
      return 0
    fi
  fi
  if [ -d "${dsh_home}/chatdsh-pnpm-store" ]; then
    printf '%s' "${dsh_home}/chatdsh-pnpm-store"
  fi
}

clean_profile_package_json() {
  local pkg_file="$1"
  [ -f "$pkg_file" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  node -e '
    const fs = require("node:fs");
    const pkgFile = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    let changed = false;
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      if (pkg[section] && typeof pkg[section] === "object") {
        for (const key of Object.keys(pkg[section])) {
          if (key.startsWith("@chatdsh/")) {
            delete pkg[section][key];
            changed = true;
          }
        }
      }
    }
    if (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) {
      const next = pkg.dsh.profile.bundles.filter((b) => typeof b !== "string" || !b.startsWith("@chatdsh/"));
      if (next.length !== pkg.dsh.profile.bundles.length) {
        pkg.dsh.profile.bundles = next;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n", "utf8");
      console.log("已从 " + pkgFile + " 清理残留的 @chatdsh/* 声明。");
    }
  ' "$pkg_file"
}

uninstall_device() {
  local dsh_home="$1"
  shift
  local profiles=("$@")
  local dsh_bin
  dsh_bin="$(resolve_dsh_bin)"

  printf '%s\n' '=== 开始清理设备端 ChatDSH 插件与本地凭据 ==='
  local profile
  for profile in "${profiles[@]}"; do
    local profile_dir="${dsh_home}/profiles/${profile}"
    if [ ! -d "$profile_dir" ]; then
      printf '跳过不存在的 profile：%s（%s）\n' "$profile" "$profile_dir"
      continue
    fi
    local store_dir=""
    store_dir="$(read_profile_store_dir "$profile_dir" "$dsh_home" "$dsh_bin")"
    if [ -n "$dsh_bin" ] && [ -f "${profile_dir}/package.json" ] && grep -q '"@chatdsh/bundle"' "${profile_dir}/package.json" 2>/dev/null; then
      printf '正在从官方 %s profile 卸载 @chatdsh/bundle...\n' "$profile"
      if [ -n "$store_dir" ]; then
        DSH_HOME="$dsh_home" npm_config_store_dir="$store_dir" pnpm_config_store_dir="$store_dir" \
          "$dsh_bin" plugin --profile "$profile" remove @chatdsh/bundle
      else
        DSH_HOME="$dsh_home" "$dsh_bin" plugin --profile "$profile" remove @chatdsh/bundle
      fi
    fi
    clean_profile_package_json "${profile_dir}/package.json"
    clean_workspace_overrides "${profile_dir}/pnpm-workspace.yaml" "$dsh_bin"
    rm -rf "${profile_dir}/node_modules/@chatdsh"
    if [ -d "${profile_dir}/node_modules/.pnpm" ]; then
      find "${profile_dir}/node_modules/.pnpm" -maxdepth 1 -name '@chatdsh+*' -exec rm -rf {} + 2>/dev/null || true
    fi
    if [ -n "$dsh_bin" ]; then
      if DSH_HOME="$dsh_home" "$dsh_bin" --profile "$profile" --dump-config >/dev/null 2>&1; then
        printf '已校验官方 %s profile 配置可正常加载（未受损）。\n' "$profile"
      fi
    fi
  done

  local files_to_remove=(
    "${dsh_home}/chatdsh-device.env"
    "${dsh_home}/chatdsh-device-join.sh"
    "${dsh_home}/chatdsh-tarballs"
    "${dsh_home}/chatdsh-download"
    "${dsh_home}/chatdsh-pnpm-store"
    "${dsh_home}/push/replica-intents.sqlite"
    "${dsh_home}/push/replica-intents.sqlite-wal"
    "${dsh_home}/push/replica-intents.sqlite-shm"
  )
  local item
  for item in "${files_to_remove[@]}"; do
    if [ -e "$item" ]; then
      rm -rf "$item"
      printf '已删除：%s\n' "$item"
    fi
  done
  if [ -d "${dsh_home}/push" ] && [ -z "$(ls -A "${dsh_home}/push" 2>/dev/null || true)" ]; then
    rmdir "${dsh_home}/push" 2>/dev/null || true
  fi

  printf '%s\n' '设备端 ChatDSH 插件与凭据已清理完成（官方 DSH 会话日志与原生配置保持不变）。'
  printf '%s\n' '提示：如本机通过 systemd / launchd / pm2 等持久服务托管了 DSH，请确认移除服务中的 chatdsh-device.env 引用（例如 /etc/systemd/system/dsh.service.d/chatdsh-device.conf）后重载并重启服务。'
}

uninstall_relay() {
  local relay_dir="$1"
  local compose_project="$2"
  local container_name="$3"
  local purge_data="$4"
  local keep_images="$5"

  printf '%s\n' '=== 开始清理中继服务端容器、网络与部署文件 ==='
  if command -v docker >/dev/null 2>&1; then
    local down_args=(compose -p "$compose_project")
    if [ -f "${relay_dir}/docker-compose.yml" ]; then
      down_args+=(-f "${relay_dir}/docker-compose.yml")
    fi
    down_args+=(down --remove-orphans)
    if [ "$purge_data" -eq 1 ]; then
      down_args+=(--volumes)
    fi
    if [ -f "${relay_dir}/docker-compose.yml" ]; then
      (cd "$relay_dir" && docker "${down_args[@]}") || true
    fi

    local existing_id
    existing_id="$(docker ps -a --filter "name=^/${container_name}$" --format '{{.ID}}' | head -n 1 || true)"
    if [ -n "$existing_id" ]; then
      docker rm -f "$existing_id" >/dev/null
      printf '已强制移除容器：%s（%s）\n' "$container_name" "$existing_id"
    fi

    if [ "$purge_data" -eq 1 ]; then
      local volumes_to_check=("${compose_project}_chatdsh-relay-data")
      if [ "$compose_project" = "chatdsh" ]; then
        volumes_to_check+=("relay_chatdsh-relay-data")
      fi
      local vol
      for vol in "${volumes_to_check[@]}"; do
        if docker volume inspect "$vol" >/dev/null 2>&1; then
          docker volume rm "$vol" >/dev/null && printf '已删除数据卷：%s\n' "$vol"
        fi
      done
    else
      printf '%s\n' '已保留中继数据卷（如需彻底删除数据卷请附加 --purge-relay-data）。'
    fi

    if [ "$keep_images" -eq 0 ]; then
      local img_ids
      img_ids="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '(^|/)chatdsh-relay:' || true)"
      if [ -n "$img_ids" ]; then
        local img
        for img in $img_ids; do
          docker rmi "$img" >/dev/null 2>&1 && printf '已移除本地镜像：%s\n' "$img" || true
        done
      fi
    fi
  else
    printf '%s\n' '未检测到 docker 命令，跳过容器与镜像清理。'
  fi

  if [ -d "$relay_dir" ]; then
    rm -rf "$relay_dir"
    printf '已删除中继部署目录：%s\n' "$relay_dir"
    local parent_dir
    parent_dir="$(dirname "$relay_dir")"
    if [ "$(basename "$parent_dir")" = ".chatdsh" ] && [ -z "$(ls -A "$parent_dir" 2>/dev/null || true)" ]; then
      rmdir "$parent_dir" 2>/dev/null || true
    fi
  fi

  printf '%s\n' '中继服务端已清理完成。如曾配置 Nginx / Caddy / Tailscale Serve / 内网穿透转发规则，请同步移除对应规则。'
}

main() {
  local do_device=0
  local do_relay=0
  local purge_relay_data=0
  local keep_images=0
  local profiles=()
  local relay_dir="${CHATDSH_RELAY_DIR:-${HOME}/.chatdsh/relay}"
  local container_name="${CHATDSH_RELAY_CONTAINER_NAME:-chatdsh-relay}"
  local compose_project="${COMPOSE_PROJECT_NAME:-${CHATDSH_COMPOSE_PROJECT:-chatdsh}}"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help)
        print_help
        return 0
        ;;
      --device)
        do_device=1
        shift
        ;;
      --relay)
        do_relay=1
        shift
        ;;
      --all)
        do_device=1
        do_relay=1
        shift
        ;;
      --purge-relay-data)
        purge_relay_data=1
        shift
        ;;
      --keep-images)
        keep_images=1
        shift
        ;;
      --profile)
        profiles+=("$2")
        shift 2
        ;;
      --profile=*)
        profiles+=("${1#--profile=}")
        shift
        ;;
      --relay-dir)
        relay_dir="$2"
        shift 2
        ;;
      --relay-dir=*)
        relay_dir="${1#--relay-dir=}"
        shift
        ;;
      --container)
        container_name="$2"
        shift 2
        ;;
      --container=*)
        container_name="${1#--container=}"
        shift
        ;;
      --project)
        compose_project="$2"
        shift 2
        ;;
      --project=*)
        compose_project="${1#--project=}"
        shift
        ;;
      *)
        printf '未知参数：%s\n' "$1" >&2
        return 1
        ;;
    esac
  done

  if [ "$do_device" -eq 0 ] && [ "$do_relay" -eq 0 ]; then
    print_help
    return 1
  fi

  if [ "${#profiles[@]}" -eq 0 ]; then
    profiles=(web)
  fi

  local dsh_home
  dsh_home="$(trim "${DSH_HOME:-}")"
  [ -n "$dsh_home" ] || dsh_home="${HOME}/.dsh"

  if [ "$do_device" -eq 1 ]; then
    uninstall_device "$dsh_home" "${profiles[@]}"
  fi
  if [ "$do_relay" -eq 1 ]; then
    uninstall_relay "$relay_dir" "$compose_project" "$container_name" "$purge_relay_data" "$keep_images"
  fi
}

main "$@"
