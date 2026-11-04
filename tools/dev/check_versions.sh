#!/usr/bin/env bash
for r in frappe/erpnext frappe/frappe frappe/frappe_docker; do
  echo "== $r"; curl -s https://api.github.com/repos/$r/releases/latest | grep -E '"(tag_name|published_at)"'
done
echo "== erpnext version branches"; curl -s "https://api.github.com/repos/frappe/erpnext/branches?per_page=100" | grep -o '"name": "version-[0-9]*"'
echo "== licenses"; for r in erpnext frappe hrms; do echo "-- $r"; curl -s https://api.github.com/repos/frappe/$r/license | grep -E '"spdx_id"'; done
grep VERSION_CODENAME /etc/os-release
