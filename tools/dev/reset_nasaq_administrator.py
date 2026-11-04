"""Reset and verify only the NEW site's Administrator password; never persist it."""
import getpass
import json
from pathlib import Path
import subprocess
import sys

status = Path("/mnt/c/Users/User/.codex/visualizations/2026/11/01/01a1986c-dd33-7182-ab8f-1a85c8f9eb22/atelier-cloud-work/administrator-reset.status")
status.write_text("waiting-for-input\n")
print("Reset only nasaq.localhost. development.localhost is not changed.")
while True:
    password = getpass.getpass("NEW Administrator password: ")
    confirm = getpass.getpass("Confirm NEW Administrator password: ")
    if password and password == confirm:
        break
    print("Passwords must be nonempty and match. Try again.")

code = '''import json, os, sys
import frappe
from frappe.utils.password import check_password, update_password
import requests
password = json.load(sys.stdin)["password"]
os.chdir("sites")
frappe.init("nasaq.localhost")
frappe.connect()
assert frappe.local.site == "nasaq.localhost"
update_password("Administrator", password, logout_all_sessions=True)
frappe.db.commit()
assert check_password("Administrator", password) == "Administrator"
frappe.destroy()
session = requests.Session()
response = session.post("http://nasaq.localhost:8001/api/method/login", json={"usr":"Administrator","pwd":password}, timeout=30)
assert response.status_code == 200, "HTTP login status: " + str(response.status_code)
assert session.cookies.get("sid") not in (None, "Guest"), "No authenticated session was issued"
session.get("http://nasaq.localhost:8001/api/method/logout", timeout=30)
print("PASSWORD_SET_AND_HTTP_LOGIN_VERIFIED")
'''
status.write_text("verifying\n")
result = subprocess.run([
    "docker", "exec", "-i", "-w", "/workspace/development/frappe-bench", "erpdev-frappe-1", "env/bin/python", "-c", code,
], input=json.dumps({"password": password}), capture_output=True, text=True)
output = (result.stdout + result.stderr).replace(password, "[REDACTED]")
del password, confirm
print(output)
status.write_text("verified\n" if result.returncode == 0 else "failed\n")
if result.returncode:
    (status.parent / "administrator-reset-redacted.log").write_text(output)
sys.exit(result.returncode)
