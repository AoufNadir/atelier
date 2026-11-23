#!/usr/bin/env bash
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# Records where the last backup went (drive | local) so the morning summary can warn. Data is not touched.
set -eu
docker exec -w /workspace/development/frappe-bench "$FRAPPE_CONTAINER" bash -lc \
  "bench --site ${NASAQ_SITE:-nasaq.localhost} execute atelier.backup_status.mark --args \"['$1']\"" >/dev/null
