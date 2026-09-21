# Petermann App

PWA offline-first para lançamento de notas RDA/RDM em campo.

Servidor: **Petermann API** (Laravel + SQLite) em `../api/`, hospedada na
Locaweb. O app fala com ela por `js/api.js`. Passo a passo de implantação:
[`../MIGRACAO-LOCAWEB.md`](../MIGRACAO-LOCAWEB.md).

> `supabase_setup.sql` e `migrations/*.sql` são o esquema **antigo** (Supabase),
> mantidos como histórico. O esquema atual está em `../api/database/migrations/`.

---

## Rodar localmente

Precisa de PHP 8.3 e Node. Na raiz do repositório:

```bash
# 1) API (porta 8000) — SQLite local
cd api && cp .env.example .env   # e troque: MAIL_MAILER=log, APP_ENV=local, APP_DEBUG=true
php artisan key:generate && php artisan migrate && php artisan serve

# 2) App (porta 8080) — qualquer servidor estático na raiz do repo
node scripts/servir.js . 8080          # ou: npx http-server . -p 8080 -c-1
```

Abra `http://localhost:8080/rda-rdm-app/`. O `js/api.js` detecta `localhost`
e aponta para `http://127.0.0.1:8000/api` sozinho. O e-mail de senha vai
para `api/storage/logs/laravel.log`.

**Sem servidor nenhum:** botão **"Usar sem conta (modo local)"** na tela de
login — tudo fica só no IndexedDB do aparelho.

---

## Papéis de usuário

O admin vem da migração do Supabase (o papel é preservado). Num banco novo,
promova o primeiro antes de subir, no PC:

```bash
php artisan tinker --execute="App\Models\Colaborador::where('email','cleiton@exemplo.com')->update(['role'=>'admin']);"
```

Depois disso o admin promove os outros dentro do app (aba **Equipe** → ✏️).

| Papel | Vê | Grava |
|---|---|---|
| colaborador | as próprias notas e repasses | as próprias |
| gestor | todos os colaboradores (todos os núcleos) | notas de qualquer um; não apaga em definitivo |
| admin | tudo | tudo, inclusive nome/papel dos outros |

---

## Estrutura de arquivos

```
rda-rdm-app/
├── index.html          ← Shell HTML + todo CSS
├── manifest.json       ← PWA config
├── sw.js               ← Service Worker (cache offline; API nunca é cacheada)
├── privacidade.html    ← Política de privacidade
└── js/
    ├── api.js          ← Cliente da Petermann API (token, dados, anexos)
    ├── app.js          ← Estado, auth, views, captura
    ├── db.js           ← IndexedDB + fila de sincronização offline-first
    ├── nfce.js         ← Parser chave 44 dígitos
    ├── sefaz.js        ← Links de consulta por UF
    ├── brasilapi.js    ← Consulta CNPJ (memória → API → BrasilAPI)
    ├── ocr.js          ← Tesseract.js + regex fiscal
    ├── recorte.js      ← Enquadramento da foto
    ├── excel.js        ← SheetJS export formato Petermann
    ├── gestor.js       ← Dashboard equipe
    ├── gdrive.js       ← Cópia dos anexos no Google Drive
    └── gsheets.js      ← Planilha ao vivo no Google Sheets
```

## Anexos

O app nunca guarda imagem no banco. O arquivo vai para o disco do servidor
(`api/storage/app/fotos/<user_id>/<nota_id>.<ext>`) e a coluna
`notas.foto_path` guarda só esse caminho. Para exibir, o app pede uma URL
assinada temporária (`POST /api/fotos/urls`, 5 min); para baixar (Drive),
usa o token normal (`GET /api/fotos/{caminho}`).

---

## Publicar

```bash
node scripts/empacotar.js app     # → petermann-app.zip (subir pelo painel da Locaweb)
```

Antes, suba o `APP_BUILD` em `js/app.js`, o `?v=` no `index.html` e o
`CACHE` no `sw.js` — os três com o mesmo número.

---

## Customizações

| O que mudar | Onde |
|---|---|
| Endereço da API | `js/api.js` → `BASE` |
| Cores / fonte | `index.html` → bloco `:root { }` |
| Núcleos | `js/app.js` → array `NUCLEOS` e `js/gestor.js` → array `NUCLEOS` |
| Regex OCR | `js/ocr.js` → função `parseFiscalText()` |
| Formato Excel | `js/excel.js` → funções `buildResumo`, `buildRDM`, `buildRDA` |
| Papéis disponíveis | `js/gestor.js` → array `ROLES` e `api/app/Models/Colaborador.php` → `ROLES` |
