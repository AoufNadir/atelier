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
# Customer and card folders. Override NASAQ_FILES_DIR in nasaq.env for another drive.
if [ -z "${NASAQ_FILES_DIR:-}" ]; then
  if [ -d /mnt/d ]; then NASAQ_FILES_DIR="/mnt/d/نسق"; else NASAQ_FILES_DIR="$NASAQ_STATE_DIR/files"; fi
fi
export NASAQ_FILES_DIR
mkdir -p "$NASAQ_FILES_DIR" 2>/dev/null || true

# The app is mounted into the bench, so this checkout is the only copy of the code.
# The mount is added only once the bench exists: a mount point would create the
# frappe-bench folder early and make the installer skip it.
compose() {
  local files=(-f .devcontainer/docker-compose.yml)
  [ -f "$FRAPPE_DOCKER_DIR/.devcontainer/compose.ports.yml" ] && files+=(-f .devcontainer/compose.ports.yml)
  # env/bin/python points into the container's pyenv installation, so it cannot
  # be resolved on the WSL host. The regular venv config survives that boundary.
  [ -f "$FRAPPE_DOCKER_DIR/development/frappe-bench/env/pyvenv.cfg" ] && files+=(-f "$NASAQ_TOOLS_DIR/compose.nasaq.yml")
  (cd "$FRAPPE_DOCKER_DIR" && docker compose -p "$NASAQ_COMPOSE_PROJECT" "${files[@]}" "$@")
}
