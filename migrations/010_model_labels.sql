-- Label use-case + info modalitas per model (plan: model-labels-modalities)
alter table model_pricing
  add column if not exists input_modalities text[] not null default '{text}',
  add column if not exists output_modalities text[] not null default '{text}',
  add column if not exists tags text[] not null default '{}';
