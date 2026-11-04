"""Read-only diagnosis. Credentials stay inside the existing database container."""
import subprocess

result = subprocess.run([
    "docker", "exec", "erpdev-mariadb-1", "sh", "-c",
    'MYSQL_PWD="${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}" '
    'mariadb -uroot --batch --skip-column-names '
    '-e "SELECT User, Host FROM mysql.user WHERE User = \'root\';"',
], text=True, capture_output=True)
print("Configured database credential works locally:", result.returncode == 0)
if result.returncode == 0:
    print("Root login scopes:", result.stdout.strip())
else:
    print("Database check failed; no credential values were displayed.")
