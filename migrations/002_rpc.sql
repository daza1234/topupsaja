-- ============================================================
-- TopUpSaja — 002_rpc.sql
-- Fungsi atomic (race-condition safe)
-- ============================================================

-- Potong credit user secara atomic. Return true jika sukses.
create or replace function deduct_user_credits(
  p_user_id uuid,
  p_credits bigint
) returns boolean
language plpgsql
as $$
declare
  v_balance bigint;
begin
  if p_credits <= 0 then
    return true;
  end if;

  select balance_credits into v_balance
  from users
  where id = p_user_id and is_active = true
  for update;

  if v_balance is null or v_balance < p_credits then
    return false;
  end if;

  update users
  set balance_credits = balance_credits - p_credits,
      updated_at = now()
  where id = p_user_id;

  return true;
end;
$$;

-- Tambah credit (dipakai saat top up sukses / admin manual).
-- expiry_days > 0 → set/extend package_expires (disimpan di settings user di topups; di sini cukup tambah saldo).
create or replace function add_user_credits(
  p_user_id uuid,
  p_credits bigint
) returns void
language plpgsql
as $$
begin
  update users
  set balance_credits = balance_credits + p_credits,
      updated_at = now()
  where id = p_user_id;
end;
$$;

-- Finalisasi top up: tandai paid + tambah credit, idempotent.
create or replace function process_topup_success(
  p_topup_id uuid
) returns boolean
language plpgsql
as $$
declare
  v_topup topups%rowtype;
begin
  select * into v_topup from topups
  where id = p_topup_id and status = 'pending'
  for update skip locked;

  if v_topup.id is null then
    return false; -- sudah diproses / tidak ada
  end if;

  update topups
  set status = 'paid', paid_at = now()
  where id = v_topup.id;

  perform add_user_credits(v_topup.user_id, v_topup.credits);

  return true;
end;
$$;

-- Ringkasan usage per user (untuk dashboard)
create or replace function get_usage_summary(
  p_user_id uuid,
  p_days int default 7
) returns table (
  alias text,
  requests bigint,
  prompt_tokens bigint,
  cached_tokens bigint,
  completion_tokens bigint,
  credits_used numeric,
  cost_usd numeric
)
language sql
as $$
  select
    u.alias,
    count(*)::bigint as requests,
    sum(u.prompt_tokens)::bigint as prompt_tokens,
    sum(u.cached_tokens)::bigint as cached_tokens,
    sum(u.completion_tokens)::bigint as completion_tokens,
    sum(u.credits_used)::numeric as credits_used,
    sum(u.cost_usd)::numeric as cost_usd
  from usage_logs u
  where u.user_id = p_user_id
    and u.created_at >= now() - (p_days || ' days')::interval
  group by u.alias
  order by credits_used desc;
$$;
