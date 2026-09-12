#!/usr/bin/env bash
# Apply migrations + seed ke database topupsaja (lokal di VM).
# Jalankan SETELAH bootstrap.sh, dari folder deploy/:
#   bash setup-db.sh
set -euo pipefail

MIGRATIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/migrations"
[ -d "$MIGRATIONS_DIR" ] || { echo "Folder migrations tidak ditemukan di $MIGRATIONS_DIR" >&2; exit 1; }

for f in 001_schema.sql 002_rpc.sql 003_seed.sql 004_reprice.sql 005_model_auto_disable.sql 006_model_vision.sql; do
  echo "== $f =="
  sudo -u postgres psql -d topupsaja -v ON_ERROR_STOP=1 -f "$MIGRATIONS_DIR/$f"
done

echo ""
echo "Verifikasi cepat:"
sudo -u postgres psql -d topupsaja -c "select count(*) as models from model_pricing;"
sudo -u postgres psql -d topupsaja -c "select count(*) as packages from credit_packages;"
