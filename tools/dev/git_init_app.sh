cd ~/erp/frappe_docker/development/frappe-bench/apps/atelier
[ -d .git ] || { git init -q -b main; git config user.email demo@example.test; git config user.name "Atelier Dev"; git add -A; git commit -qm "Initial atelier app + demo data"; }
git log --oneline | head; find atelier -maxdepth 2 -not -path '*/__pycache__*' | sort; cat atelier/modules.txt
