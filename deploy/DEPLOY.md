# Panduan Deploy: TopUpSaja Web + API ke VM Oracle Always Free

Target akhir:

| URL | Melayani | Port internal |
|---|---|---|
| `https://ai.topupsaja.com` | Web Next.js | 3000 |
| `https://api.topupsaja.com` | API Fastify | 3001 |

Root domain `topupsaja.com` (situs top-up di shared hosting) **tidak disentuh sama sekali**.

---

## 0. Urutan pengerjaan (penting)

1. Buat VM Oracle + buka port 80/443
2. Bootstrap VM (Node, Postgres, Caddy, user deploy, DB)
3. Upload kode + isi `.env`
4. Setup database (migrations + seed)
5. Build web + pasang systemd + Caddy
6. **DNS terakhir** (setelah IP VM pasti) — atau sebelumnya, tidak masalah
7. Validasi end-to-end

API dulu baru web: homepage web melakukan fetch ke API saat prerender.

---

## 1. Buat instance VM Oracle (A1 Flex ARM)

1. Console Oracle Cloud → **Compute → Instances → Create Instance**.
2. Image: **Ubuntu 22.04** (atau 24.04), Shape: **VM.Standard.A1.Flex**, **2 OCPU / 12 GB RAM**.
3. SSH key: upload/tambahkan public key mesin lokal Anda (`~/.ssh/id_ed25519.pub`).
4. Kalau shape A1 "Out of capacity": ulangi berkala (sering berhasil pagi hari WIB), atau fallback **AMD Micro (1 GB)** + tambah swap:
   ```
   sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
   sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

### Security list (WAJIB, sering terlupakan)

Console Oracle → **Networking → Virtual Cloud Networks → VCN Anda → Security Lists → Default Security List → Add Ingress Rules** (dua kali):

| Source CIDR | Protocol | Dest Port |
|---|---|---|
| 0.0.0.0/0 | TCP | 80 |
| 0.0.0.0/0 | TCP | 443 |

(SSH 22 biasanya sudah ada.) Catat **Public IP** VM.

---

## 2. Bootstrap VM

Dari mesin lokal:

```bash
ssh ubuntu@IP_PUBLIK_VM          # cek bisa login
```

Upload dan jalankan bootstrap (file ada di `deploy/`):

```bash
rsync -av /home/rx/topupsaja/deploy/ ubuntu@IP_PUBLIK_VM:/home/ubuntu/deploy/
ssh ubuntu@IP_PUBLIK_VM
cd ~/deploy && bash bootstrap.sh   # akan minta password DB — CATAT passwordnya
```

Script ini membuat user `deploy`, `ufw` allow 22/80/443, Node 20, PostgreSQL, Caddy, database `topupsaja` + role `topupsaja`.

---

## 3. Upload kode + konfigurasi

Dari mesin lokal:

```bash
VM_HOST=IP_PUBLIK_VM bash /home/rx/topupsaja/deploy/deploy.sh
```

Lalu di VM, isi secret:

```bash
sudo mkdir -p /opt/topupsaja && sudo chown ubuntu:ubuntu /opt/topupsaja
sudo chown -R deploy:deploy /opt/topupsaja   # deploy.sh sudah menaruh kode di sini
sudo -u deploy cp /opt/topupsaja/deploy/env/api.env.example /opt/topupsaja/server/.env
sudo -u deploy nano /opt/topupsaja/server/.env
```

Yang wajib diganti di `.env`:

- `DATABASE_URL` → password yang tadi dibuat di bootstrap
- `JWT_SECRET` → `openssl rand -hex 32`
- `OPENROUTER_API_KEY` → key asli
- `ADMIN_EMAILS` → email admin

```bash
sudo chmod 600 /opt/topupsaja/server/.env
```

---

## 4. Database (migrations + seed)

Di VM:

```bash
cd /opt/topupsaja/deploy && bash setup-db.sh
```

Akan menjalankan `001`–`006` dan menampilkan jumlah model & paket ter-seed (harus > 0).

---

## 5. Build web + systemd

Di VM:

```bash
cd /opt/topupsaja/web
sudo -u deploy env NEXT_PUBLIC_API_URL=https://api.topupsaja.com NEXT_PUBLIC_GOOGLE_CLIENT_ID=GANTI_CLIENT_ID_GOOGLE /usr/bin/npm run build
```

> `NEXT_PUBLIC_*` dibaca saat **build**, bukan saat runtime. Jangan build tanpa env ini — homepage akan fetch ke `localhost` pengunjung dan tombol Google tidak muncul.

Pasang service:

```bash
sudo cp /opt/topupsaja/deploy/systemd/topupsaja-api.service /etc/systemd/system/
sudo cp /opt/topupsaja/deploy/systemd/topupsaja-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now topupsaja-api
sudo systemctl enable --now topupsaja-web
curl -s localhost:3001/health   # → {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000   # → 200
```

---

## 6. Caddy (TLS otomatis)

```bash
sudo cp /opt/topupsaja/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy otomatis issue sertifikat — **tapi hanya kalau DNS `ai.` dan `api.` sudah mengarah ke IP VM**. Kalau belum, lakukan langkah 7 dulu, lalu `sudo journalctl -u caddy -f` untuk memantau issuance.

---

## 7. DNS (cPanel Zone Editor — root domain tidak diubah)

Di cPanel domain `topupsaja.com` → **Zone Editor**, tambah **2 A record** (jangan sentuh record lain, terutama `@`):

| Name | Type | TTL | Record |
|---|---|---|---|
| `ai` | A | 3600 | IP_PUBLIK_VM |
| `api` | A | 3600 | IP_PUBLIK_VM |

Cek dari lokal:

```bash
getent hosts ai.topupsaja.com     # harus keluar IP VM
getent hosts api.topupsaja.com
```

Fallback kalau Zone Editor tidak bisa menambah subdomain: pindahkan nameservers domain ke **Cloudflare** (gratis) → rekam ulang semua record existing di sana, root `@` tetap ke IP shared hosting, `ai` + `api` ke IP VM (set DNS-only/grey cloud dulu supaya Caddy issuance mulus).

---

## 8. Validasi end-to-end (urut)

```bash
# 1. npm registry — CLI benar-benar bisa dipasang dari registry
ssh ubuntu@IP_PUBLIK_VM
npm --prefix /tmp/npmtest install topupsaja-cli
node /tmp/npmtest/node_modules/topupsaja/dist/index.js --version   # → 0.8.0

# 2. Installer script
curl -fsSL https://ai.topupsaja.com/cli/install | bash -n   # tanpa error
curl -i https://ai.topupsaja.com/cli/install                # 200 text/plain

# 3. Homepage
curl -s https://ai.topupsaja.com | grep -o 'install-cli'    # ketemu

# 4. API
curl -s https://api.topupsaja.com/health
curl -s https://api.topupsaja.com/api/packages | head -c 300
curl -s https://api.topupsaja.com/api/catalog  | head -c 300
```

Terakhir, CLI nyata di mesin lokal (hapus hasil `npm link` dulu supaya tidak bentrok):

```bash
npm uninstall -g topupsaja-cli topupsaja tsa 2>/dev/null || true
curl -fsSL https://ai.topupsaja.com/cli/install | bash
topupsaja login
topupsaja        # TUI hidup, model terambil dari API produksi
```

---

## Troubleshooting

- **Caddy gagal issue sertifikat** → DNS belum propagate; `journalctl -u caddy -f`. Port 80/443 harus terbuka di security list Oracle **dan** ufw.
- **Homepage kosong (tanpa paket/model)** → API mati saat build, atau `NEXT_PUBLIC_API_URL` tidak diset saat build. Rebuild dengan env itu lalu restart.
- **API 500 koneksi DB** → cek `DATABASE_URL` password & `sudo systemctl status postgresql`.
- **Web 502** → `systemctl status topupsaja-web` (kemungkinan build belum ada atau port salah).
- **Oracle idle reclaim** → upgrade Pay-As-You-Go (tetap gratis dalam limit) atau pastikan ada traffic rutin; simpan snapshot.

## Pembaruan kode berikutnya

```bash
VM_HOST=IP_PUBLIK_VM bash /home/rx/topupsaja/deploy/deploy.sh
# lalu di VM (kalau server berubah):  sudo systemctl restart topupsaja-api
# kalau web berubah: rebuild (bagian 5) + sudo systemctl restart topupsaja-web
```
