#!/usr/bin/env bash
set -eu
cd "$HOME/erp/frappe_docker"
docker compose -p erpdev -f .devcontainer/docker-compose.yml exec -T frappe \
  sh -c 'cat > /tmp/verify_nasaq_site.py' < /mnt/f/App/ERP/scripts/verify_nasaq_site.py
docker compose -p erpdev -f .devcontainer/docker-compose.yml exec -T \
  -w /workspace/development/frappe-bench/sites frappe /workspace/development/frappe-bench/env/bin/python -c \
  'import frappe; frappe.init("nasaq.localhost"); frappe.connect(); exec(compile(open("/tmp/verify_nasaq_site.py").read(), "/tmp/verify_nasaq_site.py", "exec")); frappe.destroy()'
