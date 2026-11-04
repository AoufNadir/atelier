. "$(dirname "$(readlink -f "$0")")/lib.sh"
cd "$NASAQ_TOOLS_DIR/../.."
git add -A && git commit -q -F - && git log --oneline | head -3
