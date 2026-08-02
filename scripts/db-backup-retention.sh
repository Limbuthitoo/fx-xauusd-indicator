#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups/postgres}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
find "$BACKUP_DIR" -type f -name "orb_guide_*.dump" -mtime +"$RETENTION_DAYS" -print -delete
echo "Backup retention complete: kept files newer than $RETENTION_DAYS day(s)."
