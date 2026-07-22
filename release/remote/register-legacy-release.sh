#!/usr/bin/env bash
# 在与 activate-release 相同的远端锁内，以 CAS 登记首次升级的实际旧部署。
set -euo pipefail

ROOT="${1:?root required}"
BOOTSTRAP_DIR="${2:?bootstrap dir required}"
LEGACY_CID="${3:?legacy cid required}"
LEGACY_IMAGE="${4:?legacy image required}"
LEGACY_SNAPSHOT="${5:?legacy snapshot required}"
CURRENT_LINK="${ROOT}/current-release"

exec 9>"${ROOT}/deploy.lock"
flock -x 9
if [[ -L "${CURRENT_LINK}" ]]; then
  echo '已有 current-release，保留并跳过 legacy 登记'
  exit 0
fi

compose=(docker compose -p zen-agent -f "${BOOTSTRAP_DIR}/docker-compose.yml" --env-file "${BOOTSTRAP_DIR}/deployment.env")
descriptor_cid="$("${compose[@]}" ps -q zen-agent | sed '/^$/d')"
replicas="$(printf '%s\n' "${descriptor_cid}" | sed '/^$/d' | wc -l | tr -d ' ')"
[[ "${replicas}" == 1 ]] || { echo 'legacy descriptor 无法识别唯一活动副本' >&2; exit 1; }
[[ "${descriptor_cid}" == "${LEGACY_CID}" ]] || {
  echo 'legacy descriptor 与发现的活动容器不一致，拒绝登记陈旧基线' >&2
  exit 1
}
[[ "$(docker inspect --format '{{.Config.Image}}' "${LEGACY_CID}")" == "${LEGACY_IMAGE}" ]] || {
  echo 'legacy 活动镜像已变化，拒绝登记陈旧基线' >&2
  exit 1
}
[[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/snapshot"}}{{.Source}}{{end}}{{end}}' "${LEGACY_CID}")" == "${LEGACY_SNAPSHOT}" ]] || {
  echo 'legacy 活动快照已变化，拒绝登记陈旧基线' >&2
  exit 1
}
curl -fsS --max-time 3 http://127.0.0.1:9010/healthz >/dev/null
ln -sfn "${BOOTSTRAP_DIR}" "${CURRENT_LINK}.next"
mv -Tf "${CURRENT_LINK}.next" "${CURRENT_LINK}"
echo "已登记 legacy 回滚基线：${BOOTSTRAP_DIR}"
