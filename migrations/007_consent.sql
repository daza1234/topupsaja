-- Record waktu user menyetujui Syarat & Ketentuan + Kebijakan Privasi.
-- NULL diperbolehkan untuk akun lama (sebelum fitur consent).
alter table users add column if not exists consent_accepted_at timestamptz;