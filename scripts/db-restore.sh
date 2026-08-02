#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/db-restore.sh <backup-file.dump>"
  exit 1
fi

BACKUP_FILE="$1"
CONTAINER="${POSTGRES_CONTAINER:-orb-guide-postgres}"
DATABASE_URL="${DATABASE_URL:-postgres://orb_user:orb_password@localhost:5433/orb_guide}"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Backup file not found: $BACKUP_FILE"
  exit 1
fi

if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  cat "$BACKUP_FILE" | docker exec -i "$CONTAINER" pg_restore -U orb_user -d orb_guide --clean --if-exists --no-owner
else
  pg_restore "$DATABASE_URL" --clean --if-exists --no-owner "$BACKUP_FILE"
fi

echo "Restore complete from: $BACKUP_FILE"
