# Security Findings — TopUpSaja

Audit: 2026-09-12 · Cakupan: server API (Fastify), web dashboard (Next.js), CLI agent (Ink), infra VM (Caddy/systemd/ssh). Fix terbatas pada critical/high; medium/low dicatat sebagai rekomendasi.

## Status ringkas

| Sev | Temuan | Status |
|-----|--------|--------|
| HIGH | CORS wide-open (`origin: true`) | ✅ FIXED — allowlist `CORS_ORIGINS` |
| HIGH | `trustProxy` tidak diset → rate limit global dibagi semua user | ✅ FIXED — `trustProxy: true` (Caddy satu hop) |
| HIGH | JWT sesi di `localStorage` (XSS → pencurian token) | ✅ FIXED — cookie `ts_token` httpOnly + endpoint logout |
| HIGH | Tidak ada security headers (HSTS/XFO/CSP/Referrer-Policy) | ✅ FIXED — via Caddyfile, CSP **enforced** 2026-09-13 |
| HIGH | Email tidak terverifikasi bisa beli credit / buat API key | ✅ FIXED — verifikasi email (Gmail SMTP) + gate 403 `email_not_verified` di create API key & topup; Google login auto-verify |
| MED | Webhook QRIS tidak verifikasi `total_amount` vs order | ✅ FIXED — mismatch → log + HTTP 400, tanpa kredit |
| MED | Webhook tanpa rate limit khusus | ✅ FIXED — 60/min/IP per path webhook |
| MED | `/api/topup/status/:id` otorisasi pemilik | ✅ SUDAH AMAN sejak awal (query scoped `user_id`) |
| MED | CLI: `cat .env` / `~/.topupsaja/config.json` auto-allow (SAFE_FIRST) → output API key masuk konteks model | ✅ FIXED — gate secret-path di permission layer (`cli/src/agent/secrets.ts`), selalu `ask` bahkan di mode yolo, deny rule tetap lebih kuat |
| LOW | Register memberi 2.000.000 credit gratis tanpa email verifikasi | 📝 Roadmap (keputusan bisnis) |
| LOW | JWT 30d tanpa revocation list; bcrypt cost 10; session log CLI plaintext | 📝 Roadmap |
| LOW | `verifyApiKey` lookup by prefix 8-char `limit 20` — collision prefix disaring bcrypt, tapi lookup massal tiap request bisa dioptimalkan | 📝 Roadmap |
| LOW | CSP masih Report-Only | ✅ Enforced 2026-09-13 (rollback: `/etc/caddy/Caddyfile.bak-20260912-sec`) |

## Detail fix yang di-deploy

### Server API
- `server/src/server.js` — `trustProxy: true`; CORS origin function (allowlist `config.corsOrigins`, `credentials: true`; request tanpa Origin tetap lolos untuk CLI/curl).
- `server/src/config.js` — `corsOrigins` (default: topupsaja.com, api.topupsaja.com, ai.topupsaja.com, localhost dev).
- `server/src/routes/authRoutes.js` — register/login/google set cookie `ts_token` (HttpOnly, SameSite=Lax, Secure di prod, 30d); endpoint baru `POST /api/auth/logout`.
- `server/src/plugins/auth.js` — `authenticateSession` baca cookie dulu, fallback `Authorization` header (transisi). Verifikasi via `app.jwt.verify(token)` (bukan `request.jwtVerify` yang hanya baca header).
- `server/src/routes/topupRoutes.js` — webhook rate limit 60/min; validasi `event.amount` vs `topups.price_idr` sebelum `process_topup_success`.
- `server/src/lib/qris.js` — provider tripay/generic mengembalikan `amount` dari callback untuk divalidasi ulang.

### Web
- `web/app/dashboard/page.jsx`, `web/app/admin/page.jsx`, `web/app/Nav.jsx` — semua `localStorage.ts_token` dihapus; fetch `credentials: 'include'`; logout memanggil `/api/auth/logout`.
- Header transisi: client lama (tab terbuka) dengan `Authorization` header tetap didukung sampai token expire/rollout selesai.

### CLI
- `cli/src/agent/secrets.ts` (baru) — akses ke `~/.topupsaja/**`, `~/.tsa/settings.json`, file `*.env*` → wajib approval. Urutan keputusan: readOnly deny > classifyBash deny > rule deny > **secret-path ask** > rule allow/ask > allowlist > mode.
- Test: `cli/src/test/secrets.test.ts` + assertion `permission.test.ts` diperbarui. Suite penuh 170/170 pass.

### Infra
- `/etc/caddy/Caddyfile` — snippet `security-headers` (HSTS 1y includeSubDomains, nosniff, X-Frame-Options DENY, Referrer-Policy strict-origin-when-cross-origin) + CSP **enforced** (2026-09-13, semula Report-Only 2026-09-12). Backup: `Caddyfile.bak-20260912-sec`.
- `deploy/backup-db.sh` + `topupsaja-backup.service/.timer` — pg_dump harian 03:30 WIB ke `/home/ubuntu/backups/` (0700), retensi 14 hari. Aktif & tervalidasi (`gunzip -t` OK).
- `deploy/harden.sh` — fail2ban (jail sshd aktif) + unattended-upgrades security harian. Terpasang 2026-09-13.

### Rotasi JWT_SECRET (2026-09-13)
- `JWT_SECRET` diganti dengan random 64-hex baru; secret lama dipindah ke `JWT_SECRET_OLD` di `/opt/topupsaja/server/.env` (tidak masuk git/log).
- Dual-secret: verifikasi secret baru → fallback lama (`verifySessionToken` di `plugins/auth.js`); sign selalu secret baru. Token lama tetap valid (dites 200 di `/api/me`).
- ⚠️ **Kalender: hapus `JWT_SECRET_OLD` dari `.env` VM pada 2026-10-13** lalu `sudo systemctl restart topupsaja-api`.
- systemd unit sudah punya hardening ringan (NoNewPrivileges, PrivateTmp, ProtectSystem=full) — tidak diubah.

## Akte produksi (2026-09-12)

- ✅ Register/login → `Set-Cookie: ts_token=…; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000`
- ✅ `/api/me` via cookie → 200; logout → cookie `Max-Age=0`, `/api/me` → 401
- ✅ Fallback `Authorization: Bearer` → 200 (transisi aman)
- ✅ `curl -H "Origin: https://evil.com"` → tanpa header `access-control-allow-origin`; origin allowlisted → ACAO + credentials
- ✅ Rate limit per-IP nyata: 21x login gagal (XFF 9.9.9.9) → 429; IP lain tetap 401
- ✅ Webhook Tripay: signature salah → 403; signature valid + ref tak dikenal → 200 ignored; signature valid + `total_amount` ≠ `price_idr` (topup pending nyata +1000) → **400 tanpa kredit**
- ✅ `curl -I https://topupsaja.com` → HSTS/XFO/nosniff/Referrer-Policy/CSP-Report-Only; web 200, api 200
- ✅ CLI secret-path: unit test (`decide()` → `ask` untuk `.env`/`~/.topupsaja` bahkan mode yolo+allowlist)
- ⏳ Login via browser (email + tombol Google), tampilan dashboard, top up kecil PAID end-to-end — perlu konfirmasi user
- ✅ (2026-09-13) Gate verifikasi email: register baru → create API key & topup → 403 `email_not_verified`; setelah verifikasi → 201. Token verify link → 302 `/verify?status=ok`. Token lama (secret lama) → `/api/me` 200.

## Rekomendasi lanjutan (belum diimplementasi)

1. ~~Enforce CSP~~ ✅ 2026-09-13. ~~Email verification~~ ✅ 2026-09-13. ~~Cron pg_dump~~ ✅. ~~Fail2ban + unattended-upgrades~~ ✅. ~~Rotasi JWT_SECRET~~ ✅ dual-secret (hapus OLD: 2026-10-13).
2. JWT refresh/revocation untuk memperpendek masa token (roadmap).
3. Rotasi kredensial Tripay (manual, window maintenance — koordinasi dashboard Tripay).
4. Isi `SMTP_USER` + `SMTP_APP_PASSWORD` di `.env` VM (app password Gmail) agar email verifikasi terkirim; sementara kosong → fitur degrade aman (log warning), fallback: admin set `email_verified_at` manual via SQL.
