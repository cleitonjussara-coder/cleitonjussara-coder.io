# Prompts da migração completa — Supabase → Locaweb

Roteiro de prompts para conduzir a migração do Petermann App até o fim.
Cada bloco é um prompt **autocontido**: cole no Claude Code (nesta pasta do
repositório) na hora daquela fase. O guia técnico de referência é o
[`MIGRACAO-LOCAWEB.md`](MIGRACAO-LOCAWEB.md); os prompts seguem a mesma ordem.

**Como usar**
1. Faça uma fase por vez, na ordem. Não pule a checagem do fim de cada uma.
2. Comece toda sessão nova colando o **Prompt 0** antes do prompt da fase.
3. Onde estiver `«…»`, troque pelo valor real antes de colar.
4. Os prompts para o **suporte da Locaweb** e para o **Google Cloud** estão no
   fim — são textos para o chat/ticket deles, não para o Claude.
5. Fases 1–8 concluídas em 16/09/2026 (app no ar na Locaweb). **Fase 9
   concluída em 21/09/2026** (backup guardado fora, SUPABASE_* fora do .env,
   repo commitado; faltam só os cliques do Cleiton: pausar Supabase e
   desligar GitHub Pages). Fases 10 (SvelteKit) e 11 (certificado digital)
   são evoluções independentes; a 12 (arquivos no servidor) já foi feita.

---

## Prompt 0 — Contexto (cole no início de toda sessão)

```
Contexto da migração do Petermann App (Supabase → Locaweb):

- Repositório local nesta pasta. O app (PWA) está em rda-rdm-app/ e o backend
  novo em api/ (Laravel 13 + Eloquent + SQLite), feito para a Hospedagem II da
  Locaweb (PHP 8.3, sem Node, sem Composer, sem terminal no servidor). O
  banco é o arquivo api-petermann/database/database.sqlite no servidor
  (fora do web root); nasce e é migrado no meu PC e sobe no
  petermann-banco.zip só no primeiro envio.
- O app fala com a API por rda-rdm-app/js/api.js. Anexos ficam em disco no
  servidor (api/storage/app/fotos/<user_id>/<nota_id>.ext); no banco vai só
  o caminho (notas.foto_path). Imagem nunca entra no banco.
- Comandos prontos: php artisan migrate:fresh, php artisan migrar:supabase,
  node scripts/empacotar.js (app | api | fotos | banco). No app, aba Perfil
  (admin): "Baixar backup do banco" e "Atualizar estrutura do banco"
  (roda migrações pendentes no servidor).
- Guia: MIGRACAO-LOCAWEB.md. Memória do projeto tem os detalhes.
- PHP 8.3 e Composer estão instalados via winget (fora do PATH do bash — use
  o caminho completo que está na memória "php-local-winget").
- Regra de ouro: Supabase e GitHub Pages ficam ligados até a virada do DNS.
  Nada é commitado/push sem eu pedir (push na main publica no GitHub Pages).

Estou na fase: «número e nome da fase».
```

---

## Fase 1 — Conferências no painel da Locaweb

```
Fase 1 — conferências no painel da Locaweb antes de qualquer coisa.

Me guie pelo painel para confirmar duas coisas e diga exatamente onde clicar:
1) a versão do PHP do site pmservicosagronomicos.com.br (precisa ser 8.3 —
   se o painel só oferecer até 8.2, PARE e me diga o que muda no backend)
   e se a extensão pdo_sqlite aparece ligada;
2) se o certificado SSL (Let's Encrypt) está ativo e se dá para ativar para
   subdomínios novos.
Não há banco para criar no painel (é SQLite, um arquivo que sobe junto).

Vou te responder com o que encontrei em cada item. Não altere código nesta
fase.
```

Resposta esperada sua depois de olhar o painel (cole na sequência):

```
Encontrei: PHP «versão»; pdo_sqlite «sim/não/não achei»; SSL
«ativo/inativo». Podemos seguir para a Fase 2?
```

---

## Fase 2 — Subdomínio da API

```
Fase 2 — criar o subdomínio da API.

Já criei no painel da Locaweb:
- Subdomínio api.pmservicosagronomicos.com.br apontando para a pasta
  «api-petermann/public» (ou: «não consegui apontar para subpasta, apontei
  para api-petermann/»). SSL «ativo/pendente».

Confira se essa configuração atende o que o MIGRACAO-LOCAWEB.md espera e me
diga se falta algo. Se apontei para api-petermann/ em vez de public/,
explique o que o .htaccess de proteção faz e se preciso mudar algo.
```

---

## Fase 3 — `.env` de produção e criação das tabelas

```
Fase 3 — preencher api/.env e criar o banco SQLite zerado (no meu PC).

Monte comigo o api/.env de produção a partir do api/.env.example. Eu digito
as chaves direto no arquivo; você só me diz campo por campo o que vai em
cada um e onde pegar (APP_KEY, FRONT_URL, CORS_ORIGINS, RESEND_API_KEY,
SUPABASE_DB_URL, SUPABASE_SERVICE_KEY, GOOGLE_*). DB_CONNECTION fica
sqlite. Deixe APP_ENV=production e APP_DEBUG=false.

Depois rode `php artisan migrate:fresh --force` (zera o arquivo local, que
hoje só tem dados de teste) e me mostre o resultado.

Confirmação da fase: api/database/database.sqlite existe, zerado, com as
tabelas colaboradores, notas, repasses, repasse_emails, cnpj_cache,
personal_access_tokens e migrations.
```

---

## Fase 4 — Migrar os dados e as fotos do Supabase

```
Fase 4 — copiar tudo do Supabase para o SQLite local + fotos para a pasta local.

Rode `php artisan migrar:supabase` e me mostre o resumo (quantos perfis,
notas, repasses, CNPJs, quantas fotos baixadas/faltaram). Se alguma foto
falhar, repita com `--so-fotos` até zerar.

Depois confira, com consultas no SQLite local, se os totais batem com o
Supabase: número de colaboradores, de notas (vivas e apagadas), de repasses,
e se todas as notas com foto_path têm o arquivo correspondente em
api/storage/app/fotos/. Me apresente uma tabela "Supabase × Locaweb" com
esses números.

Confirmação da fase: totais iguais e zero foto faltando. Nada é escrito no
Supabase nesta fase.
```

---

## Fase 5 — Empacotar e subir a API

```
Fase 5 — gerar os pacotes e subir a API na Locaweb.

Feche o php artisan serve, rode `node scripts/empacotar.js` e me diga o
tamanho dos quatro zips (petermann-api.zip, petermann-banco.zip,
petermann-fotos.zip, petermann-app.zip) e os totais que o zip do banco
imprimiu. Antes de gerar, confirme que api/.env está com
APP_ENV=production e APP_DEBUG=false.

Depois me guie no Gerenciador de Arquivos da Locaweb, passo a passo, para:
1) criar a pasta api-petermann/ no lugar certo (fora das pastas dos sites);
2) extrair petermann-api.zip dentro dela;
3) extrair petermann-banco.zip dentro dela (vira database/database.sqlite);
4) extrair petermann-fotos.zip dentro de api-petermann/storage/app/;
5) conferir os arquivos ocultos (.env, .htaccess na raiz e em public/) e
   que database/ e storage/ têm permissão de escrita.

Confirmação da fase: https://api.pmservicosagronomicos.com.br/api/ping
responde {"ok":true,...}. Se responder erro 500, me diga como ler o erro
com segurança (APP_DEBUG só por um minuto) e vamos corrigir.
```

---

## Fase 6 — Login com Google e e-mails (Resend)

```
Fase 6 — ligar o login com Google e conferir o Resend.

No Google Cloud (projeto CLEITON-PM), o cliente OAuth já existe (é o mesmo
do Supabase). Me diga exatamente onde adicionar a URI de redirecionamento
https://api.pmservicosagronomicos.com.br/api/auth/google/callback e onde
copiar o ID do cliente e a chave secreta. Eu coloco em GOOGLE_CLIENT_ID e
GOOGLE_CLIENT_SECRET no .env da Locaweb (me diga como editar o .env lá
sem reenviar o zip inteiro).

Depois verifique:
- /api/ping deve responder "google": true;
- um pedido de "esqueci minha senha" com o meu e-mail deve chegar (Resend);
- explique como testar o e-mail de solicitação de repasse sem sujar os dados
  reais.

Confirmação da fase: botão "Continuar com Google" funciona no subdomínio de
teste (Fase 7) e os dois e-mails chegam.
```

---

## Fase 7 — Subdomínio de teste e checklist no celular

```
Fase 7 — testar o app novo num subdomínio de teste antes de virar o DNS.

Criei teste.pmservicosagronomicos.com.br com SSL. Me guie para extrair o
petermann-app.zip nele e para acrescentar essa origem em CORS_ORIGINS do
.env da API.

Depois me passe o checklist do MIGRACAO-LOCAWEB.md (Passo 5) em forma de
lista para eu marcar no celular, item por item: HTTPS, versão/build,
login com a senha antiga, notas antigas com foto, câmera/QR, nota nova com
foto, solicitação de repasse (e-mail), esqueci a senha, aba Equipe como
admin, instalar na tela inicial.

Eu volto aqui com o resultado de cada item. Se algum falhar, você
diagnostica com o log da API e corrige antes de eu seguir. NÃO vire o DNS
com item pendente.
```

Resposta sua depois do teste:

```
Resultado do checklist: «lista dos itens, ok/falhou e o que aconteceu».
```

---

## Fase 8 — Virada do DNS (dia da migração)

```
Fase 8 — virar o app de verdade para a Locaweb.

Ordem que eu quero seguir; me confirme cada passo antes de eu executar:
1) Avisar a equipe para NÃO lançar nada por 1 hora.
2) Rodar `php artisan migrar:supabase` uma última vez (traz o que entrou no
   Supabase desde a Fase 4), me mostrar o resumo, gerar
   `node scripts/empacotar.js banco` e `... fotos` e me guiar para extrair os
   dois zips em api-petermann/ por cima (única vez em que isso é certo — o
   que foi lançado no teste da Fase 7 é descartado).
3) No DNS do domínio, remover o CNAME de "app" que aponta para
   cleitonjussara-coder.github.io.
4) Criar o subdomínio "app" na Locaweb, ativar SSL e extrair o
   petermann-app.zip nele.
5) Conferir https://app.pmservicosagronomicos.com.br → login → build 128
   no diagnóstico.
6) Avisar a equipe: fechar e abrir o app uma vez, entrar de novo com o mesmo
   e-mail e senha.

Me diga o que observar durante a propagação do DNS e como saber que
terminou.
```

---

## Fase 9 — Pós-migração (uma semana depois) e commit

```
Fase 9 — encerrar a migração.

O app está estável na Locaweb há «N» dias. Faça comigo, nesta ordem:
0) conferir em Perfil (admin) que os backups automáticos semanais estão
   aparecendo (Fase 12) e baixar um "backup completo (banco + fotos)" para
   guardar fora da Locaweb — e me lembrar de repetir isso todo mês;
1) tirar SUPABASE_* do .env da API na Locaweb;
2) me guiar para pausar (não apagar) o projeto no Supabase;
3) me guiar para desativar o GitHub Pages no repositório;
4) revisar o diff completo do repositório (api/, rda-rdm-app/, scripts/,
   docs) e fazer o commit da migração com mensagem descritiva — confirme
   antes que .env, database.sqlite e storage/app/fotos NÃO estão indo;
5) atualizar MIGRACAO-LOCAWEB.md com um cabeçalho "migração concluída em
   «data»" e a memória do projeto.

Só faça o push quando eu confirmar.
```

---

## Fase 10 — SvelteKit (só depois da migração concluída)

Decidido em 15/09/2026: o front-end passa a usar **SvelteKit** de forma
**incremental**. Obrigatoriamente com **`adapter-static`** (modo SPA/estático):
a Hospedagem II não roda Node, então nada de SSR nem rotas de servidor do
SvelteKit — dados, login e fotos continuam na API Laravel. O build gera os
arquivos estáticos dentro de `rda-rdm-app/`, e as telas são convertidas uma
por vez. Os
módulos de motor (db.js, api.js, ocr.js, recorte.js, gdrive.js, gsheets.js,
excel.js) continuam como estão; Svelte cuida só da camada de tela. Nada de
Node no servidor: o build roda no PC e `scripts/empacotar.js` passa a
rodá-lo antes de zipar.

```
Fase 10 — começar a adoção do SvelteKit no app (migração para a Locaweb já
concluída e estável).

Monte o projeto SvelteKit com adapter-static (SPA, sem SSR nem rotas de
servidor — a hospedagem não roda Node) gerando os arquivos estáticos dentro
de rda-rdm-app/ (o build roda aqui no PC), mantendo
o app atual funcionando por inteiro. Integre o build ao
scripts/empacotar.js. Converta UMA tela como prova — «Equipe / formulário da
nota / Saldo» — reutilizando os módulos existentes (api.js, db.js etc.) sem
reescrevê-los. Verifique no navegador que a tela convertida e as demais
continuam funcionando, inclusive offline e o service worker. Só então me
apresente o plano de conversão das outras telas, uma por vez.
```

---

## Fase 11 — Certificado digital (e-CNPJ): importar notas direto da Receita

Registrado em 16/09/2026. Contexto dado pelo usuário: a empresa lança
**centenas de notas por dia**; o **certificado digital já está instalado no
computador da empresa**; com ele é possível acessar outros tipos de nota
(NF-e, NFS-e, CT-e, eventos) além do que o app lê hoje por QR/OCR.

**O que o certificado destrava e o que não destrava** (verificado em
16/09/2026):

| Documento | Com certificado | Como |
|---|---|---|
| **NF-e (55)** emitida contra o CNPJ da empresa | XML completo, valor e data exatos, sem foto | Web service **NFeDistribuicaoDFe** (Ambiente Nacional) + manifestação do destinatário |
| **NFS-e** (padrão nacional, prefeituras aderentes) | XML da nota para o tomador | API do Ambiente de Dados Nacional da NFS-e (conferir cada prefeitura: Cristalina, Paracatu, Uberlândia…) |
| **CT-e / eventos** | idem distribuição | NFeDistribuicaoDFe cobre CT-e e eventos do CNPJ |
| **NFC-e (65)** — cupom de posto, restaurante, mercado | **Nada além de "autorizada/cancelada"** — sem valor | A Receita não distribui NFC-e ao comprador, mesmo com CNPJ impresso |

Ou seja: o certificado elimina o OCR para tudo que é **NF-e/NFS-e no CNPJ
da Petermann**, e continua **QR + OCR** para cupom. Hoje o banco tem 28 notas
com chave e **todas são NFC-e** — a fase só compensa se a empresa passar a
pedir "CNPJ na nota / NF-e" nas despesas maiores (hospedagem, peças,
serviços).

**Arquitetura decidida — a chave privada NUNCA vai para a Locaweb.**
A Hospedagem II é compartilhada: um certificado A1 no servidor pode ser
copiado por quem invadir a hospedagem ou tiver a senha do painel/FTP.
O certificado fica **no computador da empresa, no repositório de
certificados do Windows, marcado como não exportável**. Um serviço local
("Agente Fiscal", Node ou .NET, rodando como serviço do Windows) consulta a
Receita com esse certificado e manda para a API da Locaweb **só os
resultados** (XML/valor/data/emitente), autenticado com um token próprio da
API (role `agente`). A Locaweb nunca vê a chave; o pior caso de invasão
expõe dados de notas, nunca a assinatura da empresa.

Regras fixas da fase:
- imagem/XML continua em disco, só o caminho no banco (regra do projeto);
- o Agente só **lê** na Receita e só **grava** na API por rota própria
  (`POST /api/agente/notas`), idempotente pela chave de 44/50 dígitos;
- nada apaga lançamento sozinho: nota importada que coincide com uma lançada
  à mão vira **"possível duplicata"** (mecanismo já existente), quem decide é
  a pessoa;
- cada consulta fica em log (quando, qual CNPJ/NSU, quantas notas) para
  auditoria; NSU (número sequencial) guardado para não reprocessar;
- manifestação do destinatário só "Ciência da Operação" (necessária para
  baixar o XML completo) — nunca "Confirmação" ou "Desconhecimento"
  automáticos;
- volume: centenas/dia cabem no limite da Receita (DistribuicaoDFe devolve
  lotes de até 50 documentos por chamada, com intervalo mínimo de 1 h em
  consulta "sem novidades" — o Agente precisa respeitar o `cStat 137/656`).

**Passo 0 (antes de qualquer código) — provar que compensa:**

```
Fase 11, passo 0 — levantamento.

Com a API na Locaweb: quantas notas do histórico têm chave de modelo 55
(NF-e) e quantas são 65 (NFC-e)? Quantas NFS-e? Separe por mês e por
colaborador. Depois me diga, com esses números, quantas notas por mês o
certificado importaria sozinho hoje, e quantas continuariam dependendo de
QR + OCR. Não escreva código do Agente ainda.
```

**Resultado do passo 0 (16/09/2026, base de produção):** 30 notas ativas —
23 NFC-e (R$ 3.965), 7 sem chave (R$ 576), **0 NF-e, 0 NFS-e**. Só
Abastecimento em RDM; nenhuma hospedagem/peças/serviços. Conclusão: hoje o
certificado importaria **zero** notas deste app. As "centenas de notas por
dia" da empresa são o fluxo fiscal/contábil (compras, serviços tomados),
que não passa pelo app — a Fase 11 é, na prática, um **módulo novo "Notas
da empresa"** (Agente Fiscal + conciliação pelo gestor), não uma melhoria
do lançamento em campo. Antes do passo 1, definir: (a) notas recebidas ou
emitidas? (b) viram RDA/RDM de alguém ou só arquivo/conciliação?

**Passo 1 — Agente Fiscal no computador da empresa:**

```
Fase 11, passo 1 — Agente Fiscal.

Crie em agente-fiscal/ um serviço para Windows (Node 20 ou .NET 8, o que
for mais simples de instalar como serviço) que:
1) usa o certificado e-CNPJ do repositório de certificados do Windows
   (não exportável — nunca leia um .pfx do disco);
2) consulta NFeDistribuicaoDFe do Ambiente Nacional a partir do último NSU
   guardado, respeitando o intervalo mínimo entre consultas;
3) para cada resNFe/procNFe recebido: faz Ciência da Operação quando
   preciso, baixa o XML completo, extrai chave, emitente (CNPJ/razão),
   valor, data, número/série, e envia para POST /api/agente/notas com o
   XML anexado (a API grava o XML em disco e só o caminho no banco);
4) registra log local e no servidor de cada rodada;
5) roda a cada 1 h e no start; instalação documentada em agente-fiscal/
   README.md, com o passo a passo para importar o certificado como não
   exportável.
Não use SEFAZ estadual; só o Ambiente Nacional. Nada de NFC-e nesta etapa.
```

**Passo 2 — a API recebe e o app mostra:**

```
Fase 11, passo 2 — API e app.

Na API: role `agente` (token Sanctum dedicado, revogável pelo Perfil do
admin), rota POST /api/agente/notas idempotente pela chave, gravação do XML
em storage/app/fotos/<dono>/<id>.xml. Nota importada nasce com
documento='nfe', metodo_captura='agente', sem dono definido (user_id = null
NÃO é permitido hoje — crie um colaborador "Importadas" ou uma fila
"a atribuir" no Perfil do gestor, e me explique a opção escolhida antes de
codar). No app: aba/filtro "Importadas pela Receita", botão para o gestor
atribuir cada nota ao colaborador e à aba (RDA/RDM), e a marcação de
possível duplicata contra as notas lançadas à mão. Verifique no navegador
e no celular.
```

**Passo 3 — NFS-e (só se o levantamento mostrar volume):**

```
Fase 11, passo 3 — NFS-e nacional.

Verifique, prefeitura por prefeitura onde a equipe atua, se a NFS-e está no
padrão nacional (ADN). Para as que estão, adicione ao Agente a distribuição
de NFS-e para o tomador (CNPJ da empresa), mesmo fluxo do passo 1, com
documento='nfse'. Para as que não estão, apenas documente — não tente
integrar portal municipal.
```

Custos a lembrar: e-CNPJ A1 ~R$ 150–250/ano (renovação anual = trocar no
repositório do Windows e nada mais); o computador do Agente precisa ficar
ligado nos horários de consulta.

---

## Fase 12 — Arquivos no próprio servidor (substitui o Google Drive)

Registrado em 19/09/2026 (builds 174–175). Pergunta que originou: "qual a
melhor forma de armazenamento para substituir o Drive, de preferência no
próprio servidor Locaweb, sem perder desempenho".

**Decisão**: o disco da Locaweb **já era** o armazenamento principal desde a
Fase 4 (`api-petermann/storage/app/fotos/<colaborador>/<nota>.ext`, banco só
com o caminho). O Drive era uma segunda cópia (árvore de pastas para o gestor
navegar) mais o "Sheets ao vivo". Então a fase não trocou de armazenamento:
tirou a dependência do Drive e deu ao gestor, dentro do app, o que ele ia
buscar lá. Locaweb Hospedagem II não tem object storage; o disco do site é a
única opção nativa e basta (19/09: 50 fotos = 48 MB, ~1 MB por foto; volume
com 332 GB livres — a cota do plano é o que vale, conferir no painel).

**O que foi feito** (tudo no ar):

| Etapa | Onde | O quê |
|---|---|---|
| 1 Miniaturas | `FotoStorage::miniatura()`, `FotoController` (`?mini=1`) | `<colab>/mini/<nota>.jpg` (GD, 360 px, ~20 KB), gerada no upload ou na 1ª vez; URL assinada arredondada para a hora → cache do navegador; corrige orientação EXIF |
| 2 Tela Arquivos | `js/arquivos.js`, `ArquivosController@resumo|notas` | Início → 📁 Arquivos (gestor/admin): Colaborador → Ano → Mês → grupo (RDA / RDM·ABASTECIMENTO / HOSPEDAGENS / OUTROS), miniaturas, toque abre a foto; tudo montado do banco, nada de varrer disco |
| 3 ZIP | `ArquivosController@zip`, `App\Services\PastaModelo` | ZIP do mês ou do ano na árvore da pasta modelo (`Colaborador/Ano/RDM DESPESAS CORPORATIVAS/ABASTECIMENTO/09 set/2026-09-03 POSTO X R$120,00.jpg`) + `Planilha_CV_<ano>.xlsx` + `SEM ANEXO.txt`; gravado em arquivo temporário (não pesa na memória), STORE (jpg não comprime) |
| 4 Backup | `App\Services\BackupCompleto`, `artisan backup:gerar`, `BackupController@lista|completo|arquivo` | ZIP banco + fotos em `storage/app/backups/` (fora do public_html), rotação de 8; Perfil (admin) lista os automáticos e baixa; "Baixar backup completo" gera na hora. Locaweb tem SQLite 3.26 (sem `VACUUM INTO`) → cópia do banco por `SQLite3::backup` — isso também consertou o `/backup/banco`, que falhava em produção |
| 5 Drive desligado | `js/gdrive.js` (`DESATIVADO = true`) | `isConfigured()`/`isConnected()` falsos → sem popup, token, upload, badge, seção no Perfil; botões "Google Sheets" (Saldo/Equipe) e ☁️ removidos; `gsheets.js` fora do index/SW; login Google segue só com openid/email/profile. Código do Drive continua inteiro: para reativar, `DESATIVADO = false` |

**Agendador de tarefas no painel da Locaweb** (o usuário cadastra; 1x por
semana, madrugada de domingo):

```
/usr/bin/php84 /home/storage/c/d7/cb/pmservicosagronomico/api-petermann/artisan backup:gerar
```

Cada execução leva ~1 s por 50 MB e grava `petermann-AAAA-MM-DD-HHMM.zip`
(hora do Brasil). Espaço: 8 cópias × tamanho das fotos — se a cota apertar,
reduzir `--manter` ou baixar a foto de 1800 px/q0,75 para ~1400 px.

**Prompt para retomar** (se algo desta fase precisar de ajuste):

```
Fase 12 — arquivos no servidor. Contexto: fotos em storage/app/fotos, miniaturas
em <colab>/mini/, tela Arquivos (js/arquivos.js + ArquivosController), ZIP na
árvore da PastaModelo, backup por `artisan backup:gerar` (BackupCompleto) com
lista no Perfil, Drive desligado por DESATIVADO=true em gdrive.js.
Preciso de: «descrever». Não reative o Drive; não apague nada do disco; deploy
= empacotar.js app + scp + unzip, API por scp de arquivo + optimize:clear.
```

Pendente desta fase: o usuário cadastrar o agendador; depois de 2 semanas
com backups automáticos aparecendo, apagar de vez o código do Drive
(gdrive.js, gsheets.js, funções *Drive* em app.js/gestor.js, escopo `drive`
em GoogleOAuth) — hoje só está desligado.

---

## Prompts de emergência

**Rollback (voltar para o Supabase)**
```
EMERGÊNCIA — preciso voltar o app para o Supabase agora. O app novo na
Locaweb está com «problema». Me diga o passo exato no DNS para recolocar o
CNAME de "app" no GitHub Pages, quanto tempo leva, o que a equipe perde
(lançamentos feitos no novo depois da virada) e como recuperar isso depois.
```

**API responde 500**
```
A API na Locaweb responde erro 500 em «rota». Me guie para ler o erro com
segurança (APP_DEBUG=true por um minuto e depois desligar, ou o arquivo
api-petermann/storage/logs/laravel-«data».log). Eu colo aqui o trecho do
erro e você corrige.
```

**Foto não aparece / "sem anexo"**
```
Uma nota migrada aparece sem anexo no app novo. Nota id «uuid», colaborador
«e-mail». Verifique: (1) foto_path no banco (baixe o backup pelo Perfil ou
me diga os dados), (2) se o arquivo existe em
api-petermann/storage/app/fotos/<user_id>/, (3) se POST /api/fotos/urls
devolve URL para esse caminho, (4) se o reparo (POST /api/notas/reparar-fotos)
resolve. Só religue referência; não apague nem suba nada.
```

**Login com Google falha**
```
O botão "Continuar com Google" volta com erro «texto do erro/#auth_error=…».
Confira nesta ordem: /api/ping mostra "google": true? A URI de callback
está cadastrada no Google Cloud exatamente igual? GOOGLE_CLIENT_ID/SECRET no
.env da Locaweb batem com o cliente? O log da API tem "google callback:"?
```

**E-mail não chega (repasse ou senha)**
```
O e-mail de «repasse/redefinição de senha» não chegou. Verifique na tabela
repasse_emails (coluna erro — num backup baixado pelo Perfil) ou no log da
API, se RESEND_API_KEY está
no .env da Locaweb e se o domínio continua verificado no Resend. Me diga o
motivo e como reenviar.
```

**Publicar uma correção depois da migração**
```
Quero publicar uma alteração «no app / na API». Suba o número de build
(app: APP_BUILD, ?v= e CACHE do sw.js, todos iguais), gere o zip com
`node scripts/empacotar.js «app|api»` e me diga onde extrair na Locaweb
sem tocar na pasta storage/app/fotos.
```

---

## Textos para o suporte da Locaweb (não são para o Claude)

**Versão do PHP**
```
Olá. Tenho o plano Hospedagem II (site pmservicosagronomicos.com.br,
Linux). Preciso rodar uma aplicação Laravel 13, que exige PHP 8.3 ou
superior. Como seleciono a versão 8.3 para este site? Ela está disponível no
meu plano? Preciso também das extensões pdo_sqlite, mbstring, openssl,
fileinfo e curl habilitadas.
```

**Subdomínio apontando para subpasta**
```
Olá. Quero criar o subdomínio api.pmservicosagronomicos.com.br com a raiz
de documentos na pasta api-petermann/public (uma subpasta dentro de uma
pasta que não é servida). Consigo apontar o subdomínio para essa subpasta
pelo painel? Se não, qual é o caminho recomendado para manter arquivos fora
do diretório público (por exemplo o .env e a pasta storage do Laravel)?
```

**Certificado SSL para subdomínios**
```
Olá. Criei os subdomínios app. e api. em pmservicosagronomicos.com.br.
Como ativo o certificado SSL gratuito (Let's Encrypt) para cada um deles?
```

---

## Texto para o Google Cloud (memória para você)

Projeto **CLEITON-PM** (nº 15986245838) → APIs e serviços → Credenciais →
cliente OAuth 2.0 já existente → **URIs de redirecionamento autorizados** →
adicionar:

```
https://api.pmservicosagronomicos.com.br/api/auth/google/callback
```

Copiar **ID do cliente** e **Chave secreta** → `GOOGLE_CLIENT_ID` e
`GOOGLE_CLIENT_SECRET` no `.env` da API na Locaweb.
