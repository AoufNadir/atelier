#!/usr/bin/env bash
# Recreate the local demo site from scratch (DEV ONLY). Admin password = frappe_docker dev default.
set -e
D="$(dirname "$0")"
bash "$D/dc.sh" 'bench --site development.localhost reinstall --yes --admin-password admin --db-root-password 123 && bench --site development.localhost install-app erpnext atelier && bench --site development.localhost execute atelier.demo.setup && bench --site development.localhost execute frappe.db.count --args "[\"Account\"]"'
