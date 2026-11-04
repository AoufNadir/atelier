#!/usr/bin/env bash
set -eu
cd "$HOME/erp/frappe_docker"
docker compose -p erpdev -f .devcontainer/docker-compose.yml exec -T \
  -w /workspace/development/frappe-bench frappe /home/frappe/.local/bin/bench \
  --site nasaq.localhost set-config host_name http://nasaq.localhost:8001
docker exec -u 0 erpdev-frappe-1 sh -c \
  'grep -q "[[:space:]]nasaq[.]localhost\([[:space:]]\|$\)" /etc/hosts || printf "\n127.0.0.1 nasaq.localhost\n" >> /etc/hosts'
