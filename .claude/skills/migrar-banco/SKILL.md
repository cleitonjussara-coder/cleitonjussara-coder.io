---
name: migrar-banco
description: Cria e aplica migrações de schema do banco SQLite da API Laravel do NOTAS PM (api/database/migrations), primeiro na homologação e depois em produção, com backup. Use quando for adicionar/alterar coluna, tabela ou índice, ou quando o usuário pedir mudança na estrutura do banco.
---

# Migrar o banco

O banco é **SQLite** em arquivo na Locaweb (`~/api-petermann/database/database.sqlite`; homologação em `~/api-teste`), em troca para **MySQL** desde 06/10/2026 (veja `MIGRACAO-MYSQL.md` e o `DB_CONNECTION` do `.env`). Migração precisa rodar nos dois: no MySQL o tamanho de `string('x', N)` é conferido e texto maior é recusado. O Supabase foi aposentado: `rda-rdm-app/migrations/*.sql` e `supabase_setup.sql` são histórico, **não use**. Toda mudança de schema é uma migração Laravel em `api/database/migrations/`.

## 1. Criar a migração

- Arquivo `api/database/migrations/AAAA_MM_DD_NNNNNN_descricao.php` (NNNNNN sequencial do dia; veja o último existente), classe anônima com `up()` **e `down()`**.
- Comentário no topo com data e o **porquê** (pedido de quem), no estilo das existentes.
- SQLite: `->change()` em coluna recria a tabela (cuidado com tabelas grandes e índices); prefira coluna `nullable()` ou com `default` para não quebrar linhas existentes; migração de dados use `DB::table()->update()` e lembre que UPDATE cru não toca `updated_at` (o sync incremental do app depende dele — atualize `updated_at` explicitamente se o aparelho precisar receber a mudança).
- Mude também o **Model** (`$fillable`, casts) e, se a coluna é sensível (ex.: `confirmado_em`), deixe-a FORA do `$fillable`.
- O app guarda dados no IndexedDB: coluna nova que o aparelho precisa enviar/receber exige ajuste em `db.js`/`api.js` e novo build (skill `publicar`).

## 2. Testar localmente

`cd api && php vendor/bin/phpunit` (usa SQLite em memória e roda todas as migrações do zero — pega erro de sintaxe e de ordem). Escreva teste da regra nova (skill `testar-api`). Teste também o `down()`: `php artisan migrate:rollback --step=1` num banco local descartável, nunca no de produção.

## 3. Homologação

`bash scripts/publicar.sh teste api` envia o código e **roda `migrate --force` sozinho** em `~/api-teste` (precisa de SSH ativo; SSH expira a cada 3 h — se voltar vazio, peça renovação). Confira: `ssh locaweb "cd ~/api-teste && /usr/bin/php84 artisan migrate:status | tail"` e teste a funcionalidade em https://teste.pmservicosagronomicos.com.br/rda-rdm-app/.

## 4. Produção (só com o "sim" explícito do usuário)

1. **Backup antes**: `ssh locaweb "cd ~/api-petermann && /usr/bin/php84 artisan backup:gerar"` (ou botão no Perfil do admin). Confirme que o arquivo novo apareceu em `storage/app/backups/`.
2. `bash scripts/publicar.sh producao api` — na produção o script só **avisa** que há migração pendente e não roda.
3. Quem aplica é o admin, pelo app: **Perfil → 🛠️ Atualizar estrutura do banco** (POST `/api/admin/migrar`). Se houver SSH, também dá: `ssh locaweb "cd ~/api-petermann && /usr/bin/php84 artisan migrate --force"`.
4. Confira `migrate:status` sem "Pending" e teste a funcionalidade no app de produção.
5. Lembre: o front novo só funciona depois que a coluna existe — ordem segura = **migração primeiro, app depois** (colunas aditivas e `nullable` deixam o app antigo funcionando).

## 5. Rollback

- Colunas aditivas: normalmente basta ignorar. Para desfazer: `php84 artisan migrate:rollback --step=1` (só com autorização e backup recente).
- Se algo corromper: restaurar o backup do passo 4.1 (a cópia mensal está em `C:\Users\user\OneDrive\Área de Trabalho\Backups Petermann\`).

## 6. Fechamento

Commit da migração + Model + testes no mesmo commit (`feat(db): ...`), registre no resumo ao usuário: o que mudou, que a homologação passou, que falta o admin tocar em "Atualizar estrutura do banco" na produção. `.env`, `storage/` e o banco nunca entram no git nem no pacote.
