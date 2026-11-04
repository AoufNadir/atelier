for r in erpnext frappe; do echo "== $r"; curl -s "https://api.github.com/repos/frappe/$r/releases?per_page=40" | grep -E '"tag_name"' | sort -V -r -u | head -6; done
for b in version-16 version-15 version-17; do printf "$b: "; curl -s -o /dev/null -w "%{http_code}\n" https://api.github.com/repos/frappe/erpnext/branches/$b; done
curl -s https://raw.githubusercontent.com/frappe/frappe_docker/main/development/installer.py | grep -n -iE "version-1|python|node" | head -20
curl -s https://raw.githubusercontent.com/frappe/frappe_docker/main/example.env | head -20
