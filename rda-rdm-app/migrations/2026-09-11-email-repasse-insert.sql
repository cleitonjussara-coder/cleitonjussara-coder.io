-- ─────────────────────────────────────────────────────────────
-- 2026-09-11 — e-mail de repasse passa a sair também no INSERT (o caminho do app)
--
-- Causa: trg_repasses_email é BEFORE INSERT, ou seja, roda antes de o
-- repasse existir na tabela. A função gravava em repasse_emails, cuja chave
-- estrangeira aponta para repasses — e o pai ainda não estava lá. Violação
-- de FK → exception → o registro do erro falhava pelo mesmo motivo → silêncio.
-- Do SQL Editor sempre funcionou porque era UPDATE em linha existente; o app
-- faz INSERT (upsert de linha nova), e por isso nunca enviou pelo app.
--
-- Correção: a FK vira DEFERRABLE INITIALLY DEFERRED — é conferida no commit,
-- quando o repasse já foi gravado. E a função ganha uma trava: em INSERT de
-- id que já existe (upsert de re-sincronização) ela não faz nada, deixando o
-- caminho de UPDATE decidir — senão cada re-push do app disparava e-mail novo.
-- ─────────────────────────────────────────────────────────────

alter table public.repasse_emails
  drop constraint if exists repasse_emails_repasse_id_fkey;
alter table public.repasse_emails
  add constraint repasse_emails_repasse_id_fkey
  foreign key (repasse_id) references public.repasses(id)
  on delete cascade deferrable initially deferred;

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

  /* Upsert de linha que já existe: o BEFORE INSERT dispara antes de o
     conflito ser detectado. Quem decide é o BEFORE UPDATE logo em seguida,
     que enxerga o old.email_sent — senão todo re-push do app reenviava. */
  if tg_op = 'INSERT' and exists (select 1 from public.repasses where id = new.id) then
    return new;
  end if;

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

-- Testes de hoje (R$ 1.000 x5 e R$ 1,00) saem do saldo. O gatilho ignora
-- linha com deleted = true, então isto não dispara e-mail.
update public.repasses set deleted = true
 where kind = 'requested' and not deleted
   and created_at::date = date '2026-09-11'
   and valor in (1000, 1);
