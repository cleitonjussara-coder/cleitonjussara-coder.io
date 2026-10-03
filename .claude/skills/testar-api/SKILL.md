---
name: testar-api
description: Roda e escreve os testes PHPUnit da API Laravel do NOTAS PM (api/), com banco SQLite em memória, sem tocar produção. Use depois de mexer em api/ (controllers, models, services, migrações, relatórios) ou quando o usuário pedir para testar o servidor/backend.
---

# Testar a API (Laravel)

## 1. Rodar

```bash
cd api && php vendor/bin/phpunit            # tudo (14 testes, ~35 s em 03/10/2026)
cd api && php vendor/bin/phpunit --filter RepasseProtegido
cd api && php vendor/bin/phpunit tests/Feature/RepasseProtegidoTest.php
```

- O `php` (8.3 via winget) já está acessível pelo bash; se não estiver, use o caminho completo: `C:\Users\user\AppData\Local\Microsoft\WinGet\Packages\PHP.PHP.8.3_Microsoft.Winget.Source_8wekyb3d8bbwe\php.exe` (a mesma pasta tem o `composer.phar`).
- Os testes usam SQLite `:memory:` (`phpunit.xml`): nunca tocam `database.sqlite` nem produção. E-mail vai para o driver `array`.
- Falha de `bootstrap/cache` ou `storage` "must be writable" = atributo ReadOnly do OneDrive: `attrib -r /s /d` na pasta.
- No servidor da Locaweb o CLI é `php84` (não `php`) — só relevante para artisan remoto.

## 2. Escrever teste novo

Modelo: `api/tests/Feature/RepasseProtegidoTest.php` (cria colaboradores por papel e usa `Sanctum::actingAs`). Regras:
- Teste a regra de negócio pela **API HTTP** (`$this->postJson/patchJson`), não só o model.
- Cubra os três papéis quando houver permissão: colaborador (dono), gestor, contabilidade (só leitura → 403 em escrita). `admin` é papel técnico do Cleiton.
- Bug corrigido = teste que **falha no código antigo**: escreva o teste, confirme que falha (ou reproduza com `git stash`), depois corrija.
- Datas: mes/ano saem da `data`; nada é gravado no futuro (422). Cuidado com Carbon 3: `diffInDays` é assinado.
- Relatórios (Excel/PDF) levam 20 s ou mais; teste a lógica de agregação separadamente quando possível.

## 3. Cuidados com PHP via patch/heredoc

Barra invertida some em `sed`/heredoc/`python` (namespace `\App\Models` vira `AppModels`) e `php -l` NÃO acusa. Edite PHP com a ferramenta Edit/Write e **rode o teste de verdade** depois — o hook de sintaxe só pega erro de parse.

## 4. Antes de publicar a API

1. `php vendor/bin/phpunit` verde.
2. Migração nova? Siga a skill `migrar-banco` (homologação primeiro; em produção o admin roda pelo app em Perfil → Atualizar estrutura do banco).
3. `publicar.sh producao app` NÃO leva a API: depois de um build que toca `api/`, rode `publicar.sh producao api` e confira os checksums contra `~/api-petermann`. Use a skill `publicar`.

## 5. Relatório

Diga quantos testes passaram/falharam (cole a falha, não resuma), o que foi coberto e o que ficou sem teste.
