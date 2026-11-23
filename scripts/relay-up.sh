#!/usr/bin/env bash
# 中继服务端 Docker Compose 引导与启动脚本。
#
# 首次运行时通过命令行询问对外域名（必填）并规范化为精确 origin 写入 `.env`；
# 检查是否已设置 `CHATDSH_PAIRING_CODE`，缺失时自动生成随机口令并持久化保存，
# 后续再次运行直接复用已保存的口令与配置，然后通过 Docker Compose 启动中继容器。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_ENV_FILE="${REPO_ROOT}/.env"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"

print_help() {
  cat <<'EOF'
用法：bash scripts/relay-up.sh [选项]

选项：
  --domain <域名或 origin>  指定对外访问域名（未指定且 .env 未保存时会通过命令行询问，必填）
  --reconfigure             重新询问并更新对外域名（已保存的配对口令保持复用）
  --print-join-command      打印设备一行接入命令（读取已保存的 .env，不重启容器）
  --config <路径>           指定环境变量文件路径（默认仓库根目录 .env）
  --no-build                跳过镜像重新构建，直接启动容器
  --prepare-only            仅检查/生成并保存 .env，不启动 Docker Compose
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

  # 去掉末尾连续斜杠后再校验是否存在路径、查询参数、片段或凭据
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

  # 默认端口按浏览器 URL.origin 规则省略
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
    printf '%s\n' '# ChatDSH 中继服务端运行配置（由 scripts/relay-up.sh 维护，请勿提交到版本库）' >> "$tmp"
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
  local interactive=0
  [ -t 0 ] && interactive=1
  while true; do
    printf '%s' '请输入中继服务端对外域名（必填，例如 relay.example.com 或 https://relay.example.com）: ' >&2
    local answer=""
    if ! IFS= read -r answer; then
      printf '\n%s\n' '未收到中继域名输入，域名为必填项' >&2
      return 1
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

build_device_join_command() {
  local public_url="$1"
  local pairing_code="$2"
  printf 'bash scripts/device-join.sh --relay %s --code %s' \
    "$(shell_quote "$public_url")" \
    "$(shell_quote "$pairing_code")"
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

print_network_checklist() {
  local public_url="$1"
  local probe_host="$2"
  local bind_port="$3"
  local domain_host
  domain_host="$(extract_host_from_origin "$public_url")"

  printf '\n'
  printf '%s\n' '公网接入前置提醒（中继容器仅监听本机 HTTP 端口，TLS 与域名路由由前置反向代理/网关承担）：'
  printf '  1. 域名解析：将 %s 的 A / AAAA（或 CNAME）记录解析到当前服务器公网 IP。\n' "$domain_host"
  printf '  2. 反向代理：在 Nginx / Caddy / 网关中为 %s 配置 HTTPS，并转发到 http://%s:%s。\n' "$public_url" "$probe_host" "$bind_port"
  printf '%s\n' '     转发规则需开启 WebSocket 升级（Upgrade / Connection）并关闭响应缓冲（proxy_buffering off），'
  printf '%s\n' '     以确保 /chatdsh/gateway/device-link、/d/<deviceId>/api/remote.mux 与 /chatdsh/gateway/events 长连接正常。'
  printf '  3. 验证公网连通：curl -fsS %s/healthz（返回 ok:true 后再在设备端执行接入命令）。\n' "$public_url"
}

print_join_instructions() {
  local env_file="$1"
  local public_url="$2"
  local pairing_code="$3"
  local join_cmd
  join_cmd="$(build_device_join_command "$public_url" "$pairing_code")"
  local config_arg=""
  if [ "$env_file" != "$DEFAULT_ENV_FILE" ]; then
    config_arg=" --config $(shell_quote "$env_file")"
  fi
  printf '\n'
  printf '%s\n' '在需要接入的设备上执行以下一行命令（自动安装插件、配对连接中继并启动 DSH）：'
  printf '  %s\n' "$join_cmd"
  printf '\n'
  printf '%s\n' '后续如需再次打印该命令，在中继宿主机执行：'
  printf '  bash scripts/relay-up.sh --print-join-command%s\n' "$config_arg"
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

main() {
  local env_file="$DEFAULT_ENV_FILE"
  local domain_arg=""
  local has_domain_arg=0
  local reconfigure=0
  local prepare_only=0
  local print_join_only=0
  local no_build=0

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help)
        print_help
        return 0
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
      --no-build)
        no_build=1
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

  if [ "$print_join_only" -eq 1 ]; then
    if [ ! -f "$env_file" ]; then
      printf '未找到配置文件 %s，请先执行 bash scripts/relay-up.sh 初始化并启动中继服务端\n' "$env_file" >&2
      return 1
    fi
    local saved_url
    local saved_code
    saved_url="$(read_env_value "$env_file" CHATDSH_PUBLIC_URL)"
    saved_code="$(read_env_value "$env_file" CHATDSH_PAIRING_CODE)"
    if [ -z "$saved_url" ] || [ -z "$saved_code" ]; then
      printf '%s 缺少 CHATDSH_PUBLIC_URL 或 CHATDSH_PAIRING_CODE，请先执行 bash scripts/relay-up.sh\n' "$env_file" >&2
      return 1
    fi
    local normalized_saved_url
    normalized_saved_url="$(normalize_public_url "$saved_url")"
    print_join_instructions "$env_file" "$normalized_saved_url" "$saved_code"
    return 0
  fi

  local existing_url=""
  local existing_code=""
  local existing_bind_host=""
  local existing_bind_port=""
  if [ -f "$env_file" ]; then
    existing_url="$(read_env_value "$env_file" CHATDSH_PUBLIC_URL)"
    existing_code="$(read_env_value "$env_file" CHATDSH_PAIRING_CODE)"
    existing_bind_host="$(read_env_value "$env_file" CHATDSH_GATEWAY_BIND_HOST)"
    existing_bind_port="$(read_env_value "$env_file" CHATDSH_GATEWAY_BIND_PORT)"
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
  if [ -n "$existing_code" ]; then
    pairing_code="$existing_code"
  elif [ -n "$env_code" ]; then
    pairing_code="$env_code"
  else
    pairing_code="$(generate_pairing_code)"
    pairing_generated=1
  fi

  local bind_host
  bind_host="$(trim "${CHATDSH_GATEWAY_BIND_HOST:-${existing_bind_host:-127.0.0.1}}")"
  [ -n "$bind_host" ] || bind_host="127.0.0.1"
  local bind_port
  bind_port="$(trim "${CHATDSH_GATEWAY_BIND_PORT:-${existing_bind_port:-3170}}")"
  [ -n "$bind_port" ] || bind_port="3170"

  local updates=()
  if [ ! -f "$env_file" ] || [ "$existing_url" != "$public_url" ]; then
    updates+=("CHATDSH_PUBLIC_URL=${public_url}")
  fi
  if [ ! -f "$env_file" ] || [ "$existing_code" != "$pairing_code" ]; then
    updates+=("CHATDSH_PAIRING_CODE=${pairing_code}")
  fi
  if ! has_env_key "$env_file" CHATDSH_GATEWAY_BIND_HOST; then
    updates+=("CHATDSH_GATEWAY_BIND_HOST=${bind_host}")
  fi
  if ! has_env_key "$env_file" CHATDSH_GATEWAY_BIND_PORT; then
    updates+=("CHATDSH_GATEWAY_BIND_PORT=${bind_port}")
  fi

  if [ "${#updates[@]}" -gt 0 ]; then
    upsert_env_file "$env_file" "${updates[@]}"
  fi

  if [ "$pairing_generated" -eq 1 ]; then
    printf '已自动生成随机配对口令并保存到 %s（权限 0600，下次运行自动复用）。\n' "$env_file"
  else
    printf '复用已保存的配对口令（来源：%s）。\n' "$env_file"
  fi
  printf '中继对外地址：%s\n' "$public_url"

  if [ "$prepare_only" -eq 1 ]; then
    local probe_host_prep="$bind_host"
    if [ "$probe_host_prep" = "0.0.0.0" ] || [ "$probe_host_prep" = "::" ]; then
      probe_host_prep="127.0.0.1"
    fi
    print_network_checklist "$public_url" "$probe_host_prep" "$bind_port"
    print_join_instructions "$env_file" "$public_url" "$pairing_code"
    return 0
  fi

  local compose_args=(compose --env-file "$env_file" -f "$COMPOSE_FILE" up -d)
  if [ "$no_build" -eq 0 ]; then
    compose_args+=(--build)
  fi
  (cd "$REPO_ROOT" && docker "${compose_args[@]}")

  local probe_host="$bind_host"
  if [ "$probe_host" = "0.0.0.0" ] || [ "$probe_host" = "::" ]; then
    probe_host="127.0.0.1"
  fi
  local health_url="http://${probe_host}:${bind_port}/healthz"
  wait_for_health "$health_url" >/dev/null
  printf '中继容器已就绪（对外来源：%s，本机回环入口：http://%s:%s）\n' "$public_url" "$probe_host" "$bind_port"
  printf '手机端 PWA 入口：%s/\n' "$public_url"
  if check_public_health "${public_url}/healthz"; then
    printf '公网域名检查通过：%s/healthz\n' "$public_url"
  else
    printf '提示：尚未通过公网地址 %s/healthz 访问到中继（若尚未配置域名解析或反向代理属正常现象）。\n' "$public_url"
    print_network_checklist "$public_url" "$probe_host" "$bind_port"
  fi
  print_join_instructions "$env_file" "$public_url" "$pairing_code"
}

main "$@"
