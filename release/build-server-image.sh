#!/usr/bin/env bash
# 构建服务端发布镜像（linux/amd64，目标机 lingm2 为 x86_64）。
# tag = git short SHA：镜像可追溯到确切提交；工作区脏时拒绝构建（发布必须来自已提交代码）。
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "工作区有未提交改动，发布镜像必须构建自已提交代码；先提交或 stash。" >&2
  exit 1
fi

TAG="$(git rev-parse --short HEAD)"
IMAGE="zen-agent-server:${TAG}"

docker build --platform linux/amd64 -t "${IMAGE}" .
docker tag "${IMAGE}" zen-agent-server:latest
echo "已构建 ${IMAGE}（并打 latest）"
