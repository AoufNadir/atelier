#!/usr/bin/env bash
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# run a command inside the frappe dev container, in frappe-bench
cd "$FRAPPE_DOCKER_DIR"
compose exec -T frappe bash -lc "cd /workspace/development/frappe-bench && $*"
