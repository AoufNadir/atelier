#!/usr/bin/env bash
# One command for a prepared computer (WSL + Docker): bench, clean site, apps, verification.
# Stops on the first failure and never replaces an existing site.
set -eu
D="$(dirname "$(readlink -f "$0")")"
. "$D/lib.sh"
docker info >/dev/null 2>&1 || { echo 'Docker is not reachable. Run install_docker.sh, then reopen WSL.'; exit 1; }
bash "$D/setup_dev.sh"
if [ ! -d "$FRAPPE_DOCKER_DIR/development/frappe-bench/sites/nasaq.localhost" ]; then
  python3 "$D/create_nasaq_with_container_credentials.py"
  bash "$D/install_nasaq_apps.sh"
  bash "$D/finish_nasaq_setup.sh"
else
  echo 'nasaq.localhost already exists; keeping it.'
  bash "$D/install_nasaq_apps.sh"
fi
bash "$D/configure_nasaq_pdf_host.sh"
bash "$D/run_nasaq_verification.sh"
echo 'BOOTSTRAP_DONE. Start it with tools/dev/Start-Nasaq.ps1'
