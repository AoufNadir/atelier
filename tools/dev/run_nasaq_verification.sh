#!/usr/bin/env bash
. "$(dirname "$(readlink -f "$0")")/lib.sh"
set -eu
cd "$FRAPPE_DOCKER_DIR"
compose exec -T frappe \
  sh -c 'cat > /tmp/verify_nasaq_site.py' < "$NASAQ_TOOLS_DIR/verify_nasaq_site.py"
compose exec -T \
  -w /workspace/development/frappe-bench/sites frappe /workspace/development/frappe-bench/env/bin/python -c \
  'import frappe; frappe.init("nasaq.localhost"); frappe.connect(); exec(compile(open("/tmp/verify_nasaq_site.py").read(), "/tmp/verify_nasaq_site.py", "exec")); frappe.destroy()'
