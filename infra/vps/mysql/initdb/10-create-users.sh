#!/bin/sh
# Runs ONCE, on the first start of an empty MySQL data volume (official image
# convention). Creates three least-privilege accounts:
#   app     DML only            — api and worker at runtime
#   migrate full DDL on this DB — the one-shot `migrate` service and restores
#   backup  read + lock         — mysqldump
# Passwords are hex strings from infra/vps/.env (so they need no URL-encoding
# in DATABASE_URL). Nothing is echoed.
set -eu

: "${MYSQL_ROOT_PASSWORD:?}" "${MYSQL_DATABASE:?}"
: "${MYSQL_APP_USER:?}" "${MYSQL_APP_PASSWORD:?}"
: "${MYSQL_MIGRATE_USER:?}" "${MYSQL_MIGRATE_PASSWORD:?}"
: "${MYSQL_BACKUP_USER:?}" "${MYSQL_BACKUP_PASSWORD:?}"

mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE USER IF NOT EXISTS '${MYSQL_APP_USER}'@'%' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_APP_USER}'@'%';

CREATE USER IF NOT EXISTS '${MYSQL_MIGRATE_USER}'@'%' IDENTIFIED BY '${MYSQL_MIGRATE_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_MIGRATE_USER}'@'%';

CREATE USER IF NOT EXISTS '${MYSQL_BACKUP_USER}'@'%' IDENTIFIED BY '${MYSQL_BACKUP_PASSWORD}';
GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES ON \`${MYSQL_DATABASE}\`.* TO '${MYSQL_BACKUP_USER}'@'%';

FLUSH PRIVILEGES;
SQL
