#!/usr/bin/env bash
# run a command inside the frappe dev container, in frappe-bench
cd ~/erp/frappe_docker
docker compose -p erpdev -f .devcontainer/docker-compose.yml exec -T frappe bash -lc "cd /workspace/development/frappe-bench && $*"
