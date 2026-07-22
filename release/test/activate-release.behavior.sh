#!/usr/bin/env bash
# 用 fake docker/curl 验证远端激活脚本的关键失败路径；应在 Linux/root 容器内执行。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUBJECT="${REPO_ROOT}/release/remote/activate-release.sh"
command -v flock >/dev/null || { echo '本测试必须在含 flock 的 Linux 发布镜像中运行' >&2; exit 1; }
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "${TEST_ROOT}"' EXIT
MOCK_BIN="${TEST_ROOT}/bin"
mkdir -p "${MOCK_BIN}"

cat >"${MOCK_BIN}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${MOCK_STATE:?}"
if [[ "${1:-}" == inspect ]]; then
  format="${3:-}"
  if [[ "${format}" == *Config.Image* ]]; then cat "${state}/image"; else cat "${state}/snapshot"; fi
  exit 0
fi
[[ "${1:-}" == compose ]] || exit 99
shift
env_file=''
compose_file=''
while (($#)); do
  case "$1" in
    --env-file) env_file="$2"; shift 2 ;;
    -p) shift 2 ;;
    -f) compose_file="$2"; shift 2 ;;
    up|down|ps|exec) op="$1"; shift; break ;;
    *) shift ;;
  esac
done
tag="$(sed -n 's/^ZA_IMAGE_TAG=//p' "${env_file}")"
snapshot="$(sed -n 's/^ZA_SNAPSHOT_HOST_DIR=//p' "${env_file}")"
if [[ "${tag}" == old ]] && ! grep -qx 'legacy-compose' "${compose_file}"; then
  printf 'wrong-old-compose\n' >>"${state}/operations"
  exit 88
fi
case "${op}" in
  up)
    printf 'up:%s\n' "${tag}" >>"${state}/operations"
    if [[ "${MOCK_FAIL_KIND:-}" == rollback && "${tag}" == old ]]; then exit 1; fi
    printf 'zen-agent-server:%s\n' "${tag}" >"${state}/image"
    printf '%s\n' "${snapshot}" >"${state}/snapshot"
    ;;
  down) printf 'down:%s\n' "${tag}" >>"${state}/operations"; : >"${state}/image"; : >"${state}/snapshot" ;;
  ps)
    if [[ "${MOCK_FAIL_KIND:-}" == replica && "${tag}" == new ]]; then
      printf 'ps:new:2\n' >>"${state}/operations"
      printf 'cid-new\ncid-extra\n'
    else
      printf 'ps:%s:1\n' "${tag}" >>"${state}/operations"
      printf 'cid-%s\n' "${tag}"
    fi
    ;;
  exec)
    joined="$*"
    if [[ "${joined}" == *release-write-probe* ]]; then
      printf 'data:%s:ok\n' "${tag}" >>"${state}/operations"
    elif [[ "${joined}" =~ lark-cli[[:space:]]+--version ]]; then
      if [[ "${MOCK_FAIL_KIND:-}" == lark && "${tag}" == new ]]; then
        printf 'lark:new:fail\n' >>"${state}/operations"
        exit 1
      fi
      printf 'lark:%s:ok\n' "${tag}" >>"${state}/operations"
    elif [[ "${joined}" == *ZA_FEISHU_CARD_BASE_TOKEN* ]]; then
      if [[ "${MOCK_CARD_ENABLED:-0}" == 1 ]]; then
        if [[ "${MOCK_FAIL_KIND:-}" == whoami && "${tag}" == new ]]; then
          printf 'whoami:new:fail\n' >>"${state}/operations"
          exit 1
        fi
        printf 'whoami:%s:ok\n' "${tag}" >>"${state}/operations"
      else
        printf 'whoami:%s:skipped\n' "${tag}" >>"${state}/operations"
      fi
    else
      printf 'exec:%s:ok\n' "${tag}" >>"${state}/operations"
    fi
    ;;
esac
EOF
chmod +x "${MOCK_BIN}/docker"

cat >"${MOCK_BIN}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
image="$(cat "${MOCK_STATE:?}/image" 2>/dev/null || true)"
tag="${image#zen-agent-server:}"
if [[ "${MOCK_FAIL_KIND:-}" == health && "${tag}" == new ]]; then
  printf 'health:new:fail\n' >>"${MOCK_STATE}/operations"
  exit 1
fi
printf 'health:%s:ok\n' "${tag}" >>"${MOCK_STATE}/operations"
exit 0
EOF
chmod +x "${MOCK_BIN}/curl"

cat >"${MOCK_BIN}/ln" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${MOCK_FAIL_KIND:-}" == link-create && "${*: -1}" == */current-release.next && ! -e "${MOCK_STATE:?}/link-create-failed" ]]; then
  : >"${MOCK_STATE}/link-create-failed"
  exit 1
fi
exec /bin/ln "$@"
EOF
chmod +x "${MOCK_BIN}/ln"

cat >"${MOCK_BIN}/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${MOCK_FAIL_KIND:-}" == link-move && "$*" == *current-release.next*current-release* && ! -e "${MOCK_STATE:?}/link-move-failed" ]]; then
  : >"${MOCK_STATE}/link-move-failed"
  exit 1
fi
exec /bin/mv "$@"
EOF
chmod +x "${MOCK_BIN}/mv"

make_release() {
  local root="$1" name="$2" tag="$3"
  mkdir -p "${root}/releases/${name}" "${root}/snapshots/${name}"
  if [[ "${name}" == old ]]; then
    printf 'legacy-compose\n' >"${root}/releases/${name}/docker-compose.yml"
  else
    printf 'new-compose\n' >"${root}/releases/${name}/docker-compose.yml"
  fi
  : >"${root}/snapshots/${name}/system-prompt.md"
  printf 'ZA_IMAGE_TAG=%s\nZA_SNAPSHOT_HOST_DIR=%s\nZA_LARK_CONFIG_HOST_DIR=%s\n' \
    "${tag}" "${root}/snapshots/${name}" "${root}/lark-cli" >"${root}/releases/${name}/deployment.env"
  if [[ "${tag}" == old ]]; then
    printf '%s\n' 'ZA_RELEASE_LEGACY=1' >>"${root}/releases/${name}/deployment.env"
  fi
}

run_case() {
  local kind="$1"
  local root="${TEST_ROOT}/${kind}"
  local state="${root}/state"
  mkdir -p "${state}"
  make_release "${root}" old old
  make_release "${root}" new new
  # 旧镜像的 prompt 烤在镜像内；旧快照没有 system-prompt.md 仍必须可回滚。
  rm "${root}/snapshots/old/system-prompt.md"
  ln -s "${root}/releases/old" "${root}/current-release"
  printf 'zen-agent-server:old\n' >"${state}/image"
  printf '%s\n' "${root}/snapshots/old" >"${state}/snapshot"
  card_enabled=0
  [[ "${kind}" == whoami ]] && card_enabled=1
  if PATH="${MOCK_BIN}:${PATH}" MOCK_STATE="${state}" MOCK_FAIL_KIND="${kind}" MOCK_CARD_ENABLED="${card_enabled}" \
    ZA_DEPLOY_HEALTH_ATTEMPTS=1 ZA_DEPLOY_HEALTH_DELAY=0 \
    bash "${SUBJECT}" "${root}" "${root}/releases/new" new "${root}/snapshots/new" "${root}/lark-cli"; then
    echo "${kind} 场景应失败却成功" >&2
    cat "${state}/operations" >&2
    exit 1
  fi
  [[ "$(readlink -f "${root}/current-release")" == "${root}/releases/old" ]]
  [[ "$(cat "${state}/image")" == 'zen-agent-server:old' ]]
  [[ "$(cat "${state}/snapshot")" == "${root}/snapshots/old" ]]
  grep -qx 'up:new' "${state}/operations"
  grep -qx 'up:old' "${state}/operations"
  grep -qx 'health:old:ok' "${state}/operations"
  grep -qx 'ps:old:1' "${state}/operations"
  grep -qx 'data:old:ok' "${state}/operations"
  case "${kind}" in
    health) grep -qx 'health:new:fail' "${state}/operations" ;;
    replica) grep -qx 'ps:new:2' "${state}/operations" ;;
    lark) grep -qx 'lark:new:fail' "${state}/operations" ;;
    whoami) grep -qx 'whoami:new:fail' "${state}/operations" ;;
  esac
}

for kind in health replica lark whoami link-create link-move; do run_case "${kind}"; done

# 卡密未配置时 whoami 必须明确跳过，不能把未授权 profile 误判为发布失败。
success_root="${TEST_ROOT}/success-unconfigured"
success_state="${success_root}/state"
mkdir -p "${success_state}"
make_release "${success_root}" new new
PATH="${MOCK_BIN}:${PATH}" MOCK_STATE="${success_state}" MOCK_CARD_ENABLED=0 \
  ZA_DEPLOY_HEALTH_ATTEMPTS=1 ZA_DEPLOY_HEALTH_DELAY=0 \
  bash "${SUBJECT}" "${success_root}" "${success_root}/releases/new" new \
    "${success_root}/snapshots/new" "${success_root}/lark-cli"
grep -qx 'whoami:new:skipped' "${success_state}/operations"
[[ "$(readlink -f "${success_root}/current-release")" == "${success_root}/releases/new" ]]

# 显式 legacy descriptor 可作为人工回滚目标：允许旧快照无外置 prompt，且不要求后来才加入的 lark-cli。
legacy_root="${TEST_ROOT}/legacy-target"
legacy_state="${legacy_root}/state"
mkdir -p "${legacy_state}"
make_release "${legacy_root}" old old
make_release "${legacy_root}" new new
rm "${legacy_root}/snapshots/old/system-prompt.md"
ln -s "${legacy_root}/releases/new" "${legacy_root}/current-release"
printf 'zen-agent-server:new\n' >"${legacy_state}/image"
printf '%s\n' "${legacy_root}/snapshots/new" >"${legacy_state}/snapshot"
PATH="${MOCK_BIN}:${PATH}" MOCK_STATE="${legacy_state}" \
  ZA_DEPLOY_HEALTH_ATTEMPTS=1 ZA_DEPLOY_HEALTH_DELAY=0 \
  bash "${SUBJECT}" "${legacy_root}" "${legacy_root}/releases/old" old \
    "${legacy_root}/snapshots/old" "${legacy_root}/lark-cli"
[[ "$(readlink -f "${legacy_root}/current-release")" == "${legacy_root}/releases/old" ]]
if grep -q '^lark:old:' "${legacy_state}/operations"; then
  echo 'legacy target 不应要求后来才加入的 lark-cli' >&2
  exit 1
fi

# 首次激活失败必须清理新服务且不创建 current-release。
first_root="${TEST_ROOT}/first"
first_state="${first_root}/state"
mkdir -p "${first_state}"
make_release "${first_root}" new new
if PATH="${MOCK_BIN}:${PATH}" MOCK_STATE="${first_state}" MOCK_FAIL_KIND=health \
  ZA_DEPLOY_HEALTH_ATTEMPTS=1 ZA_DEPLOY_HEALTH_DELAY=0 \
  bash "${SUBJECT}" "${first_root}" "${first_root}/releases/new" new "${first_root}/snapshots/new" "${first_root}/lark-cli"; then
  echo '首次失败场景应失败却成功' >&2
  exit 1
fi
[[ ! -e "${first_root}/current-release" ]]
[[ ! -s "${first_state}/image" ]]
grep -qx 'up:new' "${first_state}/operations"
grep -qx 'health:new:fail' "${first_state}/operations"
grep -qx 'down:new' "${first_state}/operations"

# legacy 登记与激活共用 deploy.lock，并以 CAS 保留先到的 current-release。
register_root="${TEST_ROOT}/register"
register_state="${register_root}/state"
mkdir -p "${register_state}"
make_release "${register_root}" first old
make_release "${register_root}" stale old
printf 'legacy-compose\n' >"${register_root}/releases/first/docker-compose.yml"
printf 'legacy-compose\n' >"${register_root}/releases/stale/docker-compose.yml"
printf 'zen-agent-server:old\n' >"${register_state}/image"
printf '%s\n' "${register_root}/snapshots/first" >"${register_state}/snapshot"
PATH="${MOCK_BIN}:${PATH}" MOCK_STATE="${register_state}" \
  bash "${REPO_ROOT}/release/remote/register-legacy-release.sh" "${register_root}" \
    "${register_root}/releases/first" cid-old zen-agent-server:old "${register_root}/snapshots/first"
PATH="${MOCK_BIN}:${PATH}" MOCK_STATE="${register_state}" \
  bash "${REPO_ROOT}/release/remote/register-legacy-release.sh" "${register_root}" \
    "${register_root}/releases/stale" cid-old zen-agent-server:old "${register_root}/snapshots/first"
[[ "$(readlink -f "${register_root}/current-release")" == "${register_root}/releases/first" ]]

echo 'activate-release failure-path tests passed'
