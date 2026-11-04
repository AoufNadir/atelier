. "$(dirname "$(readlink -f "$0")")/lib.sh"
cd "$FRAPPE_DOCKER_DIR"
ls development; cat development/apps-example.json
grep -nE 'add_argument|default=|"bench' development/installer.py
