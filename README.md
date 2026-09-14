# TopUpSaja — AI API Credit Gateway

Gateway AI OpenAI-compatible dengan sistem **prepaid credit**: user top up
paket credit via QRIS, generate API key, lalu memakai puluhan model AI
(GPT, Claude, Gemini, DeepSeek, dll) melalui satu endpoint.

Upstream: **OpenRouter**. Multiplier credit per model **auto-sync** dari feed
harga OpenRouter tiap 15 menit (margin selalu terlindungi).

```
topupsaja/
├── server/          # Fastify API (proxy, auth, billing, admin, QRIS)
├── core/            # Logika bisnis bersama (shared TS)
├── migrations/      # SQL: jalankan urut 001 → 002 → 003 → 004
├── desktop/         # App desktop Tauri (produk utama end-user)
├── cli/             # CLI (deprecated, masih jalan)
└── web/             # Next.js: landing, models, docs, dashboard, status
```

## Quick Start (Development)

### 1. Database (Supabase / Postgres apa pun)

1. Buat project Supabase → Settings → Database → Connection string (pooler).
2. Jalankan SQL urut:
   ```
   psql "$DATABASE_URL" -f migrations/001_schema.sql
   psql "$DATABASE_URL" -f migrations/002_rpc.sql
   psql "$DATABASE_URL" -f migrations/003_seed.sql
   psql "$DATABASE_URL" -f migrations/004_reprice.sql
   ```
   (atau paste isi file ke Supabase SQL Editor, satu per satu, urut.)

### 2. API Server

```bash
cd server
cp .env.example .env      # isi DATABASE_URL, JWT_SECRET, OPENROUTER_API_KEY
npm install
npm run dev               # http://localhost:3000
```

Test sync rate manual: `npm run sync`

Endpoint utama:
- `POST /v1/chat/completions` — OpenAI-compatible (streaming & non-streaming)
- `GET  /v1/models` — daftar model + rate (butuh Bearer key)
- `GET  /api/packages` — daftar paket credit (publik)
- `GET  /api/catalog` — katalog model (publik)
- `GET  /api/status` / `GET /health`

### 3. Web (Next.js)

```bash
cd web
cp .env.local.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:3000
npm install
npm run dev                        # http://localhost:3001
```

## Aplikasi Desktop

Aplikasi desktop (Tauri) adalah **produk utama untuk end-user** — antarmuka
dashboard/top up dalam satu app, tanpa perlu buka browser.

### Unduh & Install

Artefak tersedia di [GitHub Releases](https://github.com/daza1234/topupsaja/releases/latest):

| OS | Format | Updater otomatis |
| --- | --- | --- |
| Linux | `.AppImage` | ✅ (chmod +x, jalankan langsung) |
| Linux | `.deb` | ❌ (update manual via apt/dpkg) |
| Windows | `.exe` (NSIS installer) | ✅ |

### Updater

App punya tombol versi (`v0.1.x`) di header untuk cek update. Update
di-download + diverifikasi signature (minisign pubkey ter-embed di
`desktop/src-tauri/tauri.conf.json`), lalu app relaunch otomatis.

Catatan build/release:
- Artefak `latest.json` (manifest updater) di-generate via
  `node desktop/scripts/gen-latest-json.mjs` setelah build, lalu di-upload
  bersama artefak release.
- Signing build butuh env `TAURI_SIGNING_PRIVATE_KEY` (**isi file key**,
  bukan path — variant `_PATH` tidak didukung CLI ini) +
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

### CLI (deprecated)

CLI (`cli/`) masih berfungsi tapi tidak lagi menjadi produk utama —
gunakan aplikasi desktop.

## Setup Produksi (ringkas)

1. **VPS SG** — `node server/src/server.js` via systemd/pm2 di belakang Nginx
   (domain `api.topupsaja.com`), TLS via Certbot.
2. **Web** — deploy `web/` ke Vercel, set `NEXT_PUBLIC_API_URL=https://api.topupsaja.com`.
3. **QRIS** — pilih gateway pihak ketiga, set `QRIS_PROVIDER=generic` + kredensial;
   arahkan webhook vendor ke `https://api.topupsaja.com/api/topup/webhook/generic`.
   Sambil menunggu vendor, `QRIS_PROVIDER=manual` + approve dari admin.
4. **Telegram alert** — buat bot (@BotFather), isi `TELEGRAM_BOT_TOKEN` +
   `TELEGRAM_CHAT_ID`.
5. **Admin** — daftar dengan email di `ADMIN_EMAILS`, otomatis dapat role admin.
   Approve top up manual: `POST /api/admin/topups/:id/approve`.

## Sistem Pricing (referensi)

Unit credit ditampilkan dalam **M** (1 M = 1.000.000 credit).

- Basis: `1 credit = $1e-7` nilai cost OpenRouter (`CREDIT_USD_VALUE`).
- Markup **per-tier** (fee atas cost upstream, auto-sync tiap 15 menit):
  `hemat 7.0×`, `standar 6.0×`, `premium 5.0×` (`config.openrouter.fees`).
- Multiplier per model: `m = cost_per_token × fee_tier / 1e-7`.
- Konsumsi: `credits = ceil(fresh_in×m_in + cached×m_cache + out×m_out)`.
- Harga jual credit dikontrol per paket (basis Rp ~380–1.100/M credit; paket
  `standar` = 110 M credit @ Rp 50.000 ≈ Rp 455/M — match/saingi kompetitor).
- Floor Rp 350/M credit tersimpan di `settings.floor_rate_per_m_credit`;
  margin guard membandingkan rate jual paket termurah vs cost serve
  (worst case fee premium: Rp 160.000/kurs ÷ 5 ≈ Rp 320/M) dan alert bila
  markup efektif < 1.15×.

Contoh: GPT-4o-mini input ($0.15/1M token, tier standar, fee 6×) →
m_in = 9 credit/token → user bayar Rp 4.500/1M token input,
cost upstream Rp 2.400 → margin ~46%.

## Catatan Keamanan

- API key user disimpan sebagai bcrypt hash; full key hanya tampil sekali.
- `OPENROUTER_API_KEY` hanya di env server; set per-key credit limit di
  dashboard OpenRouter sebagai blast-radius cap.
- Webhook QRIS diverifikasi HMAC signature (sesuaikan dengan vendor final).
- Jangan commit `.env`.
