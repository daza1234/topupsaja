#!/usr/bin/env bash
# Upload kode dari mesin lokal ke VM + install dependencies + build web.
# Jalankan dari mesin lokal (Pop!_OS), bukan dari VM:
#   VM_HOST=1.2.3.4 bash deploy.sh
# SSH key harus sudah bisa login ke VM (ssh ubuntu@$VM_HOST).
set -euo pipefail

: "${VM_HOST:?Set VM_HOST=<ip-publik-VM>}"
SSH="ssh ubuntu@${VM_HOST}"
RSYNC="rsync -az --delete -e ssh"
REMOTE_ROOT=/opt/topupsaja

echo "== 1/4 Buat struktur di VM =="
$SSH "sudo mkdir -p $REMOTE_ROOT && sudo chown ubuntu:ubuntu $REMOTE_ROOT"

echo "== 2/4 Upload server (tanpa node_modules & .env) =="
$RSYNC --exclude node_modules --exclude '.env' --exclude '*.tmp.mjs' \
  /home/rx/topupsaja/server/ "ubuntu@${VM_HOST}:$REMOTE_ROOT/server/"
$RSYNC /home/rx/topupsaja/migrations/ "ubuntu@${VM_HOST}:$REMOTE_ROOT/migrations/"
$RSYNC --delete --exclude '*.swp' /home/rx/topupsaja/deploy/ "ubuntu@${VM_HOST}:$REMOTE_ROOT/deploy/"

echo "== 3/4 Upload web (tanpa node_modules, .next, .env.local) =="
$RSYNC --delete --exclude node_modules --exclude '.next' --exclude '.env.local' \
  /home/rx/topupsaja/web/ "ubuntu@${VM_HOST}:$REMOTE_ROOT/web/"

echo "== 4/4 Install deps di VM =="
$SSH "cd $REMOTE_ROOT/server && sudo -u deploy /usr/bin/npm ci --omit=dev"
$SSH "cd $REMOTE_ROOT/web && sudo -u deploy /usr/bin/npm ci"

echo ""
echo "Upload selesai. Lanjut di VM:"
echo "  1. sudo cp $REMOTE_ROOT/deploy/env/api.env.example /opt/topupsaja/server/.env && nano .env (isi secret)"
echo "  2. cd /opt/topupsaja/deploy && bash setup-db.sh"
echo "  3. NEXT_PUBLIC_API_URL=https://api.topupsaja.com npm run build  (di /opt/topupsaja/web)"
echo "  4. Pasang systemd + Caddyfile (lihat DEPLOY.md bagian 5-6), lalu sudo systemctl restart topupsaja-api topupsaja-web caddy"
