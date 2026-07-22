#!/usr/bin/env bash
# 可重复 Phase 1 发布门：真实 MV3 E2E、zip、linux/amd64 镜像、非 root CLI 与回滚行为。
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="phase1-verify"
IMAGE="zen-commerce:${TAG}"

pnpm test:e2e:sidepanel
bash release/build-extension.sh
node release/test/verify-extension-artifact.mjs
node release/test/verify-release-contract.mjs
docker build --pull=false --platform linux/amd64 --progress=plain -t "${IMAGE}" .
docker run --rm --platform linux/amd64 --user node "${IMAGE}" lark-cli --version >/dev/null
docker run --rm --platform linux/amd64 \
  -v "$(pwd):/repo:ro" "${IMAGE}" bash /repo/release/test/activate-release.behavior.sh
docker run --rm --platform linux/amd64 -v "$(pwd)/assets:/app/snapshot:ro" "${IMAGE}" \
  node --input-type=module -e "import { createAssemblyPort } from '@zen-agent/assembly'; const port=createAssemblyPort({snapshotRoot:'/app/snapshot',systemPromptPath:'/app/snapshot/system-prompt.md'}); await port.listSites(); await port.allTools();"

for bad_fixture in bad-manifest registry-mismatch bad-tool; do
  if docker run --rm --platform linux/amd64 \
    -v "$(pwd)/packages/assembly/test/fixtures/${bad_fixture}:/app/snapshot:ro" \
    -v "$(pwd)/packages/assembly/test/fixtures/base-prompt.md:/app/system-prompt.md:ro" \
    "${IMAGE}" node --input-type=module -e \
      "import { createAssemblyPort } from '@zen-agent/assembly'; const port=createAssemblyPort({snapshotRoot:'/app/snapshot',systemPromptPath:'/app/system-prompt.md'}); await port.listSites(); await port.allTools();"; then
    echo "非法快照 ${bad_fixture} 未被拒载" >&2
    exit 1
  fi
done

echo 'Phase 1 release/E2E gate passed'
