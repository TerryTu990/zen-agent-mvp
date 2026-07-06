#!/usr/bin/env bash
# 部署服务端到 lingm2：镜像 save|ssh|load → 同步 compose（与快照，如指定）→ 置 tag → up -d → healthz 冒烟。
# 前提：build-server-image.sh 已构建当前 HEAD 的镜像；服务器 /root/zen-agent/.env 已就位（首次人工，见 remote/env.example）。
# 用法：release/deploy-server.sh [--snapshot <本地快照根目录>]
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="lingm2"
REMOTE_DIR="/root/zen-agent"
TAG="$(git rev-parse --short HEAD)"
IMAGE="zen-agent-server:${TAG}"

SNAPSHOT_DIR=""
if [[ "${1:-}" == "--snapshot" ]]; then
  SNAPSHOT_DIR="${2:?--snapshot 需要目录参数}"
  [[ -f "${SNAPSHOT_DIR}/manifest.json" ]] || { echo "快照根缺 manifest.json：${SNAPSHOT_DIR}" >&2; exit 1; }
fi

docker image inspect "${IMAGE}" >/dev/null 2>&1 || {
  echo "本地无镜像 ${IMAGE}：先跑 release/build-server-image.sh" >&2; exit 1;
}
ssh "${HOST}" "test -f ${REMOTE_DIR}/.env" || {
  echo "服务器缺 ${REMOTE_DIR}/.env：按 release/remote/env.example 在服务器上创建（真值不经本机）" >&2; exit 1;
}

echo "[1/5] 传输镜像 ${IMAGE}（gzip 流式）…"
docker save "${IMAGE}" | gzip | ssh "${HOST}" 'gunzip | docker load'

echo "[2/5] 同步 compose 与目录骨架…"
scp -q release/remote/docker-compose.yml "${HOST}:${REMOTE_DIR}/docker-compose.yml"
ssh "${HOST}" "mkdir -p ${REMOTE_DIR}/snapshot ${REMOTE_DIR}/data/za"

if [[ -n "${SNAPSHOT_DIR}" ]]; then
  echo "[3/5] 同步快照根 ${SNAPSHOT_DIR} → ${REMOTE_DIR}/snapshot/ …"
  rsync -az --delete "${SNAPSHOT_DIR}/" "${HOST}:${REMOTE_DIR}/snapshot/"
else
  echo "[3/5] 跳过快照同步（沿用服务器现有 snapshot/；如需更新加 --snapshot <dir>）"
fi

echo "[4/5] 置镜像 tag=${TAG} 并 up -d…"
# .env 中 ZA_IMAGE_TAG 行就地更新（无则追加）——回滚 = 手工改回旧 SHA 再 up -d。
ssh "${HOST}" "cd ${REMOTE_DIR} \
  && (grep -q '^ZA_IMAGE_TAG=' .env && sed -i 's/^ZA_IMAGE_TAG=.*/ZA_IMAGE_TAG=${TAG}/' .env || echo 'ZA_IMAGE_TAG=${TAG}' >> .env) \
  && docker compose up -d"

echo "[5/5] healthz 冒烟…"
for i in $(seq 1 15); do
  if ssh "${HOST}" 'curl -fsS --max-time 3 http://127.0.0.1:9010/healthz' 2>/dev/null; then
    echo ""
    echo "部署完成：${IMAGE} @ ${HOST}（对外 https://agent.flash-api.com）"
    exit 0
  fi
  sleep 2
done
echo "冒烟失败：容器未就绪。排障：ssh ${HOST} 'cd ${REMOTE_DIR} && docker compose logs --tail 50'" >&2
exit 1
