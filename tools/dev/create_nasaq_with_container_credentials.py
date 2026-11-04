"""Create only nasaq.localhost; keep credentials in memory and preserve failed attempts."""
import getpass
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime

project = Path(os.environ.get("FRAPPE_DOCKER_DIR", Path.home() / "erp/frappe_docker"))
bench = project / "development/frappe-bench"
frappe_container = os.environ.get("NASAQ_COMPOSE_PROJECT", "erpdev") + "-frappe-1"
mariadb_container = os.environ.get("NASAQ_COMPOSE_PROJECT", "erpdev") + "-mariadb-1"
site = bench / "sites/nasaq.localhost"
state_dir = Path(os.environ.get("NASAQ_STATE_DIR", Path.home() / ".local/state/nasaq"))
state_dir.mkdir(parents=True, exist_ok=True)
status = state_dir / "site-creation.status"

def database_query(sql):
    result = subprocess.run([
        "docker", "exec", mariadb_container, "sh", "-c",
        'MYSQL_PWD="${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}" exec mariadb -uroot --batch --skip-column-names -e "$1"',
        "query", sql,
    ], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("Configured MariaDB credential could not be used; no credential was displayed.")
    return result.stdout.strip()

if site.exists():
    config = json.loads((site / "site_config.json").read_text())
    database = config["db_name"]
    if not re.fullmatch(r"[A-Za-z0-9_]+", database):
        raise RuntimeError("Unexpected database identifier; stopping.")
    if database_query(f"SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='{database}'") != "0":
        raise RuntimeError("The new site's database already exists. Stopping without replacing or deleting anything.")
    recovery = bench / "private/site-creation-recovery" / ("nasaq.localhost-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    if site.resolve() != (bench.resolve() / "sites/nasaq.localhost"):
        raise RuntimeError("Unexpected source path.")
    if not recovery.resolve().is_relative_to(bench.resolve() / "private/site-creation-recovery"):
        raise RuntimeError("Unexpected recovery path.")
    recovery.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(recovery.parent, 0o700)
    site.rename(recovery)
    print("Preserved incomplete attempt:", recovery)

print("Create the clean nasaq.localhost site. Existing development.localhost is not changed.")
print("MariaDB uses its existing Docker credential, without displaying or saving it.")
status.write_text("waiting-for-new-administrator-password\n")
while True:
    administrator = getpass.getpass("Choose NEW site Administrator password: ")
    confirm = getpass.getpass("Confirm NEW site Administrator password: ")
    if administrator and administrator == confirm:
        break
    print("Passwords must be nonempty and match. Try again.")

root = subprocess.check_output([
    "docker", "exec", mariadb_container, "sh", "-c",
    'printf %s "${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}"',
], text=True)
if not root:
    raise RuntimeError("No configured database credential; stopping.")
code = '''import json, os, sys
from frappe.commands.site import new_site
credentials = json.load(sys.stdin)
os.chdir("sites")
new_site.callback(site="nasaq.localhost", db_type="mariadb", db_root_username="root", db_root_password=credentials["root"], admin_password=credentials["admin"], mariadb_user_host_login_scope="%", set_default=False)
'''
status.write_text("creating\n")
result = subprocess.run([
    "docker", "exec", "-i", "-w", "/workspace/development/frappe-bench", frappe_container, "env/bin/python", "-c", code,
], cwd=project, input=json.dumps({"root": root, "admin": administrator}), text=True, capture_output=True)
safe_output = result.stdout + result.stderr
for secret in (root, administrator, confirm):
    safe_output = safe_output.replace(secret, "[REDACTED]")
(status.parent / "site-creation-redacted.log").write_text(safe_output)
print(safe_output)
del root, administrator, confirm
status.write_text("created\n" if result.returncode == 0 else f"failed:{result.returncode}\n")
if result.returncode:
    print("Creation failed. No site was deleted. Keep the error and investigate.")
    sys.exit(result.returncode)
print("NEW SITE CREATED. Next: tools/dev/install_nasaq_apps.sh")
