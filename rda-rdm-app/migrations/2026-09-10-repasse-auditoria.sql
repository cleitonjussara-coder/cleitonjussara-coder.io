/* ─────────────────────────────────────────────────────────────
   Migração 2026-09-10 — colunas do fluxo de repasse + auditoria
   Alinha o banco com o app v4 (build 96).

   Sem ela, todo lançamento feito no app falha ao sincronizar com
   erro 42703 (coluna inexistente) e acaba marcado como "failed".

   Pode rodar mais de uma vez sem problema (idempotente).
───────────────────────────────────────────────────────────── */

-- notas: quem criou e quem alterou por último
alter table public.notas
  add column if not exists created_by uuid references public.colaboradores(id) on delete set null,
  add column if not exists updated_by uuid references public.colaboradores(id) on delete set null;

-- repasses: recebido x solicitado, e controle de e-mail enviado
alter table public.repasses
  add column if not exists kind text not null default 'received',
  add column if not exists email_sent boolean not null default false;

do $$ begin
  alter table public.repasses
    add constraint repasses_kind_check check (kind in ('received','requested'));
exception when duplicate_object then null; end $$;

-- preenche created_by/updated_by automaticamente
create or replace function public.set_note_audit_fields()
returns trigger language plpgsql security definer as $$
begin
  if tg_op = 'INSERT' then
    if new.created_by is null then
      new.created_by := auth.uid();
    end if;
    if new.updated_by is null then
      new.updated_by := coalesce(new.created_by, auth.uid());
    end if;
  elsif tg_op = 'UPDATE' then
    if new.updated_by is null then
      new.updated_by := auth.uid();
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger trg_notas_audit
  before insert or update on public.notas
  for each row execute function public.set_note_audit_fields();

-- gestor passa a poder corrigir nota de colaborador (antes só admin)
drop policy if exists "notas_upd" on public.notas;
create policy "notas_upd" on public.notas for update using (
  user_id = auth.uid() or public.my_role() in ('admin','gestor')
);
