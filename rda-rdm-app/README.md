# Petermann App

PWA offline-first para lançamento de notas RDA/RDM em campo.

## Setup rápido (4 passos)

### 1. Criar projeto Supabase (grátis)
1. https://supabase.com → New Project → região **São Paulo (sa-east-1)**
2. Aguarde ~2 min

### 2. Rodar o SQL
1. Painel → **SQL Editor** → New Query
2. Cole todo o conteúdo de `supabase_setup.sql`
3. Clique **Run**

### 3. Configurar credenciais
**Project Settings → API**, copie:
- Project URL → `https://xxxxx.supabase.co`
- anon public key → `eyJ...`

Abra `js/app.js` e troque as duas primeiras linhas:
```js
const SUPABASE_URL      = 'https://xxxxx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJ...';
```

### 4. Hospedar
**Netlify Drop (1 min):** https://app.netlify.com/drop → arrasta a pasta `rda-rdm-app`

> PWA precisa de HTTPS para acessar a câmera.

---

## Papéis de usuário

Após os primeiros cadastros, execute no SQL Editor:
```sql
-- Admin (vê e edita tudo)
update public.colaboradores set role='admin', nucleo='Cristalina'
 where email='cleiton@exemplo.com';

-- Gestores regionais
update public.colaboradores set role='gestor', nucleo='Formosa'
 where email='rayner@exemplo.com';
update public.colaboradores set role='gestor', nucleo='Paracatu'
 where email='renan@exemplo.com';
update public.colaboradores set role='gestor', nucleo='Uberlândia'
 where email='arthur@exemplo.com';
```

---

## Estrutura de arquivos

```
rda-rdm-app/
├── index.html          ← Shell HTML + todo CSS
├── manifest.json       ← PWA config
├── sw.js               ← Service Worker (cache offline)
├── icon-192.svg        ← Ícone app
├── icon-512.svg        ← Ícone app (splash)
├── supabase_setup.sql  ← Schema + RLS + Storage + triggers
├── README.md
└── js/
    ├── app.js          ← Estado, auth, views, captura
    ├── db.js           ← IndexedDB + sync offline-first
    ├── nfce.js         ← Parser chave 44 dígitos
    ├── brasilapi.js    ← Consulta CNPJ (3 camadas de cache)
    ├── ocr.js          ← Tesseract.js + regex fiscal
    ├── excel.js        ← SheetJS export formato Petermann
    └── gestor.js       ← Dashboard equipe
```

---

## Testar localmente (sem Supabase)

```bash
cd rda-rdm-app
python3 -m http.server 8000
# Acesse http://IP-DO-PC:8000 no celular (mesma rede Wi-Fi)
```

O app detecta automaticamente que as credenciais são placeholder
e entra em **modo demo** — tudo salvo só no IndexedDB local.

---

## Customizações

| O que mudar | Onde |
|---|---|
| Cores / fonte | `index.html` → bloco `:root { }` |
| Núcleos | `js/app.js` → array `NUCLEOS` e `js/gestor.js` → array `NUCLEOS` |
| Regex OCR | `js/ocr.js` → função `parseFiscalText()` |
| Formato Excel | `js/excel.js` → funções `buildResumo`, `buildRDM`, `buildRDA` |
| Papéis disponíveis | `js/gestor.js` → array `ROLES` |
