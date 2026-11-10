#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Publica o app e/ou a API na Locaweb (21/09/2026)
#
#    bash scripts/publicar.sh teste    [app|api|tudo] [--vendor] [--sem-testes]
#    bash scripts/publicar.sh producao [app|api|tudo] [--vendor] [--sem-testes]
#
#  Fluxo recomendado: teste → conferir em teste.pmservicosagronomicos.com.br
#  → producao. O que sobe é o que está no disco (commit antes!).
#
#  Antes de enviar qualquer coisa roda os testes (PHPUnit se o alvo tem api, e
#  testar-sync-conflito.js sempre). Falhou, para sem enviar. --sem-testes pula
#  a checagem: só em emergência.
#
#  app  = node scripts/empacotar.js app → scp → unzip na pasta do subdomínio
#  api  = tar de app/ bootstrap/ config/ database/migrations/ lang/ resources/
#         routes/ + public/.htaccess/.user.ini → extrai em ~/api-<amb>
#         (.env, storage/ e banco NUNCA são tocados). --vendor manda vendor/
#         também (só quando o composer.lock mudou).
#  Na homologação as migrações rodam sozinhas; na produção o admin roda
#  pelo app (Perfil → 🛠️ Atualizar estrutura do banco), como sempre.
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

VENDOR=0; SEM_TESTES=0; SEM_GIT=0; POS=()
for a in "$@"; do
  case "$a" in
    --vendor)     VENDOR=1 ;;
    --sem-git)    SEM_GIT=1 ;;
    --sem-testes) SEM_TESTES=1 ;;
    *)            POS+=("$a") ;;
  esac
done
AMB="${POS[0]:-}"; ALVO="${POS[1]:-tudo}"

USO="uso: bash scripts/publicar.sh teste|producao [app|api|tudo] [--vendor] [--sem-testes] [--sem-git]"
case "$ALVO" in app|api|tudo) ;; *) echo "$USO"; exit 1 ;; esac
case "$AMB" in
  teste)    API_DIR=api-teste;     APP_DIR=public_html/teste; WEB_API=public_html/api-petermann/public/teste; PING=https://api.pmservicosagronomicos.com.br/teste/api/ping; APP_URL=https://teste.pmservicosagronomicos.com.br/rda-rdm-app/ ;;
  producao) API_DIR=api-petermann; APP_DIR=public_html/app;   WEB_API=public_html/api-petermann/public;       PING=https://api.pmservicosagronomicos.com.br/api/ping;       APP_URL=https://app.pmservicosagronomicos.com.br/rda-rdm-app/ ;;
  *) echo "$USO"; exit 1 ;;
esac

# 04/11/2026: nada conferia os testes antes de subir; bug já pego pela suíte podia ir ao ar.
# Fica aqui em cima, antes do primeiro envio, e qualquer falha encerra sem tocar no servidor.
php_local() {
  local winget="/c/Users/user/AppData/Local/Microsoft/WinGet/Packages/PHP.PHP.8.3_Microsoft.Winget.Source_8wekyb3d8bbwe/php.exe"
  if [[ -n "${PHP_BIN:-}" ]]; then echo "$PHP_BIN"
  elif [[ -x "$winget" ]]; then echo "$winget"   # o php do winget não está no PATH do Git Bash
  elif command -v php >/dev/null 2>&1; then echo php
  else return 1
  fi
}

rodar_testes() {
  if [[ "$ALVO" == "api" || "$ALVO" == "tudo" ]]; then
    echo "▸ testes: PHPUnit"
    local php
    php=$(php_local) || { echo "  ✗ php não encontrado: nada foi enviado"; exit 1; }
    # --configuration é obrigatório: sem ele o PHPUnit roda migrate:fresh no banco local.
    if ! (cd api && DB_CONNECTION=sqlite DB_DATABASE=:memory: "$php" vendor/bin/phpunit --configuration phpunit.xml --no-progress); then
      echo "  ✗ PHPUnit falhou: nada foi enviado"; exit 1
    fi
  fi
  # 09/11/2026 (auditoria): o lint fecha com zero erro; um no-undef novo é nome que sumiu (caso do build 588).
  if [[ "$ALVO" == "app" || "$ALVO" == "tudo" ]]; then
    echo "▸ testes: ESLint do app"
    if [[ ! -d rda-rdm-app/node_modules ]]; then
      echo "  ✗ rda-rdm-app/node_modules não existe (rode npm ci lá): nada foi enviado"; exit 1
    fi
    if ! (cd rda-rdm-app && npx --no-install eslint --no-warn-ignored --quiet js/*.js sw.js); then
      echo "  ✗ ESLint achou erro: nada foi enviado"; exit 1
    fi
  fi
  echo "▸ testes: sincronização"
  if ! node scripts/testar-sync-conflito.js; then
    echo "  ✗ testar-sync-conflito falhou: nada foi enviado"; exit 1
  fi
  echo "  ✔ testes passaram"
}

# 10/11/2026 (auditoria, item 1): o que sobe é o disco. Pasta com arquivo modificado ou atrás do
# GitHub publicaria código velho (a pasta principal chegou a estar no 601 com a produção no 603).
conferir_git() {
  echo "▸ git: pasta limpa e em dia com origin/main"
  local sujos
  sujos=$(git status --porcelain --untracked-files=no)
  if [[ -n "$sujos" ]]; then
    echo "$sujos" | sed 's/^/    /'
    echo "  ✗ há arquivo modificado sem commit: commite (ou guarde) antes de publicar. Nada foi enviado"; exit 1
  fi
  if git fetch -q origin main 2>/dev/null; then
    if ! git merge-base --is-ancestor origin/main HEAD; then
      echo "  ✗ esta pasta está ATRÁS do GitHub (origin/main $(git rev-parse --short origin/main), aqui $(git rev-parse --short HEAD))."
      echo "    Publicar daqui desfaria o que já está no ar. Rode git pull (ou rebase) antes. Nada foi enviado"; exit 1
    fi
  else
    echo "  ⚠ sem acesso ao GitHub agora: não deu para conferir se a pasta está em dia"
  fi
}
if [[ "$SEM_GIT" == "1" ]]; then
  echo "  ⚠ --sem-git: publicando sem conferir o git (só em emergência)"
else
  conferir_git
fi

if [[ "$SEM_TESTES" == "1" ]]; then
  echo "════════════════════════════════════════════════════════════"
  echo "  ⚠⚠⚠  --sem-testes: PUBLICANDO SEM RODAR OS TESTES ($AMB)  ⚠⚠⚠"
  echo "  Só em emergência. Rode os testes assim que der."
  echo "════════════════════════════════════════════════════════════"
else
  rodar_testes
fi

SSH_OPTS=(-o Ciphers=aes256-ctr -o MACs=hmac-sha2-256 -o BatchMode=yes -o ConnectTimeout=25)
HOST=locaweb
BUILD=$(grep -o 'APP_BUILD = [0-9]*' rda-rdm-app/js/app.js | grep -o '[0-9]*')

# Build realmente servido pela web (não confia no que o servidor "disse")
publicado() { curl -s --max-time 25 "${APP_URL}js/app.js?zz=$RANDOM$RANDOM" | grep -o 'APP_BUILD = [0-9]*' | grep -o '[0-9]*' | head -1; }

# Plano B: 22/09/2026 o SSH da Locaweb passou a aceitar conexão mas NÃO executar
# comando nenhum (saída vazia, exit 0) — o unzip nunca acontecia e o script
# seguia "com sucesso". O SFTP continuou funcionando, então mandamos os
# arquivos que mudam a cada build direto para a pasta.
sftp_app() {
  echo "  plano B: enviando por SFTP (sem shell remoto)"
  local lote; lote=$(mktemp)
  {
    echo "put -r rda-rdm-app/js $APP_DIR/rda-rdm-app"
    echo "put rda-rdm-app/index.html $APP_DIR/rda-rdm-app/index.html"
    echo "put rda-rdm-app/sw.js $APP_DIR/rda-rdm-app/sw.js"
    echo "put rda-rdm-app/manifest.json $APP_DIR/rda-rdm-app/manifest.json"
    echo "put rda-rdm-app/privacidade.html $APP_DIR/rda-rdm-app/privacidade.html"
    [[ "$AMB" == "teste" ]] && echo "put rda-rdm-app/manifest-teste.json $APP_DIR/rda-rdm-app/manifest-teste.json"
  } > "$lote"
  sftp "${SSH_OPTS[@]}" -b "$lote" "$HOST" >/dev/null
  rm -f "$lote"
  echo "  ⚠ imagens/ícones NOVOS não vão por aqui — só js/, index.html, sw.js e manifest."
}

# Mesmo plano B para a API: os arquivos do Laravel são PHP puro, então basta
# gravá-los no lugar. Funciona porque em bootstrap/cache só existem
# packages.php e services.php (não há config/route cache para limpar) —
# confira com `sftp locaweb` → `ls <api>/bootstrap/cache` se mudar.
# vendor/ e as migrações (precisam de artisan) NÃO vão por aqui.
sftp_api() {
  echo "  plano B: enviando a API por SFTP (sem shell remoto)"
  local lote; lote=$(mktemp)
  {
    for d in app config routes resources lang; do echo "put -r api/$d $API_DIR"; done
    echo "put -r api/database/migrations $API_DIR/database"
    echo "put api/bootstrap/app.php $API_DIR/bootstrap/app.php"
    echo "put api/bootstrap/providers.php $API_DIR/bootstrap/providers.php"
    echo "put api/artisan $API_DIR/artisan"
    echo "put api/public/.htaccess $WEB_API/.htaccess"
    echo "put api/public/.user.ini $WEB_API/.user.ini"
  } > "$lote"
  sftp "${SSH_OPTS[@]}" -b "$lote" "$HOST" >/dev/null
  rm -f "$lote"
  echo "  ⚠ vendor/ e migrações do banco NÃO vão por SFTP (dependem do artisan no servidor)."
}

# A API não tem número de build: para saber se o arquivo chegou mesmo,
# trazemos um de volta e comparamos com o do PC.
api_igual() {   # $1 = caminho relativo dentro de api/
  local tmp; tmp=$(mktemp)
  printf 'get %s/%s %s\n' "$API_DIR" "$1" "$tmp" > "$tmp.b"
  sftp "${SSH_OPTS[@]}" -b "$tmp.b" "$HOST" >/dev/null 2>&1
  local ok=1
  cmp -s "api/$1" "$tmp" && ok=0
  rm -f "$tmp" "$tmp.b"
  return $ok
}

# Ordem: a API ANTES do app (21/10/2026). O app novo pode depender de rotas que só a API nova tem; com o app na frente,
# quem abria o app no meio da publicação — ou se a etapa da API falhasse (SSH expirado) — via a tela quebrada (404).
if [[ "$ALVO" == "api" || "$ALVO" == "tudo" ]]; then
  echo "▸ api → ~/$API_DIR"
  PASTAS=(app bootstrap/app.php bootstrap/providers.php config database/migrations lang resources routes artisan composer.json composer.lock)
  [[ "$VENDOR" == "1" ]] && PASTAS+=(vendor) && echo "  (com vendor/)"
  tar -C api -czf - --exclude='bootstrap/cache' "${PASTAS[@]}" \
    | ssh "${SSH_OPTS[@]}" "$HOST" "cd ~/$API_DIR && tar -xzf - && rm -f bootstrap/cache/*.php" || true
  # .htaccess/.user.ini do web root vêm do repositório (api/public)
  scp "${SSH_OPTS[@]}" -q api/public/.htaccess "$HOST:$WEB_API/.htaccess" || true
  scp "${SSH_OPTS[@]}" -q api/public/.user.ini "$HOST:$WEB_API/.user.ini" || true
  # Confere os 3 arquivos MAIS RECENTES da API (os que acabaram de mudar). Comparar um arquivo
  # fixo (AdminController) passava mesmo quando nada novo chegava: com o SSH sem shell o tar não
  # extrai nada e o arquivo fixo, que não mudou, parecia "igual" — o PDF novo ficou de fora do
  # teste em 01/10/2026 e o script dizia "✔ arquivos da API no servidor".
  RECENTES=$(cd api && find app routes config -type f -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -3 | cut -d' ' -f2-)
  conferir_api() { local f; for f in $RECENTES; do api_igual "$f" || return 1; done; return 0; }
  conferir_api || sftp_api
  if ! conferir_api; then
    echo "  ✗ o servidor NÃO recebeu os arquivos da API"; exit 1
  fi
  echo "  ✔ arquivos da API no servidor"
  # Migrações dependem do artisan, que precisa de shell. Sem shell, quem
  # aplica é o gestor/admin pelo app (Perfil → 🛠️ Atualizar estrutura do
  # banco), que chama POST /admin/migrar dentro do próprio Laravel.
  # `grep -c` sai com 1 quando não acha nada e o script roda com `set -e`:
  # sem os dois `|| true` a publicação terminava aqui, calada.
  PEND=$(ssh "${SSH_OPTS[@]}" "$HOST" "cd ~/$API_DIR && /usr/bin/php84 artisan migrate:status 2>/dev/null | grep -c Pending || true" 2>/dev/null || true)
  if [[ -z "$PEND" ]]; then
    echo "  ⚠ sem shell remoto: se esta versão trouxe migração nova, aplique no app (Perfil → 🛠️ Atualizar estrutura do banco)."
  elif [[ "$PEND" != "0" ]]; then
    if [[ "$AMB" == "teste" ]]; then
      ssh "${SSH_OPTS[@]}" "$HOST" "cd ~/$API_DIR && /usr/bin/php84 artisan migrate --force 2>&1 | tail -3"
    else
      echo "  ⚠ $PEND migração(ões) pendente(s): Perfil → 🛠️ Atualizar estrutura do banco"
    fi
  fi
fi

if [[ "$ALVO" == "app" || "$ALVO" == "tudo" ]]; then
  echo "▸ app (build $BUILD) → $AMB"
  node scripts/empacotar.js app >/dev/null
  scp "${SSH_OPTS[@]}" -q petermann-app.zip "$HOST:tmp/petermann-app-$AMB.zip"
  ssh "${SSH_OPTS[@]}" "$HOST" "cd ~/$APP_DIR && unzip -oq ~/tmp/petermann-app-$AMB.zip && rm -f ~/tmp/petermann-app-$AMB.zip && grep -o 'APP_BUILD = [0-9]*' rda-rdm-app/js/app.js" || true
  sleep 2
  if [[ "$(publicado)" != "$BUILD" ]]; then sftp_app; sleep 2; fi
  NO_AR=$(publicado)
  if [[ "$NO_AR" != "$BUILD" ]]; then
    echo "  ✗ o site ainda serve o build ${NO_AR:-?} (esperado $BUILD) — NÃO publicado"; exit 1
  fi
  echo "  ✔ build $BUILD no ar · $APP_URL"
fi

printf '▸ ping: '; curl -s --max-time 20 "$PING" | head -c 200; echo
