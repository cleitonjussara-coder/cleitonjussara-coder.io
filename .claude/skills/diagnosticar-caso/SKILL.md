---
name: diagnosticar-caso
description: Roteiro para investigar relato de usuário do NOTAS PM ("sumiu", "falhou", "não sobe", "apareceu sozinho", nota/repasse/anexo faltando) usando logs de acesso da Locaweb e consulta somente leitura ao banco. Use quando alguém da equipe relatar nota, repasse ou foto sumindo, travada ou duplicada.
---

# Diagnosticar um caso de campo

Casos reais que moldaram este roteiro: Paulo (anexo vazio no iPhone, 03/10/2026), UDI Star (nota apagada pela própria conta), repasse/recarga "sumindo" (01/10/2026). **Hipótese primeiro, prova depois; nada é alterado em produção durante o diagnóstico.**

## 0. Pré-requisitos

- SSH da Locaweb expira a cada **3 h**. Se `ssh locaweb` abrir e voltar vazio (exit 0), é isso: peça ao usuário para renovar em Configurações > SSH no painel. Não investigue script nem servidor antes.
- Peça sempre: **quem** (colaborador e papel), **qual nota/valor/data**, **aparelho** (iPhone/Android/PC), **hora aproximada** e **print** do que ele vê (chip "falhou", "ok", lixeira…).

## 1. Onde o dado pode estar (do mais barato ao mais caro)

1. **Servidor, tabela `notas`/`repasses`**: existe? `deleted`? `updated_by` ≠ `created_by`?
2. **Lápide `notas_apagadas`** (id, user_id, `apagada_por`, `apagada_em` em UTC): apagada por quem? DELETE é definitivo (linha + arquivo).
3. **Lixeira do app** (`lancamentos_apagados`, só no aparelho) e fila offline do IndexedDB (`pushPending`): se só existe no celular, a **única cópia está lá** — oriente a NÃO sair da conta nem limpar dados do navegador.
4. **Log de acesso** (quem fez o quê e quando) — passo 2.
5. **Histórico/auditoria** (build 287, só o último autor; auditoria de `updated_by` só desde 26/09/2026).

## 2. Log de acesso

`~/logs/access_log2026MMDD` (antigos em `.gz`). Formato por `|`: `ip|-|-|[data]|https|"METODO /api/…"|status|bytes_resp|"referer"|"UA"|xff|%I|%O|%S`.

```bash
ssh locaweb "grep 'api/notas' ~/logs/access_log2026MMDD | awk -F'|' '\$7>=400'"      # 4xx/5xx do dia
ssh locaweb "grep '<id-da-nota>' ~/logs/access_log2026MMDD"                           # vida da nota
```
- `%I` = bytes **recebidos**. Upload de foto normal ≈ 258 KB; ≈ 1,4 KB = **arquivo vazio** (iPhone com arquivo só no iCloud/WhatsApp) → 422.
- `PUT 200` seguido de `DELETE 200` do mesmo id = alguém apagou (cheque a lápide). A diferença exata de 2:00 entre PUT e DELETE já foi vista: se repetir, investigue o código de exclusão do app.
- Erros 422/403 **não** vão para `storage/logs/laravel-*.log`; 5xx sim.
- User-Agent mostra o aparelho; vários tokens no mesmo celular = troca de conta.

## 3. Banco de produção: somente leitura

- **Nunca baixar o `database.sqlite`** (o sistema bloqueia e há dados pessoais).
- Consulta pontual por id, com PDO `query_only`: `ssh locaweb 'php84' < consulta.php` (script no scratchpad, não no repo). Peça autorização do usuário para consultar por id; consulta ampla pode ser barrada.
- Não fixar e-mails de usuário em scripts.

## 4. Causas já conhecidas (confira antes de inventar teoria)

| Sintoma | Causa provável | Memória |
|---|---|---|
| Chip "⚠️ falhou", 422 no anexo | anexo de 0 bytes (iCloud) | caso-paulo-anexo-vazio-iphone |
| PUT 403 "Contabilidade só consulta" | duas contas no mesmo celular; fila do IndexedDB compartilhada | caso-paulo-anexo-vazio-iphone |
| Nota ok no celular, ausente no servidor | DELETE pela própria conta (ver lápide) | caso-udi-star-nota-apagada-e-nfse |
| Repasse/recarga some | dono apagava o que o gestor pagou; pull perdia janela; mês de destino | repasse-recarga-sumindo |
| Registro apagado volta (ou some) | Drive, `pullIncremental` e lista da equipe do gestor sobrescrevem o local | tres-fontes-sobrescrevem-local |
| Lançamento "aparece sozinho" na lixeira | lixeira órfã | tres-fontes-sobrescrevem-local |
| Número da NFS-e "12741" | era a Lei 12.741 no rodapé; chave de 50 dígitos | nfse-chave-50-digitos |
| Cartão cortado no celular | grid `1fr` + nowrap | layout-grid-1fr-estoura-no-celular |
| Lançamento em mês errado | data manda em mês/ano | data-manda-em-mes-ano |

## 5. Regras de conduta

- **Nada apaga lançamento sozinho** — detectar e avisar é o limite. Não crie exclusão por semelhança.
- Não corrija dado de produção à mão sem o "sim" explícito do usuário e sem backup (`backup:gerar`).
- Sessões paralelas do Claude editam a mesma pasta: antes de corrigir o código, `git status`/`git log`; antes de publicar, use a skill `publicar`.
- Correção de código: escreva o teste que falha no comportamento antigo (skill `testar-api` ou `testar-celular`).

## 6. Fechamento

Responda ao usuário em linguagem simples: **o que aconteceu, a prova (log/lápide), se dá para recuperar, o que ele deve fazer agora** e o que foi corrigido. Se o caso ensinou algo novo, registre na memória (`caso-<nome>`) e atualize a tabela do passo 4.
