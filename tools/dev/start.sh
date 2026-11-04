#!/usr/bin/env bash
# Start the dev containers and the Frappe dev server (http://development.localhost:8000)
cd ~/erp/frappe_docker
docker compose -p erpdev -f .devcontainer/docker-compose.yml -f .devcontainer/compose.ports.yml up -d
exec bash /mnt/f/App/ERP/scripts/dc.sh "bench start"
