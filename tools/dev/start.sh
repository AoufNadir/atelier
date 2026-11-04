#!/usr/bin/env bash
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# Start the dev containers and the Frappe dev server (http://development.localhost:8000)
cd "$FRAPPE_DOCKER_DIR"
compose up -d
exec bash "$NASAQ_TOOLS_DIR/dc.sh" "bench start"
