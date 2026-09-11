/* ─────────────────────────────────────────────────────────────
   Migração 2026-09-10 — solicitação de repasse envia e-mail sozinha

   Até aqui o app abria o aplicativo de e-mail do aparelho (mailto:) e a
   pessoa enviava. Agora, quando um repasse do tipo "requested" chega ao
   banco, um gatilho chama a API do Resend e envia — inclusive se o
   celular estava offline na hora e só sincronizou depois.

   ANTES DE RODAR, faça no Resend (resend.com):
     1. crie a conta;
     2. verifique o domínio pmservicosagronomicos.com.br (2 registros DNS);
     3. crie uma API key.

   DEPOIS DE RODAR, guarde a chave no cofre (uma vez, só a chave muda):
     select vault.create_secret('re_SUA_CHAVE_AQUI', 'resend_api_key');

   Enquanto a chave não estiver no cofre o gatilho não envia — mas também
   NÃO impede a gravação: o repasse entra com email_sent = false e será
   enviado assim que a chave existir e a linha for tocada de novo.

   Remetente: app@pmservicosagronomicos.com.br (precisa do domínio verificado)
   Destino:   cleitonjussara@gmail.com (quem aprova o repasse)
   Reply-to:  o e-mail do colaborador, para o gestor responder direto.

   Pode rodar mais de uma vez sem problema (idempotente).
───────────────────────────────────────────────────────────── */

-- 1) chamadas HTTP de dentro do banco
create extension if not exists pg_net with schema extensions;

-- 2) registro de cada envio (para auditoria e para achar falhas)
create table if not exists public.repasse_emails (
  id          uuid        primary key default gen_random_uuid(),
  repasse_id  uuid        not null references public.repasses(id) on delete cascade,
  request_id  bigint,                 -- id na fila do pg_net (net._http_response)
  created_at  timestamptz not null default now()
);
alter table public.repasse_emails enable row level security;
drop policy if exists "repasse_emails_sel" on public.repasse_emails;
create policy "repasse_emails_sel" on public.repasse_emails for select
  using (public.my_role() in ('admin','gestor'));

-- 3) o envio
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

  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
  if v_key is null then
    raise warning 'enviar_email_repasse: chave resend_api_key ausente no cofre — repasse % gravado sem envio', new.id;
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
  /* Falha no envio NUNCA pode impedir a gravação do repasse. */
  raise warning 'enviar_email_repasse (%): %', new.id, sqlerrm;
  return new;
end;
$$;

create or replace trigger trg_repasses_email
  before insert or update on public.repasses
  for each row execute function public.enviar_email_repasse();

/* ── Como conferir se saiu ──────────────────────────────────
   O pg_net envia em segundo plano; a resposta da API fica em
   net._http_response por um tempo. Para ver o resultado do último:

     select r.created_at, h.status_code, left(h.content::text, 200) as resposta
     from public.repasse_emails r
     left join net._http_response h on h.id = r.request_id
     order by r.created_at desc limit 5;

   status_code 200 = enviado. 4xx = a API recusou (chave, domínio ou
   remetente não verificado) — a mensagem em `resposta` diz o motivo.
────────────────────────────────────────────────────────────── */
