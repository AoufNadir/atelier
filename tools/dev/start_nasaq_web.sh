#!/usr/bin/env bash
# Serve ONLY the new site, without restarting the existing development server.
set -eu
cd "$HOME/erp/frappe_docker"
if ! docker exec erpdev-frappe-1 /workspace/development/frappe-bench/env/bin/python -c \
  'import socket,sys; s=socket.socket(); sys.exit(s.connect_ex(("127.0.0.1",8001)))'; then
  docker exec -d -w /workspace/development/frappe-bench erpdev-frappe-1 bash -lc \
    'exec bench --site nasaq.localhost serve --port 8001 --noreload > logs/nasaq-web.log 2>&1'
fi
if ! python3 -c 'import socket,sys; s=socket.socket(); sys.exit(s.connect_ex(("127.0.0.1",8001)))'; then
  nohup python3 /mnt/f/App/ERP/scripts/nasaq_local_proxy.py \
    > /mnt/c/Users/User/.codex/visualizations/2026/11/01/01a1986c-dd33-7182-ab8f-1a85c8f9eb22/atelier-cloud-work/nasaq-proxy.log 2>&1 < /dev/null &
fi
echo 'New site URL: http://nasaq.localhost:8001/atelier-login'
