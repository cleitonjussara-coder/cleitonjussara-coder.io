# Trocar o banco da API de SQLite para MySQL

Pedido do Cleiton em 06/10/2026: a equipe vai passar de 100 pessoas, e o
SQLite trava o arquivo inteiro a cada gravação. O MySQL já vem no plano da
Locaweb (Hospedagem II). Fotos e anexos não mudam de lugar.

**Como funciona:** o comando `banco:mudar mysql` põe a API em manutenção
por poucos segundos (o app guarda as notas no celular e reenvia sozinho),
copia todas as tabelas, confere a contagem de cada uma, grava
`DB_CONNECTION=mysql` no `.env` e sai da manutenção. Se a conferência
falhar, nada muda: o sistema continua no SQLite. O arquivo
`database.sqlite` fica intacto como cópia de segurança.

## 1. Criar os bancos no painel (Cleiton)

Painel da Locaweb → Banco de dados → MySQL → criar **dois** bancos: um para
o teste e outro para a produção. Anote host, nome, usuário e senha de cada
um. Não mande a senha pelo chat.

## 2. Pôr os dados no `.env` do servidor

Em `~/api-teste/.env` (teste) e `~/api-petermann/.env` (produção), acrescente
as linhas abaixo, cada uma com os dados do seu banco. Não mexa no
`DB_CONNECTION` (o comando troca sozinho).

```
MYSQL_HOST=...
MYSQL_DATABASE=...
MYSQL_USERNAME=...
MYSQL_PASSWORD=...
```

## 3. Ensaio (pode ser de dia)

```bash
ssh locaweb "cd ~/api-teste && /usr/bin/php84 artisan banco:mudar mysql --ensaio"
```

Copia e confere sem virar o sistema. Mostra quantas linhas foram por tabela
e quanto tempo levou. Se algum dado não couber no MySQL (texto maior que a
coluna), o comando lista quais são e não copia nada.

## 4. Virada

Teste primeiro e confira o app em teste.pmservicosagronomicos.com.br.
Produção só com o "ok" do Cleiton, à noite:

```bash
ssh locaweb "cd ~/api-petermann && /usr/bin/php84 artisan backup:gerar --sem-drive"
ssh locaweb "cd ~/api-petermann && /usr/bin/php84 artisan banco:mudar mysql"
```

Confira `https://api.pmservicosagronomicos.com.br/api/ping` e lance uma nota
de teste no app.

## Voltar, se precisar

```bash
ssh locaweb "cd ~/api-petermann && /usr/bin/php84 artisan banco:mudar sqlite"
```

Leva de volta para o SQLite tudo o que entrou no MySQL depois da virada.

## O que muda depois

- O backup (`backup:gerar` e o botão do Perfil) continua gerando um
  `database.sqlite` dentro do zip, montado a partir do MySQL.
- Migrações novas continuam iguais (skill `migrar-banco`). O SQLite não
  confere tamanho de texto e o MySQL confere: coluna `string('x', N)` precisa
  bater com o `max:N` da validação.
- Os testes rodam no SQLite em memória. Para rodar contra um MySQL
  descartável: `DB_CONNECTION=mysql DB_HOST=... DB_DATABASE=... php vendor/bin/phpunit`.
