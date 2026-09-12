-- ============================================================
-- TopUpSaja — 001_schema.sql
-- Jalankan di Supabase SQL Editor / psql, urut 001 → 002 → 003
-- ============================================================

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  balance_credits bigint not null default 0,
  role text not null default 'user' check (role in ('user', 'admin')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  key_hash text unique not null,
  key_prefix text not null,
  label text default 'default',
  is_active boolean not null default true,
  rate_limit_per_min int not null default 60,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_api_keys_prefix on api_keys (key_prefix);
create index if not exists idx_api_keys_user on api_keys (user_id);

-- Katalog model: multiplier turunan dari harga OpenRouter (sync 15 menit)
create table if not exists model_pricing (
  id uuid primary key default gen_random_uuid(),
  or_model_id text unique not null,          -- 'openai/gpt-4o-mini'
  alias text unique not null,                -- 'ts/gpt-4o-mini' (publik)
  display_name text,
  family text,
  context_window int,
  max_output int,
  cost_in_usd numeric(14, 10) not null default 0,
  cost_out_usd numeric(14, 10) not null default 0,
  m_in numeric(12, 2) not null default 1,
  m_out numeric(12, 2) not null default 1,
  m_cache numeric(12, 2) not null default 1,
  tier text not null default 'standar' check (tier in ('hemat', 'standar', 'premium')),
  upstream_status text not null default 'operational'
    check (upstream_status in ('operational', 'degraded', 'outage', 'unknown')),
  is_active boolean not null default true,
  synced_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_model_alias on model_pricing (alias);
create index if not exists idx_model_active on model_pricing (is_active);

create table if not exists credit_packages (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,                 -- 'coba' | 'hemat' | ...
  display_name text not null,
  credits bigint not null,                   -- total credit termasuk bonus
  base_credits bigint not null,              -- credit sebelum bonus
  bonus_percent numeric(5, 2) not null default 0,
  price_idr numeric(12, 2) not null,
  expiry_days int not null default 90,
  is_featured boolean not null default false,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists topups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  package_id uuid references credit_packages(id),
  package_code text not null,
  credits bigint not null,                   -- total credit yang dikreditkan
  price_idr numeric(12, 2) not null,
  method text not null default 'qris',
  provider text not null default 'manual',
  provider_ref text unique,                  -- order id / invoice id vendor
  payment_url text,
  qr_string text,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'expired', 'failed', 'cancelled')),
  paid_at timestamptz,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now()
);
create index if not exists idx_topups_user on topups (user_id, status);
create index if not exists idx_topups_ref on topups (provider_ref);

create table if not exists usage_logs (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  api_key_id uuid references api_keys(id) on delete set null,
  or_model_id text not null,
  alias text not null,
  prompt_tokens int not null default 0,
  cached_tokens int not null default 0,
  completion_tokens int not null default 0,
  credits_used bigint not null default 0,
  cost_usd numeric(14, 8) not null default 0,
  latency_ms int not null default 0,
  status_code int not null default 200,
  estimated boolean not null default false,
  error_message text,
  created_at timestamptz not null default now()
);
create index if not exists idx_usage_user_date on usage_logs (user_id, created_at desc);
create index if not exists idx_usage_created on usage_logs (created_at);

create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
