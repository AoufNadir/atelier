#!/usr/bin/env bash
. "$(dirname "$(readlink -f "$0")")/lib.sh"
set -eu

cd "$FRAPPE_DOCKER_DIR"
status="$NASAQ_STATE_DIR/site-creation.status"
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
if compose exec frappe bash -lc \
  'cd /workspace/development/frappe-bench && bench new-site nasaq.localhost --db-type mariadb --db-root-username root --mariadb-user-host-login-scope=%'; then
  printf 'created\n' > "$status"
  echo 'NEW SITE CREATED. Next: tools/dev/install_nasaq_apps.sh'
else
  code=$?
  printf 'failed:%s\n' "$code" > "$status"
  echo 'Creation did not finish. Do not delete or reset a site; keep the error and investigate.'
fi
