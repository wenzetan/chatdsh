#!/usr/bin/env bash
# 设备侧一行接入脚本：安装 @chatdsh/bundle 插件、配对连接中继服务端并启动官方 DSH。
#
# 免克隆仓库一键接入（首选，直接从 GitHub Releases 下载预构建插件归档并校验 SHA-256，兼容 zsh / bash / fish / sh）：
#   curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/device-join.sh | bash -s -- --relay https://relay.example.com
#
# 后续在同一设备再次启动（自动复用已安装的插件与保存的设备凭据）：
#   bash ~/.dsh/chatdsh-device-join.sh

set -euo pipefail

GITHUB_REPO="${CHATDSH_GITHUB_REPO:-wenzetan/chatdsh}"
GITHUB_REF="${CHATDSH_GITHUB_REF:-main}"
RAW_BASE="${CHATDSH_RAW_BASE:-https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_REF}}"
DEFAULT_RELEASE_TAG="${CHATDSH_RELEASE_TAG:-latest}"
BUNDLE_ARCHIVE_NAME="${CHATDSH_BUNDLE_ARCHIVE_NAME:-chatdsh-plugin-bundle.tar.gz}"

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
REPO_ROOT=""
RUNTIME_ROOT=""
if [ -n "$SCRIPT_SOURCE" ] && [ -f "$SCRIPT_SOURCE" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  if [ -f "${SCRIPT_DIR}/../dsh-adapter/package.json" ] && [ -f "${SCRIPT_DIR}/../runtime/package.json" ]; then
    REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
    RUNTIME_ROOT="${REPO_ROOT}/runtime"
  fi
fi

print_help() {
  cat <<'EOF'
用法：
  远程一键接入：curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/device-join.sh | bash -s -- --relay https://relay.example.com
  本地复用启动：bash ~/.dsh/chatdsh-device-join.sh [选项] [-- <透传给 dsh 的参数>]

选项：
  --relay <域名或 origin>     中继对外地址（首次接入必填，后续自动复用）
  --code <配对口令>           中继配对口令（不传时在交互终端静默提示输入，避免留存 Shell 历史）
  --code-stdin                从标准输入读取配对口令（避免口令出现在进程参数中）
  --from-relay-env <路径>     直接从本地中继 .env 读取 CHATDSH_PUBLIC_URL 与 CHATDSH_PAIRING_CODE（不经命令行传密）
  --redact-secrets            脱敏输出模式：不向终端打印真实域名与凭据详情（供 AI Agent 调用）
  --approval-timeout <秒>     等待中继管理员审批的超时秒数（默认 600 秒）
  --profile <名称>            目标官方 DSH profile（默认 web）
  --name <设备名>             向中继登记的设备名称（默认主机名）
  --port <端口>               传递给 dsh 的本地监听端口
  --bundle <包名或路径>       直接传给 `dsh plugin add` 的自定义组合包来源
  --bundle-archive <路径/URL> 指定预构建插件归档 chatdsh-plugin-bundle.tar.gz 的本地路径或下载地址
  --release-tag <标签>        指定 GitHub Release 标签（默认 latest，例如 v0.1.0）
  --remote                    强制从 GitHub Releases 下载预构建插件归档（忽略本地源码产物）
  --from-local                强制从当前源码仓库打包安装（需位于已构建的源码仓库内）
  --skip-checksum             跳过插件归档 SHA-256 校验（仅调试使用）
  --install-only              仅完成插件安装后退出（不配对、不启动 dsh）
  --pair-url <origin>         配对请求使用的直连地址（默认与 --relay 相同）
  --skip-install              跳过插件安装步骤
  --re-pair                   忽略已保存凭据并重新配对
  --no-start                  完成安装与配对后退出，不启动 dsh
  -h, --help                  显示帮助信息
EOF
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

format_env_value() {
  local value="$1"
  if [ -z "$value" ]; then
    printf ''
    return 0
  fi
  if [[ "$value" =~ ^[A-Za-z0-9_./:@+-]+$ ]]; then
    printf '%s' "$value"
    return 0
  fi
  local escaped="${value//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  printf '"%s"' "$escaped"
}

normalize_public_url() {
  local raw
  raw="$(trim "$1")"
  if [ -z "$raw" ]; then
    printf '%s\n' '中继地址不能为空' >&2
    return 1
  fi
  if [[ "$raw" =~ [[:space:]] ]]; then
    printf '%s\n' '中继地址不能包含空白字符' >&2
    return 1
  fi
  local candidate="$raw"
  if [[ "$raw" =~ ^([A-Za-z][A-Za-z0-9+.-]*):// ]]; then
    local proto_lower
    proto_lower="$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"
    if [ "$proto_lower" != "http" ] && [ "$proto_lower" != "https" ]; then
      printf '仅支持 http 或 https 协议：%s:\n' "$proto_lower" >&2
      return 1
    fi
    candidate="${proto_lower}://${raw#*://}"
  else
    candidate="https://${raw}"
  fi
  local stripped="$candidate"
  while [[ "$stripped" == */ ]]; do
    stripped="${stripped%/}"
  done
  local scheme="${stripped%%://*}"
  local rest="${stripped#*://}"
  if [ -z "$rest" ] || [[ "$rest" == *"@"* ]] || [[ "$rest" == *"?"* ]] || [[ "$rest" == *"#"* ]] || [[ "$rest" == *"/"* ]]; then
    printf '中继地址必须是精确 HTTP/HTTPS origin：%s\n' "$raw" >&2
    return 1
  fi
  printf '%s://%s' "$scheme" "$rest"
}

read_env_value() {
  local file="$1"
  local target_key="$2"
  local found=""
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[2]}"
      local val
      val="$(trim "${BASH_REMATCH[3]}")"
      if [ "$key" = "$target_key" ]; then
        if [[ "$val" == \"*\" ]] && [ "${#val}" -ge 2 ]; then
          val="${val:1:${#val}-2}"
          val="${val//\\\"/\"}"
          val="${val//\\\\/\\}"
        elif [[ "$val" == \'*\' ]] && [ "${#val}" -ge 2 ]; then
          val="${val:1:${#val}-2}"
        fi
        found="$val"
      fi
    fi
  done < "$file"
  printf '%s' "$found"
}

write_device_env() {
  local file="$1"
  local control_url="$2"
  local device_id="$3"
  local node_token="$4"
  mkdir -p "$(dirname "$file")"
  local tmp="${file}.tmp.$$"
  umask 077
  {
    printf '%s\n' '# ChatDSH 设备连接凭据（由 device-join.sh 维护，权限 0600）'
    printf 'CHATDSH_CONTROL_URL=%s\n' "$(format_env_value "$control_url")"
    printf 'CHATDSH_DEVICE_ID=%s\n' "$(format_env_value "$device_id")"
    printf 'CHATDSH_NODE_TOKEN=%s\n' "$(format_env_value "$node_token")"
  } > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
  chmod 600 "$file"
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
  command -v dsh
}

resolve_store_dir() {
  local dsh_home="$1"
  if [ -n "${pnpm_config_store_dir:-}" ]; then
    printf '%s' "$pnpm_config_store_dir"
  elif [ -n "${npm_config_store_dir:-}" ]; then
    printf '%s' "$npm_config_store_dir"
  elif [ -n "${CHATDSH_PNPM_STORE:-}" ]; then
    printf '%s' "$CHATDSH_PNPM_STORE"
  elif [ -n "$RUNTIME_ROOT" ] && [ -d "${RUNTIME_ROOT}/.run/pnpm-store" ]; then
    printf '%s' "${RUNTIME_ROOT}/.run/pnpm-store"
  else
    printf '%s' "${dsh_home}/chatdsh-pnpm-store"
  fi
}

persist_standalone_script() {
  local dsh_home="$1"
  [ -z "$REPO_ROOT" ] || return 0
  local saved="${dsh_home}/chatdsh-device-join.sh"
  if [ -n "$SCRIPT_SOURCE" ] && [ -f "$SCRIPT_SOURCE" ] && [ "$SCRIPT_SOURCE" != "$saved" ]; then
    cp -f "$SCRIPT_SOURCE" "$saved"
    chmod 755 "$saved"
  elif [ ! -f "$saved" ]; then
    curl -fsSL --retry 2 --max-time 30 "${RAW_BASE}/scripts/device-join.sh" -o "${saved}.tmp.$$" 2>/dev/null || {
      rm -f "${saved}.tmp.$$"
      return 0
    }
    chmod 755 "${saved}.tmp.$$"
    mv -f "${saved}.tmp.$$" "$saved"
  fi
}

has_local_artifacts_ready() {
  [ -n "$REPO_ROOT" ] || return 1
  local required=(
    "${REPO_ROOT}/dsh-adapter/lib/index.js"
    "${RUNTIME_ROOT}/packages/bundle/chatdsh/lib/index.js"
    "${RUNTIME_ROOT}/packages/client/pwa/lib/index.js"
    "${RUNTIME_ROOT}/packages/client/pwa/lib/client.js"
    "${RUNTIME_ROOT}/packages/client/telemetry/lib/index.js"
    "${RUNTIME_ROOT}/packages/client/telemetry/lib/client.js"
    "${RUNTIME_ROOT}/packages/client/remote/lib/index.js"
    "${RUNTIME_ROOT}/packages/client/remote/lib/client.js"
    "${RUNTIME_ROOT}/packages/core/contracts/lib/index.js"
    "${RUNTIME_ROOT}/packages/core/diagnostics/lib/index.js"
    "${RUNTIME_ROOT}/packages/core/remote-client/lib/index.js"
    "${RUNTIME_ROOT}/packages/host/device-link/lib/index.js"
    "${RUNTIME_ROOT}/packages/host/import/lib/index.js"
    "${RUNTIME_ROOT}/packages/host/push/lib/index.js"
    "${RUNTIME_ROOT}/packages/host/settings-sync/lib/index.js"
    "${RUNTIME_ROOT}/packages/host/telemetry/lib/index.js"
  )
  local file
  for file in "${required[@]}"; do
    if [ ! -f "$file" ]; then
      return 1
    fi
  done
  return 0
}

verify_archive_sha256() {
  local archive_file="$1"
  local checksum_file="$2"
  local expected_name="$3"
  node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const [archiveFile, checksumFile, expectedName] = process.argv.slice(1);
    const lines = fs.readFileSync(checksumFile, "utf8").split(/\r?\n/).filter(Boolean);
    const targetName = expectedName || path.basename(archiveFile);
    let expected = "";
    for (const line of lines) {
      const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
      if (m && (m[2].trim() === targetName || path.basename(m[2].trim()) === targetName)) {
        expected = m[1].toLowerCase();
        break;
      }
    }
    if (!expected) {
      throw new Error("SHA256SUMS.txt 中未找到 " + targetName + " 的校验记录");
    }
    const actual = crypto.createHash("sha256").update(fs.readFileSync(archiveFile)).digest("hex").toLowerCase();
    if (actual !== expected) {
      throw new Error("插件归档 SHA-256 校验失败：期望 " + expected + "，实际 " + actual);
    }
  ' "$archive_file" "$checksum_file" "$expected_name"
}

resolve_release_base() {
  local release_tag="$1"
  if [ -n "${CHATDSH_RELEASE_BASE:-}" ]; then
    printf '%s' "${CHATDSH_RELEASE_BASE%/}"
    return 0
  fi
  if [ "$release_tag" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download' "$GITHUB_REPO"
  else
    printf 'https://github.com/%s/releases/download/%s' "$GITHUB_REPO" "$release_tag"
  fi
}

install_bundle_from_archive() {
  local dsh_home="$1"
  local profile="$2"
  local archive_source="$3"
  local release_tag="$4"
  local skip_checksum="$5"
  local dsh_bin
  dsh_bin="$(resolve_dsh_bin)"
  local store
  store="$(resolve_store_dir "$dsh_home")"
  mkdir -p "$store"

  local profile_dir="${dsh_home}/profiles/${profile}"
  if [ ! -f "${profile_dir}/pnpm-workspace.yaml" ]; then
    DSH_HOME="$dsh_home" npm_config_store_dir="$store" pnpm_config_store_dir="$store" \
      "$dsh_bin" --profile "$profile" --dump-config >/dev/null
  fi

  local download_dir="${dsh_home}/chatdsh-download"
  mkdir -p "$download_dir"
  local archive_file=""
  local checksum_url=""
  local archive_name="$BUNDLE_ARCHIVE_NAME"

  if [ -n "$archive_source" ]; then
    if [[ "$archive_source" == http://* ]] || [[ "$archive_source" == https://* ]]; then
      archive_name="$(basename "${archive_source%%\?*}")"
      archive_file="${download_dir}/${archive_name}"
      printf '正在下载插件归档：%s\n' "$archive_source"
      curl -fsSL --retry 2 --max-time 120 "$archive_source" -o "${archive_file}.tmp.$$"
      mv -f "${archive_file}.tmp.$$" "$archive_file"
      if [ "$skip_checksum" -eq 0 ]; then
        checksum_url="${archive_source%/*}/SHA256SUMS.txt"
      fi
    else
      if [ ! -f "$archive_source" ]; then
        printf '未找到本地插件归档：%s\n' "$archive_source" >&2
        return 1
      fi
      archive_file="$archive_source"
      archive_name="$(basename "$archive_file")"
      local local_sum="$(dirname "$archive_file")/SHA256SUMS.txt"
      if [ "$skip_checksum" -eq 0 ] && [ -f "$local_sum" ]; then
        verify_archive_sha256 "$archive_file" "$local_sum" "$archive_name"
      fi
    fi
  else
    local release_base
    release_base="$(resolve_release_base "$release_tag")"
    local archive_url="${release_base}/${BUNDLE_ARCHIVE_NAME}"
    archive_file="${download_dir}/${BUNDLE_ARCHIVE_NAME}"
    printf '正在从 GitHub Releases 下载预构建插件归档（%s）...\n' "$release_tag"
    if ! curl -fsSL --retry 2 --max-time 120 "$archive_url" -o "${archive_file}.tmp.$$"; then
      rm -f "${archive_file}.tmp.$$"
      printf '下载插件归档失败：%s\n' "$archive_url" >&2
      printf '%s\n' '请确认 GitHub Actions 已完成插件归档构建发布，或传入 --bundle-archive <路径> / --from-local。' >&2
      return 1
    fi
    mv -f "${archive_file}.tmp.$$" "$archive_file"
    if [ "$skip_checksum" -eq 0 ]; then
      checksum_url="${release_base}/SHA256SUMS.txt"
    fi
  fi

  if [ -n "$checksum_url" ]; then
    local checksum_file="${download_dir}/SHA256SUMS.txt"
    if ! curl -fsSL --retry 2 --max-time 30 "$checksum_url" -o "${checksum_file}.tmp.$$"; then
      rm -f "${checksum_file}.tmp.$$"
      printf '下载校验文件失败：%s（如需跳过校验可附加 --skip-checksum）\n' "$checksum_url" >&2
      return 1
    fi
    mv -f "${checksum_file}.tmp.$$" "$checksum_file"
    verify_archive_sha256 "$archive_file" "$checksum_file" "$archive_name"
    printf '%s\n' '插件归档 SHA-256 校验通过。'
  fi

  local tarballs_dir="${dsh_home}/chatdsh-tarballs"
  rm -rf "$tarballs_dir"
  mkdir -p "$tarballs_dir"
  tar -xzf "$archive_file" -C "$tarballs_dir"

  if [ ! -f "${tarballs_dir}/manifest.json" ] || [ ! -f "${tarballs_dir}/apply-overrides.cjs" ]; then
    printf '插件归档结构不完整（缺少 manifest.json 或 apply-overrides.cjs）：%s\n' "$archive_file" >&2
    return 1
  fi

  node "${tarballs_dir}/apply-overrides.cjs" "${profile_dir}/pnpm-workspace.yaml" "${tarballs_dir}/manifest.json"

  local bundle_tarball
  bundle_tarball="$(node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!manifest.bundle || !manifest.bundle.tarball) {
      throw new Error("manifest.json 缺少 bundle.tarball");
    }
    console.log(path.join(path.dirname(path.resolve(process.argv[1])), manifest.bundle.tarball));
  ' "${tarballs_dir}/manifest.json")"

  DSH_HOME="$dsh_home" npm_config_store_dir="$store" pnpm_config_store_dir="$store" \
    "$dsh_bin" plugin --profile "$profile" add "$bundle_tarball"
}

install_bundle_from_local_repo() {
  local dsh_home="$1"
  local profile="$2"
  local dsh_bin
  dsh_bin="$(resolve_dsh_bin)"
  local store
  store="$(resolve_store_dir "$dsh_home")"
  mkdir -p "$store"

  if ! has_local_artifacts_ready; then
    printf '%s\n' '本地插件产物尚未构建，请先构建 dsh-adapter 与 runtime，或使用 --remote 从 GitHub Releases 下载预构建归档。' >&2
    return 1
  fi

  local profile_dir="${dsh_home}/profiles/${profile}"
  if [ ! -f "${profile_dir}/pnpm-workspace.yaml" ]; then
    DSH_HOME="$dsh_home" npm_config_store_dir="$store" pnpm_config_store_dir="$store" \
      "$dsh_bin" --profile "$profile" --dump-config >/dev/null
  fi

  local tarballs_dir="${dsh_home}/chatdsh-tarballs"
  mkdir -p "$tarballs_dir"

  local pkg_dirs=(
    "${REPO_ROOT}/dsh-adapter"
    "${RUNTIME_ROOT}/packages/bundle/chatdsh"
    "${RUNTIME_ROOT}/packages/client/pwa"
    "${RUNTIME_ROOT}/packages/client/telemetry"
    "${RUNTIME_ROOT}/packages/client/remote"
    "${RUNTIME_ROOT}/packages/core/contracts"
    "${RUNTIME_ROOT}/packages/core/diagnostics"
    "${RUNTIME_ROOT}/packages/core/remote-client"
    "${RUNTIME_ROOT}/packages/host/device-link"
    "${RUNTIME_ROOT}/packages/host/import"
    "${RUNTIME_ROOT}/packages/host/push"
    "${RUNTIME_ROOT}/packages/host/settings-sync"
    "${RUNTIME_ROOT}/packages/host/telemetry"
  )

  local overrides_pairs=()
  local bundle_tarball=""
  local dir
  for dir in "${pkg_dirs[@]}"; do
    local meta
    meta="$(node -e "const m=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')); console.log(m.name + '\t' + m.version);" "${dir}/package.json")"
    local pkg_name="${meta%%$'\t'*}"
    local pkg_version="${meta#*$'\t'}"
    (
      cd "$RUNTIME_ROOT"
      DSH_HOME="$dsh_home" npm_config_store_dir="$store" pnpm_config_store_dir="$store" \
        pnpm "--config.store-dir=${store}" --config.verify-deps-before-run=false --dir "$dir" pack --pack-destination "$tarballs_dir" >/dev/null
    )
    local base="${pkg_name#@}"
    base="${base/\//-}"
    local tarball="${tarballs_dir}/${base}-${pkg_version}.tgz"
    if [ ! -f "$tarball" ]; then
      printf '未生成打包产物：%s\n' "$tarball" >&2
      return 1
    fi
    overrides_pairs+=("${pkg_name}=file:${tarball}")
    if [ "$pkg_name" = "@chatdsh/bundle" ]; then
      bundle_tarball="$tarball"
    fi
  done

  node -e '
    const fs = require("node:fs");
    const YAML = require(process.argv[1]);
    const target = process.argv[2];
    const text = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    const doc = YAML.parseDocument(text.trim() === "" ? "{}\n" : text);
    for (const pair of process.argv.slice(3)) {
      const sep = pair.indexOf("=");
      doc.setIn(["overrides", pair.slice(0, sep)], pair.slice(sep + 1));
    }
    fs.writeFileSync(target, String(doc), "utf8");
  ' "${RUNTIME_ROOT}/node_modules/yaml/dist/index.js" "${profile_dir}/pnpm-workspace.yaml" "${overrides_pairs[@]}"

  DSH_HOME="$dsh_home" npm_config_store_dir="$store" pnpm_config_store_dir="$store" \
    "$dsh_bin" plugin --profile "$profile" add "$bundle_tarball"
}

install_bundle_into_profile() {
  local dsh_home="$1"
  local profile="$2"
  local bundle_spec="$3"
  local bundle_archive="$4"
  local release_tag="$5"
  local force_remote="$6"
  local force_local="$7"
  local skip_checksum="$8"
  local dsh_bin
  dsh_bin="$(resolve_dsh_bin)"
  local store
  store="$(resolve_store_dir "$dsh_home")"
  mkdir -p "$store"

  if [ -n "$bundle_spec" ]; then
    DSH_HOME="$dsh_home" npm_config_store_dir="$store" pnpm_config_store_dir="$store" \
      "$dsh_bin" plugin --profile "$profile" add "$bundle_spec"
    return 0
  fi

  if [ -n "$bundle_archive" ]; then
    install_bundle_from_archive "$dsh_home" "$profile" "$bundle_archive" "$release_tag" "$skip_checksum"
    return 0
  fi

  if [ "$force_local" -eq 1 ]; then
    install_bundle_from_local_repo "$dsh_home" "$profile"
    return 0
  fi

  if [ "$force_remote" -eq 0 ] && has_local_artifacts_ready; then
    install_bundle_from_local_repo "$dsh_home" "$profile"
    return 0
  fi

  install_bundle_from_archive "$dsh_home" "$profile" "" "$release_tag" "$skip_checksum"
}

pair_device() {
  local endpoint="$1"
  local code="$2"
  local name="$3"
  local redact="${4:-0}"
  local approval_timeout_sec="${5:-600}"
  local platform_name
  case "$(uname -s)" in
    Darwin) platform_name="darwin" ;;
    Linux) platform_name="linux" ;;
    *) platform_name="linux" ;;
  esac

  local body
  body="$(node -e 'console.log(JSON.stringify({ code: process.argv[1], name: process.argv[2], platform: process.argv[3], role: "both", capabilities: ["shell"] }));' "$code" "$name" "$platform_name")"
  local url="${endpoint%/}/chatdsh/gateway/devices/pair"

  local response_file
  response_file="$(mktemp "${DSH_HOME_RESOLVED}/pair-resp.XXXXXX")"
  chmod 600 "$response_file"
  local status
  status="$(curl -sS --max-time 15 -o "$response_file" -w '%{http_code}' -X POST "$url" -H 'content-type: application/json' --data-binary "$body")"
  local resp_text
  resp_text="$(cat "$response_file")"
  rm -f "$response_file"

  if [ "$status" -eq 200 ]; then
    node -e '
      const parsed = JSON.parse(process.argv[1]);
      if (typeof parsed.deviceId !== "string" || !parsed.deviceId || typeof parsed.token !== "string" || !parsed.token) {
        throw new Error("设备配对响应缺少 deviceId 或 token");
      }
      console.log(parsed.deviceId + "\t" + parsed.token);
    ' "$resp_text"
    return 0
  fi

  if [ "$status" -ne 202 ]; then
    if [ "$redact" -eq 1 ]; then
      printf '设备配对失败（HTTP %s，详细地址与响应已脱敏）\n' "$status" >&2
    else
      printf '设备配对失败（%s，HTTP %s）：%s\n' "$url" "$status" "$resp_text" >&2
    fi
    return 1
  fi

  local pending_meta
  pending_meta="$(node -e '
    const parsed = JSON.parse(process.argv[1]);
    if (typeof parsed.requestId !== "string" || !parsed.requestId || typeof parsed.pollToken !== "string" || !parsed.pollToken) {
      throw new Error("待审批配对响应缺少 requestId 或 pollToken");
    }
    console.log(parsed.requestId + "\t" + parsed.pollToken);
  ' "$resp_text")"
  local request_id="${pending_meta%%$'\t'*}"
  local poll_token="${pending_meta#*$'\t'}"

  printf '配对申请已提交（requestId=%s），等待中继服务端审批放行...\n' "$request_id" >&2
  printf '请在中继宿主机执行以下命令审批：\n' >&2
  printf '  bash ~/.chatdsh/relay/relay-approve.sh approve %s\n' "$request_id" >&2
  printf '（源码仓库部署执行：bash scripts/relay-approve.sh approve %s）\n' "$request_id" >&2

  local claim_url="${endpoint%/}/chatdsh/gateway/devices/pair/claim"
  local claim_body
  claim_body="$(node -e 'console.log(JSON.stringify({ requestId: process.argv[1], pollToken: process.argv[2] }));' "$request_id" "$poll_token")"
  local deadline=$(( $(date +%s) + approval_timeout_sec ))
  local poll_sleep="${CHATDSH_PAIRING_POLL_SEC:-1}"

  while [ "$(date +%s)" -lt "$deadline" ]; do
    sleep "$poll_sleep"
    local claim_file
    claim_file="$(mktemp "${DSH_HOME_RESOLVED}/pair-claim.XXXXXX")"
    chmod 600 "$claim_file"
    local claim_status
    claim_status="$(curl -sS --max-time 15 -o "$claim_file" -w '%{http_code}' -X POST "$claim_url" -H 'content-type: application/json' --data-binary "$claim_body")"
    local claim_text
    claim_text="$(cat "$claim_file")"
    rm -f "$claim_file"

    if [ "$claim_status" -eq 202 ]; then
      continue
    fi
    if [ "$claim_status" -eq 200 ]; then
      node -e '
        const parsed = JSON.parse(process.argv[1]);
        if (typeof parsed.deviceId !== "string" || !parsed.deviceId || typeof parsed.token !== "string" || !parsed.token) {
          throw new Error("审批领取响应缺少 deviceId 或 token");
        }
        console.log(parsed.deviceId + "\t" + parsed.token);
      ' "$claim_text"
      return 0
    fi
    if [ "$claim_status" -eq 403 ]; then
      printf '配对申请已被中继管理员拒绝（requestId=%s）。\n' "$request_id" >&2
      return 1
    fi
    if [ "$claim_status" -eq 410 ]; then
      printf '配对申请已过期（requestId=%s），请重新发起配对。\n' "$request_id" >&2
      return 1
    fi
    if [ "$redact" -eq 1 ]; then
      printf '领取审批结果失败（HTTP %s，详细地址与响应已脱敏）\n' "$claim_status" >&2
    else
      printf '领取审批结果失败（%s，HTTP %s）：%s\n' "$claim_url" "$claim_status" "$claim_text" >&2
    fi
    return 1
  done

  printf '等待中继审批超时（requestId=%s，超时 %s 秒）。\n' "$request_id" "$approval_timeout_sec" >&2
  return 1
}

read_pairing_code_interactive() {
  local answer=""
  if [ -t 0 ]; then
    printf '%s' '请输入中继配对口令（输入不回显）: ' >&2
    IFS= read -rs answer || true
    printf '\n' >&2
  elif [ -r /dev/tty ]; then
    printf '%s' '请输入中继配对口令（输入不回显）: ' >&2
    IFS= read -rs answer </dev/tty || true
    printf '\n' >&2
  fi
  printf '%s' "$(trim "$answer")"
}

main() {
  local relay_arg=""
  local pair_url_arg=""
  local code_arg=""
  local code_stdin=0
  local from_relay_env=""
  local approval_timeout=600
  local redact_secrets=0
  if [ "${CHATDSH_REDACT_SECRETS:-0}" = "1" ]; then
    redact_secrets=1
  fi
  local profile="web"
  local name_arg=""
  local bundle_arg=""
  local bundle_archive_arg=""
  local release_tag="$DEFAULT_RELEASE_TAG"
  local force_remote=0
  local force_local=0
  local skip_checksum=0
  local install_only=0
  local port_arg=""
  local skip_install=0
  local re_pair=0
  local no_start=0
  local dsh_extra_args=()

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --)
        shift
        dsh_extra_args=("$@")
        break
        ;;
      -h|--help)
        print_help
        return 0
        ;;
      --skip-install)
        skip_install=1
        shift
        ;;
      --re-pair)
        re_pair=1
        shift
        ;;
      --no-start)
        no_start=1
        shift
        ;;
      --install-only)
        install_only=1
        shift
        ;;
      --remote)
        force_remote=1
        shift
        ;;
      --from-local)
        force_local=1
        shift
        ;;
      --skip-checksum)
        skip_checksum=1
        shift
        ;;
      --code-stdin)
        code_stdin=1
        shift
        ;;
      --redact-secrets)
        redact_secrets=1
        shift
        ;;
      --approval-timeout)
        approval_timeout="$2"
        shift 2
        ;;
      --approval-timeout=*)
        approval_timeout="${1#--approval-timeout=}"
        shift
        ;;
      --from-relay-env)
        from_relay_env="$2"
        shift 2
        ;;
      --from-relay-env=*)
        from_relay_env="${1#--from-relay-env=}"
        shift
        ;;
      --relay)
        relay_arg="$2"
        shift 2
        ;;
      --relay=*)
        relay_arg="${1#--relay=}"
        shift
        ;;
      --pair-url)
        pair_url_arg="$2"
        shift 2
        ;;
      --pair-url=*)
        pair_url_arg="${1#--pair-url=}"
        shift
        ;;
      --code)
        code_arg="$2"
        shift 2
        ;;
      --code=*)
        code_arg="${1#--code=}"
        shift
        ;;
      --profile)
        profile="$2"
        shift 2
        ;;
      --profile=*)
        profile="${1#--profile=}"
        shift
        ;;
      --name)
        name_arg="$2"
        shift 2
        ;;
      --name=*)
        name_arg="${1#--name=}"
        shift
        ;;
      --bundle)
        bundle_arg="$2"
        shift 2
        ;;
      --bundle=*)
        bundle_arg="${1#--bundle=}"
        shift
        ;;
      --bundle-archive)
        bundle_archive_arg="$2"
        shift 2
        ;;
      --bundle-archive=*)
        bundle_archive_arg="${1#--bundle-archive=}"
        shift
        ;;
      --release-tag)
        release_tag="$2"
        shift 2
        ;;
      --release-tag=*)
        release_tag="${1#--release-tag=}"
        shift
        ;;
      --port)
        port_arg="$2"
        shift 2
        ;;
      --port=*)
        port_arg="${1#--port=}"
        shift
        ;;
      *)
        printf '未知参数：%s\n' "$1" >&2
        return 1
        ;;
    esac
  done

  if [ "$force_remote" -eq 1 ] && [ "$force_local" -eq 1 ]; then
    printf '%s\n' '--remote 与 --from-local 不能同时使用' >&2
    return 1
  fi

  DSH_HOME_RESOLVED="$(trim "${DSH_HOME:-}")"
  if [ -z "$DSH_HOME_RESOLVED" ]; then
    DSH_HOME_RESOLVED="${HOME}/.dsh"
  fi
  mkdir -p "$DSH_HOME_RESOLVED"
  persist_standalone_script "$DSH_HOME_RESOLVED"

  if [ "$skip_install" -eq 0 ]; then
    printf '[1/3] 正在安装 @chatdsh/bundle 到官方 %s profile（DSH_HOME=%s）...\n' "$profile" "$DSH_HOME_RESOLVED"
    install_bundle_into_profile "$DSH_HOME_RESOLVED" "$profile" "$bundle_arg" "$bundle_archive_arg" "$release_tag" "$force_remote" "$force_local" "$skip_checksum"
  else
    printf '%s\n' '[1/3] 已跳过插件安装。'
  fi

  if [ "$install_only" -eq 1 ]; then
    printf '%s\n' '插件安装完成（已按 --install-only 退出）。'
    return 0
  fi

  if [ -n "$from_relay_env" ]; then
    if [ ! -f "$from_relay_env" ]; then
      printf '未找到中继配置文件：%s\n' "$from_relay_env" >&2
      return 1
    fi
    if [ -z "$relay_arg" ]; then
      relay_arg="$(read_env_value "$from_relay_env" CHATDSH_PUBLIC_URL)"
    fi
    if [ -z "$code_arg" ]; then
      code_arg="$(read_env_value "$from_relay_env" CHATDSH_PAIRING_CODE)"
    fi
  fi

  printf '%s\n' '[2/3] 正在检查设备配对凭据...'
  local env_file="${DSH_HOME_RESOLVED}/chatdsh-device.env"
  local saved_url=""
  local saved_device_id=""
  local saved_token=""
  if [ -f "$env_file" ]; then
    saved_url="$(read_env_value "$env_file" CHATDSH_CONTROL_URL)"
    saved_device_id="$(read_env_value "$env_file" CHATDSH_DEVICE_ID)"
    saved_token="$(read_env_value "$env_file" CHATDSH_NODE_TOKEN)"
  fi

  local control_url=""
  if [ -n "$relay_arg" ]; then
    control_url="$(normalize_public_url "$relay_arg")"
  elif [ -n "$saved_url" ]; then
    control_url="$(normalize_public_url "$saved_url")"
  else
    printf '%s\n' '缺少中继地址：首次接入请传入 --relay <中继地址>，或传入 --from-relay-env <路径>' >&2
    return 1
  fi

  local device_id=""
  local node_token=""
  if [ "$re_pair" -eq 0 ] && [ -n "$saved_device_id" ] && [ -n "$saved_token" ] && [ "$saved_url" = "$control_url" ]; then
    device_id="$saved_device_id"
    node_token="$saved_token"
    printf '复用已保存的设备凭据：deviceId=%s（来源：%s）。\n' "$device_id" "$env_file"
  else
    local code
    code="$(trim "$code_arg")"
    if [ -z "$code" ] && [ "$code_stdin" -eq 1 ]; then
      IFS= read -r code || true
      code="$(trim "$code")"
    elif [ -z "$code" ]; then
      code="$(read_pairing_code_interactive)"
    fi
    if [ -z "$code" ]; then
      printf '%s\n' '缺少配对口令：请在交互终端输入、使用 --code-stdin、传入 --from-relay-env .env 或 --code <配对口令>' >&2
      return 1
    fi
    local pair_endpoint="$control_url"
    if [ -n "$pair_url_arg" ]; then
      pair_endpoint="$(normalize_public_url "$pair_url_arg")"
    fi
    local dev_name
    dev_name="$(trim "${name_arg:-$(hostname)}")"
    [ -n "$dev_name" ] || dev_name="chatdsh-device"

    local pair_out
    pair_out="$(pair_device "$pair_endpoint" "$code" "$dev_name" "$redact_secrets" "$approval_timeout")"
    device_id="${pair_out%%$'\t'*}"
    node_token="${pair_out#*$'\t'}"
    write_device_env "$env_file" "$control_url" "$device_id" "$node_token"
    printf '设备配对完成：deviceId=%s，凭据已保存到 %s（权限 0600）。\n' "$device_id" "$env_file"
  fi

  local restart_hint="bash ${DSH_HOME_RESOLVED}/chatdsh-device-join.sh"
  if [ -n "$REPO_ROOT" ]; then
    restart_hint="bash scripts/device-join.sh"
  fi

  if [ "$no_start" -eq 1 ]; then
    printf '[3/3] 已按 --no-start 跳过启动 DSH。后续启动执行：%s\n' "$restart_hint"
    return 0
  fi

  local dsh_bin
  dsh_bin="$(resolve_dsh_bin)"
  local dsh_args=(--profile "$profile")
  if [ -n "$port_arg" ]; then
    dsh_args+=(--port "$port_arg")
  fi
  if [ "${#dsh_extra_args[@]}" -gt 0 ]; then
    dsh_args+=("${dsh_extra_args[@]}")
  fi

  if [ "$redact_secrets" -eq 1 ]; then
    printf '%s\n' '[3/3] 正在启动官方 DSH（连接地址已由凭据文件注入，脱敏隐藏）...'
  else
    printf '[3/3] 正在启动官方 DSH（连接中继 %s）...\n' "$control_url"
  fi
  printf '提示：后续在本机重启只需执行 %s。\n' "$restart_hint"

  exec env \
    "DSH_HOME=${DSH_HOME_RESOLVED}" \
    "CHATDSH_CONTROL_URL=${control_url}" \
    "CHATDSH_DEVICE_ID=${device_id}" \
    "CHATDSH_NODE_TOKEN=${node_token}" \
    "$dsh_bin" "${dsh_args[@]}"
}

main "$@"
