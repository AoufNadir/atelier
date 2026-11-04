#!/usr/bin/env bash
# Local startup with the new site's PDF hostname mapping. No site is created,
# migrated, reset, copied or deleted by this script.
set -eu
cd "$HOME/erp/frappe_docker"
docker compose -p erpdev -f .devcontainer/docker-compose.yml \
  -f .devcontainer/compose.ports.yml -f /mnt/f/App/ERP/scripts/compose.nasaq.yml up -d
exec bash /mnt/f/App/ERP/scripts/dc.sh 'bench start'
