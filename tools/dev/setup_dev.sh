#!/usr/bin/env bash
# Frappe/ERPNext v16 dev environment, per frappe_docker/docs (development) without VS Code.
set -euo pipefail
cd ~/erp/frappe_docker
[ -d .devcontainer ] || cp -R devcontainer-example .devcontainer
# Ports normally forwarded by devcontainer.json
cat > .devcontainer/compose.ports.yml <<'Y'
services:
  frappe:
    ports:
      - "8000:8000"
      - "9000:9000"
Y
docker compose -p erpdev -f .devcontainer/docker-compose.yml -f .devcontainer/compose.ports.yml up -d
sleep 15
docker compose -p erpdev -f .devcontainer/docker-compose.yml exec -T frappe bash -lc \
  'cd /workspace/development && [ -d frappe-bench ] || python3 installer.py --apps-json apps-example.json --frappe-branch version-16'
echo "SETUP_DONE"
