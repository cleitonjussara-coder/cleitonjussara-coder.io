/* ─────────────────────────────────────────────────────────────
   Migração 2026-09-10 — admin e gestor podem gravar nota de outro
   colaborador.

   A policy `notas_upd` já liberava a correção, mas o app grava por
   UPSERT (INSERT ... ON CONFLICT DO UPDATE), e o Postgres avalia a
   policy de INSERT mesmo quando a linha existe e o caminho tomado é
   o de update. Com `notas_ins` exigindo `user_id = auth.uid()`, a
   correção feita por gestor/admin era rejeitada pelo RLS: ficava
   salva no aparelho e nunca chegava ao servidor.

   Efeito: admin e gestor passam a poder gravar linhas em nome de
   qualquer colaborador — corrigir as existentes e também criar.
   Para restringir só a admin, troque por `= 'admin'`.

   Pode rodar mais de uma vez sem problema (idempotente).
───────────────────────────────────────────────────────────── */

drop policy if exists "notas_ins" on public.notas;
create policy "notas_ins" on public.notas for insert
with check (
  user_id = auth.uid() or public.my_role() in ('admin','gestor')
);
