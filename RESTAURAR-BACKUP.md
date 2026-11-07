# Como restaurar o NOTAS PM

Roteiro para pane. Conferido em 06/11/2026 contra o sistema no build 546.
O que já foi provado está marcado. Leia a seção certa antes de digitar qualquer comando.

## Regra de ouro

1. **Antes de restaurar, guarde o que existe**, mesmo que pareça estragado.
2. **Teste a restauração em pasta separada** antes de colocar no lugar.
3. Restaurar volta o sistema para a hora do backup: o que entrou depois se perde.

## Onde estão os backups

| Backup | Horário | Conteúdo | No servidor | No Drive |
|---|---|---|---|---|
| `banco-*.zip` | Todo dia, 02:30 | Só o banco | 14 cópias | 30 cópias |
| `fotos-*.zip` | Todo dia, 02:45 | Anexos novos desde o último completo | 3 cópias | 14 cópias |
| `petermann-*.zip` | Domingo, 03:30 | Banco e todos os anexos | 2 cópias | 12 cópias, mais 1 por mês por 12 meses |

- **No servidor:** `~/api-petermann/storage/app/backups/`
- **No Drive:** pasta **Backups Petermann App**, na conta conectada em Perfil → Backup. Abra pelo site do Drive; não depende do servidor.
- **Fora dos backups:** o arquivo `.env` (ver "Chaves do sistema").
- **Regra das cópias antigas:** o servidor só apaga uma cópia depois de confirmar que ela está no Drive. Com o Drive desconectado ou dando erro, nada é apagado no servidor e o log diz quais cópias ficaram.

Para voltar tudo, são três arquivos: o **banco mais novo**, o **completo mais novo** e o **fotos mais novo**.

## Acesso ao servidor

O SSH da Locaweb expira a cada 3 horas. Renove no painel antes de começar. Se o `ssh` abrir e não executar nada, é isso.

```bash
ssh -o Ciphers=aes256-ctr -o MACs=hmac-sha2-256 locaweb
```

O PHP no servidor é `/usr/bin/php84`, não `php`.

## Caso 1: banco estragado, servidor funcionando

Sintoma: erro de banco, dados errados depois de uma operação, "database disk image is malformed".

```bash
cd ~/api-petermann
/usr/bin/php84 artisan down
```

Guarde o banco atual, com os arquivos auxiliares:

```bash
ANTES=~/tmp/banco-antes-$(date +%Y%m%d-%H%M)
mkdir -p "$ANTES" && cp database/database.sqlite* "$ANTES"/
```

Extraia o backup em uma pasta separada e confira. O resultado precisa ser `ok`:

```bash
ls -t storage/app/backups/banco-*.zip | head -3
mkdir -p ~/tmp/restaurar && unzip -o storage/app/backups/NOME-DO-ARQUIVO.zip -d ~/tmp/restaurar
sqlite3 ~/tmp/restaurar/database.sqlite 'pragma quick_check;'
```

Coloque no lugar. **Os arquivos `-wal` e `-shm` precisam sair**: se ficarem, misturam dados velhos com o banco restaurado.

```bash
rm -f database/database.sqlite-wal database/database.sqlite-shm
cp ~/tmp/restaurar/database.sqlite database/database.sqlite
/usr/bin/php84 artisan migrate:status | grep -c Pending
/usr/bin/php84 artisan up
```

Se aparecerem migrações pendentes, rode `/usr/bin/php84 artisan migrate --force` antes do `up`.

Depois, abra o app, confira a última nota e peça para a equipe usar **Enviar agora**: o que estava nos aparelhos volta a subir.

## Caso 2: anexos perdidos, banco bom

```bash
cd ~/api-petermann/storage/app/backups
ls -t petermann-*.zip | head -1
ls -t fotos-*.zip | head -1
mkdir -p ~/tmp/fotos
unzip -o NOME-DO-COMPLETO.zip 'fotos/*' -d ~/tmp/fotos
unzip -o NOME-DO-FOTOS.zip 'fotos/*' -d ~/tmp/fotos
```

A ordem importa: **primeiro o completo, depois o fotos mais novo por cima**. Use só o `fotos-*.zip` mais novo, porque ele já traz o que os anteriores trouxeram. Se o completo for mais novo que o fotos, ignore o fotos.

```bash
cp -rn ~/tmp/fotos/fotos/. ~/api-petermann/storage/app/fotos/
```

O `-n` não sobrescreve o que ainda existe. As miniaturas são refeitas sozinhas.

## Caso 3: servidor perdido

Sem a Locaweb, tudo sai do Drive.

1. Baixe do Drive os três arquivos mais novos. Isto foi provado em 06/11/2026: os três vieram idênticos aos do servidor.
2. Baixe o código do GitHub e instale as dependências em `api/` com `composer install --no-dev`.
3. Recupere o `.env` do gerenciador de senhas e ajuste `APP_URL`, `FRONT_URL`, `CORS_ORIGINS` e `FOTOS_PATH`.
4. Copie `database.sqlite` para `api/database/` e monte a pasta de fotos como no Caso 2.
5. Dê permissão de escrita a `api/storage`, `api/bootstrap/cache` e `api/database`.
6. Aponte o subdomínio para `api/public`. O `index.php` da produção espera o código em `~/api-petermann`, fora da pasta pública.
7. Publique o app e confira `/api/ping`.
8. Refaça os agendamentos abaixo.
9. Em Perfil → Backup, reconecte o Google Drive: a autorização fica em `storage/app/drive-backup.json`, que não está nos backups.
10. Se o endereço do app mudar, atualize as URIs de redirecionamento no Google Cloud (projeto CLEITON-PM).

### Agendamentos

```text
30 2 * * * /usr/bin/php84 <api>/artisan backup:gerar --so-banco
45 2 * * * /usr/bin/php84 <api>/artisan backup:gerar --fotos-novas
30 3 * * 0 /usr/bin/php84 <api>/artisan backup:gerar
10 4 * * * /usr/bin/php84 <api>/artisan armazenamento:verificar
40 4 * * * /usr/bin/php84 <api>/artisan tokens:limpar
20 7 * * * /usr/bin/php84 <api>/artisan cartoes:verificar
```

## Chaves do sistema (.env)

O `.env` guarda segredos e **não entra em backup nenhum**, de propósito: quem abrisse um backup teria acesso a tudo. A cópia fica em gerenciador de senhas. **Nunca no Git, no Drive comum ou em conversa.**

Refaça a cópia sempre que uma chave mudar. Sem o `.env`, dá para recriar:

| Variável | Sem a cópia |
|---|---|
| `APP_KEY` | Gerar outra com `artisan key:generate`. Links temporários antigos deixam de valer. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Pegar ou gerar no Google Cloud, projeto CLEITON-PM. |
| `RESEND_API_KEY` | Gerar outra no painel do Resend. |
| `ANTHROPIC_API_KEY` | Gerar outra no console da Anthropic e aplicar com `scripts/definir-chave-ia.sh`. |
| `WEBPUSH_PUBLIC_KEY`, `WEBPUSH_PRIVATE_KEY` | Gerar outro par. **Cada aparelho precisa ativar as notificações de novo.** É o que mais dá trabalho perder. |

As demais variáveis são configuração comum, e o modelo está em `api/.env.example`.

## Testar de vez em quando

Repita a cada 3 meses, ou depois de mudar o backup. Baixe o banco mais novo para `~/tmp`, extraia e rode `pragma quick_check`, sem tocar em `database/`.

- **05/11/2026:** completo e banco restaurados no servidor, integridade ok, o sistema abriu o banco.
- **06/11/2026:** os três tipos baixados do Drive, idênticos aos do servidor, sem erro nos ZIPs.

Os Casos 1 e 2 nunca foram executados de verdade sobre um sistema em uso, e o Caso 3 nunca foi ensaiado. Faça com calma.
