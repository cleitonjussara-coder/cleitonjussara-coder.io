# Petermann API

Backend do Petermann App: **Laravel 13 + Eloquent (ORM) + SQLite**, feito
para a Hospedagem compartilhada da Locaweb (PHP 8.3, sem Composer nem
Node no servidor). Substitui o Supabase — banco, login, anexos e e-mail.

Guia de implantação e migração de dados: [`../MIGRACAO-LOCAWEB.md`](../MIGRACAO-LOCAWEB.md).

## Mapa

| Camada | Onde |
|---|---|
| Esquema (migrações) | `database/migrations/` — em produção, `POST /api/admin/migrar` (admin) aplica as pendentes no servidor |
| Models (ORM) | `app/Models/` — Colaborador, Nota, Repasse, RepasseEmail, CnpjCache |
| Rotas | `routes/api.php` (tudo sob `/api`) |
| Controllers | `app/Http/Controllers/` — Auth, Nota, Repasse, Colaborador, Foto, Cnpj |
| Serviços | `app/Services/` — `FotoStorage` (anexos em disco), `RepasseEmailService` (Resend), `GoogleOAuth` |
| Migração do Supabase | `app/Console/Commands/MigrarSupabase.php` → `php artisan migrar:supabase` |
| Configuração própria | `config/petermann.php` (tudo vem do `.env`) |
| Manutenção sem terminal | `AdminController` (status, migrar) e `BackupController` (cópia íntegra do SQLite via VACUUM INTO) — só admin |

## Regras de acesso (as mesmas policies do Supabase)

| | colaborador | gestor | admin |
|---|---|---|---|
| ver notas/repasses | só os seus | de todos | de todos |
| gravar nota | a sua | de qualquer um | de qualquer um |
| apagar nota em definitivo | a sua | — | qualquer |
| lançar repasse | só o seu | só o seu | só o seu |
| editar repasse | o seu | — | qualquer |
| ver/editar perfis | o seu (nome) | vê todos | edita todos (nome, papel) |

## Anexos

Nunca no banco. `FotoStorage` grava em `storage/app/fotos/<user_id>/<nota_id>.<ext>`
(ou `FOTOS_PATH` do `.env`) e `notas.foto_path` guarda o caminho. Entrega:
URL assinada temporária (`POST /api/fotos/urls`) para `<img>`, ou Bearer
(`GET /api/fotos/{caminho}`) para download. Exclusão definitiva apaga o
arquivo junto. `POST /api/notas/reparar-fotos` religa notas que perderam a
referência (o caminho é determinístico).

## Desenvolvimento

```bash
cp .env.example .env        # troque para DB_CONNECTION=sqlite, MAIL_MAILER=log, APP_ENV=local
php artisan key:generate
php artisan migrate
php artisan serve           # http://127.0.0.1:8000/api/ping
php vendor/bin/pint         # estilo de código
```

Endpoints: `php artisan route:list --path=api`.
