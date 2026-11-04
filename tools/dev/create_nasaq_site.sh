#!/usr/bin/env bash
set -eu

cd "$HOME/erp/frappe_docker"
status=/mnt/c/Users/User/.codex/visualizations/2026/11/01/01a1986c-dd33-7182-ab8f-1a85c8f9eb22/atelier-cloud-work/site-creation.status
if test -e development/frappe-bench/sites/nasaq.localhost; then
  echo 'nasaq.localhost already exists. Stopping without changing it.'
  printf 'already-exists\n' > "$status"
  exit 1
fi

echo 'Create the NEW site: nasaq.localhost'
echo 'Enter the MariaDB root password, then choose and confirm the new Administrator password.'
echo 'Passwords are entered privately in this terminal. Do not paste them into the chat.'
echo 'The existing development.localhost site will not be changed.'
printf 'waiting-for-input\n' > "$status"
if docker compose -p erpdev -f .devcontainer/docker-compose.yml exec frappe bash -lc \
  'cd /workspace/development/frappe-bench && bench new-site nasaq.localhost --db-type mariadb --db-root-username root --mariadb-user-host-login-scope=%'; then
  printf 'created\n' > "$status"
  echo 'NEW SITE CREATED. Return to Codex so the apps and clean setup can be installed.'
else
  code=$?
  printf 'failed:%s\n' "$code" > "$status"
  echo 'Creation did not finish. Do not delete or reset a site; return to Codex with the error.'
fi
