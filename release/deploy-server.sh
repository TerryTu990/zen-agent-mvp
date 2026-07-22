#!/usr/bin/env bash
# 部署服务端到 lingm2：镜像传输 → 版本化快照校验/切换 → compose up → healthz；失败成对回滚镜像与快照。
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="lingm2"
REMOTE_DIR="/root/zen-agent"
TAG="$(git rev-parse --short HEAD)"
IMAGE="zen-agent-server:${TAG}"
SNAPSHOT_DIR=""
SNAPSHOT_VERSION=""

if [[ "${1:-}" == "--snapshot" ]]; then
  SNAPSHOT_DIR="${2:?--snapshot 需要目录参数}"
  [[ -f "${SNAPSHOT_DIR}/manifest.json" ]] || { echo "快照根缺 manifest.json：${SNAPSHOT_DIR}" >&2; exit 1; }
  SNAPSHOT_VERSION="$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(m.version??""))' "${SNAPSHOT_DIR}/manifest.json")"
  [[ "${SNAPSHOT_VERSION}" =~ ^[0-9A-Za-z][0-9A-Za-z.-]*$ ]] || { echo "快照 version 非法" >&2; exit 1; }
fi

docker image inspect "${IMAGE}" >/dev/null 2>&1 || {
  echo "本地无镜像 ${IMAGE}：先跑 release/build-server-image.sh" >&2; exit 1;
}
ssh "${HOST}" "test -f ${REMOTE_DIR}/.env" || {
  echo "服务器缺 ${REMOTE_DIR}/.env：按 release/remote/env.example 在服务器上创建" >&2; exit 1;
}

echo "[1/6] 记录当前非敏感部署状态并传输 ${IMAGE}…"
OLD_IMAGE="$(ssh "${HOST}" "docker inspect --format '{{.Config.Image}}' \$(docker compose -f ${REMOTE_DIR}/docker-compose.yml ps -q zen-agent 2>/dev/null | head -n 1) 2>/dev/null || true")"
OLD_SNAPSHOT="$(ssh "${HOST}" "docker inspect --format '{{range .Mounts}}{{if eq .Destination \"/app/snapshot\"}}{{.Source}}{{end}}{{end}}' \$(docker compose -f ${REMOTE_DIR}/docker-compose.yml ps -q zen-agent 2>/dev/null | head -n 1) 2>/dev/null || true")"
docker save "${IMAGE}" | gzip | ssh "${HOST}" 'gunzip | docker load'

echo "[2/6] 同步 compose、签发脚本与目录骨架…"
scp -q release/remote/docker-compose.yml "${HOST}:${REMOTE_DIR}/docker-compose.yml"
scp -q release/remote/sign-token.sh "${HOST}:${REMOTE_DIR}/sign-token.sh"
ssh "${HOST}" "chmod +x ${REMOTE_DIR}/sign-token.sh && mkdir -p ${REMOTE_DIR}/snapshots ${REMOTE_DIR}/data/za ${REMOTE_DIR}/lark-cli && chown -R 1000:1000 ${REMOTE_DIR}/data/za ${REMOTE_DIR}/lark-cli"

TARGET_SNAPSHOT="${OLD_SNAPSHOT:-${REMOTE_DIR}/snapshot}"
if [[ -n "${SNAPSHOT_DIR}" ]]; then
  TARGET_SNAPSHOT="${REMOTE_DIR}/snapshots/${SNAPSHOT_VERSION}"
  STAGING_SNAPSHOT="${REMOTE_DIR}/snapshots/.staging-${SNAPSHOT_VERSION}-${TAG}"
  echo "[3/6] 上传并校验快照 ${SNAPSHOT_VERSION}…"
  ssh "${HOST}" "test ! -e ${STAGING_SNAPSHOT}"
  rsync -az "${SNAPSHOT_DIR}/" "${HOST}:${STAGING_SNAPSHOT}/"
  ssh "${HOST}" "docker run --rm -v ${STAGING_SNAPSHOT}:/app/snapshot:ro ${IMAGE} node --input-type=module -e \"import { createAssemblyPort } from '@zen-agent/assembly'; createAssemblyPort({snapshotRoot:'/app/snapshot',systemPromptPath:'/app/assets/system-prompt.md'});\""
  if ssh "${HOST}" "test -d ${TARGET_SNAPSHOT}"; then
    ssh "${HOST}" "diff -qr ${STAGING_SNAPSHOT} ${TARGET_SNAPSHOT} >/dev/null && rm -rf ${STAGING_SNAPSHOT}" || {
      echo "同版本快照内容不同，拒绝覆盖：${TARGET_SNAPSHOT}" >&2
      exit 1
    }
  else
    ssh "${HOST}" "mv ${STAGING_SNAPSHOT} ${TARGET_SNAPSHOT}"
  fi
else
  echo "[3/6] 沿用当前快照 ${TARGET_SNAPSHOT}"
fi

rollback() {
  if [[ -n "${OLD_IMAGE}" && -n "${OLD_SNAPSHOT}" ]]; then
    local old_tag="${OLD_IMAGE##*:}"
    echo "部署失败，回滚镜像 ${OLD_IMAGE} 与快照 ${OLD_SNAPSHOT}…" >&2
    ssh "${HOST}" "printf '%s\n' 'ZA_IMAGE_TAG=${old_tag}' 'ZA_SNAPSHOT_HOST_DIR=${OLD_SNAPSHOT}' > ${REMOTE_DIR}/deployment.env && cd ${REMOTE_DIR} && docker compose --env-file deployment.env up -d" || true
  fi
}
trap rollback ERR

echo "[4/6] 成对切换镜像 tag=${TAG} 与快照 ${TARGET_SNAPSHOT}…"
ssh "${HOST}" "printf '%s\n' 'ZA_IMAGE_TAG=${TAG}' 'ZA_SNAPSHOT_HOST_DIR=${TARGET_SNAPSHOT}' 'ZA_LARK_CONFIG_HOST_DIR=${REMOTE_DIR}/lark-cli' > ${REMOTE_DIR}/deployment.env && cd ${REMOTE_DIR} && docker compose --env-file deployment.env up -d"

echo "[5/6] 本机 healthz 与单副本冒烟…"
ready=0
for _ in $(seq 1 15); do
  if ssh "${HOST}" 'curl -fsS --max-time 3 http://127.0.0.1:9010/healthz' 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
[[ "${ready}" == "1" ]] || { echo "冒烟失败：容器未就绪" >&2; exit 1; }
replicas="$(ssh "${HOST}" "cd ${REMOTE_DIR} && docker compose --env-file deployment.env ps -q zen-agent | wc -l | tr -d ' '")"
[[ "${replicas}" == "1" ]] || { echo "生产必须保持单副本，当前 ${replicas}" >&2; exit 1; }

echo "[6/6] 验证镜像内 lark-cli 可执行…"
ssh "${HOST}" "cd ${REMOTE_DIR} && docker compose --env-file deployment.env exec -T zen-agent lark-cli --version >/dev/null"
trap - ERR
echo ""
echo "部署完成：${IMAGE} @ ${HOST}，snapshot=${TARGET_SNAPSHOT}"
