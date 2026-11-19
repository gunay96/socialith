#!/bin/sh
# Restore a backup made by backup-mysql.sh (see docs/OPERATIONS_RUNBOOK.md).
#
#   # 1) SAFE restore drill — into a separate scratch database; the live one is untouched:
#   docker compose … --profile tools run --rm -e TARGET_DB=socialith_restore_check backup \
#       sh /scripts/restore-mysql.sh /backups/mysql/socialith-<ts>.sql.gz
#
#   # 2) Real restore over the live database — DESTRUCTIVE. Stop api + worker first, and confirm explicitly:
#   docker compose … stop api worker
#   docker compose … --profile tools run --rm -e CONFIRM_RESTORE=yes backup \
#       sh /scripts/restore-mysql.sh /backups/mysql/socialith-<ts>.sql.gz
#
# Verifies the checksum first. Overwriting the live database requires
# CONFIRM_RESTORE=yes; restoring into any other TARGET_DB does not (it creates
# that database if missing).
set -eu

file="${1:?usage: restore-mysql.sh <backup.sql.gz>}"
: "${MYSQL_HOST:=mysql}" "${MYSQL_DATABASE:?}" "${MYSQL_MIGRATE_USER:?}" "${MYSQL_MIGRATE_PASSWORD:?}"
target="${TARGET_DB:-$MYSQL_DATABASE}"

[ -f "$file" ] || { echo "no such file: $file" >&2; exit 1; }

if [ -f "$file.sha256" ]; then
  ( cd "$(dirname "$file")" && sha256sum -c "$(basename "$file").sha256" ) || { echo "checksum mismatch — refusing to restore" >&2; exit 1; }
else
  echo "WARNING: no .sha256 next to the backup; only gzip integrity is checked" >&2
fi
gzip -t "$file"

if [ "$target" = "$MYSQL_DATABASE" ] && [ "${CONFIRM_RESTORE:-}" != "yes" ]; then
  echo "Refusing to overwrite the live database '$target' without CONFIRM_RESTORE=yes (stop api and worker first)." >&2
  exit 2
fi

export MYSQL_PWD="$MYSQL_MIGRATE_PASSWORD"
mysql -h "$MYSQL_HOST" -u "$MYSQL_MIGRATE_USER" -e "CREATE DATABASE IF NOT EXISTS \`$target\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
gunzip -c "$file" | mysql -h "$MYSQL_HOST" -u "$MYSQL_MIGRATE_USER" --default-character-set=utf8mb4 "$target"

tables=$(mysql -h "$MYSQL_HOST" -u "$MYSQL_MIGRATE_USER" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$target'")
echo "OK restored $file into '$target' ($tables tables)"
