#!/usr/bin/env bash
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# Serve ONLY the new site, without restarting the existing development server.
set -eu
cd "$FRAPPE_DOCKER_DIR"
if ! docker exec "$FRAPPE_CONTAINER" /workspace/development/frappe-bench/env/bin/python -c \
  'import socket,sys; s=socket.socket(); sys.exit(s.connect_ex(("127.0.0.1",8001)))'; then
  docker exec -d -w /workspace/development/frappe-bench "$FRAPPE_CONTAINER" bash -lc \
    'exec bench --site nasaq.localhost serve --port 8001 --noreload > logs/nasaq-web.log 2>&1'
fi
if ! python3 -c 'import socket,sys; s=socket.socket(); sys.exit(s.connect_ex(("127.0.0.1",8001)))'; then
  nohup python3 "$NASAQ_TOOLS_DIR/nasaq_local_proxy.py" \
    > "$NASAQ_STATE_DIR/nasaq-proxy.log" 2>&1 < /dev/null &
fi
echo 'New site URL: http://nasaq.localhost:8001/atelier-login'
