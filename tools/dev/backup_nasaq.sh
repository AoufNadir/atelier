#!/usr/bin/env bash
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# Daily backup of the real site (database + files) copied to a folder outside the computer's
# bench, e.g. the Google Drive for desktop folder. Keeps the newest $KEEP sets there.
# Usage: backup_nasaq.sh /mnt/g/My\ Drive/raqmi-backups
set -eu
DEST="${1:?destination folder}"
KEEP="${NASAQ_BACKUP_KEEP:-14}"
SITE="${NASAQ_SITE:-nasaq.localhost}"
docker exec -w /workspace/development/frappe-bench "$FRAPPE_CONTAINER" bash -lc "bench --site $SITE backup --with-files" >/dev/null
SRC="$FRAPPE_DOCKER_DIR/development/frappe-bench/sites/$SITE/private/backups"
stamp=$(ls -1t "$SRC" | grep -- '-database.sql.gz$' | head -1 | sed 's/-database.sql.gz$//')
[ -n "$stamp" ] || { echo "no backup produced" >&2; exit 1; }
mkdir -p "$DEST/$stamp"
cp "$SRC/$stamp"* "$DEST/$stamp/"
# a backup set = one folder per run; drop the oldest beyond KEEP
ls -1d "$DEST"/*/ 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do rm -rf "$old"; done
echo "backup: $DEST/$stamp ($(du -sh "$DEST/$stamp" | cut -f1))"
