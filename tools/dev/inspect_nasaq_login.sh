#!/usr/bin/env bash
. "$(dirname "$(readlink -f "$0")")/lib.sh"
set -eu
docker cp "$NASAQ_TOOLS_DIR/inspect_nasaq_login.py" "$FRAPPE_CONTAINER":/tmp/inspect_nasaq_login.py
docker exec -w /workspace/development/frappe-bench/sites "$FRAPPE_CONTAINER" \
  /workspace/development/frappe-bench/env/bin/python -c \
  'import frappe; frappe.init("nasaq.localhost"); frappe.connect(); exec(open("/tmp/inspect_nasaq_login.py").read()); frappe.destroy()'
