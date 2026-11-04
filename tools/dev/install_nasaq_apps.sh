#!/usr/bin/env bash
# Register the mounted app in the bench, then install ERPNext and Atelier on the clean site.
# Installs no demo data. Safe to re-run: apps already installed are skipped.
set -eu
. "$(dirname "$(readlink -f "$0")")/lib.sh"
compose exec -T -w /workspace/development/frappe-bench frappe bash -lc '
  set -eu
  grep -qx atelier sites/apps.txt || echo atelier >> sites/apps.txt
  env/bin/python -m pip install --quiet -e apps/atelier
  installed=$(bench --site nasaq.localhost list-apps)
  echo "$installed" | grep -q "^erpnext" || bench --site nasaq.localhost install-app erpnext
  echo "$installed" | grep -q "^atelier" || bench --site nasaq.localhost install-app atelier
  bench --site nasaq.localhost migrate
  bench --site nasaq.localhost list-apps
'
