-- ============================================================
-- TopUpSaja — 004_reprice.sql
-- Repricing paket ke basis "M credit" (kompetitif, Rp ~380–1.100/M)
-- + markup fee per-tier (lihat config.openrouter.fees).
-- Jalankan SETELAH 003 untuk DB yang sudah ada.
-- ============================================================

-- Paket baru: total credit (termasuk bonus 10%) & harga
update credit_packages set credits = 5500000,    base_credits = 5000000,    bonus_percent = 10, price_idr = 6000,   is_featured = false, sort_order = 1 where code = 'coba';
update credit_packages set credits = 27500000,   base_credits = 25000000,   bonus_percent = 10, price_idr = 15000,  is_featured = false, sort_order = 2 where code = 'hemat';
update credit_packages set credits = 110000000,  base_credits = 100000000,  bonus_percent = 10, price_idr = 50000,  is_featured = true,  sort_order = 3 where code = 'standar';
update credit_packages set credits = 275000000,  base_credits = 250000000,  bonus_percent = 10, price_idr = 115000, is_featured = false, sort_order = 4 where code = 'pro';
update credit_packages set credits = 550000000,  base_credits = 500000000,  bonus_percent = 10, price_idr = 210000, is_featured = false, sort_order = 5 where code = 'mega';

insert into credit_packages (code, display_name, credits, base_credits, bonus_percent, price_idr, expiry_days, is_featured, sort_order)
values ('mega', 'Mega', 550000000, 500000000, 10, 210000, 90, false, 5)
on conflict (code) do nothing;

-- Settings ikut repricing
insert into settings (key, value) values
  ('floor_rate_per_m_credit', '350'::jsonb),
  ('free_signup_credits', '2000000'::jsonb)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- Catatan: multiplier model_pricing (m_in/m_out/m_cache) akan otomatis
-- tersinkron ulang oleh job syncRates dengan fee per-tier baru.
-- Jalankan `npm run sync` setelah migration ini.
