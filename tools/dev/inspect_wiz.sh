. "$(dirname "$(readlink -f "$0")")/lib.sh"
B="$FRAPPE_DOCKER_DIR/development"/frappe-bench/apps
grep -n "args\.\|args.get" $B/erpnext/erpnext/setup/setup_wizard/operations/install_fixtures.py | head -40
grep -n "def setup_complete\|def get_setup_stages\|args\." $B/frappe/frappe/desk/page/setup_wizard/setup_wizard.py | head -40
ls $B/erpnext/erpnext/accounts/doctype/account/chart_of_accounts/verified | grep -i -E "dz|alg|fr_" 
ls $B/frappe/frappe/translations | grep -E "^(ar|fr)"; ls $B/erpnext/erpnext/locale 2>/dev/null | grep -E "^(ar|fr)"
