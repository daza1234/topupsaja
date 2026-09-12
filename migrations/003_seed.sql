-- ============================================================
-- TopUpSaja — 003_seed.sql
-- Paket credit awal + settings default
-- ============================================================

insert into credit_packages (code, display_name, credits, base_credits, bonus_percent, price_idr, expiry_days, is_featured, sort_order) values
  ('coba',    'Coba',      5500000,    5000000,  10,  6000,  90, false, 1),
  ('hemat',   'Hemat',    27500000,   25000000,  10, 15000,  90, false, 2),
  ('standar', 'Standar', 110000000,  100000000,  10, 50000,  90, true,  3),
  ('pro',     'Pro',      275000000,  250000000, 10, 115000, 90, false, 4),
  ('mega',    'Mega',     550000000,  500000000, 10, 210000, 90, false, 5)
on conflict (code) do nothing;

insert into settings (key, value) values
  ('maintenance_mode', 'false'::jsonb),
  ('idr_per_usd', '16000'::jsonb),
  ('floor_rate_per_m_credit', '350'::jsonb),
  ('max_tokens_cap', '16384'::jsonb),
  ('upstream_balance_alert_usd', '20'::jsonb),
  ('free_signup_credits', '2000000'::jsonb)
on conflict (key) do nothing;
