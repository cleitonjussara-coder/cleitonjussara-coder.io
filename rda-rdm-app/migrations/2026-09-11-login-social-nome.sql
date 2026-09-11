-- ─────────────────────────────────────────────────────────────
-- 2026-09-11 — login social: nome do colaborador vem do provedor
--
-- Com e-mail/senha o app manda `nome` nos metadados do cadastro. Com
-- Google/Microsoft/Facebook/Apple o Supabase grava o que o provedor
-- devolve: `full_name` (Google, Facebook), `name` (Microsoft, Apple).
-- Sem isto, quem entrasse pelo botão social ficava com o nome igual ao
-- começo do e-mail.
-- ─────────────────────────────────────────────────────────────

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.colaboradores (id, email, nome)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data->>'nome', ''),
      nullif(new.raw_user_meta_data->>'full_name', ''),
      nullif(new.raw_user_meta_data->>'name', ''),
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
