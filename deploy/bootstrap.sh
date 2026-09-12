#!/usr/bin/env bash
# Bootstrap VM Oracle Always Free (Ubuntu 22.04/24.04 ARM) untuk TopUpSaja.
# Jalankan SEKALI sebagai user dengan sudo: bash bootstrap.sh
set -euo pipefail

if [ "$EUID" -eq 0 ]; then echo "Jangan jalankan sebagai root (pakai user ubuntu + sudo)." >&2; exit 1; fi

echo "== 1/6 User deploy =="
if ! id deploy >/dev/null 2>&1; then
  sudo adduser --disabled-password --gecos "" deploy
fi
sudo usermod -aG sudo deploy || true

echo "== 2/6 Firewall (ufw) =="
sudo apt-get update -y
sudo apt-get install -y ufw
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

echo "== 3/6 Node.js 20 LTS =="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "== 4/6 PostgreSQL =="
sudo apt-get install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql

echo "== 5/6 Caddy =="
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update -y && sudo apt-get install -y caddy

echo "== 6/6 Database + user deploy =="
read -rsp 'Password DB untuk user topupsaja: ' DBPASS; echo
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'topupsaja') THEN
    CREATE ROLE topupsaja LOGIN PASSWORD '$DBPASS';
  ELSE
    ALTER ROLE topupsaja PASSWORD '$DBPASS';
  END IF;
END \$\$;
SELECT 'CREATE_DATABASE' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='topupsaja')\gexec
SQL
sudo -u postgres psql -c "ALTER DATABASE topupsaja OWNER TO topupsaja;"

DBPASS="$DBPASS" sudo -u postgres psql -d topupsaja -v ON_ERROR_STOP=1 <<SQL
ALTER SCHEMA public OWNER TO topupsaja;
GRANT ALL ON SCHEMA public TO topupsaja;
SQL

echo ""
echo "SELESAI. Lanjut ke langkah deploy aplikasi (lihat DEPLOY.md bagian 4)."
echo "Password DB tadi: simpan di /opt/topupsaja/server/.env (DATABASE_URL)."
