#!/bin/sh
# Consistent logical backup of the Socialith database (runs inside the
# `backup` compose service; see docs/OPERATIONS_RUNBOOK.md).
#
#   docker compose -f infra/vps/docker-compose.yml --env-file infra/vps/.env \
#       --profile tools run --rm backup sh /scripts/backup-mysql.sh
#
# --single-transaction gives a consistent InnoDB snapshot WITHOUT locking the
# running application. Output: /backups/mysql/socialith-<UTC timestamp>.sql.gz
# plus a .sha256. The file is written under a temporary name, verified, and
# only then renamed — a half-written backup is never mistaken for a good one.
set -eu

: "${MYSQL_HOST:=mysql}" "${MYSQL_DATABASE:?}" "${MYSQL_BACKUP_USER:?}" "${MYSQL_BACKUP_PASSWORD:?}"
: "${BACKUP_RETENTION_DAYS:=14}"

dir=/backups/mysql
mkdir -p "$dir"
ts=$(date -u +%Y%m%dT%H%M%SZ)
final="$dir/socialith-$ts.sql.gz"
tmp="$final.partial"

MYSQL_PWD="$MYSQL_BACKUP_PASSWORD" mysqldump \
  -h "$MYSQL_HOST" -u "$MYSQL_BACKUP_USER" \
  --single-transaction --routines --triggers --no-tablespaces \
  --set-gtid-purged=OFF --default-character-set=utf8mb4 \
  "$MYSQL_DATABASE" | gzip -9 > "$tmp"

# Verify before trusting it: valid gzip, ends with mysqldump's completion marker, non-trivial size.
gzip -t "$tmp"
gunzip -c "$tmp" | tail -n 3 | grep -q "Dump completed" || { echo "backup incomplete: no 'Dump completed' marker" >&2; rm -f "$tmp"; exit 1; }
size=$(wc -c < "$tmp")
[ "$size" -gt 2000 ] || { echo "backup suspiciously small ($size bytes)" >&2; rm -f "$tmp"; exit 1; }

mv "$tmp" "$final"
( cd "$dir" && sha256sum "$(basename "$final")" > "$(basename "$final").sha256" )

# Retention: keep BACKUP_RETENTION_DAYS days of dumps.
find "$dir" -name 'socialith-*.sql.gz*' -type f -mtime +"$BACKUP_RETENTION_DAYS" -delete

echo "OK $final ($size bytes)"
