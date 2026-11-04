#!/usr/bin/env bash
set -eu
docker cp /mnt/f/App/ERP/scripts/inspect_nasaq_login.py erpdev-frappe-1:/tmp/inspect_nasaq_login.py
docker exec -w /workspace/development/frappe-bench/sites erpdev-frappe-1 \
  /workspace/development/frappe-bench/env/bin/python -c \
  'import frappe; frappe.init("nasaq.localhost"); frappe.connect(); exec(open("/tmp/inspect_nasaq_login.py").read()); frappe.destroy()'
