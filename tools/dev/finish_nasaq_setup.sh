#!/usr/bin/env bash
set -eu
cd "$HOME/erp/frappe_docker"
docker compose -p erpdev -f .devcontainer/docker-compose.yml exec -T \
  -w /workspace/development/frappe-bench frappe /home/frappe/.local/bin/bench \
  --site nasaq.localhost execute frappe.desk.page.setup_wizard.setup_wizard.setup_complete \
  --kwargs '{"args":{"language":"ar","country":"Algeria","timezone":"Africa/Algiers","currency":"DZD","company_name":"نَسَق للطباعة","company_abbr":"NSQ","chart_of_accounts":"Algerie - Plan Comptable General 2 avec code","fy_start_date":"2026-01-01","fy_end_date":"2026-12-31","setup_demo":0,"enable_telemetry":0}}'
