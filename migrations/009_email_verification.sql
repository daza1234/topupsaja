-- 009: Email verification — kolom di users (satu token aktif per user, hash sha256)
alter table users add column if not exists email_verified_at timestamptz;
alter table users add column if not exists email_verify_token_hash char(64);
alter table users add column if not exists email_verify_expires_at timestamptz;
