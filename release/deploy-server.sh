#!/usr/bin/env bash
# 部署到 lingm2：传镜像 → 上传不可变快照/release → 服务器侧加锁激活并验证/回滚。
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="lingm2"
REMOTE_DIR="/root/zen-agent"
TAG="$(git rev-parse --short HEAD)"
IMAGE="zen-agent-server:${TAG}"
SNAPSHOT_DIR=""
SNAPSHOT_VERSION=""
DEPLOY_ID="${TAG}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
RELEASE_DIR="${REMOTE_DIR}/releases/${DEPLOY_ID}"

if [[ "${1:-}" == "--snapshot" ]]; then
  SNAPSHOT_DIR="${2:?--snapshot 需要目录参数}"
  [[ -f "${SNAPSHOT_DIR}/manifest.json" ]] || { echo "快照根缺 manifest.json：${SNAPSHOT_DIR}" >&2; exit 1; }
  [[ -f "${SNAPSHOT_DIR}/system-prompt.md" ]] || { echo "快照根缺 system-prompt.md：${SNAPSHOT_DIR}" >&2; exit 1; }
  SNAPSHOT_VERSION="$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(m.version??""))' "${SNAPSHOT_DIR}/manifest.json")"
  [[ "${SNAPSHOT_VERSION}" =~ ^[0-9A-Za-z][0-9A-Za-z.-]*$ ]] || { echo '快照 version 非法' >&2; exit 1; }
else
  echo '生产发布必须显式传 --snapshot <dir>，拒绝不确定的首次/沿用快照' >&2
  exit 1
fi

docker image inspect "${IMAGE}" >/dev/null 2>&1 || {
  echo "本地无镜像 ${IMAGE}：先跑 release/build-server-image.sh" >&2
  exit 1
}
ssh "${HOST}" "test -f ${REMOTE_DIR}/.env" || {
  echo "服务器缺 ${REMOTE_DIR}/.env：按 release/remote/env.example 在服务器上创建" >&2
  exit 1
}

# 从现有 /root/zen-agent 单体 compose 平滑迁移：只读取活动容器的非敏感镜像名/挂载源，
# 生成可供本次失败回滚的首个版本化 descriptor；不重启、不读取 .env 内容。
if ! ssh "${HOST}" "test -L ${REMOTE_DIR}/current-release"; then
  LEGACY_CID=""
  if ssh "${HOST}" "test -f ${REMOTE_DIR}/docker-compose.yml"; then
    LEGACY_CID="$(ssh "${HOST}" "docker compose -p zen-agent -f ${REMOTE_DIR}/docker-compose.yml ps -q zen-agent | sed -n '1p'")"
  fi
  if [[ -n "${LEGACY_CID}" ]]; then
    LEGACY_IMAGE="$(ssh "${HOST}" "docker inspect --format '{{.Config.Image}}' ${LEGACY_CID}")"
    LEGACY_SNAPSHOT="$(ssh "${HOST}" "docker inspect --format '{{range .Mounts}}{{if eq .Destination \"/app/snapshot\"}}{{.Source}}{{end}}{{end}}' ${LEGACY_CID}")"
    [[ "${LEGACY_IMAGE}" =~ ^zen-agent-server:([0-9A-Za-z][0-9A-Za-z._-]*)$ ]] || {
      echo "现有镜像无法安全纳入自动回滚：${LEGACY_IMAGE}" >&2
      exit 1
    }
    LEGACY_TAG="${BASH_REMATCH[1]}"
    [[ -n "${LEGACY_SNAPSHOT}" ]] || { echo '现有服务缺 /app/snapshot 挂载，拒绝无回滚部署' >&2; exit 1; }
    BOOTSTRAP_DIR="${REMOTE_DIR}/releases/bootstrap-${DEPLOY_ID}"
    ssh "${HOST}" "install -d -m 700 ${REMOTE_DIR}/releases ${BOOTSTRAP_DIR}"
    # 保留实际旧 compose，而不是拿新模板描述旧镜像；相对 env_file 通过同目录只读软链继续指向唯一 .env。
    ssh "${HOST}" "cp -p ${REMOTE_DIR}/docker-compose.yml ${BOOTSTRAP_DIR}/docker-compose.yml && ln -s ${REMOTE_DIR}/.env ${BOOTSTRAP_DIR}/.env && printf '%s\n' 'ZA_IMAGE_TAG=${LEGACY_TAG}' 'ZA_SNAPSHOT_HOST_DIR=${LEGACY_SNAPSHOT}' 'ZA_LARK_CONFIG_HOST_DIR=${REMOTE_DIR}/lark-cli' 'ZA_RELEASE_LEGACY=1' > ${BOOTSTRAP_DIR}/deployment.env.tmp && chmod 600 ${BOOTSTRAP_DIR}/deployment.env.tmp && mv ${BOOTSTRAP_DIR}/deployment.env.tmp ${BOOTSTRAP_DIR}/deployment.env"
    scp -q release/remote/register-legacy-release.sh "${HOST}:${BOOTSTRAP_DIR}/register-legacy-release.sh"
    ssh "${HOST}" "chmod 700 ${BOOTSTRAP_DIR}/register-legacy-release.sh && ${BOOTSTRAP_DIR}/register-legacy-release.sh ${REMOTE_DIR} ${BOOTSTRAP_DIR} ${LEGACY_CID} ${LEGACY_IMAGE} ${LEGACY_SNAPSHOT}"
    echo "已登记现有服务为回滚基线：${BOOTSTRAP_DIR}"
  fi
fi

echo "[1/6] 传输 ${IMAGE}…"
docker save "${IMAGE}" | gzip | ssh "${HOST}" 'gunzip | docker load'

echo "[2/6] 创建版本化 release ${DEPLOY_ID}…"
ssh "${HOST}" "install -d -m 700 ${REMOTE_DIR}/releases ${REMOTE_DIR}/snapshots && install -d -m 700 ${RELEASE_DIR}"
scp -q release/remote/docker-compose.yml release/remote/activate-release.sh "${HOST}:${RELEASE_DIR}/"
scp -q release/remote/sign-token.sh "${HOST}:${REMOTE_DIR}/sign-token.sh"
ssh "${HOST}" "chmod 700 ${RELEASE_DIR}/activate-release.sh ${REMOTE_DIR}/sign-token.sh"

TARGET_SNAPSHOT="${REMOTE_DIR}/snapshots/${SNAPSHOT_VERSION}"
STAGING_SNAPSHOT="${REMOTE_DIR}/snapshots/.staging-${SNAPSHOT_VERSION}-${DEPLOY_ID}"
echo "[3/6] 上传并真正装配校验快照 ${SNAPSHOT_VERSION}…"
ssh "${HOST}" "test ! -e ${STAGING_SNAPSHOT}"
rsync -az "${SNAPSHOT_DIR}/" "${HOST}:${STAGING_SNAPSHOT}/"
ssh "${HOST}" "docker run --rm -v ${STAGING_SNAPSHOT}:/app/snapshot:ro ${IMAGE} node --input-type=module -e \"import { createAssemblyPort } from '@zen-agent/assembly'; const port=createAssemblyPort({snapshotRoot:'/app/snapshot',systemPromptPath:'/app/snapshot/system-prompt.md'}); await port.listSites(); await port.allTools();\""
ssh "${HOST}" "flock -x ${REMOTE_DIR}/snapshot.lock -c 'if test -d ${TARGET_SNAPSHOT}; then diff -qr ${STAGING_SNAPSHOT} ${TARGET_SNAPSHOT} >/dev/null && rm -rf ${STAGING_SNAPSHOT}; else mv ${STAGING_SNAPSHOT} ${TARGET_SNAPSHOT}; fi'" || {
  echo "同版本快照内容不同，拒绝覆盖：${TARGET_SNAPSHOT}" >&2
  exit 1
}

echo "[4/6] 服务器侧串行激活；失败自动恢复完整旧 release…"
ssh "${HOST}" "${RELEASE_DIR}/activate-release.sh ${REMOTE_DIR} ${RELEASE_DIR} ${TAG} ${TARGET_SNAPSHOT} ${REMOTE_DIR}/lark-cli"

echo '[5/6] 报告型对外站点 healthz（不参与已完成的原子激活/回滚）…'
curl -fsS --max-time 10 https://agent.flash-api.com/healthz >/dev/null

echo '[6/6] 完成。'
echo "部署完成：${IMAGE} @ ${HOST}，snapshot=${TARGET_SNAPSHOT}，release=${DEPLOY_ID}"
