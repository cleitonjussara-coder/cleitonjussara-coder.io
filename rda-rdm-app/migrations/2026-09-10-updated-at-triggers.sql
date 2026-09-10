/* ─────────────────────────────────────────────────────────────
   Migração 2026-09-10 (2/2) — triggers de updated_at

   O bloco de updated_at do supabase_setup.sql nunca chegou a este
   banco: a função set_updated_at() não existia, e por consequência
   nenhum dos três triggers.

   Sem eles, updated_at só muda quando o app manda o valor no payload.
   Qualquer alteração feita FORA do app (Table Editor do Supabase, ou
   um update via SQL) deixa updated_at congelado — e o pull incremental
   do app (db.js, `.gte('updated_at', since)`) nunca enxerga a linha.
   Na prática, a correção não chega aos celulares da equipe.

   ATENÇÃO: com os triggers ativos, updated_at passa a ser sempre
   definido pelo servidor nos UPDATEs, ignorando o valor enviado pelo
   cliente. É o comportamento pretendido pelo script original.

   Pode rodar mais de uma vez sem problema (idempotente).
   Não altera nenhum dado existente.
───────────────────────────────────────────────────────────── */

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace trigger trg_colabs_upd
  before update on public.colaboradores
  for each row execute function public.set_updated_at();

create or replace trigger trg_notas_upd
  before update on public.notas
  for each row execute function public.set_updated_at();

create or replace trigger trg_repasses_upd
  before update on public.repasses
  for each row execute function public.set_updated_at();
