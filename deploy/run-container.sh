#!/usr/bin/env bash
# Launch (or relaunch) Lumen behind Coolify's Traefik proxy. Run on the VPS.
# Idempotent: removes any existing container first. State lives in bind mounts
# under /opt/lumen-data so it survives rebuilds and is easy to back up.
set -euo pipefail

NAME="lumen"
IMAGE="lumen:latest"
NET="coolify"
PORT=3456
HOST='Host(`lumen.trynewways.com`)'
ENV_FILE="/opt/lumen-secrets/runtime.env"
DATA="/opt/lumen-data"
AUTH_FILE="/opt/lumen-secrets/htpasswd"   # basic-auth for the whole dashboard

mkdir -p "$DATA"/{data,uploads,config,logs}
docker rm -f "$NAME" >/dev/null 2>&1 || true

# Traefik reads the htpasswd users from a label. With plain `docker run` the
# value is taken literally (no `$$` escaping — that is a docker-compose rule).
USERS=$(cat "$AUTH_FILE")

docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  --network "$NET" \
  --env-file "$ENV_FILE" \
  --cpus=2 --memory=3g --memory-swap=5g \
  -v "$DATA/data:/app/data" \
  -v "$DATA/uploads:/app/uploads" \
  -v "$DATA/config:/app/config" \
  -v "$DATA/logs:/app/logs" \
  --label 'traefik.enable=true' \
  --label "traefik.docker.network=${NET}" \
  --label "traefik.http.services.${NAME}.loadbalancer.server.port=${PORT}" \
  --label "traefik.http.routers.${NAME}.rule=${HOST}" \
  --label "traefik.http.routers.${NAME}.entrypoints=https" \
  --label "traefik.http.routers.${NAME}.tls=true" \
  --label "traefik.http.routers.${NAME}.tls.certresolver=letsencrypt" \
  --label "traefik.http.routers.${NAME}.middlewares=${NAME}-auth" \
  --label "traefik.http.middlewares.${NAME}-auth.basicauth.users=${USERS}" \
  --label "traefik.http.routers.${NAME}-http.rule=${HOST}" \
  --label "traefik.http.routers.${NAME}-http.entrypoints=http" \
  --label "traefik.http.routers.${NAME}-http.middlewares=${NAME}-redirect" \
  --label "traefik.http.middlewares.${NAME}-redirect.redirectscheme.scheme=https" \
  "$IMAGE"

echo "started $NAME ($IMAGE) -> https://lumen.trynewways.com"
