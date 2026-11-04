#!/usr/bin/env bash
. "$(dirname "$(readlink -f "$0")")/lib.sh"
set -eu
cd "$FRAPPE_DOCKER_DIR"
compose exec -T \
  -w /workspace/development/frappe-bench frappe /home/frappe/.local/bin/bench \
  --site nasaq.localhost set-config host_name http://nasaq.localhost:8001
docker exec -u 0 "$FRAPPE_CONTAINER" sh -c \
  'grep -q "[[:space:]]nasaq[.]localhost\([[:space:]]\|$\)" /etc/hosts || printf "\n127.0.0.1 nasaq.localhost\n" >> /etc/hosts'
