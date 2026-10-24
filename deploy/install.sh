#!/usr/bin/env bash
# MMBOT 离线部署辅助脚本：prepare（准备离线包）/ load（离线主机导入）/ config（重建配置）/ check（自检）。
# 完整步骤与背景见 deploy/README.zh.md。脚本幂等：重复执行不会重复破坏已有配置。
set -euo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SELF_DIR/.." && pwd)
ENV_FILE="$SELF_DIR/.env"
ENV_EXAMPLE="$SELF_DIR/.env.example"
OFFLINE_DIR="$SELF_DIR/offline"
IMAGES_DIR="$OFFLINE_DIR/images"
COMPOSE_FILE="$SELF_DIR/compose.offline.yml"

COMMAND=prepare
DRY_RUN=0
FORCE=0
SKIP_BUILD=0
INCLUDE_SECRETS=1
IMAGE_NAME=ds-bot

info() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
用法：deploy/install.sh [prepare|load|config|check] [选项]

命令：
  prepare   （默认）在联网/构建机上准备离线包：构建镜像、导出镜像 tar、生成配置与传输包
  load      在离线主机上导入镜像包、生成配置，并打印启动命令
  config    只根据 deploy/.env 重建配置（data/cordis.patch.yml 与目录），不动镜像
  check     运行部署自检（等价于 node deploy/check.mjs）

选项：
  --dry-run          只打印将要执行的动作：不写文件、不调用 docker、不联网
  --force            覆盖已存在的 data/cordis.patch.yml 与镜像包（.env 永不覆盖）
  --skip-build       不重新构建镜像，直接导出本机已有的镜像
  --without-secrets  打包时不包含 deploy/.env（密钥由目标机自行填写，更安全）
  --image NAME       镜像仓库名（默认 ds-bot，生成的 tag 为 NAME:local 与 NAME:<插件版本>）
  -h, --help         显示本帮助

示例：
  deploy/install.sh                          # 构建并准备离线包
  deploy/install.sh prepare --skip-build     # 复用已有镜像，只导出与打包
  deploy/install.sh --dry-run                # 预演，不做任何改动
  deploy/install.sh load                     # 在离线主机上导入
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    prepare|load|config|check) COMMAND=$1 ;;
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --without-secrets) INCLUDE_SECRETS=0 ;;
    --image)
      shift
      [ $# -gt 0 ] || { usage >&2; printf 'error: --image 需要一个参数\n' >&2; exit 2; }
      IMAGE_NAME=$1
      ;;
    --image=*) IMAGE_NAME=${1#*=} ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; printf 'error: 未知参数：%s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

# run 在 dry-run 下只回显；其余情况直接执行，失败由 set -e 终止。
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

require_docker() {
  if [ "$DRY_RUN" -eq 1 ]; then
    note "[dry-run] 检查 docker 与 docker compose v2"
    return 0
  fi
  command -v docker >/dev/null 2>&1 || die "找不到 docker，请先安装 Docker 24+"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 不可用（需要 Compose v2.24+）"
  docker info >/dev/null 2>&1 || die "Docker daemon 未运行"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "找不到 sha256sum 或 shasum，无法校验镜像包"
  fi
}

ensure_env() {
  if [ -f "$ENV_FILE" ]; then
    return 0
  fi
  [ -f "$ENV_EXAMPLE" ] || die "缺少 $ENV_EXAMPLE"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [dry-run] cp %s %s\n' "$ENV_EXAMPLE" "$ENV_FILE"
    return 0
  fi
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  note "已从 .env.example 生成 $ENV_FILE"
  warn "请先填写模型网关（MMBOT_GATEWAY_*）、模型（MMBOT_MODEL_*）与信任域（DSH_TRUSTED_HOST），再重新执行本脚本"
}

load_env() {
  [ -f "$ENV_FILE" ] || return 0
  # set -a 让 .env 里的变量同时导出给 docker build / docker compose。
  set -a
  # shellcheck disable=SC1090,SC1091
  . "$ENV_FILE"
  set +a
}

resolve_dir() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$SELF_DIR/${1#./}" ;;
  esac
}

configure_dirs() {
  DATA_DIR_ABS=$(resolve_dir "${DATA_DIR:-./data}")
  WORKSPACE_DIR_ABS=$(resolve_dir "${WORKSPACE_DIR:-./workspace}")
}

plugin_version() {
  local manifest="$REPO_ROOT/ds-bot/package.json"
  [ -f "$manifest" ] || die "缺少 ${manifest}；请在 MMBOT 仓库内运行本脚本"
  local version
  version=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([0-9][^"]*\)".*/\1/p' "$manifest" | head -n 1)
  printf '%s\n' "${version:-0.0.0}"
}

# 生成 DSH 的 home 层配置：让团队默认走 OpenAI 兼容网关，并让新建 Bot 落在同一模型上。
write_gateway_patch() {
  local target="$DATA_DIR_ABS/cordis.patch.yml"
  local base_url="${MMBOT_GATEWAY_BASE_URL:-}"
  local api_key="${MMBOT_GATEWAY_API_KEY:-}"
  local model_id="${MMBOT_MODEL_ID:-}"

  if [ -z "$base_url" ] || [ -z "$api_key" ] || [ -z "$model_id" ]; then
    warn "MMBOT_GATEWAY_BASE_URL / MMBOT_GATEWAY_API_KEY / MMBOT_MODEL_ID 未填全，跳过 $target"
    note "填好 $ENV_FILE 后执行：deploy/install.sh config"
    return 0
  fi

  if [ -f "$target" ] && [ "$FORCE" -eq 0 ]; then
    info "已存在 ${target}，保留不动（--force 覆盖，会先备份）"
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [dry-run] 写入 %s（网关 %s，模型 %s）\n' "$target" "$base_url" "$model_id"
    return 0
  fi

  mkdir -p "$DATA_DIR_ABS"
  if [ -f "$target" ]; then
    local backup
    backup="$target.bak.$(date +%Y%m%d%H%M%S)"
    cp "$target" "$backup"
    note "已备份旧配置到 $backup"
  fi
  cat > "$target" <<EOF
# 由 deploy/install.sh 生成，对应 deploy/.env 的模型网关设置。
# DSH 启动时读取本文件（home 层 patch）；改动后重启容器生效。
- id: llm-pi-ai
  config:
    providers:
      gateway:
        # 密钥只从容器环境变量读取，不写进本文件。
        apiKeyEnv: MMBOT_GATEWAY_API_KEY
        api: openai-completions
        baseURL: ${base_url}
        models:
          - id: ${model_id}
            name: ${MMBOT_MODEL_NAME:-$model_id}
            contextWindow: ${MMBOT_MODEL_CONTEXT_WINDOW:-131072}
            maxTokens: ${MMBOT_MODEL_MAX_TOKENS:-8192}
# 新建 Bot 的表单默认使用 DSH 默认模型；这里把默认模型也指到网关，避免新 Bot 落在无密钥的官方模型上。
- id: agent-default-model
  config:
    provider: gateway
    model: ${model_id}
EOF
  chmod 600 "$target"
  info "已写入 $target"
}

build_image() {
  if [ "$SKIP_BUILD" -eq 1 ]; then
    info "跳过构建（--skip-build）"
    return 0
  fi
  [ -f "$REPO_ROOT/docker/Dockerfile" ] || die "缺少 docker/Dockerfile；请在 MMBOT 仓库内运行本脚本"
  info "构建镜像 $IMAGE_LOCAL 与 ${IMAGE_VERSIONED}（这一步需要能访问 npm 源与 Docker 基础镜像）"
  run docker build \
    -f "$REPO_ROOT/docker/Dockerfile" \
    -t "$IMAGE_LOCAL" \
    -t "$IMAGE_VERSIONED" \
    --build-arg "NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org/}" \
    --build-arg "DSH_VERSION=${DSH_VERSION:-0.2.0-rc.2}" \
    "$REPO_ROOT"
}

save_image() {
  local archive="$IMAGES_DIR/${IMAGE_NAME}-${PLUGIN_VERSION}.tar.gz"

  if [ -f "$archive" ] && [ "$FORCE" -eq 0 ]; then
    info "已存在离线镜像包 $(basename "$archive")，跳过导出（--force 重新导出）"
    return 0
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [dry-run] mkdir -p %s\n' "$IMAGES_DIR"
    printf '    [dry-run] docker save -o %s %s %s\n' "$archive.tmp" "$IMAGE_LOCAL" "$IMAGE_VERSIONED"
    printf '    [dry-run] gzip -c %s > %s\n' "$archive.tmp" "$archive"
    printf '    [dry-run] 写入 %s/SHA256SUMS\n' "$IMAGES_DIR"
    return 0
  fi

  mkdir -p "$IMAGES_DIR"
  info "导出镜像到 ${archive}（约 1–2 GB，视构建产物而定）"
  docker save -o "$archive.tmp" "$IMAGE_LOCAL" "$IMAGE_VERSIONED"
  gzip -c "$archive.tmp" > "$archive"
  rm -f "$archive.tmp"

  local hash
  hash=$(sha256_of "$archive")
  printf '%s  %s\n' "$hash" "$(basename "$archive")" > "$IMAGES_DIR/SHA256SUMS"
  info "镜像包 SHA-256：$hash"
}

make_bundle() {
  local bundle="$OFFLINE_DIR/mmbot-offline-${PLUGIN_VERSION}.tar"
  [ -f "$IMAGES_DIR/SHA256SUMS" ] || warn "没有镜像包，离线包会不完整；请先不带 --skip-build 执行 prepare"

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [dry-run] tar cf <临时文件> -C %s --exclude=deploy/data --exclude=deploy/workspace --exclude=deploy/offline/mmbot-offline-* deploy\n' "$REPO_ROOT"
    printf '    [dry-run] mv <临时文件> %s\n' "$bundle"
    return 0
  fi

  mkdir -p "$OFFLINE_DIR"
  # 写到仓库外再移入，避免 tar 把自己正在写的包打进去。
  local tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/mmbot-offline.XXXXXX")
  info "打包离线传输包（含 deploy/、镜像包与配置）"
  if [ "$INCLUDE_SECRETS" -eq 0 ]; then
    tar cf "$tmp" -C "$REPO_ROOT" \
      --exclude=deploy/data \
      --exclude=deploy/workspace \
      --exclude='deploy/offline/mmbot-offline-*' \
      --exclude=deploy/.env \
      deploy
  else
    tar cf "$tmp" -C "$REPO_ROOT" \
      --exclude=deploy/data \
      --exclude=deploy/workspace \
      --exclude='deploy/offline/mmbot-offline-*' \
      deploy
  fi
  mv "$tmp" "$bundle"
  info "离线包：$bundle"
  if [ "$INCLUDE_SECRETS" -eq 1 ]; then
    warn "离线包里包含 deploy/.env（含网关密钥），请用加密介质传输；需要更严格时用 --without-secrets"
  fi
}

verify_archive() {
  local archive=$1
  local expected actual
  local sums="$IMAGES_DIR/SHA256SUMS"
  [ -f "$sums" ] || { warn "没有 ${sums}，跳过校验"; return 0; }
  expected=$(awk -v name="$(basename "$archive")" '$2 == name { print $1 }' "$sums")
  [ -n "$expected" ] || { warn "$sums 里没有 $(basename "$archive") 的记录，跳过校验"; return 0; }
  actual=$(sha256_of "$archive")
  [ "$expected" = "$actual" ] || die "$(basename "$archive") 校验失败：期望 ${expected}，实际 $actual"
  note "校验通过：$(basename "$archive")"
}

print_prepare_next_steps() {
  cat <<EOF

下一步：

  1) 把离线包拷到离线主机（USB / 内网文件服务器 / 堡垒机均可）：
       $OFFLINE_DIR/mmbot-offline-${PLUGIN_VERSION}.tar

  2) 在离线主机解包并导入镜像与配置：
       tar xf mmbot-offline-${PLUGIN_VERSION}.tar
       ./deploy/install.sh load

  3) 启动服务（通常在离线主机的 MMBOT 仓库目录或解包目录执行）：
       docker compose -f deploy/compose.offline.yml --env-file deploy/.env up -d

  4) 自检：
       node deploy/check.mjs

EOF
}

print_load_next_steps() {
  cat <<EOF

下一步：

  1) 启动服务：
       docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

  2) 看启动日志并取首次登录链接（含 ?token=...）：
       docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs -f ds-bot | grep -m1 'dsh web:'

  3) 在浏览器打开该链接一次完成登录。用 deploy/.env 的 DSH_TRUSTED_HOST 里的域名/IP 打开，
     否则接口会返回 403。

  4) 自检：
       node "$SELF_DIR/check.mjs"

  需要 HTTPS + 反向代理时：
       mkdir -p deploy/proxy/tls && cp <fullchain.pem> <privkey.pem> deploy/proxy/tls/
       docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" --profile proxy up -d

EOF
}

command_prepare() {
  info "MMBOT 离线包准备（插件版本 ${PLUGIN_VERSION}）"
  require_docker
  ensure_env
  load_env
  configure_dirs
  build_image
  save_image
  write_gateway_patch
  run mkdir -p "$WORKSPACE_DIR_ABS"
  make_bundle
  print_prepare_next_steps
}

command_load() {
  info "MMBOT 离线镜像导入（插件版本 ${PLUGIN_VERSION}）"
  require_docker
  ensure_env
  load_env
  configure_dirs

  local found=0 archive
  if [ -d "$IMAGES_DIR" ]; then
    for archive in "$IMAGES_DIR"/*.tar.gz; do
      [ -e "$archive" ] || continue
      found=1
      if [ "$DRY_RUN" -eq 0 ]; then
        verify_archive "$archive"
      else
        printf '    [dry-run] 校验 %s\n' "$(basename "$archive")"
      fi
      info "导入 $(basename "$archive")"
      run docker load -i "$archive"
    done
  fi

  if [ "$found" -eq 0 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '    [dry-run] 在 %s 下查找 *.tar.gz\n' "$IMAGES_DIR"
    else
      die "$IMAGES_DIR 下没有镜像包；请把部署包里的 deploy/offline/images 一起拷过来"
    fi
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [dry-run] docker image inspect %s\n' "${MMBOT_IMAGE:-ds-bot:local}"
  else
    docker image inspect "${MMBOT_IMAGE:-ds-bot:local}" >/dev/null 2>&1 \
      || die "镜像 ${MMBOT_IMAGE:-ds-bot:local} 未导入；确认 deploy/.env 的 MMBOT_IMAGE 与镜像 tag 一致"
  fi
  write_gateway_patch
  run mkdir -p "$WORKSPACE_DIR_ABS"
  print_load_next_steps
}

command_config() {
  info "按 deploy/.env 重建配置"
  ensure_env
  load_env
  configure_dirs
  write_gateway_patch
  run mkdir -p "$WORKSPACE_DIR_ABS"
  note "重启容器让配置生效：docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d"
}

command_check() {
  command -v node >/dev/null 2>&1 || die "找不到 node（需要 Node.js 18+）才能运行自检"
  if [ "$DRY_RUN" -eq 1 ]; then
    run node "$SELF_DIR/check.mjs" --dry-run
  else
    node "$SELF_DIR/check.mjs"
  fi
}

PLUGIN_VERSION=$(plugin_version)
IMAGE_LOCAL="${IMAGE_NAME}:local"
IMAGE_VERSIONED="${IMAGE_NAME}:${PLUGIN_VERSION}"

case "$COMMAND" in
  prepare) command_prepare ;;
  load) command_load ;;
  config) command_config ;;
  check) command_check ;;
  *) die "未知命令：$COMMAND" ;;
esac
