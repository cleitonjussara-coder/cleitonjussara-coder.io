/* ─────────────────────────────────────────────────────────────
   Migração 2026-09-10 — exclusão definitiva de nota

   Hoje não existe policy de DELETE em public.notas nem em
   storage.objects. Sem policy, o RLS nega: o app não consegue
   apagar de verdade — só marcar deleted = true (a lixeira).

   Quem pode apagar em definitivo:
     • o DONO da nota;
     • admin.
   Gestor NÃO entra: ele corrige nota de colaborador (notas_upd),
   mas apagar sem volta o lançamento de outra pessoa é outro nível.
   Para incluir gestor, troque por: in ('admin','gestor').

   ATENÇÃO: DELETE aqui é irreversível — a linha sai do banco.
   A lixeira (deleted = true) continua sendo o caminho normal.

   Pode rodar mais de uma vez sem problema (idempotente).
───────────────────────────────────────────────────────────── */

-- nota: dono ou admin apagam em definitivo
drop policy if exists "notas_del" on public.notas;
create policy "notas_del" on public.notas for delete
using (
  user_id = auth.uid() or public.my_role() = 'admin'
);

-- anexo no Storage: mesma regra, pelo dono da pasta (user_id/nota_id.ext)
drop policy if exists "fotos_del" on storage.objects;
create policy "fotos_del" on storage.objects for delete
using (
  bucket_id = 'notas-fotos' and (
    auth.uid()::text = (storage.foldername(name))[1] or
    public.my_role() = 'admin'
  )
);
