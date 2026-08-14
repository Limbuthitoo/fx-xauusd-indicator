#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env.production}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.prod.yml)
VALIDATION_TIMEOUT_SECONDS="${VALIDATION_TIMEOUT_SECONDS:-300}"

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

echo "[4/9] Building migration image and applying checksum-ledger migrations"
"${COMPOSE[@]}" --profile prod-tools run --build --rm migrate

echo "[5/9] Building production services"
"${COMPOSE[@]}" --profile prod build api worker web quant ops-monitor

echo "[6/9] Starting production services"
"${COMPOSE[@]}" --profile prod up -d postgres redis quant api worker web ops-monitor backup

echo "[7/9] Waiting for health checks"
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
npm run verify:modules
run_validation() {
  local script="$1"
  echo "Running $script in an isolated production-tools container"
  "${COMPOSE[@]}" --profile prod-tools run --rm --no-deps migrate \
    sh -lc "cd /app && timeout -s TERM ${VALIDATION_TIMEOUT_SECONDS} npm run ${script}"
}

run_validation validate:paper-lifecycle
run_validation validate:mvp-runtime
run_validation validate:production-observation

echo "[9/9] Verifying public API, WebSocket, and optional authenticated tenant flow"
npm run deploy:verify -- "$ENV_FILE"
npm run deploy:verify-websocket -- "$ENV_FILE"
if [[ -n "${TENANT_TOKEN:-}" || ( -n "${TENANT_EMAIL:-}" && -n "${TENANT_PASSWORD:-}" ) ]]; then
  npm run validate:modules-flow
else
  echo "Tenant flow proof skipped. Set TENANT_TOKEN, or TENANT_EMAIL and TENANT_PASSWORD, to run it."
fi

echo "Production deployment and lifecycle verification complete."
