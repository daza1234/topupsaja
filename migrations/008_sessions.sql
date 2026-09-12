-- 008: Device sessions — token sesi opaque per perangkat (90 hari)
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash char(64) not null unique,
  user_agent text,
  ip text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists sessions_user_id_idx on sessions(user_id);
create index if not exists sessions_expires_idx on sessions(expires_at) where revoked_at is null;
