---
name: pedido
description: Estrutura um pedido de programação do NOTAS PM em contexto, objetivo, escopo, forma de verificar e ação permitida, completando só o que faltar. Use quando o usuário digitar /pedido, ou quando o pedido for vago e de risco (exclusão, repasse, sincronização, banco, publicação em produção).
---

# Pedido estruturado

Objetivo: transformar um pedido solto em algo executável **sem adivinhar** e sem ação que o usuário não autorizou.

## 1. Ler o que já veio

Extraia do que o usuário escreveu (e dos prints) cada campo:

| Campo | O que precisa estar claro |
|---|---|
| **Contexto** | quem relatou, papel (colaborador/gestor/contabilidade), aparelho, quando, teste ou produção, print |
| **Problema/objetivo** | o que acontece x o que deveria acontecer |
| **Escopo** | onde pode e onde NÃO pode mexer (tela, API, banco) |
| **Verificar com** | teste PHPUnit, print a 320/360 px, build em teste, log de acesso |
| **Ação** | `investigar` · `corrigir` · `corrigir + publicar em teste` · `publicar em produção` |

## 2. Perguntar só o que falta

- Se faltarem 1–4 campos, pergunte **de uma vez** (AskUserQuestion, com opções quando houver; "Ação" quase sempre vira pergunta de múltipla escolha). Nunca devolva um questionário de cinco perguntas para um pedido que já traz quase tudo.
- Se faltar só a **Ação**, assuma o mais seguro: `investigar` para pergunta ("por que…", "o que acha…"); `corrigir` + conferir em teste para ordem direta. **Produção só com "publica em produção" dito de forma explícita** — "habilitei o ssh" ou "pode seguir" não valem.
- Se o pedido misturar assuntos, numere, proponha a ordem e trate um por vez (um build por assunto).

## 3. Confirmar em uma linha e agir

Antes de agir, repita em 3–5 linhas: o que entendeu, escopo, como vai verificar e a ação. Em risco alto (exclusão, repasse/recarga, sync, schema, produção) mostre **o plano e o que vai mudar** e espere o "sim"; em UI, mostre imagem antes de implementar. Em risco baixo, só prossiga.

## 4. Encaminhar para a skill certa

- Relato de campo (sumiu/falhou/não sobe) → `diagnosticar-caso`
- Mudança de tela/layout → `testar-celular`
- Mudança em `api/` → `testar-api`
- Coluna/tabela nova → `migrar-banco`
- Subir para teste/produção → `publicar`

## 5. Fechar

Resumo curto: o que foi feito, como foi verificado (cole a prova), o que falta com o usuário. Se o pedido revelar preferência nova do usuário sobre como trabalhar, salve na memória.
