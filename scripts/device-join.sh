#!/usr/bin/env bash
# 设备侧一行接入脚本：安装 @chatdsh/bundle 插件、配对连接中继服务端并启动官方 DSH。
#
# 首次运行（从 relay-up.sh 输出直接复制）：
#   bash scripts/device-join.sh --relay https://relay.example.com --code '<配对口令>'
#
# 后续在同一设备再次启动（自动复用已安装的插件与保存的设备凭据）：
#   bash scripts/device-join.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUNTIME_ROOT="${REPO_ROOT}/runtime"

print_help() {
  cat <<'EOF'
用法：bash scripts/device-join.sh [选项] [-- <透传给 dsh 的参数>]

选项：
  --relay <域名或 origin>  中继对外地址（首次接入必填，后续自动复用）
  --code <配对口令>        中继配对口令（不传时在交互终端静默提示输入，避免留存 Shell 历史）
  --code-stdin             从标准输入读取配对口令（避免口令出现在进程参数中）
  --from-relay-env <路径>  直接从本地中继 .env 读取 CHATDSH_PUBLIC_URL 与 CHATDSH_PAIRING_CODE（不经命令行传密）
  --redact-secrets         脱敏输出模式：不向终端打印真实域名与凭据详情（供 AI Agent 调用）
  --approval-timeout <秒>  等待中继管理员审批的超时秒数（默认 600 秒）
  --profile <名称>         目标官方 DSH profile（默认 web）
  --name <设备名>          向中继登记的设备名称（默认主机名）
  --port <端口>            传递给 dsh 的本地监听端口
  --bundle <包名或路径>    自定义组合包来源（缺省打包并安装当前仓库的 @chatdsh/bundle）
  --pair-url <origin>      配对请求使用的直连地址（默认与 --relay 相同）
  --skip-install           跳过插件安装步骤
  --re-pair                忽略已保存凭据并重新配对
  --no-start               完成安装与配对后退出，不启动 dsh
  -h, --help               显示帮助信息
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
    printf '%s\n' '# ChatDSH 设备连接凭据（由 scripts/device-join.sh 维护，权限 0600）'
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

assert_local_artifacts_ready() {
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
  local missing=0
  local file
  for file in "${required[@]}"; do
    if [ ! -f "$file" ]; then
      missing=$((missing + 1))
    fi
  done
  if [ "$missing" -gt 0 ]; then
    printf '本地插件产物尚未构建（缺失 %d 项），请先构建：\n' "$missing" >&2
    printf '%s\n' '  cd dsh-adapter && pnpm build && cd ../runtime && pnpm build && pnpm build:client' >&2
    return 1
  fi
}

install_bundle_into_profile() {
  local dsh_home="$1"
  local profile="$2"
  local bundle_spec="$3"
  local dsh_bin
  dsh_bin="$(resolve_dsh_bin)"
  local store="${pnpm_config_store_dir:-${npm_config_store_dir:-${CHATDSH_PNPM_STORE:-${RUNTIME_ROOT}/.run/pnpm-store}}}"

  if [ -n "$bundle_spec" ]; then
    DSH_HOME="$dsh_home" npm_config_store_dir="$store" pnpm_config_store_dir="$store" \
      "$dsh_bin" plugin --profile "$profile" add "$bundle_spec"
    return 0
  fi

  assert_local_artifacts_ready

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

  # 使用 yaml 第三方库更新 pnpm-workspace.yaml 的 overrides 字段，保留其他内容
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
  printf '  bash scripts/relay-approve.sh approve %s\n' "$request_id" >&2
  printf '（拒绝可执行：bash scripts/relay-approve.sh reject %s）\n' "$request_id" >&2

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

  DSH_HOME_RESOLVED="$(trim "${DSH_HOME:-}")"
  if [ -z "$DSH_HOME_RESOLVED" ]; then
    DSH_HOME_RESOLVED="${HOME}/.dsh"
  fi
  mkdir -p "$DSH_HOME_RESOLVED"

  if [ "$skip_install" -eq 0 ]; then
    printf '[1/3] 正在安装 @chatdsh/bundle 到官方 %s profile（DSH_HOME=%s）...\n' "$profile" "$DSH_HOME_RESOLVED"
    install_bundle_into_profile "$DSH_HOME_RESOLVED" "$profile" "$bundle_arg"
  else
    printf '%s\n' '[1/3] 已跳过插件安装。'
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
    printf '%s\n' '缺少中继地址：首次接入请传入 --relay <中继地址> --code <配对口令>，或传入 --from-relay-env .env' >&2
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
    elif [ -z "$code" ] && [ -t 0 ]; then
      printf '%s' '请输入中继配对口令（输入不回显）: ' >&2
      IFS= read -rs code || true
      printf '\n' >&2
      code="$(trim "$code")"
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

  if [ "$no_start" -eq 1 ]; then
    printf '%s\n' '[3/3] 已按 --no-start 跳过启动 DSH。后续启动执行：bash scripts/device-join.sh'
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
  printf '%s\n' '提示：后续在本机重启只需执行 bash scripts/device-join.sh；接入新设备时在中继宿主机执行 bash scripts/relay-up.sh --print-join-command 获取命令。'

  exec env \
    "DSH_HOME=${DSH_HOME_RESOLVED}" \
    "CHATDSH_CONTROL_URL=${control_url}" \
    "CHATDSH_DEVICE_ID=${device_id}" \
    "CHATDSH_NODE_TOKEN=${node_token}" \
    "$dsh_bin" "${dsh_args[@]}"
}

main "$@"
