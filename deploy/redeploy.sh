#!/usr/bin/env bash
# One-shot redeploy from the dev machine to the Hetzner VPS.
#   bash deploy/redeploy.sh            # sync, build, restart, health check
set -euo pipefail
VPS=root@65.21.178.172
REMOTE=/opt/lumen
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> [1/3] rsync project -> $VPS:$REMOTE"
rsync -az --delete \
  --exclude='.git' --exclude='node_modules' --exclude='data' --exclude='uploads' \
  --exclude='logs' --exclude='config/credentials.json' --exclude='config/tokens.json' \
  --exclude='.env' --exclude='mise.toml' \
  -e 'ssh -o ConnectTimeout=15' "$HERE/" "$VPS:$REMOTE/"

echo "==> [2/3] build image + restart container"
ssh -o ConnectTimeout=15 "$VPS" "cd $REMOTE && docker build -t lumen:latest . && bash deploy/run-container.sh"

echo "==> [3/3] wait for health"
ssh -o ConnectTimeout=15 "$VPS" 'st=none; for i in $(seq 1 30); do st=$(docker inspect lumen --format "{{.State.Health.Status}}" 2>/dev/null || echo none); [ "$st" = healthy ] && break; sleep 3; done; echo "container health: $st"'
curl -s -o /dev/null -w "https://lumen.trynewways.com -> %{http_code}\n" https://lumen.trynewways.com/health
