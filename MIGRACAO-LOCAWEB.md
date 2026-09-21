> ## ✅ Migração concluída em 21/09/2026
> App e API rodam na Locaweb desde 16/09/2026 (fases 1–8). Fase 9 fechada em
> 21/09/2026: backup semanal conferido (cron domingo 03:30, rotação de 8) e
> cópia guardada em `Área de Trabalho/Backups Petermann/` (repetir todo mês);
> `SUPABASE_*` removido do `.env` de produção (cópia em
> `.env.bak-antes-fase9-20260921`); repositório commitado (`36ae60d` em
> diante). Pendências manuais do Cleiton: pausar o projeto no Supabase e
> desligar o GitHub Pages (hoje só redireciona para o domínio novo).
> O Supabase pode ser apagado a partir de ~21/10/2026, se nada faltar.
> **Publicar hoje = `node scripts/empacotar.js app` + scp/unzip via SSH**
> (ver "O que muda no dia a dia"). Este documento fica como histórico.

# Migrar o Petermann App para a Locaweb (Hospedagem II)

**O que muda:** o sistema inteiro sai do Supabase e passa a rodar na sua
hospedagem Locaweb — o app (PWA) e uma **API própria em PHP/Laravel** com
banco **SQLite** (um arquivo no servidor, fora do web root). Os anexos
(fotos, PDF, XML das notas) ficam em **disco no servidor**; no banco vai
**só o caminho** (`notas.foto_path`), nunca a imagem.

Por que SQLite e não o MySQL do plano: nada para criar no painel, a
migração dos dados roda inteira **no seu PC** e o arquivo pronto sobe junto
com a API. Para uma equipe pequena não há diferença de desempenho. Trocar
para MySQL depois é uma linha no `.env` (`DB_CONNECTION=mysql`).

**O que não muda para a equipe:** endereço do app, atalho na tela inicial,
e-mail e senha de cada um (as senhas migram como estão), notas, repasses e
fotos já lançados, as regras de quem vê o quê, o Google Drive e a planilha.

Regra de ouro: **o Supabase e o GitHub Pages ficam ligados até o fim.**
Se algo der errado, é só voltar o DNS e o app volta na hora.

---

## O que foi feito de fato (15/09/2026) — leia antes do passo a passo

O passo a passo abaixo foi escrito antes de conhecer o servidor. Na prática:

- **SSH existe** na Hospedagem II (painel → Configurações → SSH → Habilitar,
  vale 3 h por vez). A chave pública do PC está em `~/.ssh/authorized_keys`
  no servidor; o alias `ssh locaweb` (em `~/.ssh/config` do PC) usa o IP
  179.188.55.112 — o nome `ftp.pmservicosagronomicos.com.br` aponta para
  outro IP e dá timeout. O SSH embutido do Windows corrompe a conexão; use o
  do Git (`C:\Program Files\Git\usr\bin\ssh.exe`).
- **PHP CLI:** `/usr/bin/php84` (o `php` puro não existe no PATH do shell).
- A Locaweb cria a pasta do subdomínio (`public_html/api-petermann`) como
  **root**, sem permissão de escrita — só a `public/` é nossa. Por isso o
  Laravel mora em **`~/api-petermann/`** (fora do web root) e o
  `public/index.php` aponta para lá (ver o comentário nele).
- A migração dos dados rodou **no servidor** (`php84 artisan migrar:supabase`):
  ele alcança o pooler do Supabase (`aws-1-sa-east-1.pooler.supabase.com`; a
  conexão direta `db.*.supabase.co` é IPv6 e não alcança) e o Storage. Nada
  de zip de banco/fotos.
- Limites de upload do PHP-FPM ficam no `public/.user.ini` (o `php_value` do
  .htaccess é ignorado).

Publicar uma nova versão da API, hoje: `node scripts/empacotar.js api` →
`scp petermann-api.zip locaweb:tmp/` → no servidor, descompactar por cima de
`~/api-petermann` (sem tocar em `.env`, `database/` e `storage/`) e copiar
`public/` para `~/public_html/api-petermann/public/`.

---

## Como fica

```
Locaweb — Hospedagem II (Linux, PHP 8.3)
│
├── app.pmservicosagronomicos.com.br   ← a PWA (arquivos estáticos)
│     .htaccess · index.html · rda-rdm-app/
│
├── api.pmservicosagronomicos.com.br   ← a API (Laravel), raiz = api-petermann/public
│     api-petermann/            (fora do web root)
│       ├── public/             ← ÚNICA pasta servida
│       ├── storage/app/fotos/  ← anexos: <user_id>/<nota_id>.jpg|png|pdf|xml
│       ├── database/database.sqlite ← O BANCO (colaboradores · notas · repasses · cnpj_cache · repasse_emails)
│       └── .env                ← chaves do Resend e do Google
```

| Antes (Supabase) | Agora (Locaweb) |
|---|---|
| Postgres + RLS | SQLite + regras na API (Eloquent) — mesmas permissões |
| Auth (e-mail/senha, Google) | Sanctum (token) + Google OAuth feito pela API |
| Storage `notas-fotos` | disco `storage/app/fotos`, só o caminho no banco |
| gatilho `enviar_email_repasse` (pg_net → Resend) | `RepasseEmailService` → Resend |
| função `chave_nfce_existe` | `POST /api/notas/chave-existe` |
| gatilhos `updated_at` / auditoria | Eloquent timestamps + `created_by`/`updated_by` no controller |

Código: `api/` (Laravel) e `rda-rdm-app/js/api.js` (o app fala com a API).

---

## Antes de começar — 2 conferências no painel da Locaweb

1. **Versão do PHP do site: 8.3** (Hospedagem → Configurações → Versão do PHP).
   O Laravel 13 exige 8.3+. Se o painel só oferecer 8.2, me avise ANTES de
   qualquer outro passo — o backend precisa ser rebaixado para Laravel 12.
   A extensão `pdo_sqlite` vem ligada no PHP da Locaweb; o `/api/ping` do
   Passo 3 confirma.
2. **SSL** ativo para os dois subdomínios (`app` e `api`). Sem HTTPS a câmera
   não abre, o app não instala e o token trafegaria em texto claro.

Não há banco para criar no painel: o SQLite é um arquivo que sobe junto.

---

## Passo 1 — Criar o subdomínio da API

Painel → **Subdomínios → Criar**: nome `api`, pasta **`api-petermann/public`**.

O detalhe que importa: a pasta do subdomínio é a **`public/`** dentro de
`api-petermann/`, e `api-petermann/` fica **fora** de qualquer pasta servida.
É isso que deixa `.env`, `storage/` (as fotos) e `vendor/` inacessíveis
pela web. Se o painel não deixar apontar para uma subpasta, aponte para
`api-petermann/` mesmo — o `.htaccess` que vai dentro dela nega tudo, exceto
`public/`. Ative o SSL do `api`.

---

## Passo 2 — Preencher o `.env` e migrar os dados (no seu PC)

Tudo aqui roda na sua máquina: o banco nasce em `api/database/database.sqlite`
e é ele que vai para o servidor no Passo 3.

1. Em `api/`, copie `.env.example` para `.env` e preencha:
   - `DB_CONNECTION=sqlite` (já vem assim; não precisa de mais nada de banco)
   - `APP_KEY` — gere com `php artisan key:generate`
   - `RESEND_API_KEY` — a mesma que está no cofre do Supabase (`resend_api_key`)
   - `SUPABASE_DB_URL` — Supabase → Project Settings → Database → Connection
     string (modo *Session*, porta 5432)
   - `SUPABASE_SERVICE_KEY` — Project Settings → API → **service_role**
     (só para a migração; depois pode apagar do `.env`)
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — ver Passo 4
2. Cria o banco **zerado** (apaga qualquer dado de teste que estiver no
   arquivo local — é o que você quer: o banco de produção nasce limpo):
   ```bash
   php artisan migrate:fresh --force
   ```
3. Copia perfis + senhas, notas, repasses, cache de CNPJ e baixa todos os
   anexos do Storage para `api/storage/app/fotos/`:
   ```bash
   php artisan migrar:supabase
   ```
   Pode rodar de novo quantas vezes precisar (não duplica; foto já baixada
   não baixa de novo). Se alguma foto falhar, ele lista e você repete com
   `php artisan migrar:supabase --so-fotos`.
4. Deixe o `.env` de produção: `APP_ENV=production`, `APP_DEBUG=false`,
   `APP_URL=https://api.pmservicosagronomicos.com.br`,
   `FRONT_URL=https://app.pmservicosagronomicos.com.br/rda-rdm-app`.

---

## Passo 3 — Gerar os pacotes e subir

Feche o `php artisan serve` se estiver aberto e, na raiz do repositório:

```bash
node scripts/empacotar.js
```

Gera quatro zips (todos fora do Git):

| Arquivo | Onde extrair no Gerenciador de Arquivos |
|---|---|
| `petermann-api.zip` | dentro de **`api-petermann/`** (crie a pasta vazia primeiro, no mesmo nível das pastas dos sites) |
| `petermann-banco.zip` | dentro de **`api-petermann/`** — vira `database/database.sqlite`. **Só neste primeiro envio.** |
| `petermann-fotos.zip` | dentro de **`api-petermann/storage/app/`** — vira `fotos/` |
| `petermann-app.zip` | na raiz do subdomínio **`app`** (por enquanto, num subdomínio de teste — ver Passo 5) |

O `petermann-api.zip` leva o `vendor/` (a hospedagem não tem Composer) e o
seu `.env`; **nunca** leva o banco nem as fotos — assim uma atualização da
API pode ser extraída por cima sem risco. Depois de extrair, confira que
`api-petermann/.env` e `api-petermann/database/database.sqlite` existem e
que `api-petermann/storage` e `api-petermann/database` têm permissão de
escrita (o padrão do FTP já é; o SQLite cria arquivos `-wal`/`-shm` ao lado
do banco).

### ⚠️ Arquivos que começam com ponto

`.htaccess` e `.env` ficam **escondidos** na maioria dos gerenciadores. Se
não aparecerem depois de extrair, ligue **"Mostrar arquivos ocultos"** e
confirme: `app/.htaccess`, `api-petermann/.env`, `api-petermann/.htaccess`
e `api-petermann/public/.htaccess`.

### Teste da API

Abra `https://api.pmservicosagronomicos.com.br/api/ping`. Tem que responder
`{"ok":true,"app":"Petermann API",...}`. Se der erro 500, ligue
`APP_DEBUG=true` no `.env` **só para ler o erro**, e desligue em seguida.
Erro falando de `could not find driver` = `pdo_sqlite` desligado no PHP do
site (painel → Versão do PHP → extensões).

---

## Passo 4 — Login com Google (projeto CLEITON-PM no Google Cloud)

O botão "Continuar com Google" e o Drive automático do gestor passam pela
API. No Google Cloud → APIs e serviços → Credenciais → o cliente OAuth
que já existe (é o mesmo do Supabase):

- **URIs de redirecionamento autorizados** → adicione
  `https://api.pmservicosagronomicos.com.br/api/auth/google/callback`
- Copie **ID do cliente** e **Chave secreta** para `GOOGLE_CLIENT_ID` e
  `GOOGLE_CLIENT_SECRET` no `.env` (e reenvie o `.env`, ou edite no painel).

Sem isso o botão avisa "Login com Google ainda não está liberado" e o
login por e-mail/senha continua funcionando normalmente.

**Resend:** o domínio `pmservicosagronomicos.com.br` já está verificado lá
(o e-mail de repasse já saía por ele). A mesma chave serve. O que muda é que
agora o "esqueci minha senha" também sai pelo Resend.

---

## Passo 5 — Testar num subdomínio antes de virar a chave

Crie `teste.pmservicosagronomicos.com.br` (pasta própria, SSL ligado) e
extraia o `petermann-app.zip` nele. A API já é a definitiva; só o app está
em teste. No `.env` da API, acrescente o subdomínio de teste ao CORS:

```
CORS_ORIGINS=https://app.pmservicosagronomicos.com.br,https://teste.pmservicosagronomicos.com.br
```

Abra `https://teste.pmservicosagronomicos.com.br` no celular e confira:

- [ ] Cadeado na barra (HTTPS)
- [ ] Rodapé do login mostra **Versão v4**; no diagnóstico, **build 128**
- [ ] Entra com o **mesmo e-mail e senha de antes**
- [ ] Home carrega os números e as notas antigas aparecem **com as fotos**
- [ ] Toque no **+** → **Escanear QR**: a câmera abre
- [ ] Lance uma nota de teste com foto → em "Notas" ela aparece com miniatura
- [ ] Peça um repasse (solicitação) → o e-mail chega em `repasse@`
- [ ] "Esqueci minha senha" → o e-mail chega e o link abre a tela de nova senha
- [ ] Gestor/admin: aba **Equipe** lista todos e abre o cartão de cada um
- [ ] Menu do navegador → **Adicionar à tela inicial** instala e abre como app

Se algo falhar, me avise o que aconteceu antes de continuar.

---

## Passo 6 — Virar o DNS do `app`

1. **Congele os lançamentos por 1 hora** (avise a equipe) e rode
   `php artisan migrar:supabase` **uma última vez** — ele traz o que entrou
   no Supabase desde a primeira cópia. Depois `node scripts/empacotar.js banco`
   e `node scripts/empacotar.js fotos`, e reenvie os dois zips para
   `api-petermann/` (o banco do servidor ainda é o da cópia inicial, sem
   nada da equipe — é a única vez em que extrair o banco por cima é certo;
   o que foi lançado durante o teste do Passo 5 é descartado junto).
2. No **DNS** do domínio, **remova** o CNAME de `app` que aponta para
   `cleitonjussara-coder.github.io` (o GitHub). Enquanto existir, a Locaweb
   não assume.
3. Crie o subdomínio `app` na Locaweb (pasta própria), ative o SSL e extraia
   o `petermann-app.zip` nele.
4. Confira `https://app.pmservicosagronomicos.com.br` → login → **build 128**.

A propagação leva de minutos a algumas horas. Nesse meio-tempo alguns
celulares ainda veem o app antigo (Supabase) e outros já veem o novo — por
isso o congelamento: lançamento feito no antigo depois da cópia final
**não** vem para o novo sozinho.

Peça para cada pessoa **fechar e abrir o app uma vez**. Quem já tem o app
instalado não precisa reinstalar. Na primeira abertura o app vai pedir
login de novo (a sessão antiga era do Supabase).

---

## Passo 7 — Depois de uma semana estável

- Desative o GitHub Pages no repositório (não tem pressa).
- Pause o projeto no Supabase (Settings → General → Pause). Não apague:
  é o backup até você ter certeza. Depois de um mês, pode apagar.
- Apague `SUPABASE_*` do `.env` da API.

---

## O que muda no dia a dia

**Publicar uma alteração do app:** `node scripts/empacotar.js app` → enviar
`petermann-app.zip` pelo painel → conferir o **build** no diagnóstico.
Continua sendo o número que diz se a atualização chegou.

**Publicar uma alteração da API:** `node scripts/empacotar.js api` → enviar
`petermann-api.zip` para `api-petermann/`. **Nunca** extraia o zip da API
sobre `storage/app/fotos/` com o gerenciador em modo "substituir pasta" —
o zip da API não leva as fotos de propósito, mas um gerenciador que apaga a
pasta de destino antes de extrair levaria os anexos junto. Na dúvida,
extraia num nome temporário e mova.

**Mudança no banco:** nova migração em `api/database/migrations/` → sobe
a API → no app, aba **Perfil** (admin) → **Atualizar estrutura do banco**.
Isso roda as migrações pendentes no servidor (não dá para rodar do PC: o
banco é um arquivo lá). Baixe um backup antes.

**Backup:** o painel da Locaweb **não** faz backup de arquivo avulso. No app,
aba **Perfil** (admin) → **Baixar backup do banco** gera uma cópia íntegra do
SQLite (`petermann-AAAA-MM-DD.sqlite`) — guarde no Drive, uma vez por
semana. As fotos estão em `api-petermann/storage/app/fotos/` — baixe a pasta
de vez em quando; o Drive continua recebendo cópia pela consolidação do
gestor. Para olhar os dados de um backup no PC: DB Browser for SQLite.

**Rollback:** enquanto o Passo 7 não for feito, voltar é: recolocar o CNAME
de `app` para o GitHub. O app antigo (build 127) volta com o Supabase —
perdendo o que foi lançado no novo depois da virada.
