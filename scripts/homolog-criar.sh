#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Cria (ou recria) o ambiente de HOMOLOGAÇÃO na Locaweb (21/09/2026)
#
#    bash scripts/homolog-criar.sh            # cria api-teste a partir da produção
#    bash scripts/homolog-criar.sh --dados    # só recopia banco + fotos da produção
#
#  Resultado:
#    app  → https://teste.pmservicosagronomicos.com.br/rda-rdm-app/
#           (subdomínio já existente no painel; pasta ~/public_html/teste)
#    API  → https://api.pmservicosagronomicos.com.br/teste/api/…
#           (~/public_html/api-petermann/public/teste → ~/api-teste, fora do web root)
#
#  A API de teste é uma cópia do código + vendor da produção, com .env,
#  banco (SQLite) e fotos PRÓPRIOS. O .env troca URLs, CORS, APP_ENV=staging e
#  não envia e-mail nenhum (sem RESEND_API_KEY) — repasse e alertas só no log.
#  Depois de criar, publique o código com: bash scripts/publicar.sh teste tudo
# ─────────────────────────────────────────────────────────────
set -euo pipefail
SSH_OPTS=(-o Ciphers=aes256-ctr -o MACs=hmac-sha2-256 -o BatchMode=yes -o ConnectTimeout=25)
HOST=locaweb
SO_DADOS=0; [[ "${1:-}" == "--dados" ]] && SO_DADOS=1

ssh "${SSH_OPTS[@]}" "$HOST" "SO_DADOS=$SO_DADOS bash -s" <<'REMOTO'
set -euo pipefail
PHP=/usr/bin/php84
PROD=$HOME/api-petermann
TESTE=$HOME/api-teste
WEB=$HOME/public_html/api-petermann/public/teste

if [[ "$SO_DADOS" == "0" ]]; then
  echo "▸ código + vendor → $TESTE"
  mkdir -p "$TESTE"
  for d in app bootstrap config lang public resources routes vendor; do
    rm -rf "$TESTE/$d"; cp -a "$PROD/$d" "$TESTE/$d"
  done
  cp -a "$PROD"/artisan "$PROD"/composer.json "$PROD"/composer.lock "$TESTE"/
  mkdir -p "$TESTE"/database/migrations && cp -a "$PROD"/database/migrations/. "$TESTE"/database/migrations/
  rm -f "$TESTE"/bootstrap/cache/*.php
  mkdir -p "$TESTE"/storage/{app/{fotos,backups,public,private},framework/{cache/data,sessions,views},logs}
  chmod -R u+rwX "$TESTE"/storage

  echo "▸ .env de homologação"
  if [[ ! -f "$TESTE/.env" ]]; then
    grep -vE '^(APP_ENV|APP_URL|APP_DEBUG|FRONT_URL|CORS_ORIGINS|RESEND_API_KEY|FOTOS_PATH|APP_KEY|ARMAZENAMENTO_LIMITE_MB|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET)=' "$PROD/.env" > "$TESTE/.env"
    cat >> "$TESTE/.env" <<'ENV'

# ─── HOMOLOGAÇÃO (gerado por scripts/homolog-criar.sh, 21/09/2026) ───
APP_ENV=staging
APP_DEBUG=false
APP_URL=https://api.pmservicosagronomicos.com.br/teste
FRONT_URL=https://teste.pmservicosagronomicos.com.br/rda-rdm-app
CORS_ORIGINS=https://teste.pmservicosagronomicos.com.br,http://localhost:8080,http://127.0.0.1:8080
# homologação não manda e-mail nenhum (sem chave do Resend): repasse e alertas só vão para o log
RESEND_API_KEY=
# login Google só na produção (o callback /teste/… não está cadastrado no Google Cloud): botão fica oculto
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
ARMAZENAMENTO_LIMITE_MB=2048
APP_KEY=
ENV
    (cd "$TESTE" && $PHP artisan key:generate --force -q)
    echo "  .env criado (APP_KEY nova)"
  else
    echo "  .env já existia — mantido"
  fi

  echo "▸ web root $WEB"
  mkdir -p "$WEB"
  cp -a "$PROD/public/.htaccess" "$WEB/.htaccess"
  cp -a "$PROD/public/.user.ini" "$WEB/.user.ini" 2>/dev/null || true
  cat > "$WEB/index.php" <<'PHPX'
<?php

use Illuminate\Foundation\Application;
use Illuminate\Http\Request;

define('LARAVEL_START', microtime(true));

/* HOMOLOGAÇÃO: api.pmservicosagronomicos.com.br/teste → $HOME/api-teste
   (cópia da API com banco e fotos próprios). Gerado por scripts/homolog-criar.sh. */
$app_dir = dirname(__DIR__, 4).'/api-teste';

if (file_exists($maintenance = $app_dir.'/storage/framework/maintenance.php')) {
    require $maintenance;
}
require $app_dir.'/vendor/autoload.php';

/** @var Application $app */
$app = require_once $app_dir.'/bootstrap/app.php';

$app->handleRequest(Request::capture());
PHPX
  printf 'User-agent: *\nDisallow: /\n' > "$WEB/robots.txt"
fi

echo "▸ banco + fotos (cópia da produção de agora)"
rm -f "$TESTE"/database/database.sqlite "$TESTE"/database/database.sqlite-wal "$TESTE"/database/database.sqlite-shm
$PHP -r '$s=new SQLite3($argv[1], SQLITE3_OPEN_READONLY); $d=new SQLite3($argv[2]); if(!$s->backup($d)) { fwrite(STDERR,"backup falhou\n"); exit(1);} echo "  banco copiado\n";' "$PROD/database/database.sqlite" "$TESTE/database/database.sqlite"
rm -rf "$TESTE/storage/app/fotos"; cp -a "$PROD/storage/app/fotos" "$TESTE/storage/app/fotos"
echo "  fotos: $(find "$TESTE/storage/app/fotos" -type f | wc -l) arquivos"
# tokens de login da produção não valem no teste (APP_KEY diferente, sessões separadas)
$PHP -r '$d=new SQLite3($argv[1]); $d->exec("DELETE FROM personal_access_tokens"); $d->exec("DELETE FROM convites"); echo "  tokens limpos\n";' "$TESTE/database/database.sqlite"

cd "$TESTE" && $PHP artisan migrate --force -q && echo "▸ migrações ok"
echo "▸ pronto"
REMOTO

echo
echo "Conferindo:"
curl -s --max-time 20 https://api.pmservicosagronomicos.com.br/teste/api/ping; echo
