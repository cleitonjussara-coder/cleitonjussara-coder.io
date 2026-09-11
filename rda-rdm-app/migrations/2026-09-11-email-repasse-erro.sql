-- ─────────────────────────────────────────────────────────────
-- 2026-09-11 — gatilho de e-mail registra o motivo quando desiste
--
-- Vindo do app (sessão `authenticated`), a solicitação de repasse chegava
-- com email_sent = false e nada em repasse_emails: o gatilho rodava e
-- desistia — ou por não achar a chave no cofre ou por exceção — e o motivo
-- ia só para o log do Postgres, onde ninguém olha. Do SQL Editor (sessão
-- `postgres`) o mesmo gatilho enviava normal.
--
-- Aqui a tabela ganha a coluna `erro` e a função grava nela toda vez que
-- desiste, para o motivo ficar consultável:
--   select * from public.repasse_emails where erro is not null order by created_at desc;
-- ─────────────────────────────────────────────────────────────

alter table public.repasse_emails add column if not exists erro text;

create or replace function public.enviar_email_repasse()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key    text;
  v_colab  record;
  v_valor  text;
  v_body   jsonb;
  v_req    bigint;
  v_erro   text;
begin
  /* Só solicitação, só viva, só a que ainda não saiu. */
  if new.kind <> 'requested' or new.deleted then return new; end if;

  /* Já enviado antes: não reenvia e não deixa o app rebaixar a marca.
     O app manda o registro inteiro no upsert, e a cópia local pode estar
     com email_sent = false mesmo depois de o servidor ter enviado. */
  if tg_op = 'UPDATE' and old.email_sent then
    new.email_sent := true;
    return new;
  end if;
  if new.email_sent then return new; end if;

  begin
    select decrypted_secret into v_key
      from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
  exception when others then
    v_erro := 'cofre: ' || sqlerrm;
  end;
  if v_erro is null and v_key is null then
    v_erro := 'cofre: chave resend_api_key não encontrada';
  end if;
  if v_erro is not null then
    raise warning 'enviar_email_repasse (%): %', new.id, v_erro;
    insert into public.repasse_emails (repasse_id, erro) values (new.id, v_erro);
    return new;
  end if;

  select nome, email into v_colab from public.colaboradores where id = new.user_id;

  /* R$ no formato brasileiro: to_char usa vírgula/ponto do locale do
     servidor (en_US), então troca à mão. */
  v_valor := replace(replace(replace(
               to_char(coalesce(new.valor, 0), 'FM999,999,990.00'),
             ',', '#'), '.', ','), '#', '.');

  v_body := jsonb_strip_nulls(jsonb_build_object(
    'from',     'Petermann App <app@pmservicosagronomicos.com.br>',
    'to',       jsonb_build_array('cleitonjussara@gmail.com'),
    'reply_to', nullif(v_colab.email, ''),
    'subject',  format('Solicitação de repasse %s - %s/%s', new.tipo, new.mes, new.ano),
    'text',     format(
      E'Olá,\n\nSolicito o repasse referente à despesa %s.\n\n'
      || E'Detalhes:\n- Tipo: %s\n- Valor: R$ %s\n- Data: %s\n- Período: %s/%s\n- Descrição: %s\n\n'
      || E'Atenciosamente,\n%s\n%s',
      new.tipo, new.tipo, v_valor, to_char(new.data, 'DD/MM/YYYY'), new.mes, new.ano,
      coalesce(nullif(new.descricao, ''), 'Sem descrição'),
      coalesce(nullif(v_colab.nome, ''), 'Colaborador'),
      coalesce(v_colab.email, ''))
  ));

  select net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || v_key,
                 'Content-Type',  'application/json'),
    body    := v_body
  ) into v_req;

  insert into public.repasse_emails (repasse_id, request_id) values (new.id, v_req);
  new.email_sent := true;
  return new;

exception when others then
  /* Falha no envio NUNCA pode impedir a gravação do repasse. O registro
     do motivo também não: se até ele falhar, fica só o warning. */
  raise warning 'enviar_email_repasse (%): %', new.id, sqlerrm;
  begin
    insert into public.repasse_emails (repasse_id, erro) values (new.id, sqlerrm);
  exception when others then null;
  end;
  return new;
end;
$$;
