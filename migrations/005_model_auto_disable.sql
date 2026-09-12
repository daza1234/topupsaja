-- ============================================================
-- TopUpSaja — 005_model_auto_disable.sql
-- Auto-disable model saat upstream outage:
--   fail_count      = hitungan kegagalan upstream beruntun (reset saat sukses)
--   auto_disabled_at= waktu model dinonaktifkan otomatis (NULL = tidak auto)
-- Manual disable admin TIDAK mengisi auto_disabled_at → tidak di-probe ulang.
-- ============================================================

alter table model_pricing
  add column if not exists fail_count int not null default 0,
  add column if not exists auto_disabled_at timestamptz;
