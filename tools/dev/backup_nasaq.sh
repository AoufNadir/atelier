#!/usr/bin/env bash
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# Backup of the real site (database + files). Prints the folder holding the newest set, so the
# Windows side can copy it to a drive WSL cannot see (Google Drive for desktop is not mounted in WSL).
set -eu
SITE="${NASAQ_SITE:-nasaq.localhost}"
docker exec -w /workspace/development/frappe-bench "$FRAPPE_CONTAINER" bash -lc "bench --site $SITE backup --with-files" >/dev/null
SRC="$FRAPPE_DOCKER_DIR/development/frappe-bench/sites/$SITE/private/backups"
stamp=$(ls -1t "$SRC" | grep -- '-database.sql.gz$' | head -1 | sed 's/-database.sql.gz$//')
[ -n "$stamp" ] || { echo "no backup produced" >&2; exit 1; }
OUT="$NASAQ_STATE_DIR/backup-out/$stamp"
rm -rf "$NASAQ_STATE_DIR/backup-out" && mkdir -p "$OUT"
cp "$SRC/$stamp"* "$OUT/"
echo "$OUT"
