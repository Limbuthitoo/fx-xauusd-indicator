#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups/postgres}"
TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
FILE="$BACKUP_DIR/orb_guide_$TIMESTAMP.dump"
CONTAINER="${POSTGRES_CONTAINER:-orb-guide-postgres}"
DATABASE_URL="${DATABASE_URL:-postgres://orb_user:orb_password@localhost:5433/orb_guide}"

mkdir -p "$BACKUP_DIR"

if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  docker exec "$CONTAINER" pg_dump -U orb_user -d orb_guide -Fc > "$FILE"
else
  pg_dump "$DATABASE_URL" -Fc > "$FILE"
fi

echo "Backup created: $FILE"
