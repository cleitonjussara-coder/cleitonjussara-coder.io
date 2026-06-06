-- =====================================================================
-- PETERMANN APP — Supabase Setup
-- Execute no SQL Editor do seu projeto Supabase.
-- =====================================================================

-- ─── Extensões ───────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ─── Tabelas ─────────────────────────────────────────────────────────

-- Perfis de usuário
create table if not exists public.colaboradores (
  id          uuid        primary key references auth.users(id) on delete cascade,
  nome        text        not null default '',
  email       text        not null default '',
  role        text        not null default 'colaborador'
                          check (role in ('colaborador','gestor','admin')),
  nucleo      text        not null default 'Cristalina',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Notas de despesa (RDA / RDM)
create table if not exists public.notas (
  id              uuid          primary key default gen_random_uuid(),
  user_id         uuid          not null references public.colaboradores(id) on delete cascade,
  tipo            text          not null check (tipo in ('RDA','RDM')),
  subtipo         text          check (subtipo in ('Abastecimento','Hospedagem','Outros') or subtipo is null),
  cnpj            char(14),
  razao_social    text,
  valor           numeric(12,2) not null check (valor >= 0),
  data            date          not null,
  mes             smallint      not null check (mes between 1 and 12),
  ano             smallint      not null check (ano >= 2020),
  metodo_captura  text          not null default 'manual',
  chave_nfce      char(44),
  uf              char(2),
  modelo          char(2),
  foto_path       text,
  observacao      text,
  deleted         boolean       not null default false,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);

-- Repasses recebidos (PIX / transferências)
create table if not exists public.repasses (
  id          uuid          primary key default gen_random_uuid(),
  user_id     uuid          not null references public.colaboradores(id) on delete cascade,
  tipo        text          not null check (tipo in ('RDA','RDM')),
  valor       numeric(12,2) not null check (valor >= 0),
  data        date          not null,
  mes         smallint      not null check (mes between 1 and 12),
  ano         smallint      not null check (ano >= 2020),
  descricao   text,
  deleted     boolean       not null default false,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now()
);

-- Cache de CNPJ (evita consultas repetidas à BrasilAPI)
create table if not exists public.cnpj_cache (
  cnpj            char(14)    primary key,
  razao_social    text,
  nome_fantasia   text,
  consultado_em   timestamptz not null default now()
);

-- ─── Trigger: updated_at automático ──────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger trg_colabs_upd   before update on public.colaboradores for each row execute function public.set_updated_at();
create or replace trigger trg_notas_upd    before update on public.notas         for each row execute function public.set_updated_at();
create or replace trigger trg_repasses_upd before update on public.repasses      for each row execute function public.set_updated_at();

-- ─── Trigger: criar perfil no cadastro ───────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.colaboradores (id, email, nome)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'nome', split_part(new.email,'@',1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace trigger trg_new_user
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── Row Level Security ───────────────────────────────────────────────
alter table public.colaboradores enable row level security;
alter table public.notas         enable row level security;
alter table public.repasses      enable row level security;
alter table public.cnpj_cache    enable row level security;

-- Funções auxiliares de role / nucleo
create or replace function public.my_role()
returns text language sql security definer stable as $$
  select role from public.colaboradores where id = auth.uid();
$$;

create or replace function public.my_nucleo()
returns text language sql security definer stable as $$
  select nucleo from public.colaboradores where id = auth.uid();
$$;

-- colaboradores: ver a si mesmo, gestor vê núcleo, admin vê tudo
create policy "colab_sel" on public.colaboradores for select using (
  id = auth.uid() or
  public.my_role() = 'admin' or
  (public.my_role() = 'gestor' and nucleo = public.my_nucleo())
);
create policy "colab_upd_self"  on public.colaboradores for update using (id = auth.uid());
create policy "colab_upd_admin" on public.colaboradores for update using (public.my_role() = 'admin');

-- notas
create policy "notas_sel" on public.notas for select using (
  user_id = auth.uid() or
  public.my_role() = 'admin' or
  (public.my_role() = 'gestor' and
    exists(select 1 from public.colaboradores c where c.id = user_id and c.nucleo = public.my_nucleo()))
);
create policy "notas_ins" on public.notas for insert with check (user_id = auth.uid());
create policy "notas_upd" on public.notas for update using (
  user_id = auth.uid() or public.my_role() = 'admin'
);

-- repasses
create policy "rep_sel" on public.repasses for select using (
  user_id = auth.uid() or
  public.my_role() = 'admin' or
  (public.my_role() = 'gestor' and
    exists(select 1 from public.colaboradores c where c.id = user_id and c.nucleo = public.my_nucleo()))
);
create policy "rep_ins" on public.repasses for insert with check (user_id = auth.uid());
create policy "rep_upd" on public.repasses for update using (
  user_id = auth.uid() or public.my_role() = 'admin'
);

-- cnpj_cache: qualquer autenticado lê e escreve
create policy "cnpj_sel" on public.cnpj_cache for select using (auth.uid() is not null);
create policy "cnpj_ins" on public.cnpj_cache for insert with check (auth.uid() is not null);
create policy "cnpj_upd" on public.cnpj_cache for update using (auth.uid() is not null);

-- ─── Storage bucket ───────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('notas-fotos', 'notas-fotos', false)
on conflict (id) do nothing;

create policy "fotos_ins" on storage.objects for insert
  with check (bucket_id = 'notas-fotos' and auth.uid() is not null);

create policy "fotos_sel" on storage.objects for select using (
  bucket_id = 'notas-fotos' and (
    auth.uid()::text = (storage.foldername(name))[1] or
    public.my_role() in ('admin','gestor')
  )
);

-- ─── Índices ──────────────────────────────────────────────────────────
create index if not exists idx_notas_uid    on public.notas(user_id);
create index if not exists idx_notas_anomes on public.notas(ano, mes);
create index if not exists idx_notas_upd    on public.notas(updated_at);
create index if not exists idx_rep_uid      on public.repasses(user_id);
create index if not exists idx_rep_anomes   on public.repasses(ano, mes);
create index if not exists idx_rep_upd      on public.repasses(updated_at);

-- ─── Promoções de papel ───────────────────────────────────────────────
-- Execute após os primeiros cadastros. Troque pelos e-mails reais.
--
-- update public.colaboradores set role='admin',  nucleo='Cristalina' where email='cleiton@exemplo.com';
-- update public.colaboradores set role='gestor', nucleo='Formosa'    where email='rayner@exemplo.com';
-- update public.colaboradores set role='gestor', nucleo='Paracatu'   where email='renan@exemplo.com';
-- update public.colaboradores set role='gestor', nucleo='Uberlândia' where email='arthur@exemplo.com';
