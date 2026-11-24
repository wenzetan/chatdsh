#!/usr/bin/env bash
# 中继服务端 Docker Compose 引导与启动脚本。
#
# 支持两种运行方式：
#   1. 远程免克隆部署（首选，直接复用 GitHub 仓库脚本与 GHCR 预构建多架构镜像，兼容 zsh / bash / fish / sh）：
#      curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/relay-up.sh | bash
#   2. 本地仓库内运行（开发者源码构建可附加 --build）：
#      bash scripts/relay-up.sh [--build]

set -euo pipefail

GITHUB_REPO="${CHATDSH_GITHUB_REPO:-wenzetan/chatdsh}"
GITHUB_REF="${CHATDSH_GITHUB_REF:-main}"
RAW_BASE="${CHATDSH_RAW_BASE:-https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_REF}}"
DEFAULT_RELAY_IMAGE="${CHATDSH_RELAY_IMAGE:-ghcr.io/${GITHUB_REPO%%/*}/chatdsh-relay:latest}"

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
STANDALONE_MODE=1
REPO_ROOT=""
if [ -n "$SCRIPT_SOURCE" ] && [ -f "$SCRIPT_SOURCE" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  if [ -f "${SCRIPT_DIR}/../docker-compose.yml" ] && [ -f "${SCRIPT_DIR}/../Dockerfile" ]; then
    REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
    STANDALONE_MODE=0
  elif [ -f "${SCRIPT_DIR}/docker-compose.yml" ]; then
    REPO_ROOT="$SCRIPT_DIR"
    STANDALONE_MODE=1
  fi
fi

DEFAULT_WORK_DIR="${CHATDSH_RELAY_DIR:-${HOME}/.chatdsh/relay}"
if [ -n "$REPO_ROOT" ]; then
  DEFAULT_WORK_DIR="$REPO_ROOT"
fi

print_help() {
  cat <<'EOF'
用法：
  远程一键部署：curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/relay-up.sh | bash
  远程带参执行：curl -fsSL https://raw.githubusercontent.com/wenzetan/chatdsh/main/scripts/relay-up.sh | bash -s -- [选项]
  本地脚本执行：bash relay-up.sh [选项]

选项：
  --dir <目录>              指定中继部署目录（独立部署默认 ~/.chatdsh/relay，源码仓库默认仓库根）
  --domain <域名或 origin>  指定对外访问域名（未指定且 .env 未保存时会通过命令行询问，必填）
  --reconfigure             重新询问并更新对外域名（已保存的配对口令保持复用）
  --print-join-command      打印设备一行接入命令（读取已保存的 .env，不重启容器）
  --redact-secrets          脱敏输出模式：不向标准输出打印配对口令与真实域名（供 AI Agent 调用）
  --disable-pairing         清空 .env 中的配对口令并重启容器，关闭新设备配对入口（返回 404）
  --rotate-pairing-code     重新生成随机配对口令并重启容器，旧口令立即失效
  --bind-host <IP>          指定宿主机监听 IP（默认 127.0.0.1；严禁 0.0.0.0 或 ::，仅限回环或具体内网穿透网卡 IP）
  --image <镜像名>          指定中继容器镜像（默认 ghcr.io/wenzetan/chatdsh-relay:latest）
  --build                   使用本地源码与 docker-compose.build.yml 重新构建镜像（需位于源码仓库内）
  --no-pull                 启动前不执行 docker compose pull（直接使用本地已有镜像）
  --no-build                兼容参数：不从源码构建，直接使用预构建镜像
  --update-scripts          重新从 GitHub 拉取最新的 docker-compose.yml 与管理脚本到部署目录
  --config <路径>           指定环境变量文件路径（默认 <部署目录>/.env）
  --prepare-only            仅检查/生成并保存 .env（独立模式同时拉取部署文件），不启动 Docker Compose
  -h, --help                显示帮助信息
EOF
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

shell_quote() {
  local value="$1"
  if [[ "$value" =~ ^[A-Za-z0-9_./:@+-]+$ ]]; then
    printf '%s' "$value"
    return 0
  fi
  local escaped="${value//\'/\'\\\'\'}"
  printf "'%s'" "$escaped"
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

download_file() {
  local url="$1"
  local dest="$2"
  local mode="${3:-644}"
  mkdir -p "$(dirname "$dest")"
  local tmp="${dest}.tmp.$$"
  if ! curl -fsSL --retry 2 --max-time 30 "$url" -o "$tmp"; then
    rm -f "$tmp"
    printf '下载远端文件失败：%s\n' "$url" >&2
    return 1
  fi
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
}

ensure_standalone_files() {
  local work_dir="$1"
  local force_update="${2:-0}"
  mkdir -p "$work_dir"

  if [ "$force_update" -eq 1 ] || [ ! -f "${work_dir}/docker-compose.yml" ]; then
    download_file "${RAW_BASE}/docker-compose.yml" "${work_dir}/docker-compose.yml" 644
  fi
  if [ "$force_update" -eq 1 ] || [ ! -f "${work_dir}/relay-up.sh" ]; then
    download_file "${RAW_BASE}/scripts/relay-up.sh" "${work_dir}/relay-up.sh" 755
  fi
  if [ "$force_update" -eq 1 ] || [ ! -f "${work_dir}/relay-approve.sh" ]; then
    download_file "${RAW_BASE}/scripts/relay-approve.sh" "${work_dir}/relay-approve.sh" 755
  fi
}

# 将域名或完整来源规范化为精确 HTTP/HTTPS origin。
normalize_public_url() {
  local raw
  raw="$(trim "$1")"
  if [ -z "$raw" ]; then
    printf '%s\n' '域名不能为空，请输入中继对外访问域名或完整 origin（例如 relay.example.com 或 https://relay.example.com）' >&2
    return 1
  fi
  if [[ "$raw" =~ [[:space:]] ]]; then
    printf '%s\n' '域名不能包含空白字符' >&2
    return 1
  fi

  local candidate="$raw"
  if [[ "$raw" =~ ^([A-Za-z][A-Za-z0-9+.-]*):// ]]; then
    local proto="${BASH_REMATCH[1]}"
    local proto_lower
    proto_lower="$(printf '%s' "$proto" | tr '[:upper:]' '[:lower:]')"
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

  if [ -z "$rest" ]; then
    printf '%s\n' '域名缺少主机名' >&2
    return 1
  fi
  if [[ "$rest" == *"@"* ]]; then
    printf '%s\n' '域名不允许包含用户名或口令' >&2
    return 1
  fi
  if [[ "$rest" == *"?"* ]] || [[ "$rest" == *"#"* ]]; then
    printf '%s\n' '对外地址不能包含查询参数或片段' >&2
    return 1
  fi
  if [[ "$rest" == *"/"* ]]; then
    printf '对外地址必须是精确 origin，不能包含路径：/%s\n' "${rest#*/}" >&2
    return 1
  fi

  local host=""
  local port=""
  if [[ "$rest" == \[* ]]; then
    if [[ "$rest" =~ ^(\[[0-9A-Fa-f:]+\])(:([0-9]+))?$ ]]; then
      host="${BASH_REMATCH[1]}"
      port="${BASH_REMATCH[3]}"
    else
      printf '域名格式不合法：%s\n' "$raw" >&2
      return 1
    fi
  else
    if [[ "$rest" == *:* ]]; then
      host="${rest%%:*}"
      port="${rest#*:}"
      if [[ ! "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
        printf '端口号不合法：%s\n' "$port" >&2
        return 1
      fi
    else
      host="$rest"
    fi
    host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
    if [ -z "$host" ] || [[ ! "$host" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || [[ "$host" == *".."* ]]; then
      printf '域名格式不合法：%s\n' "$raw" >&2
      return 1
    fi
  fi

  if { [ "$scheme" = "https" ] && [ "$port" = "443" ]; } || { [ "$scheme" = "http" ] && [ "$port" = "80" ]; }; then
    port=""
  fi

  if [ -n "$port" ]; then
    printf '%s://%s:%s' "$scheme" "$host" "$port"
  else
    printf '%s://%s' "$scheme" "$host"
  fi
}

generate_pairing_code() {
  head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\r\n'
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

has_env_key() {
  local file="$1"
  local target_key="$2"
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)= ]]; then
      if [ "${BASH_REMATCH[2]}" = "$target_key" ]; then
        return 0
      fi
    fi
  done < "$file"
  return 1
}

# 原子更新 .env 中的若干键值对，保留原文件注释与其他键，文件权限限制为 0600。
upsert_env_file() {
  local file="$1"
  shift
  local dir
  dir="$(dirname "$file")"
  mkdir -p "$dir"

  local keys=()
  local vals=()
  local pair
  for pair in "$@"; do
    keys+=("${pair%%=*}")
    vals+=("${pair#*=}")
  done

  local tmp="${file}.tmp.$$"
  umask 077
  : > "$tmp"

  local seen_list=""
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)= ]]; then
        local key="${BASH_REMATCH[2]}"
        local matched=0
        local idx
        for idx in "${!keys[@]}"; do
          if [ "${keys[$idx]}" = "$key" ]; then
            if [[ " $seen_list " != *" $key "* ]]; then
              printf '%s=%s\n' "$key" "$(format_env_value "${vals[$idx]}")" >> "$tmp"
              seen_list="${seen_list} ${key}"
            fi
            matched=1
            break
          fi
        done
        if [ "$matched" -eq 0 ]; then
          printf '%s\n' "$line" >> "$tmp"
        fi
      else
        printf '%s\n' "$line" >> "$tmp"
      fi
    done < "$file"
  else
    printf '%s\n' '# ChatDSH 中继服务端运行配置（由 relay-up.sh 维护，请勿提交到版本库）' >> "$tmp"
  fi

  local idx
  for idx in "${!keys[@]}"; do
    local key="${keys[$idx]}"
    if [[ " $seen_list " != *" $key "* ]]; then
      printf '%s=%s\n' "$key" "$(format_env_value "${vals[$idx]}")" >> "$tmp"
    fi
  done

  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
  chmod 600 "$file"
}

prompt_required_domain() {
  local use_tty=0
  local interactive=0
  if [ -t 0 ]; then
    interactive=1
  elif { [ -z "$SCRIPT_SOURCE" ] || [ "$SCRIPT_SOURCE" = "/dev/stdin" ]; } && [ -r /dev/tty ]; then
    use_tty=1
    interactive=1
  fi

  while true; do
    printf '%s' '请输入中继服务端对外域名（必填，例如 relay.example.com 或 https://relay.example.com）: ' >&2
    local answer=""
    if [ "$use_tty" -eq 1 ]; then
      if ! IFS= read -r answer </dev/tty; then
        printf '\n%s\n' '未收到中继域名输入，域名为必填项' >&2
        return 1
      fi
    else
      if ! IFS= read -r answer; then
        printf '\n%s\n' '未收到中继域名输入，域名为必填项' >&2
        return 1
      fi
    fi
    local normalized=""
    if normalized="$(normalize_public_url "$answer")"; then
      printf '%s' "$normalized"
      return 0
    fi
    if [ "$interactive" -eq 0 ]; then
      return 1
    fi
  done
}

extract_host_from_origin() {
  local origin="$1"
  local rest="${origin#*://}"
  if [[ "$rest" == \[* ]]; then
    printf '%s' "${rest%%]*}]"
  else
    printf '%s' "${rest%%:*}"
  fi
}

check_public_health() {
  local url="$1"
  local body=""
  if body="$(curl -fsS --max-time 3 "$url" 2>/dev/null)"; then
    if [[ "$body" == *'"ok":true'* ]]; then
      return 0
    fi
  fi
  return 1
}

relay_script_invocation() {
  local work_dir="$1"
  local script_name="$2"
  if [ "$STANDALONE_MODE" -eq 0 ] && [ "$work_dir" = "$REPO_ROOT" ]; then
    printf 'bash scripts/%s' "$script_name"
  else
    printf 'bash %s' "$(shell_quote "${work_dir}/${script_name}")"
  fi
}

print_network_checklist() {
  local public_url="$1"
  local probe_host="$2"
  local bind_port="$3"
  local redact="${4:-0}"
  local domain_host
  local display_url
  if [ "$redact" -eq 1 ]; then
    domain_host='<你在 .env 中配置的域名>'
    display_url='<你在 .env 中配置的 CHATDSH_PUBLIC_URL>'
  else
    domain_host="$(extract_host_from_origin "$public_url")"
    display_url="$public_url"
  fi

  printf '\n'
  printf '%s\n' '公网接入前置提醒（中继容器仅监听本机 HTTP 端口，TLS 与域名路由由前置反向代理/网关承担）：'
  printf '  1. 域名解析：将 %s 的 A / AAAA（或 CNAME）记录解析到当前服务器公网 IP。\n' "$domain_host"
  printf '  2. 反向代理：在 Nginx / Caddy / 网关中为 %s 配置 HTTPS，并转发到 http://%s:%s。\n' "$display_url" "$probe_host" "$bind_port"
  printf '%s\n' '     转发规则需开启 WebSocket 升级（Upgrade / Connection）并关闭响应缓冲（proxy_buffering off），'
  printf '%s\n' '     以确保 /chatdsh/gateway/device-link、/d/<deviceId>/api/remote.mux 与 /chatdsh/gateway/events 长连接正常。'
  printf '  3. 访问保护：公网暴露建议开启 CHATDSH_ACCESS_MODE=required 或在反向代理配置身份认证（Cloudflare Access / OIDC / mTLS）；仅 Tailscale 私有网络访问可保持默认。\n'
  printf '  4. 验证公网连通：curl -fsS %s/healthz（返回 ok:true 后再在设备端执行接入命令）。\n' "$display_url"
}

print_redacted_join_hint() {
  local work_dir="$1"
  local env_file="$2"
  local default_env="${work_dir}/.env"
  local config_arg=""
  if [ "$env_file" != "$default_env" ]; then
    config_arg=" --config $(shell_quote "$env_file")"
  fi
  local up_cmd
  local approve_cmd
  up_cmd="$(relay_script_invocation "$work_dir" relay-up.sh)"
  approve_cmd="$(relay_script_invocation "$work_dir" relay-approve.sh)"
  printf '\n'
  printf '%s\n' '已启用脱敏输出模式，配对口令与域名未打印到终端输出。'
  printf '%s\n' '如需查看完整设备接入命令，请在自己的本地终端手动执行：'
  printf '  %s --print-join-command%s\n' "$up_cmd" "$config_arg"
  printf '%s\n' '同机设备接入可直接引用 .env 变量文件（免克隆仓库、不传递明文口令）：'
  printf '  curl -fsSL %s/scripts/device-join.sh | bash -s -- --from-relay-env %s --redact-secrets\n' "$RAW_BASE" "$(shell_quote "$env_file")"
  printf '%s\n' '客户端发起配对申请后，在中继宿主机审批放行：'
  printf '  %s%s list\n' "$approve_cmd" "$config_arg"
  printf '  %s%s approve <requestId>\n' "$approve_cmd" "$config_arg"
  printf '%s\n' '全部设备配对完成后可关闭配对入口：'
  printf '  %s%s --disable-pairing\n' "$up_cmd" "$config_arg"
}

print_join_instructions() {
  local work_dir="$1"
  local env_file="$2"
  local public_url="$3"
  local pairing_code="$4"
  local default_env="${work_dir}/.env"
  local config_arg=""
  if [ "$env_file" != "$default_env" ]; then
    config_arg=" --config $(shell_quote "$env_file")"
  fi
  local up_cmd
  local approve_cmd
  up_cmd="$(relay_script_invocation "$work_dir" relay-up.sh)"
  approve_cmd="$(relay_script_invocation "$work_dir" relay-approve.sh)"
  printf '\n'
  printf '%s\n' '在需要接入的设备上执行以下一行命令（免克隆仓库，自动从 GitHub Releases 下载插件归档并校验 SHA-256、交互静默输入口令、等待审批并启动 DSH）：'
  printf '  curl -fsSL %s/scripts/device-join.sh | bash -s -- --relay %s\n' "$RAW_BASE" "$(shell_quote "$public_url")"
  printf '%s\n' '按提示输入下方配对口令（仅用于提交配对申请，仍需中继管理员审批才会放行）：'
  printf '  %s\n' "$pairing_code"
  printf '\n'
  printf '%s\n' '客户端提交配对申请后，在中继宿主机审批放行：'
  printf '  %s%s list\n' "$approve_cmd" "$config_arg"
  printf '  %s%s approve <requestId>\n' "$approve_cmd" "$config_arg"
  printf '\n'
  printf '%s\n' '全部设备配对完成后建议关闭配对入口（需要接入新设备时再执行 --rotate-pairing-code 重新启用）：'
  printf '  %s%s --disable-pairing\n' "$up_cmd" "$config_arg"
  printf '\n'
  printf '%s\n' '后续如需再次打印该命令，在中继宿主机执行：'
  printf '  %s --print-join-command%s\n' "$up_cmd" "$config_arg"
}

wait_for_health() {
  local url="$1"
  local deadline=$(( $(date +%s) + 30 ))
  local body=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if body="$(curl -fsS --max-time 2 "$url" 2>/dev/null)"; then
      if [[ "$body" == *'"ok":true'* ]]; then
        printf '%s' "$body"
        return 0
      fi
    fi
    sleep 0.5
  done
  printf '等待中继健康检查超时（%s）\n' "$url" >&2
  return 1
}

validate_bind_host() {
  local host
  host="$(trim "$1")"
  if [ -z "$host" ]; then
    printf '%s\n' 'CHATDSH_GATEWAY_BIND_HOST 不能为空，请使用 127.0.0.1 或具体内网穿透网卡 IP' >&2
    return 1
  fi
  case "$host" in
    0.0.0.0|::|"[::]"|"*"|0:0:0:0:0:0:0:0)
      printf 'CHATDSH_GATEWAY_BIND_HOST 不允许绑定通配地址（%s），请仅绑定 127.0.0.1 或具体内网穿透服务网卡 IP\n' "$host" >&2
      return 1
      ;;
  esac
  printf '%s' "$host"
}

main() {
  local work_dir="$DEFAULT_WORK_DIR"
  local has_dir_arg=0
  local env_file=""
  local domain_arg=""
  local has_domain_arg=0
  local bind_host_arg=""
  local has_bind_host_arg=0
  local image_arg=""
  local has_image_arg=0
  local reconfigure=0
  local prepare_only=0
  local print_join_only=0
  local build_local=0
  local no_pull=0
  local update_scripts=0
  local disable_pairing=0
  local rotate_pairing_code=0
  local redact_secrets=0
  if [ "${CHATDSH_REDACT_SECRETS:-0}" = "1" ]; then
    redact_secrets=1
  fi
  if [ "${CHATDSH_RELAY_BUILD:-0}" = "1" ]; then
    build_local=1
  fi

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help)
        print_help
        return 0
        ;;
      --dir)
        if [ "$#" -lt 2 ]; then
          printf '%s\n' '--dir 缺少参数' >&2
          return 1
        fi
        work_dir="$2"
        has_dir_arg=1
        shift 2
        ;;
      --dir=*)
        work_dir="${1#--dir=}"
        has_dir_arg=1
        shift
        ;;
      --reconfigure)
        reconfigure=1
        shift
        ;;
      --prepare-only)
        prepare_only=1
        shift
        ;;
      --print-join-command|--join-command)
        print_join_only=1
        shift
        ;;
      --redact-secrets)
        redact_secrets=1
        shift
        ;;
      --disable-pairing)
        disable_pairing=1
        shift
        ;;
      --rotate-pairing-code)
        rotate_pairing_code=1
        shift
        ;;
      --build)
        build_local=1
        shift
        ;;
      --no-build)
        build_local=0
        no_pull=1
        shift
        ;;
      --no-pull)
        no_pull=1
        shift
        ;;
      --update-scripts)
        update_scripts=1
        shift
        ;;
      --image)
        if [ "$#" -lt 2 ]; then
          printf '%s\n' '--image 缺少参数' >&2
          return 1
        fi
        image_arg="$2"
        has_image_arg=1
        shift 2
        ;;
      --image=*)
        image_arg="${1#--image=}"
        has_image_arg=1
        shift
        ;;
      --domain)
        if [ "$#" -lt 2 ]; then
          printf '%s\n' '--domain 缺少参数' >&2
          return 1
        fi
        domain_arg="$2"
        has_domain_arg=1
        shift 2
        ;;
      --domain=*)
        domain_arg="${1#--domain=}"
        has_domain_arg=1
        shift
        ;;
      --bind-host)
        if [ "$#" -lt 2 ]; then
          printf '%s\n' '--bind-host 缺少参数' >&2
          return 1
        fi
        bind_host_arg="$2"
        has_bind_host_arg=1
        shift 2
        ;;
      --bind-host=*)
        bind_host_arg="${1#--bind-host=}"
        has_bind_host_arg=1
        shift
        ;;
      --config)
        if [ "$#" -lt 2 ]; then
          printf '%s\n' '--config 缺少参数' >&2
          return 1
        fi
        env_file="$2"
        shift 2
        ;;
      --config=*)
        env_file="${1#--config=}"
        shift
        ;;
      *)
        printf '未知参数：%s\n' "$1" >&2
        return 1
        ;;
    esac
  done

  if [ "$has_dir_arg" -eq 1 ]; then
    if [ ! -f "${work_dir}/Dockerfile" ] || [ ! -f "${work_dir}/docker-compose.build.yml" ]; then
      STANDALONE_MODE=1
    fi
  fi

  if [ -z "$env_file" ]; then
    env_file="${work_dir}/.env"
  fi
  local compose_file="${work_dir}/docker-compose.yml"
  local compose_build_file="${work_dir}/docker-compose.build.yml"

  if [ "$STANDALONE_MODE" -eq 1 ]; then
    ensure_standalone_files "$work_dir" "$update_scripts"
  fi

  if [ "$disable_pairing" -eq 1 ] && [ "$rotate_pairing_code" -eq 1 ]; then
    printf '%s\n' '--disable-pairing 与 --rotate-pairing-code 不能同时使用' >&2
    return 1
  fi

  if [ "$disable_pairing" -eq 1 ]; then
    if [ ! -f "$env_file" ]; then
      printf '未找到配置文件 %s\n' "$env_file" >&2
      return 1
    fi
    upsert_env_file "$env_file" "CHATDSH_PAIRING_CODE="
    printf '已清空 %s 中的 CHATDSH_PAIRING_CODE，新设备配对入口已关闭。\n' "$env_file"
    if [ "$prepare_only" -eq 0 ]; then
      (cd "$work_dir" && docker compose --env-file "$env_file" -f "$compose_file" up -d --no-build)
      printf '%s\n' '已更新中继容器，/chatdsh/gateway/devices/pair 现返回 404 pairing-disabled。'
    fi
    return 0
  fi

  if [ "$print_join_only" -eq 1 ]; then
    if [ ! -f "$env_file" ]; then
      printf '未找到配置文件 %s，请先执行 relay-up.sh 初始化并启动中继服务端\n' "$env_file" >&2
      return 1
    fi
    local saved_url
    local saved_code
    saved_url="$(read_env_value "$env_file" CHATDSH_PUBLIC_URL)"
    saved_code="$(read_env_value "$env_file" CHATDSH_PAIRING_CODE)"
    if [ -z "$saved_url" ]; then
      printf '%s 缺少 CHATDSH_PUBLIC_URL，请先执行 relay-up.sh\n' "$env_file" >&2
      return 1
    fi
    if [ -z "$saved_code" ]; then
      printf '%s 中的配对口令已关闭；如需接入新设备，请先执行 %s --rotate-pairing-code\n' "$env_file" "$(relay_script_invocation "$work_dir" relay-up.sh)" >&2
      return 1
    fi
    local normalized_saved_url
    normalized_saved_url="$(normalize_public_url "$saved_url")"
    print_join_instructions "$work_dir" "$env_file" "$normalized_saved_url" "$saved_code"
    return 0
  fi

  local existing_url=""
  local existing_code=""
  local existing_bind_host=""
  local existing_bind_port=""
  local existing_approval=""
  local existing_image=""
  if [ -f "$env_file" ]; then
    existing_url="$(read_env_value "$env_file" CHATDSH_PUBLIC_URL)"
    existing_code="$(read_env_value "$env_file" CHATDSH_PAIRING_CODE)"
    existing_bind_host="$(read_env_value "$env_file" CHATDSH_GATEWAY_BIND_HOST)"
    existing_bind_port="$(read_env_value "$env_file" CHATDSH_GATEWAY_BIND_PORT)"
    existing_approval="$(read_env_value "$env_file" CHATDSH_PAIRING_APPROVAL)"
    existing_image="$(read_env_value "$env_file" CHATDSH_RELAY_IMAGE)"
  fi

  local public_url=""
  if [ "$has_domain_arg" -eq 1 ]; then
    public_url="$(normalize_public_url "$domain_arg")"
  elif [ "$reconfigure" -eq 0 ] && [ -n "$existing_url" ]; then
    public_url="$(normalize_public_url "$existing_url")"
  else
    public_url="$(prompt_required_domain)"
  fi

  local pairing_code=""
  local pairing_generated=0
  local env_code
  env_code="$(trim "${CHATDSH_PAIRING_CODE:-}")"
  if [ "$rotate_pairing_code" -eq 1 ]; then
    pairing_code="$(generate_pairing_code)"
    pairing_generated=1
  elif [ -n "$existing_code" ]; then
    pairing_code="$existing_code"
  elif [ -n "$env_code" ]; then
    pairing_code="$env_code"
  else
    pairing_code="$(generate_pairing_code)"
    pairing_generated=1
  fi

  local raw_bind_host
  if [ "$has_bind_host_arg" -eq 1 ]; then
    raw_bind_host="$bind_host_arg"
  else
    raw_bind_host="${CHATDSH_GATEWAY_BIND_HOST:-${existing_bind_host:-127.0.0.1}}"
  fi
  local bind_host
  bind_host="$(validate_bind_host "$raw_bind_host")"
  local bind_port
  bind_port="$(trim "${CHATDSH_GATEWAY_BIND_PORT:-${existing_bind_port:-3170}}")"
  [ -n "$bind_port" ] || bind_port="3170"
  local pairing_approval
  pairing_approval="$(trim "${CHATDSH_PAIRING_APPROVAL:-${existing_approval:-required}}")"
  [ -n "$pairing_approval" ] || pairing_approval="required"

  local relay_image
  if [ "$has_image_arg" -eq 1 ]; then
    relay_image="$(trim "$image_arg")"
  elif [ "$build_local" -eq 1 ]; then
    relay_image="${existing_image:-chatdsh-relay:local}"
  else
    relay_image="$(trim "${existing_image:-$DEFAULT_RELAY_IMAGE}")"
  fi

  local updates=()
  if [ ! -f "$env_file" ] || [ "$existing_url" != "$public_url" ]; then
    updates+=("CHATDSH_PUBLIC_URL=${public_url}")
  fi
  if [ ! -f "$env_file" ] || [ "$existing_code" != "$pairing_code" ]; then
    updates+=("CHATDSH_PAIRING_CODE=${pairing_code}")
  fi
  if ! has_env_key "$env_file" CHATDSH_PAIRING_APPROVAL; then
    updates+=("CHATDSH_PAIRING_APPROVAL=${pairing_approval}")
  fi
  if ! has_env_key "$env_file" CHATDSH_GATEWAY_BIND_HOST || [ "$existing_bind_host" != "$bind_host" ]; then
    updates+=("CHATDSH_GATEWAY_BIND_HOST=${bind_host}")
  fi
  if ! has_env_key "$env_file" CHATDSH_GATEWAY_BIND_PORT; then
    updates+=("CHATDSH_GATEWAY_BIND_PORT=${bind_port}")
  fi
  if [ "$has_image_arg" -eq 1 ] || ! has_env_key "$env_file" CHATDSH_RELAY_IMAGE; then
    updates+=("CHATDSH_RELAY_IMAGE=${relay_image}")
  fi

  if [ "${#updates[@]}" -gt 0 ]; then
    upsert_env_file "$env_file" "${updates[@]}"
  fi

  if [ "$pairing_generated" -eq 1 ]; then
    printf '已自动生成随机配对口令并保存到 %s（权限 0600，下次运行自动复用）。\n' "$env_file"
  else
    printf '复用已保存的配对口令（来源：%s）。\n' "$env_file"
  fi
  if [ "$redact_secrets" -eq 1 ]; then
    printf '中继对外地址：已从 %s 加载（脱敏隐藏）\n' "$env_file"
  else
    printf '中继对外地址：%s\n' "$public_url"
  fi

  if [ "$prepare_only" -eq 1 ]; then
    print_network_checklist "$public_url" "$bind_host" "$bind_port" "$redact_secrets"
    if [ "$redact_secrets" -eq 1 ]; then
      print_redacted_join_hint "$work_dir" "$env_file"
    else
      print_join_instructions "$work_dir" "$env_file" "$public_url" "$pairing_code"
    fi
    return 0
  fi

  if [ "$build_local" -eq 1 ]; then
    if [ ! -f "$compose_build_file" ] || [ ! -f "${work_dir}/Dockerfile" ]; then
      printf '当前目录 %s 缺少 Dockerfile 或 docker-compose.build.yml，无法执行 --build\n' "$work_dir" >&2
      return 1
    fi
    (cd "$work_dir" && docker compose --env-file "$env_file" -f "$compose_file" -f "$compose_build_file" up -d --build)
  else
    if [ "$no_pull" -eq 0 ]; then
      (cd "$work_dir" && docker compose --env-file "$env_file" -f "$compose_file" pull)
    fi
    (cd "$work_dir" && docker compose --env-file "$env_file" -f "$compose_file" up -d)
  fi

  local health_url="http://${bind_host}:${bind_port}/healthz"
  wait_for_health "$health_url" >/dev/null
  if [ "$redact_secrets" -eq 1 ]; then
    printf '中继容器已就绪（本机绑定入口：http://%s:%s，对外来源已由 %s 注入）\n' "$bind_host" "$bind_port" "$env_file"
    if check_public_health "${public_url}/healthz"; then
      printf '%s\n' '公网域名检查通过（<CHATDSH_PUBLIC_URL>/healthz 返回 ok:true）'
    else
      printf '%s\n' '提示：尚未通过公网对外地址访问到中继（若尚未配置域名解析或反向代理属正常现象）。'
      print_network_checklist "$public_url" "$bind_host" "$bind_port" 1
    fi
    print_redacted_join_hint "$work_dir" "$env_file"
  else
    printf '中继容器已就绪（对外来源：%s，本机绑定入口：http://%s:%s）\n' "$public_url" "$bind_host" "$bind_port"
    printf '手机端 PWA 入口：%s/\n' "$public_url"
    if check_public_health "${public_url}/healthz"; then
      printf '公网域名检查通过：%s/healthz\n' "$public_url"
    else
      printf '提示：尚未通过公网地址 %s/healthz 访问到中继（若尚未配置域名解析或反向代理属正常现象）。\n' "$public_url"
      print_network_checklist "$public_url" "$bind_host" "$bind_port" 0
    fi
    print_join_instructions "$work_dir" "$env_file" "$public_url" "$pairing_code"
  fi
}

main "$@"
