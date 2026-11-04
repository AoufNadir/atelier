#!/usr/bin/env bash
# Load changed Python: the site's web process runs with --noreload. Data is not touched.
set -eu
. "$(dirname "$(readlink -f "$0")")/lib.sh"
docker exec "$FRAPPE_CONTAINER" pkill -f 'serve --port 8001' || true
sleep 2
bash "$NASAQ_TOOLS_DIR/start_nasaq_web.sh"
