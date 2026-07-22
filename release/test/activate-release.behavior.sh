#!/usr/bin/env bash
# 用 fake docker/curl 验证远端激活脚本的关键失败路径；应在 Linux/root 容器内执行。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUBJECT="${REPO_ROOT}/release/remote/activate-release.sh"
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
while (($#)); do
  case "$1" in
    --env-file) env_file="$2"; shift 2 ;;
    -p|-f) shift 2 ;;
    up|down|ps|exec) op="$1"; shift; break ;;
    *) shift ;;
  esac
done
tag="$(sed -n 's/^ZA_IMAGE_TAG=//p' "${env_file}")"
snapshot="$(sed -n 's/^ZA_SNAPSHOT_HOST_DIR=//p' "${env_file}")"
case "${op}" in
  up)
    if [[ "${MOCK_FAIL_KIND:-}" == rollback && "${tag}" == old ]]; then exit 1; fi
    printf 'zen-agent-server:%s\n' "${tag}" >"${state}/image"
    printf '%s\n' "${snapshot}" >"${state}/snapshot"
    ;;
  down) : >"${state}/image"; : >"${state}/snapshot" ;;
  ps)
    if [[ "${MOCK_FAIL_KIND:-}" == replica && "${tag}" == new ]]; then printf 'cid-new\ncid-extra\n'; else printf 'cid-%s\n' "${tag}"; fi
    ;;
  exec)
    if [[ "${MOCK_FAIL_KIND:-}" == lark && "${tag}" == new ]]; then exit 1; fi
    ;;
esac
EOF
chmod +x "${MOCK_BIN}/docker"

cat >"${MOCK_BIN}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
image="$(cat "${MOCK_STATE:?}/image" 2>/dev/null || true)"
if [[ "${MOCK_FAIL_KIND:-}" == health && "${image}" == zen-agent-server:new ]]; then exit 1; fi
exit 0
EOF
chmod +x "${MOCK_BIN}/curl"

make_release() {
  local root="$1" name="$2" tag="$3"
  mkdir -p "${root}/releases/${name}" "${root}/snapshots/${name}"
  : >"${root}/releases/${name}/docker-compose.yml"
  : >"${root}/snapshots/${name}/system-prompt.md"
  printf 'ZA_IMAGE_TAG=%s\nZA_SNAPSHOT_HOST_DIR=%s\nZA_LARK_CONFIG_HOST_DIR=%s\n' \
    "${tag}" "${root}/snapshots/${name}" "${root}/lark-cli" >"${root}/releases/${name}/deployment.env"
}

run_case() {
  local kind="$1"
  local root="${TEST_ROOT}/${kind}"
  local state="${root}/state"
  mkdir -p "${state}"
  make_release "${root}" old old
  make_release "${root}" new new
  ln -s "${root}/releases/old" "${root}/current-release"
  printf 'zen-agent-server:old\n' >"${state}/image"
  printf '%s\n' "${root}/snapshots/old" >"${state}/snapshot"
  if PATH="${MOCK_BIN}:${PATH}" MOCK_STATE="${state}" MOCK_FAIL_KIND="${kind}" \
    ZA_DEPLOY_HEALTH_ATTEMPTS=1 ZA_DEPLOY_HEALTH_DELAY=0 \
    bash "${SUBJECT}" "${root}" "${root}/releases/new" new "${root}/snapshots/new" "${root}/lark-cli"; then
    echo "${kind} 场景应失败却成功" >&2
    exit 1
  fi
  [[ "$(readlink -f "${root}/current-release")" == "${root}/releases/old" ]]
  [[ "$(cat "${state}/image")" == 'zen-agent-server:old' ]]
  [[ "$(cat "${state}/snapshot")" == "${root}/snapshots/old" ]]
}

for kind in health replica lark; do run_case "${kind}"; done

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

echo 'activate-release failure-path tests passed'
