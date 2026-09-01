#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${DEPLOY_ENV_FILE:-.env.production}"
LOCK_FILE="${DEPLOY_LOCK_FILE:-/tmp/fx-xauusd-indicator-deploy.lock}"

cd "$ROOT_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another deployment is already running. Lock: $LOCK_FILE" >&2
  exit 1
fi

for command in git node npm docker curl flock; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required." >&2; exit 1; }
done
docker compose version >/dev/null

node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 or newer is required."); process.exit(1); }'

if [[ ! -f "$ENV_FILE" ]]; then
  echo "$ENV_FILE is missing. Create it from .env.production.example first." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked repository changes are present. Commit or restore them before deployment." >&2
  git status --short
  exit 1
fi
if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "VPS deployment must run from the main branch." >&2
  exit 1
fi

echo "[bootstrap] Updating main with a fast-forward-only pull"
git fetch origin main
git pull --ff-only origin main
echo "Deploying commit $(git rev-parse --short=8 HEAD)"

backup_file="${ENV_FILE}.backup-$(date +%Y%m%d%H%M%S)"
cp "$ENV_FILE" "$backup_file"

set_env_value() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

CURRENT_CALENDAR_PROVIDER="$(grep '^ECONOMIC_CALENDAR_PROVIDER=' "$ENV_FILE" | tail -1 | cut -d= -f2 || true)"
if [[ -z "$CURRENT_CALENDAR_PROVIDER" || "$CURRENT_CALENDAR_PROVIDER" == "trading_economics" ]]; then
  set_env_value ECONOMIC_CALENDAR_PROVIDER official_us
fi
sed -i \
  -e '/^TRADING_ECONOMICS_API_KEY=/d' \
  -e '/^ECONOMIC_CALENDAR_LOOKAHEAD_DAYS=/d' \
  "$ENV_FILE"

COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.prod.yml)
ENV_PROJECT_NAME="$(grep '^COMPOSE_PROJECT_NAME=' "$ENV_FILE" | tail -1 | cut -d= -f2 || true)"
DEFAULT_PROJECT_NAME="$(basename "$ROOT_DIR" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-${ENV_PROJECT_NAME:-$DEFAULT_PROJECT_NAME}}"

check_owned_port() {
  local port="$1"
  local expected_service="$2"
  local owners
  owners="$(docker ps --filter "publish=${port}" --format '{{.Label "com.docker.compose.project"}}:{{.Label "com.docker.compose.service"}}' | sed '/^:$/d' | sort -u)"
  if [[ -n "$owners" ]]; then
    while IFS= read -r owner; do
      [[ "$owner" == "${PROJECT_NAME}:${expected_service}" ]] || { echo "Port $port belongs to unexpected Docker service: $owner" >&2; exit 1; }
    done <<< "$owners"
    return
  fi
  if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :${port}" | tail -n +2 | grep -q .; then
    echo "Port $port is occupied by a non-project process. It will not be killed automatically." >&2
    exit 1
  fi
}

check_owned_port 7073 api
WEB_PORT="$(grep '^WEB_HOST_PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2 || true)"
QUANT_PORT="$(grep '^QUANT_HOST_PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2 || true)"
check_owned_port "${WEB_PORT:-3000}" web
check_owned_port "${QUANT_PORT:-8000}" quant

mapfile -t stopped_tools < <(docker ps -aq \
  --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
  --filter "label=com.docker.compose.service=migrate" \
  --filter status=exited)
if (( ${#stopped_tools[@]} > 0 )); then
  docker rm "${stopped_tools[@]}" >/dev/null
  echo "Removed ${#stopped_tools[@]} stopped deployment-tool container(s)."
fi

if docker ps -q \
  --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
  --filter "label=com.docker.compose.service=migrate" | grep -q .; then
  echo "A migration or validation container is still running. Wait for it or inspect it before deploying." >&2
  exit 1
fi

echo "Environment backup: $backup_file"
VALIDATION_TIMEOUT_SECONDS="${VALIDATION_TIMEOUT_SECONDS:-2400}" \
  bash scripts/deploy-vps-production.sh "$ENV_FILE"

echo "One-command deployment completed at commit $(git rev-parse --short=8 HEAD)."
