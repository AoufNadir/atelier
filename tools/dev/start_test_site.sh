#!/usr/bin/env bash
# Serve a separate test site on its own port, beside the main site (8001), after loading new code.
# Usage: start_test_site.sh <site> [port]   e.g. start_test_site.sh test-tour.localhost 8002
# Restarts only that port's web process; the main site and the data are untouched.
set -eu
. "$(dirname "$(readlink -f "$0")")/lib.sh"
SITE="${1:?site name, e.g. test-tour.localhost}"
PORT="${2:-8002}"
[ "$PORT" != 8001 ] || { echo "8001 is the main site; use restart_nasaq_web.sh for it"; exit 1; }
docker exec "$FRAPPE_CONTAINER" pkill -f "serve --port $PORT" || true
sleep 2
docker exec -d -w /workspace/development/frappe-bench "$FRAPPE_CONTAINER" bash -lc \
  "exec bench --site $SITE serve --port $PORT --noreload > logs/$SITE-web.log 2>&1"
# host side: forward 127.0.0.1:$PORT to the container (restart it, the container address may have changed)
pkill -f "NASAQ_PORT=$PORT" 2>/dev/null || true
pkill -f "nasaq_local_proxy.py.*#$PORT" 2>/dev/null || true
sleep 1
nohup env NASAQ_PORT="$PORT" python3 "$NASAQ_TOOLS_DIR/nasaq_local_proxy.py" "#$PORT" \
  > "$NASAQ_STATE_DIR/proxy-$PORT.log" 2>&1 < /dev/null &
sleep 3
echo "Test site: http://$SITE:$PORT/atelier"
