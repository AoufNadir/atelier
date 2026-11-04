# Shared settings for tools/dev. Sourced by the other scripts; contains no secrets.
# Paths come from this file's own location, so the repository can live anywhere.
NASAQ_TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export NASAQ_TOOLS_DIR

# Optional per-computer overrides (git-ignored; see nasaq.env.example).
if [ -f "$NASAQ_TOOLS_DIR/nasaq.env" ]; then
  . "$NASAQ_TOOLS_DIR/nasaq.env"
fi

export FRAPPE_DOCKER_DIR="${FRAPPE_DOCKER_DIR:-$HOME/erp/frappe_docker}"
export NASAQ_COMPOSE_PROJECT="${NASAQ_COMPOSE_PROJECT:-erpdev}"
export NASAQ_STATE_DIR="${NASAQ_STATE_DIR:-$HOME/.local/state/nasaq}"
export NASAQ_APP_DIR="${NASAQ_APP_DIR:-$(cd "$NASAQ_TOOLS_DIR/../.." && pwd)}"
export FRAPPE_CONTAINER="${NASAQ_COMPOSE_PROJECT}-frappe-1"
export MARIADB_CONTAINER="${NASAQ_COMPOSE_PROJECT}-mariadb-1"
mkdir -p "$NASAQ_STATE_DIR"

# The app is mounted into the bench, so this checkout is the only copy of the code.
# The mount is added only once the bench exists: a mount point would create the
# frappe-bench folder early and make the installer skip it.
compose() {
  local files=(-f .devcontainer/docker-compose.yml)
  [ -f "$FRAPPE_DOCKER_DIR/.devcontainer/compose.ports.yml" ] && files+=(-f .devcontainer/compose.ports.yml)
  [ -x "$FRAPPE_DOCKER_DIR/development/frappe-bench/env/bin/python" ] && files+=(-f "$NASAQ_TOOLS_DIR/compose.nasaq.yml")
  (cd "$FRAPPE_DOCKER_DIR" && docker compose -p "$NASAQ_COMPOSE_PROJECT" "${files[@]}" "$@")
}
