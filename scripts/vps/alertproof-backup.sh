#!/usr/bin/env bash
# Encrypted nightly logical backup of the AlertProof Postgres database.
#
# Output: /var/backups/alertproof/alertproof-YYYYmmdd-HHMMSS.sql.gz.enc
# Cipher: AES-256-CBC, PBKDF2 (200k iterations), passphrase in $KEY_FILE.
#
# Restore:
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -salt \
#     -pass file:/etc/vps-apps/alertproof-backup.key -in <file> | gunzip \
#     | docker exec -i alertproof-postgres-1 psql -U alertproof -d <target_db>
#
# WARNING: the backups are worthless without /etc/vps-apps/alertproof-backup.key.
# Store a copy of that key off this host, in the same place as
# ALERTPROOF_ENCRYPTION_KEY.
set -euo pipefail

CONTAINER=alertproof-postgres-1
DB_USER=alertproof
DB_NAME=alertproof
DEST=/var/backups/alertproof
KEY_FILE=/etc/vps-apps/alertproof-backup.key
KEEP_DAYS=14

log() { echo "$(date -u +%FT%TZ) alertproof-backup: $*"; }

[ -r "$KEY_FILE" ] || { log "FATAL: missing key file $KEY_FILE"; exit 1; }
docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true \
  || { log "FATAL: $CONTAINER is not running"; exit 1; }

mkdir -p "$DEST"
chmod 700 "$DEST"

STAMP=$(date -u +%Y%m%d-%H%M%S)
TMP="$DEST/.alertproof-$STAMP.partial"
OUT="$DEST/alertproof-$STAMP.sql.gz.enc"

# pipefail makes a pg_dump failure fail the whole pipeline, so a truncated dump
# can never be promoted to a real backup filename.
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists \
  | gzip -9 \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
      -pass "file:$KEY_FILE" -out "$TMP"

mv "$TMP" "$OUT"
chmod 600 "$OUT"
log "wrote $OUT ($(stat -c %s "$OUT") bytes)"

DELETED=$(find "$DEST" -name 'alertproof-*.sql.gz.enc' -mtime "+$KEEP_DAYS" -print -delete | wc -l)
find "$DEST" -name '.alertproof-*.partial' -mmin +120 -delete
log "retention: removed $DELETED backup(s) older than $KEEP_DAYS days; $(find "$DEST" -name 'alertproof-*.sql.gz.enc' | wc -l) retained"
