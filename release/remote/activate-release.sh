#!/usr/bin/env bash
# 服务器侧原子激活：flock 串行化、版本化 compose/env、失败时恢复上一完整 release。
set -euo pipefail

ROOT="${1:?root required}"
RELEASE_DIR="${2:?release dir required}"
IMAGE_TAG="${3:?image tag required}"
SNAPSHOT_DIR="${4:?snapshot dir required}"
LARK_DIR="${5:?lark dir required}"
CURRENT_LINK="${ROOT}/current-release"
LOCK_FILE="${ROOT}/deploy.lock"
COMPOSE_FILE="${RELEASE_DIR}/docker-compose.yml"
DEPLOYMENT_ENV="${RELEASE_DIR}/deployment.env"
HEALTH_ATTEMPTS="${ZA_DEPLOY_HEALTH_ATTEMPTS:-15}"
HEALTH_DELAY="${ZA_DEPLOY_HEALTH_DELAY:-2}"

exec 9>"${LOCK_FILE}"
flock -n 9 || { echo '已有部署正在执行，拒绝并发切换' >&2; exit 3; }

[[ -f "${COMPOSE_FILE}" ]] || { echo "缺 compose：${COMPOSE_FILE}" >&2; exit 1; }
[[ -d "${SNAPSHOT_DIR}" ]] || { echo "缺快照：${SNAPSHOT_DIR}" >&2; exit 1; }
LEGACY_RELEASE=0
if [[ -f "${DEPLOYMENT_ENV}" ]] && grep -qx 'ZA_RELEASE_LEGACY=1' "${DEPLOYMENT_ENV}"; then
  LEGACY_RELEASE=1
fi
[[ "${LEGACY_RELEASE}" == 1 || -f "${SNAPSHOT_DIR}/system-prompt.md" ]] || { echo '快照缺 system-prompt.md' >&2; exit 1; }
install -d -m 700 -o 1000 -g 1000 "${LARK_DIR}"
install -d -m 700 -o 1000 -g 1000 "${ROOT}/data/za"

OLD_RELEASE=""
if [[ -L "${CURRENT_LINK}" ]]; then
  OLD_RELEASE="$(readlink -f "${CURRENT_LINK}")"
fi

tmp_env="${DEPLOYMENT_ENV}.tmp.$$"
printf '%s\n' \
  "ZA_IMAGE_TAG=${IMAGE_TAG}" \
  "ZA_SNAPSHOT_HOST_DIR=${SNAPSHOT_DIR}" \
  "ZA_LARK_CONFIG_HOST_DIR=${LARK_DIR}" >"${tmp_env}"
if [[ "${LEGACY_RELEASE}" == 1 ]]; then
  printf '%s\n' 'ZA_RELEASE_LEGACY=1' >>"${tmp_env}"
fi
chmod 600 "${tmp_env}"
mv -f "${tmp_env}" "${DEPLOYMENT_ENV}"

compose() {
  local release_dir="$1"
  docker compose -p zen-agent -f "${release_dir}/docker-compose.yml" \
    --env-file "${release_dir}/deployment.env" "${@:2}"
}

validate_release() {
  local release_dir="$1"
  local expected_image="$2"
  local expected_snapshot="$3"
  local ready=0
  local cid replicas actual_image actual_snapshot

  for _ in $(seq 1 "${HEALTH_ATTEMPTS}"); do
    if curl -fsS --max-time 3 http://127.0.0.1:9010/healthz >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep "${HEALTH_DELAY}"
  done
  [[ "${ready}" == 1 ]] || { echo '容器 healthz 未就绪' >&2; return 1; }

  replicas="$(compose "${release_dir}" ps -q zen-agent | sed '/^$/d' | wc -l | tr -d ' ')"
  [[ "${replicas}" == 1 ]] || { echo "生产副本数异常：${replicas}" >&2; return 1; }
  cid="$(compose "${release_dir}" ps -q zen-agent)"
  actual_image="$(docker inspect --format '{{.Config.Image}}' "${cid}")"
  [[ "${actual_image}" == "${expected_image}" ]] || { echo '活动镜像与 release 不一致' >&2; return 1; }
  actual_snapshot="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/snapshot"}}{{.Source}}{{end}}{{end}}' "${cid}")"
  [[ "${actual_snapshot}" == "${expected_snapshot}" ]] || { echo '活动快照与 release 不一致' >&2; return 1; }

  # 审计/会话为 fail-open，单看 health 无法发现 bind 目录不可写；实际写读删一个无敏感探针。
  compose "${release_dir}" exec -T zen-agent sh -eu -c '
    probe="/data/za/.release-write-probe-$$"
    umask 077
    printf ok >"${probe}"
    test "$(cat "${probe}")" = ok
    rm -f "${probe}"
  ' || { echo '持久数据卷不可写' >&2; return 1; }
  if ! grep -qx 'ZA_RELEASE_LEGACY=1' "${release_dir}/deployment.env"; then
    compose "${release_dir}" exec -T zen-agent lark-cli --version >/dev/null || {
      echo 'lark-cli 不可执行' >&2
      return 1
    }
    # 只有三项卡密配置同时存在时才要求 general（或显式 profile）可读、可刷新。
    compose "${release_dir}" exec -T zen-agent sh -eu -c '
      if [ -n "${ZA_FEISHU_CARD_BASE_TOKEN:-}" ] && [ -n "${ZA_FEISHU_CARD_TABLE_ID:-}" ] && [ -n "${ZA_FULFILLMENT_GUIDE_URL:-}" ]; then
        umask 077
        lark-cli --profile "${ZA_FEISHU_PROFILE:-general}" whoami >/dev/null
      fi
    ' || { echo '飞书 profile smoke 失败' >&2; return 1; }
  fi
}

rollback() {
  if [[ -n "${OLD_RELEASE}" && -f "${OLD_RELEASE}/deployment.env" && -f "${OLD_RELEASE}/docker-compose.yml" ]]; then
    local old_tag old_snapshot
    old_tag="$(sed -n 's/^ZA_IMAGE_TAG=//p' "${OLD_RELEASE}/deployment.env")"
    old_snapshot="$(sed -n 's/^ZA_SNAPSHOT_HOST_DIR=//p' "${OLD_RELEASE}/deployment.env")"
    echo "激活失败，恢复上一 release：${OLD_RELEASE}" >&2
    compose "${OLD_RELEASE}" up -d || return 1
    validate_release "${OLD_RELEASE}" "zen-agent-server:${old_tag}" "${old_snapshot}" || return 1
    ln -sfn "${OLD_RELEASE}" "${CURRENT_LINK}.next"
    mv -Tf "${CURRENT_LINK}.next" "${CURRENT_LINK}"
    return 0
  fi

  echo '首次激活失败：停止新服务并保持无活动 release' >&2
  compose "${RELEASE_DIR}" down >/dev/null 2>&1 || return 1
  rm -f "${CURRENT_LINK}"
}

activation_status=0
compose "${RELEASE_DIR}" up -d || activation_status=$?
if [[ "${activation_status}" == 0 ]]; then
  validate_release "${RELEASE_DIR}" "zen-agent-server:${IMAGE_TAG}" "${SNAPSHOT_DIR}" || activation_status=$?
fi
if [[ "${activation_status}" == 0 ]]; then
  if ! ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}.next" || ! mv -Tf "${CURRENT_LINK}.next" "${CURRENT_LINK}"; then
    echo 'current-release 原子切换失败' >&2
    activation_status=1
  fi
fi
if [[ "${activation_status}" != 0 ]]; then
  if ! rollback; then
    echo '严重：新 release 失败且回滚验证失败，需要人工介入' >&2
    exit 2
  fi
  exit "${activation_status}"
fi
echo "已激活 ${RELEASE_DIR}"
