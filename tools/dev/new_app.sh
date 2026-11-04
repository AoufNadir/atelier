#!/usr/bin/env bash
set -e
D="$(dirname "$0")"
bash "$D/dc.sh" '[ -d apps/atelier ] || printf "Atelier\nGestion atelier (ERPNext)\nDemo Atelier\ndemo@example.test\ngpl-3.0\nn\nn\n" | bench new-app atelier --no-git; ls apps; bench --site development.localhost list-apps'
