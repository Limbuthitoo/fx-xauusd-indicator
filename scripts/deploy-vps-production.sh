#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env.production}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.prod.yml)
VALIDATION_TIMEOUT_SECONDS="${VALIDATION_TIMEOUT_SECONDS:-2400}"
declare -A PREVIOUS_IMAGE_REFS=()
declare -A ROLLBACK_IMAGE_REFS=()
ROLLOUT_STARTED=false
DEPLOY_SUCCEEDED=false
CANARY_CONTAINERS=()

run_validation() {
  local script="$1"
  echo "Running $script in an isolated production-tools container"
  "${COMPOSE[@]}" --profile prod-tools run --rm --no-deps migrate \
    sh -lc "export PATH=/opt/venv/bin:\$PATH; cd /app && timeout -s TERM ${VALIDATION_TIMEOUT_SECONDS} npm run ${script}"
}

capture_previous_images() {
  local service container_id
  for service in api worker web quant ops-monitor; do
    container_id="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -n "$container_id" ]]; then
      PREVIOUS_IMAGE_REFS["$service"]="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
      ROLLBACK_IMAGE_REFS["$service"]="fx-xauusd-indicator-rollback-${service}:previous"
      docker image tag "$(docker inspect --format '{{.Image}}' "$container_id")" "${ROLLBACK_IMAGE_REFS[$service]}"
    fi
  done
}

rollback_on_failure() {
  local result=$?
  set +e
  local canary
  for canary in "${CANARY_CONTAINERS[@]:-}"; do
    [[ -n "$canary" ]] && docker rm -f "$canary" >/dev/null 2>&1
  done
  if [[ "$result" -ne 0 && "$ROLLOUT_STARTED" == "true" && "$DEPLOY_SUCCEEDED" != "true" ]]; then
    echo "Deployment failed after rollout began. Restoring previous application images." >&2
    local service
    local restore_services=()
    for service in api worker web quant ops-monitor; do
      if [[ -n "${ROLLBACK_IMAGE_REFS[$service]:-}" && -n "${PREVIOUS_IMAGE_REFS[$service]:-}" ]]; then
        docker image tag "${ROLLBACK_IMAGE_REFS[$service]}" "${PREVIOUS_IMAGE_REFS[$service]}"
        restore_services+=("$service")
      fi
    done
    if (( ${#restore_services[@]} > 0 )); then
      "${COMPOSE[@]}" --profile prod up -d --no-deps --force-recreate "${restore_services[@]}"
    fi
    "${COMPOSE[@]}" --profile prod ps
    echo "Previous application images restored. Database migrations are additive and remain applied." >&2
  fi
  set -e
  exit "$result"
}

run_http_canary() {
  local service="$1"
  local host_port="$2"
  local container_port="$3"
  local health_path="$4"
  local name="xauusd-${service}-canary-$$"
  local attempt
  echo "Smoke-testing $service replacement on localhost:$host_port"
  "${COMPOSE[@]}" --profile prod run -d --name "$name" --no-deps \
    -p "127.0.0.1:${host_port}:${container_port}" "$service" >/dev/null
  CANARY_CONTAINERS+=("$name")
  for attempt in $(seq 1 24); do
    if curl --fail --silent "http://127.0.0.1:${host_port}${health_path}" >/dev/null; then
      docker rm -f "$name" >/dev/null
      return 0
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null || true)" != "true" ]]; then
      break
    fi
    sleep 5
  done
  echo "$service canary did not pass its health check." >&2
  docker logs --tail 100 "$name" >&2 || true
  return 1
}

wait_for_service() {
  local service="$1"
  local attempts="${2:-36}"
  local container_id status attempt
  for attempt in $(seq 1 "$attempts"); do
    container_id="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -n "$container_id" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      if [[ "$status" == "healthy" || "$status" == "running" ]]; then
        return 0
      fi
      if [[ "$status" == "unhealthy" || "$status" == "exited" || "$status" == "dead" ]]; then
        echo "$service entered $status state." >&2
        docker logs --tail 100 "$container_id" >&2 || true
        return 1
      fi
    fi
    sleep 5
  done
  echo "$service did not become healthy within $((attempts * 5)) seconds." >&2
  return 1
}

trap rollback_on_failure EXIT

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Environment file not found: $ENV_FILE" >&2
  exit 1
fi

echo "[1/9] Installing the locked validation toolchain"
npm ci

echo "[2/9] Validating production environment"
npm run release:validate-production -- "$ENV_FILE"
npm run deploy:vps-preflight -- "$ENV_FILE"
"${COMPOSE[@]}" --profile prod config --quiet

echo "[3/9] Creating pre-deployment PostgreSQL backup"
BACKUP_DIR="${BACKUP_DIR:-backups/postgres}" npm run db:backup

echo "[4/9] Capturing rollback images and building replacements while live services remain online"
capture_previous_images
"${COMPOSE[@]}" --profile prod build api worker web quant ops-monitor

echo "[5/9] Applying checksum-ledger migrations after successful image builds"
"${COMPOSE[@]}" --profile prod-tools run --build --rm migrate
run_http_canary quant 18000 8000 /health
run_http_canary api 17073 7073 /api/health
run_http_canary web 13000 3000 /

echo "[6/9] Starting production services"
ROLLOUT_STARTED=true
"${COMPOSE[@]}" --profile prod up -d postgres redis quant api worker web ops-monitor backup

echo "[7/9] Waiting for health checks"
wait_for_service postgres
wait_for_service redis
wait_for_service quant
wait_for_service api
wait_for_service worker
wait_for_service web
wait_for_service ops-monitor
for attempt in $(seq 1 36); do
  if curl --fail --silent http://localhost:7073/api/health >/dev/null; then
    break
  fi
  if [[ "$attempt" == "36" ]]; then
    echo "API did not become healthy within three minutes." >&2
    "${COMPOSE[@]}" --profile prod ps
    exit 1
  fi
  sleep 5
done
"${COMPOSE[@]}" --profile prod ps

echo "[8/9] Verifying deterministic target sequences and PostgreSQL lifecycle integrity"
run_validation calendar:sync
run_validation verify:modules
run_validation validate:paper-lifecycle
run_validation validate:mvp-runtime
run_validation validate:signal-policy
run_validation validate:production-observation

echo "[9/9] Verifying public API, WebSocket, and optional authenticated tenant flow"
PROMPTED_ADMIN_OTP=false
if [[ -z "${ADMIN_OTP:-}" && -z "${ADMIN_MFA_CODE:-}" && -t 0 ]]; then
  read -rsp "Current admin OTP (press Enter if MFA is disabled): " ADMIN_OTP
  echo
  export ADMIN_OTP
  PROMPTED_ADMIN_OTP=true
fi
npm run deploy:verify -- "$ENV_FILE"
npm run deploy:verify-websocket -- "$ENV_FILE"
if [[ -n "${TENANT_TOKEN:-}" || ( -n "${TENANT_EMAIL:-}" && -n "${TENANT_PASSWORD:-}" ) ]]; then
  npm run validate:modules-flow
else
  echo "Tenant flow proof skipped. Set TENANT_TOKEN, or TENANT_EMAIL and TENANT_PASSWORD, to run it."
fi
if [[ "$PROMPTED_ADMIN_OTP" == "true" ]]; then
  unset ADMIN_OTP
fi

DEPLOY_SUCCEEDED=true
echo "Production deployment and lifecycle verification complete."
