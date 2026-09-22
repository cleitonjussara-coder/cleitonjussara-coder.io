#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Publica o app e/ou a API na Locaweb (21/09/2026)
#
#    bash scripts/publicar.sh teste    [app|api|tudo] [--vendor]
#    bash scripts/publicar.sh producao [app|api|tudo] [--vendor]
#
#  Fluxo recomendado: teste → conferir em teste.pmservicosagronomicos.com.br
#  → producao. O que sobe é o que está no disco (commit antes!).
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

AMB="${1:-}"; ALVO="${2:-tudo}"; VENDOR=0
for a in "$@"; do [[ "$a" == "--vendor" ]] && VENDOR=1; done
[[ "$ALVO" == "--vendor" ]] && ALVO=tudo

case "$AMB" in
  teste)    API_DIR=api-teste;     APP_DIR=public_html/teste; WEB_API=public_html/api-petermann/public/teste; PING=https://api.pmservicosagronomicos.com.br/teste/api/ping; APP_URL=https://teste.pmservicosagronomicos.com.br/rda-rdm-app/ ;;
  producao) API_DIR=api-petermann; APP_DIR=public_html/app;   WEB_API=public_html/api-petermann/public;       PING=https://api.pmservicosagronomicos.com.br/api/ping;       APP_URL=https://app.pmservicosagronomicos.com.br/rda-rdm-app/ ;;
  *) echo "uso: bash scripts/publicar.sh teste|producao [app|api|tudo] [--vendor]"; exit 1 ;;
esac
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
    [[ "$AMB" == "teste" ]] && echo "put rda-rdm-app/manifest-teste.json $APP_DIR/rda-rdm-app/manifest-teste.json"
  } > "$lote"
  sftp "${SSH_OPTS[@]}" -b "$lote" "$HOST" >/dev/null
  rm -f "$lote"
  echo "  ⚠ imagens/ícones NOVOS não vão por aqui — só js/, index.html, sw.js e manifest."
}

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

if [[ "$ALVO" == "api" || "$ALVO" == "tudo" ]]; then
  echo "▸ api → ~/$API_DIR"
  PASTAS=(app bootstrap/app.php bootstrap/providers.php config database/migrations lang resources routes artisan composer.json composer.lock)
  [[ "$VENDOR" == "1" ]] && PASTAS+=(vendor) && echo "  (com vendor/)"
  tar -C api -czf - --exclude='bootstrap/cache' "${PASTAS[@]}" \
    | ssh "${SSH_OPTS[@]}" "$HOST" "cd ~/$API_DIR && tar -xzf - && rm -f bootstrap/cache/*.php"
  # .htaccess/.user.ini do web root vêm do repositório (api/public)
  scp "${SSH_OPTS[@]}" -q api/public/.htaccess "$HOST:$WEB_API/.htaccess"
  scp "${SSH_OPTS[@]}" -q api/public/.user.ini "$HOST:$WEB_API/.user.ini"
  if [[ "$AMB" == "teste" ]]; then
    ssh "${SSH_OPTS[@]}" "$HOST" "cd ~/$API_DIR && /usr/bin/php84 artisan migrate --force 2>&1 | tail -3"
  else
    PEND=$(ssh "${SSH_OPTS[@]}" "$HOST" "cd ~/$API_DIR && /usr/bin/php84 artisan migrate:status 2>/dev/null | grep -c Pending || true")
    [[ "${PEND:-0}" != "0" ]] && echo "  ⚠ $PEND migração(ões) pendente(s): Perfil → 🛠️ Atualizar estrutura do banco"
  fi
fi

printf '▸ ping: '; curl -s --max-time 20 "$PING" | head -c 200; echo
