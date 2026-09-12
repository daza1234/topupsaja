-- 006: flag dukungan input gambar (vision) per model
alter table model_pricing
  add column if not exists supports_vision boolean not null default false;
