---
name: publicar
description: Publica o app/API do NOTAS PM na Locaweb com checklist de segurança (git status, 3 marcadores de build, "Como usar", teste antes de produção). Use quando o usuário pedir para publicar, subir, colocar no ar, mandar para teste ou produção.
---

# Publicar NOTAS PM

Regra de ouro: **teste primeiro, produção só depois de conferido e com o "sim" do usuário.**

## 1. Antes de publicar (checklist)

1. `git status` e `git log -3`: o que sobe é o que está no **disco**. Se houver mudança que não é desta tarefa (sessão paralela), pare e avise antes de seguir.
2. Os 3 marcadores de build (`APP_BUILD` em `js/app.js`, `CACHE` em `sw.js`, `?v=NNN` no `index.html`) sobem juntos com `node scripts/bump-build.js` (sem argumento = build atual + 1; `--ver` só confere). Nunca republique conteúdo diferente sob o mesmo número.
3. A mudança altera a interação? Então a seção correspondente do `#ajuda-overlay` ("Como usar") em `index.html` foi atualizada no mesmo build.
4. Mudou `composer.lock`? Use `--vendor`. Mudou schema? Há migração em `rda-rdm-app/migrations/` e ela será aplicada no passo certo.
5. Sintaxe: `node --check` nos JS alterados; `php -l` nos PHP (lembre que `php -l` não pega barra invertida comida — execute o código de verdade quando mexer em PHP com namespaces).
6. Commit feito (mensagem `feat|fix(escopo): ... (build N)`).

## 2. Homologação

```bash
bash scripts/publicar.sh teste tudo
```
Confirme que o build servido é o novo (o script já confere). Se a saída vier vazia/exit 0 sem efeito, é o SSH expirado (3 h) — peça renovação no painel da Locaweb.
Teste a mudança em https://teste.pmservicosagronomicos.com.br/rda-rdm-app/ (preview/Chrome) e mostre prova ao usuário.

## 3. Produção (só com confirmação explícita)

```bash
bash scripts/publicar.sh producao tudo
```
Migração em produção: o admin roda pelo app (Perfil → Atualizar estrutura do banco). Avise o usuário para reabrir o app (service worker) e conferir o número do build no diagnóstico.

## 4. Fechamento

`git push`. Resuma: build N, onde está no ar, o que mudou, se a ajuda foi atualizada, pendências. Rollback: `git checkout <commit> -- rda-rdm-app api && bash scripts/publicar.sh producao tudo`.
