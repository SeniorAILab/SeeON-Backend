#!/bin/sh
set -eu

AI_REPO=
ML_REPO=
FRESH=false
RUN_TESTS=false
TEARDOWN=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ai-repo) AI_REPO=$2; shift 2 ;;
    --ml-repo) ML_REPO=$2; shift 2 ;;
    --fresh) FRESH=true; shift ;;
    --test) RUN_TESTS=true; shift ;;
    --teardown) TEARDOWN=true; shift ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

test -n "$AI_REPO"
test -n "$ML_REPO"
test -d "$AI_REPO/backend/prisma/init"
test -f "$ML_REPO/backend/app/main.py"
test "$FRESH" = true
test "$RUN_TESTS" = true
test "$TEARDOWN" = true

RUN_ID="task15-$$-$(date +%s)"
RESOURCE="cloud-edge-${RUN_ID}"
DB_CONTAINER="${RESOURCE}-postgres"
OLD_ML_CONTAINER="${RESOURCE}-old-ml"
NETWORK="${RESOURCE}-network"
VOLUME="${RESOURCE}-pgdata"
OLD_ML_IMAGE="${RESOURCE}-old-ml:local"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/cloud-edge-task15.XXXXXX")
AI_LOG="$TMP_DIR/ai.log"
ML_LOG="$TMP_DIR/ml.log"
SECRET_HANDOFF="$TMP_DIR/enrollment.json"
AI_PID=
ML_PID=

cleanup() {
  status=$?
  set +e
  if [ "$status" -ne 0 ]; then
    for log in "$AI_LOG" "$ML_LOG"; do
      if [ -f "$log" ]; then
        sed -E 's#postgresql://[^[:space:]]+#postgresql://<redacted>#g' "$log" >&2
      fi
    done
    if docker inspect "$OLD_ML_CONTAINER" >/dev/null 2>&1; then
      docker logs "$OLD_ML_CONTAINER" 2>&1 | \
        sed -E 's#postgresql://[^[:space:]]+#postgresql://<redacted>#g' >&2
    fi
  fi
  test -z "$AI_PID" || kill "$AI_PID" 2>/dev/null
  test -z "$ML_PID" || kill "$ML_PID" 2>/dev/null
  docker rm -f "$OLD_ML_CONTAINER" "$DB_CONTAINER" >/dev/null 2>&1
  docker image rm "$OLD_ML_IMAGE" >/dev/null 2>&1
  docker volume rm "$VOLUME" >/dev/null 2>&1
  docker network rm "$NETWORK" >/dev/null 2>&1
  rm -rf "$TMP_DIR"
  return "$status"
}
trap cleanup EXIT HUP INT TERM

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

wait_http() {
  url=$1
  log=${2:-}
  count=0
  until curl -fsS "$url" >/dev/null 2>&1; do
    count=$((count + 1))
    if [ "$count" -ge 60 ]; then
      printf 'service failed to become ready: %s\n' "$url" >&2
      if [ -n "$log" ] && [ -f "$log" ]; then
        sed -E 's#postgresql://[^[:space:]]+#postgresql://<redacted>#g' "$log" >&2
      fi
      return 1
    fi
    sleep 1
  done
}

DB_PASSWORD=$(openssl rand -hex 24)
APP_PASSWORD=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 32)
EDGE_TOKEN=$(openssl rand -hex 32)
EDGE_PEPPER=$(openssl rand -hex 32)
RELAY_TOKEN=$(openssl rand -hex 32)
DASHBOARD_PASSWORD=$(openssl rand -hex 24)
FACILITY_ID=a5ff4ed1-7e63-4a4f-9ef0-42e807d74a64
AI_PORT=$(free_port)
ML_PORT=$(free_port)
OLD_ML_PORT=$(free_port)

docker network create "$NETWORK" >/dev/null
docker volume create "$VOLUME" >/dev/null
docker run -d \
  --name "$DB_CONTAINER" \
  --network "$NETWORK" \
  -e POSTGRES_USER=fall \
  -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  -e POSTGRES_DB=fall_task15 \
  -e APP_DB_USER=fall_app \
  -e APP_DB_PASSWORD="$APP_PASSWORD" \
  -v "$VOLUME:/var/lib/postgresql/data" \
  -v "$AI_REPO/backend/prisma/init:/docker-entrypoint-initdb.d:ro" \
  -p 127.0.0.1::5432 \
  postgres:17-alpine >/dev/null

count=0
until docker exec "$DB_CONTAINER" pg_isready -U fall -d fall_task15 >/dev/null 2>&1; do
  count=$((count + 1))
  test "$count" -lt 60 || exit 1
  sleep 1
done
DB_PORT=$(docker port "$DB_CONTAINER" 5432/tcp | sed 's/.*://')
export DIRECT_URL="postgresql://fall:${DB_PASSWORD}@127.0.0.1:${DB_PORT}/fall_task15?schema=public"
export DATABASE_URL="postgresql://fall_app:${APP_PASSWORD}@127.0.0.1:${DB_PORT}/fall_task15?schema=public"
export SESSION_JWT_SECRET="$SESSION_SECRET"
export FRONT_ORIGIN="http://127.0.0.1:3000"
export EDGE_FACILITY_TOKEN="$EDGE_TOKEN"
export EDGE_TOKEN_PEPPER="$EDGE_PEPPER"
export EDGE_LEGACY_COMPAT_ENABLED=true
export EVENT_CLIPS_ENABLED=true
export MEDIA_CLIP_DIR="$TMP_DIR/ai-clips"
export CLOUD_EDGE_CLIP_PATH="$TMP_DIR/synthetic.mp4"
export DEPLOY_SHA
DEPLOY_SHA=$(GIT_MASTER=1 git -C "$AI_REPO" rev-parse HEAD)
mkdir -p "$MEDIA_CLIP_DIR" "$TMP_DIR/ml-state/ml-api" "$TMP_DIR/ml-clips"
ffmpeg -loglevel error -f lavfi -i color=c=black:s=16x16:d=1 \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart -an -y "$CLOUD_EDGE_CLIP_PATH"

if [ ! -d "$AI_REPO/node_modules" ]; then
  pnpm --dir "$AI_REPO" install --offline --frozen-lockfile
fi
pnpm --dir "$AI_REPO/backend" exec prisma generate
pnpm --dir "$AI_REPO/backend" exec prisma migrate deploy
pnpm --dir "$AI_REPO" --filter backend build

export PORT="$AI_PORT"
pnpm --dir "$AI_REPO" --filter backend start:prod >"$AI_LOG" 2>&1 &
AI_PID=$!
export CLOUD_EDGE_AI_URL="http://127.0.0.1:${AI_PORT}"
wait_http "$CLOUD_EDGE_AI_URL/health" "$AI_LOG"

export HOME="$TMP_DIR/home"
export XDG_STATE_HOME="$TMP_DIR/ml-state"
ML_STATE_DIR="$HOME/.local/state/ml-api"
export API_CONNECTION_SETTINGS_PATH="$ML_STATE_DIR/catalog.sqlite3"
export CLOUD_EDGE_ML_CATALOG_PATH="$API_CONNECTION_SETTINGS_PATH"
export API_BACKEND_BASE_URL="$CLOUD_EDGE_AI_URL/api"
export API_EDGE_RELAY_TOKEN="$RELAY_TOKEN"
export RELAY_TOKEN="$RELAY_TOKEN"
export API_DASHBOARD_USERNAME=task15-dashboard
export API_DASHBOARD_PASSWORD="$DASHBOARD_PASSWORD"
export CLOUD_EDGE_ML_DASHBOARD_USERNAME="$API_DASHBOARD_USERNAME"
export CLOUD_EDGE_ML_DASHBOARD_PASSWORD="$DASHBOARD_PASSWORD"
export CLIP_STORE_DIR="$TMP_DIR/ml-clips"
export CLOUD_EDGE_ML_URL="http://127.0.0.1:${ML_PORT}"
export CLOUD_EDGE_RELAY_TOKEN="$RELAY_TOKEN"
export CLOUD_EDGE_SECRET_HANDOFF_PATH="$SECRET_HANDOFF"

mkdir -p "$ML_STATE_DIR"
BACKUP_META="$TMP_DIR/backup-meta"
(
  cd "$ML_REPO"
  uv run python - "$BACKUP_META" <<'PY'
import sys
from pathlib import Path
from backend.app.features.connection.store import ConnectionSettingsStore

store = ConnectionSettingsStore.from_env()
store.save({})
receipt = store.create_pre_v1_backup()
Path(sys.argv[1]).write_text(f"{receipt.path}\n{receipt.sha256}\n")
PY
)
export CLOUD_EDGE_PRE_V1_BACKUP_PATH
CLOUD_EDGE_PRE_V1_BACKUP_PATH=$(sed -n '1p' "$BACKUP_META")
export CLOUD_EDGE_PRE_V1_BACKUP_SHA256
CLOUD_EDGE_PRE_V1_BACKUP_SHA256=$(sed -n '2p' "$BACKUP_META")

(
  cd "$ML_REPO"
  uv run uvicorn backend.app.main:app --host 127.0.0.1 --port "$ML_PORT"
) >"$ML_LOG" 2>&1 &
ML_PID=$!
wait_http "$CLOUD_EDGE_ML_URL/health/live" "$ML_LOG"

unset EDGE_FACILITY_TOKEN
(
  cd "$AI_REPO"
  pnpm --filter backend test -- --runInBand \
    test/edge-legacy-compat-characterization.spec.ts \
    test/alert-media-download.spec.ts
  pnpm --filter backend test -- --runInBand \
    test/cloud-edge-provisioning.e2e-spec.ts
)
(
  cd "$ML_REPO"
  uv run pytest -q -m integration tests/test_cloud_edge_provisioning_integration.py
)

OLD_AI_DIR="$TMP_DIR/old-ai"
mkdir -p "$OLD_AI_DIR"
GIT_MASTER=1 git -C "$AI_REPO" archive 14c484124a2d74972b15ee6d34860c3593b1580b | tar -x -C "$OLD_AI_DIR"
(
  cd "$OLD_AI_DIR"
  pnpm install --frozen-lockfile
  pnpm --dir backend exec prisma generate
  pnpm --filter backend build
)
kill "$AI_PID"
wait "$AI_PID" 2>/dev/null || true
AI_PID=
export EDGE_FACILITY_TOKEN="$EDGE_TOKEN"
(
  cd "$OLD_AI_DIR"
  PORT="$AI_PORT" pnpm --filter backend start:prod
) >"$TMP_DIR/old-ai.log" 2>&1 &
AI_PID=$!
wait_http "$CLOUD_EDGE_AI_URL/health" "$TMP_DIR/old-ai.log"
LOGIN_JSON="$TMP_DIR/login.json"
COOKIE_JAR="$TMP_DIR/cookies.txt"
CAMERAS_JSON="$TMP_DIR/cameras.json"
umask 077
printf '{"email":"%s","password":"%s"}' 'task15-admin@example.invalid' \
  'task15-local-password' >"$LOGIN_JSON"
curl -fsS -c "$COOKIE_JAR" -H 'Content-Type: application/json' \
  --data-binary "@$LOGIN_JSON" "$CLOUD_EDGE_AI_URL/api/v1/auth/login" >/dev/null
curl -fsS -b "$COOKIE_JAR" \
  "$CLOUD_EDGE_AI_URL/api/v1/cameras?facilityId=$FACILITY_ID" >"$CAMERAS_JSON"
CANONICAL_CAMERA_ID=$(docker exec "$DB_CONTAINER" psql -U fall -d fall_task15 -Atc \
  "SELECT id FROM cameras WHERE edge_ref = 'camera-task15';")
node - "$CAMERAS_JSON" "$CANONICAL_CAMERA_ID" <<'NODE'
const fs = require('node:fs');
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!JSON.stringify(body).includes(process.argv[3])) process.exit(1);
NODE

ML_BASE_SHA=bc9dfe3482fd3d9b707d67a02f95aabf1bbc7a40
OLD_ML_DIR="$TMP_DIR/old-ml"
OLD_ML_DOCKERFILE="$TMP_DIR/old-ml.Dockerfile"
mkdir -p "$OLD_ML_DIR"
GIT_MASTER=1 git -C "$ML_REPO" archive "$ML_BASE_SHA" | tar -x -C "$OLD_ML_DIR"
node - "$OLD_ML_DIR/Dockerfile.backend" "$OLD_ML_DOCKERFILE" <<'NODE'
const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
const compatible = source.replace(
  /^RUN --mount=type=cache,target=[^ ]+ \\\n    /gm,
  'RUN ',
);
if (compatible === source) process.exit(1);
fs.writeFileSync(process.argv[3], compatible);
NODE
docker build -q -f "$OLD_ML_DOCKERFILE" -t "$OLD_ML_IMAGE" "$OLD_ML_DIR" >/dev/null
kill "$ML_PID"
wait "$ML_PID" 2>/dev/null || true
ML_PID=
docker run -d \
  --name "$OLD_ML_CONTAINER" \
  -p "127.0.0.1:${OLD_ML_PORT}:8000" \
  -e HOST=0.0.0.0 \
  -e API_CONNECTION_SETTINGS_PATH=/root/.local/state/ml-api/catalog.sqlite3 \
  -e API_FACILITY_ID="$FACILITY_ID" \
  -e EDGE_FACILITY_TOKEN="$EDGE_TOKEN" \
  -e API_BACKEND_BASE_URL="http://host.docker.internal:${AI_PORT}/api" \
  -e API_EDGE_RELAY_TOKEN="$RELAY_TOKEN" \
  -e CLIP_STORE_DIR=/var/lib/clip-store \
  -v "$ML_STATE_DIR:/root/.local/state/ml-api" \
  -v "$TMP_DIR/ml-clips:/var/lib/clip-store" \
  "$OLD_ML_IMAGE" >/dev/null
wait_http "http://127.0.0.1:${OLD_ML_PORT}/health/live"
OLD_ML_IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$OLD_ML_IMAGE")

AI_SHA=$(GIT_MASTER=1 git -C "$AI_REPO" rev-parse HEAD)
ML_SHA=$(GIT_MASTER=1 git -C "$ML_REPO" rev-parse HEAD)
MIGRATION_COUNT=$(docker exec "$DB_CONTAINER" psql -U fall -d fall_task15 -Atc \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;')
INACTIVE_COUNT=$(docker exec "$DB_CONTAINER" psql -U fall -d fall_task15 -Atc \
  'SELECT count(*) FROM cameras WHERE is_active = false;')
printf 'CLOUD_EDGE_TEST_OK ai_sha=%s ml_sha=%s migrations=%s inactive=%s old_ml_image=%s\n' \
  "$AI_SHA" "$ML_SHA" "$MIGRATION_COUNT" "$INACTIVE_COUNT" "$OLD_ML_IMAGE_ID"

cleanup
trap - EXIT HUP INT TERM
if docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || \
   docker volume inspect "$VOLUME" >/dev/null 2>&1 || \
   docker network inspect "$NETWORK" >/dev/null 2>&1; then
  printf '%s\n' 'named resource teardown failed' >&2
  exit 1
fi
printf '%s\n' 'CLOUD_EDGE_TEARDOWN_OK'
