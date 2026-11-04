. "$(dirname "$(readlink -f "$0")")/lib.sh"
B="$FRAPPE_DOCKER_DIR/development"/frappe-bench/apps
ls $B/frappe/node_modules/vue/dist/ 2>/dev/null | head; cat $B/frappe/node_modules/vue/package.json | grep '"version"'
ls $B/frappe/frappe/www | head -40
grep -rn "class StaticPage" -A15 $B/frappe/frappe/website/page_renderers/static_page.py | head -30
grep -n "def get_balance_on" $B/erpnext/erpnext/accounts/utils.py
