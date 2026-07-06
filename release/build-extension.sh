#!/usr/bin/env bash
# 打包 Chrome 插件发布 zip：manifest + dist + icons（不含 src/test/node_modules）。
# 版本取 manifest.json 的 version；构建前重新 esbuild 确保 dist 与源码一致。
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm --filter @zen-agent/extension build >/dev/null

VERSION="$(node -p "JSON.parse(require('fs').readFileSync('apps/extension/manifest.json','utf8')).version")"
OUT_DIR="release/artifacts"
OUT="${OUT_DIR}/zen-agent-extension-${VERSION}.zip"
mkdir -p "${OUT_DIR}"
rm -f "${OUT}"

(cd apps/extension && zip -qr "../../${OUT}" manifest.json dist icons)
echo "已打包 ${OUT}"
echo "安装后配置：za.serverBaseUrl = https://agent.flash-api.com（chrome.storage.local）"
