#!/usr/bin/env bash
# Grava a chave da API da Anthropic (ANTHROPIC_API_KEY) no .env do servidor,
# SEM a chave passar por chat, histórico do shell ou arquivo do repositório.
#
#   bash scripts/definir-chave-ia.sh teste|producao            # pede a chave (oculta) e grava
#   bash scripts/definir-chave-ia.sh teste|producao --verificar  # só diz se a chave já está no .env
#
# Usa SFTP (a Locaweb está sem shell remoto). Antes de gravar, guarda uma cópia
# do .env anterior em ~/.env.bak-<data> no servidor e uma cópia local temporária.
set -euo pipefail
AMB="${1:-}"; MODO="${2:-}"
case "$AMB" in
  teste)    API_DIR=api-teste ;;
  producao) API_DIR=api-petermann ;;
  *) echo "uso: bash scripts/definir-chave-ia.sh teste|producao [--verificar]"; exit 1 ;;
esac
SSH_OPTS=(-o Ciphers=aes256-ctr -o MACs=hmac-sha2-256 -o BatchMode=yes -o ConnectTimeout=25)
HOST=locaweb
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

printf 'get %s/.env %s/env.atual\n' "$API_DIR" "$TMP" > "$TMP/get.b"
sftp "${SSH_OPTS[@]}" -b "$TMP/get.b" "$HOST" >/dev/null 2>&1 || true
if [[ ! -s "$TMP/env.atual" ]]; then
  echo "✗ não consegui ler ~/$API_DIR/.env (SSH/SFTP expirado? renove no painel da Locaweb)"; exit 1
fi

if grep -qE '^ANTHROPIC_API_KEY=.+' "$TMP/env.atual"; then TEM=sim; else TEM=não; fi
if [[ "$MODO" == "--verificar" ]]; then
  echo "$AMB: ANTHROPIC_API_KEY já está no .env? $TEM"; exit 0
fi

read -rsp "Cole a chave (sk-ant-...) e tecle Enter — não aparece na tela: " CHAVE; echo
CHAVE=$(printf '%s' "$CHAVE" | tr -d '[:space:]"'"'")      # tira espaço, quebra de linha (\r) e aspas que vêm junto da colagem
if [[ ! "$CHAVE" =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]]; then
  # diagnóstico SEM revelar a chave: tamanho, começo (7 letras) e se veio abreviada com "..."
  ABREV=não; [[ "$CHAVE" == *...* || "$CHAVE" == *…* ]] && ABREV=sim
  echo "✗ isso não parece uma chave da Anthropic: recebi ${#CHAVE} caracteres, começando com '${CHAVE:0:7}', abreviada com '...': $ABREV"
  echo "  (uma chave inteira tem uns 100+ caracteres e começa com sk-ant-; copie de novo logo após criar)"
  exit 1
fi

# remove a linha antiga (se houver), garante quebra de linha no fim e acrescenta a nova
tr -d '\r' < "$TMP/env.atual" | grep -v '^ANTHROPIC_API_KEY=' > "$TMP/env.novo" || true
[[ -n "$(tail -c1 "$TMP/env.novo")" ]] && echo >> "$TMP/env.novo"
printf 'ANTHROPIC_API_KEY=%s\n' "$CHAVE" >> "$TMP/env.novo"
unset CHAVE

DATA=$(date +%Y%m%d-%H%M)
{
  echo "put $TMP/env.atual $API_DIR/.env.bak-$DATA"
  echo "put $TMP/env.novo $API_DIR/.env"
} > "$TMP/put.b"
sftp "${SSH_OPTS[@]}" -b "$TMP/put.b" "$HOST" >/dev/null

# confere de volta: a linha existe e o resto do arquivo continua igual
sftp "${SSH_OPTS[@]}" -b "$TMP/get.b" "$HOST" >/dev/null 2>&1 || true
if grep -qE '^ANTHROPIC_API_KEY=sk-ant-' "$TMP/env.atual" && [[ $(wc -l < "$TMP/env.atual") -ge $(wc -l < "$TMP/env.novo") ]]; then
  echo "✔ chave gravada em ~/$API_DIR/.env (cópia do .env anterior: ~/$API_DIR/.env.bak-$DATA)"
else
  echo "✗ não consegui confirmar a gravação — confira ~/$API_DIR/.env"; exit 1
fi
