#!/usr/bin/env bash
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# Local startup with the new site's PDF hostname mapping. No site is created,
# migrated, reset, copied or deleted by this script.
set -eu
cd "$FRAPPE_DOCKER_DIR"
compose up -d
exec bash "$NASAQ_TOOLS_DIR/dc.sh" 'bench start'
