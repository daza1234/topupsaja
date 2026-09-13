#!/usr/bin/env bash
# pg_dump harian + retensi 14 hari. Dipanggil oleh topupsaja-backup.service.
set -euo pipefail
DIR=/home/ubuntu/backups
mkdir -p "$DIR"
chmod 700 "$DIR"
sudo -u postgres pg_dump topupsaja | gzip > "$DIR/topupsaja-$(date +%Y%m%d).sql.gz.tmp"
mv "$DIR/topupsaja-$(date +%Y%m%d).sql.gz.tmp" "$DIR/topupsaja-$(date +%Y%m%d).sql.gz"
find "$DIR" -name 'topupsaja-*.sql.gz' -mtime +14 -delete
