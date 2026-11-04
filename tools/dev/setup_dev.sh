#!/usr/bin/env bash
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# Frappe/ERPNext v16 dev environment, per frappe_docker/docs (development) without VS Code.
set -euo pipefail
if [ ! -d "$FRAPPE_DOCKER_DIR" ]; then
  mkdir -p "$(dirname "$FRAPPE_DOCKER_DIR")"
  git clone --depth 1 https://github.com/frappe/frappe_docker "$FRAPPE_DOCKER_DIR"
fi
cd "$FRAPPE_DOCKER_DIR"
[ -d .devcontainer ] || cp -R devcontainer-example .devcontainer
# Ports normally forwarded by devcontainer.json
cat > .devcontainer/compose.ports.yml <<'Y'
services:
  frappe:
    ports:
      - "8000:8000"
      - "9000:9000"
Y
compose up -d
sleep 15
compose exec -T frappe bash -lc \
  'cd /workspace/development && [ -d frappe-bench ] || python3 installer.py --apps-json apps-example.json --frappe-branch version-16'
# The bench exists now, so this adds the app mount.
compose up -d
echo "SETUP_DONE"
