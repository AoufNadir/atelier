#!/usr/bin/env bash
# A site created without --mariadb-user-host-login-scope=% has its database user tied to the Frappe container's
# address at that time; after a restart the address changes and MariaDB answers «Access denied (1045)».
# This re-attaches that one user to any host. Data and password are untouched. Usage: fix_site_db_host.sh <site>
set -eu
. "$(dirname "$(readlink -f "$0")")/lib.sh"
SITE="${1:?site name, e.g. test-tour.localhost}"
DB=$(bash "$NASAQ_TOOLS_DIR/dc.sh" "python3 -c 'import json;print(json.load(open(\"sites/$SITE/site_config.json\"))[\"db_name\"])'" | tail -1)
[ -n "$DB" ] || { echo "db_name not found for $SITE"; exit 1; }
docker exec -i "$MARIADB_CONTAINER" sh -c 'mariadb -uroot -p"${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}"' <<SQL
SET @u = '$DB';
SELECT CONCAT('before: ', GROUP_CONCAT(Host)) FROM mysql.user WHERE User=@u;
SET @h = (SELECT Host FROM mysql.user WHERE User=@u AND Host<>'%' LIMIT 1);
SET @q = IF(@h IS NULL OR EXISTS(SELECT 1 FROM mysql.user WHERE User=@u AND Host='%'), 'DO 0', CONCAT('RENAME USER ''', @u, '''@''', @h, ''' TO ''', @u, '''@''%'''));
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
FLUSH PRIVILEGES;
SELECT CONCAT('after: ', GROUP_CONCAT(Host)) FROM mysql.user WHERE User=@u;
SQL
echo "Done. Reload http://$SITE:8002 (or the port that site uses)."
