#!/usr/bin/env bash
. "$(dirname "$(readlink -f "$0")")/lib.sh"
set -eu
NASAQ_COMPANY_NAME="${NASAQ_COMPANY_NAME:-نَسَق للطباعة}"
NASAQ_COMPANY_ABBR="${NASAQ_COMPANY_ABBR:-NSQ}"
NASAQ_FISCAL_YEAR="${NASAQ_FISCAL_YEAR:-$(date +%Y)}"
args_json=$(printf '{"args":{"language":"ar","country":"Algeria","timezone":"Africa/Algiers","currency":"DZD","company_name":"%s","company_abbr":"%s","chart_of_accounts":"Algerie - Plan Comptable General 2 avec code","fy_start_date":"%s-01-01","fy_end_date":"%s-12-31","setup_demo":0,"enable_telemetry":0}}' "$NASAQ_COMPANY_NAME" "$NASAQ_COMPANY_ABBR" "$NASAQ_FISCAL_YEAR" "$NASAQ_FISCAL_YEAR")
compose exec -T \
  -w /workspace/development/frappe-bench frappe /home/frappe/.local/bin/bench \
  --site nasaq.localhost execute frappe.desk.page.setup_wizard.setup_wizard.setup_complete \
  --kwargs "$args_json"
