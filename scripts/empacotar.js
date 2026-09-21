#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────
   empacotar.js — gera os pacotes para subir na Locaweb.

   Uso (na raiz do repo):
     node scripts/empacotar.js            → os quatro zips
     node scripts/empacotar.js app        → só o app (PWA)
     node scripts/empacotar.js api        → só a API (Laravel + vendor + .env)
     node scripts/empacotar.js fotos      → só os anexos (api/storage/app/fotos)
     node scripts/empacotar.js banco      → só o banco (api/database/database.sqlite)

   Saída (na raiz, todos ignorados pelo Git):
     petermann-app.zip    → extrair na raiz do subdomínio app.
     petermann-api.zip    → extrair na pasta api-petermann/ (fora do web root)
     petermann-fotos.zip  → extrair em api-petermann/storage/app/ (vira fotos/)
     petermann-banco.zip  → extrair em api-petermann/ (vira database/database.sqlite)
                            SÓ NO PRIMEIRO ENVIO — depois disso o banco de
                            verdade é o do servidor, e extrair de novo
                            apagaria tudo que a equipe lançou.

   O zip da API NUNCA leva o banco nem as fotos: assim uma atualização da
   API pode ser extraída por cima sem risco para os dados.

   A API é empacotada com o vendor/ de PRODUÇÃO (composer install --no-dev):
   a hospedagem não tem Composer. O .env vai junto — é o que está em api/.env
   na hora de rodar; confira que é o de produção (APP_ENV=production).
   Usa o tar do Windows 10+ (gera zip com barras normais para o Linux).
───────────────────────────────────────────────────────────── */
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const API  = path.join(RAIZ, 'api');
const TMP  = path.join(RAIZ, '.empacotar-tmp');
const alvo = (process.argv[2] || 'tudo').toLowerCase();

const PHP = process.env.PHP || acharPhp();
function acharPhp() {
  const cand = [
    'php',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Packages/PHP.PHP.8.3_Microsoft.Winget.Source_8wekyb3d8bbwe/php.exe'),
  ];
  for (const c of cand) {
    try { execSync(`"${c}" -v`, { stdio: 'ignore' }); return c; } catch (_) {}
  }
  return 'php';
}

function limpar(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copiar(de, para, filtro = () => true) {
  fs.mkdirSync(para, { recursive: true });
  for (const ent of fs.readdirSync(de, { withFileTypes: true })) {
    const rel = path.join(de, ent.name);
    if (!filtro(rel, ent)) continue;
    const dst = path.join(para, ent.name);
    if (ent.isDirectory()) copiar(rel, dst, filtro);
    else fs.copyFileSync(rel, dst);
  }
}
function zipar(pasta, saida) {
  fs.rmSync(saida, { force: true });
  /* tar do Windows (bsdtar) gera zip com barras normais — o Compress-Archive
     do PowerShell 5 grava "pasta\arquivo" e o Linux da Locaweb extrai isso
     como UM arquivo com barra invertida no nome. O conteúdo vai na raiz do
     zip (é o que o gerenciador espera ao "extrair aqui"); .htaccess e .env
     entram normalmente. */
  const tar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')   // o do Git Bash lê "C:" como host remoto
    : 'tar';
  /* Lista os itens da raiz em vez de passar "." — com "." o bsdtar grava os
     nomes como "./rda-rdm-app/js/app.js", e o Explorador do Windows (e alguns
     gerenciadores de hospedagem) mostram o zip VAZIO (21/09/2026). */
  const itens = fs.readdirSync(pasta).map(n => `"${n}"`).join(' ');
  execSync(`"${tar}" -a -cf "${saida}" -C "${pasta}" ${itens}`, { stdio: 'inherit' });
  const mb = (fs.statSync(saida).size / 1048576).toFixed(1);
  console.log(`✔ ${path.basename(saida)}  (${mb} MB)`);
}

function empacotarApp() {
  const t = path.join(TMP, 'app');
  limpar(t); fs.mkdirSync(t, { recursive: true });
  fs.copyFileSync(path.join(RAIZ, '.htaccess'), path.join(t, '.htaccess'));
  fs.copyFileSync(path.join(RAIZ, 'index.html'), path.join(t, 'index.html'));
  copiar(path.join(RAIZ, 'rda-rdm-app'), path.join(t, 'rda-rdm-app'), (rel, ent) => {
    const n = ent.name;
    if (ent.isDirectory()) return !['node_modules', 'migrations'].includes(n);
    return !/\.(sql|md|mjs|lock)$/.test(n) && !['package.json', 'package-lock.json', '.nojekyll'].includes(n);
  });
  zipar(t, path.join(RAIZ, 'petermann-app.zip'));
}

function empacotarApi() {
  const env = path.join(API, '.env');
  if (!fs.existsSync(env)) throw new Error('api/.env não existe — crie a partir do .env.example');
  const conteudo = fs.readFileSync(env, 'utf8');
  if (!/^APP_ENV=production/m.test(conteudo)) {
    console.warn('⚠  api/.env não está com APP_ENV=production — este zip leva o .env como está.');
  }
  if (/^APP_DEBUG=true/m.test(conteudo)) {
    console.warn('⚠  api/.env está com APP_DEBUG=true — em produção isso expõe erros com caminhos e SQL.');
  }

  /* O vendor vai COMPLETO (com as ferramentas de desenvolvimento): o
     'composer install --no-dev' dentro do OneDrive falha com frequência
     (antivírus/indexador travam a remoção dos pacotes) e deixava o vendor
     local pela metade. phpunit/pint no servidor são inofensivos — nada os
     carrega. Para um pacote enxuto: EMPACOTAR_NO_DEV=1 node scripts/empacotar.js api */
  const composer = path.join(path.dirname(PHP), 'composer.phar');
  const cmd = fs.existsSync(composer) ? `"${PHP}" "${composer}"` : 'composer';
  const noDev = process.env.EMPACOTAR_NO_DEV === '1';
  if (noDev) {
    console.log('composer install --no-dev (vendor de produção)…');
    execSync(`${cmd} install --no-dev --optimize-autoloader --no-interaction --no-progress`, { cwd: API, stdio: 'inherit' });
  }

  const t = path.join(TMP, 'api');
  limpar(t);
  copiar(API, t, (rel, ent) => {
    const n = ent.name;
    const relPosix = path.relative(API, rel).split(path.sep).join('/');
    if (ent.isDirectory()) {
      return !['node_modules', 'tests', '.git'].includes(n)
        && !relPosix.startsWith('storage/app/fotos')            // vai no zip de fotos
        && !relPosix.startsWith('storage/app/backups')          // backups ficam só no servidor
        && !relPosix.startsWith('storage/logs')
        && !relPosix.startsWith('storage/framework/cache')
        && !relPosix.startsWith('storage/framework/sessions')
        && !relPosix.startsWith('storage/framework/views');
    }
    if (relPosix.startsWith('database/') && /\.sqlite/.test(n)) return false;   // banco vai no zip próprio
    if (n.startsWith('.env')) return false;   // NUNCA: o .env do servidor é o de produção (19/09/2026: o zip levava o .env local)
    return !['.env.example', 'phpunit.xml', 'vite.config.js', 'package.json', 'package-lock.json', 'README.md', '.gitignore', '.editorconfig', '.gitattributes'].includes(n)
      && !/\.log$/.test(n);
  });
  /* pastas vazias que o Laravel exige (o zip não guarda pasta vazia: deixa
     um .gitignore dentro para elas existirem) */
  for (const d of ['storage/logs', 'storage/framework/cache/data', 'storage/framework/sessions', 'storage/framework/views', 'storage/app/fotos', 'bootstrap/cache']) {
    fs.mkdirSync(path.join(t, d), { recursive: true });
    fs.writeFileSync(path.join(t, d, '.gitignore'), '*\n!.gitignore\n');
  }
  /* cache de config/rotas gerado localmente não pode ir: tem caminhos daqui */
  for (const f of fs.readdirSync(path.join(t, 'bootstrap/cache'))) {
    if (f !== '.gitignore') fs.rmSync(path.join(t, 'bootstrap/cache', f));
  }
  zipar(t, path.join(RAIZ, 'petermann-api.zip'));

  if (noDev) {
    console.log('composer install (volta o vendor de desenvolvimento)…');
    execSync(`${cmd} install --no-interaction --no-progress --quiet`, { cwd: API, stdio: 'inherit' });
  }
}

function empacotarFotos() {
  const src = path.join(API, 'storage/app/fotos');
  const t = path.join(TMP, 'fotos');
  limpar(t);
  copiar(src, path.join(t, 'fotos'), (rel, ent) => ent.name !== '.gitignore');
  let n = 0;
  (function contar(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? contar(path.join(d, e.name)) : n++;
  })(path.join(t, 'fotos'));
  console.log(`${n} anexos`);
  zipar(t, path.join(RAIZ, 'petermann-fotos.zip'));
}

function empacotarBanco() {
  const src = path.join(API, 'database/database.sqlite');
  if (!fs.existsSync(src)) throw new Error('api/database/database.sqlite não existe — rode php artisan migrate + migrar:supabase');
  const t = path.join(TMP, 'banco');
  limpar(t); fs.mkdirSync(path.join(t, 'database'), { recursive: true });
  const dst = path.join(t, 'database/database.sqlite');
  /* Em modo WAL as gravações recentes ficam no database.sqlite-wal; copiar
     só o arquivo principal perderia isso. VACUUM INTO gera uma cópia íntegra
     e compacta, mesmo com o artisan serve aberto. */
  const dstPhp = dst.replace(/\\/g, '/').replace(/'/g, "\\'");
  const srcPhp = src.replace(/\\/g, '/').replace(/'/g, "\\'");
  execSync(`"${PHP}" -r "$p = new PDO('sqlite:${srcPhp}'); $p->exec(\\"VACUUM INTO '${dstPhp}'\\"); echo $p->query('select count(*) from colaboradores')->fetchColumn(), ' colaboradores, ', $p->query('select count(*) from notas')->fetchColumn(), ' notas, ', $p->query('select count(*) from repasses')->fetchColumn(), ' repasses';"`, { stdio: 'inherit' });
  const mb = (fs.statSync(dst).size / 1048576).toFixed(2);
  console.log(`\nbanco: ${mb} MB — confira que é o MIGRADO (migrar:supabase), não o de teste`);
  zipar(t, path.join(RAIZ, 'petermann-banco.zip'));
}

try {
  if (alvo === 'tudo' || alvo === 'app')   empacotarApp();
  if (alvo === 'tudo' || alvo === 'api')   empacotarApi();
  if (alvo === 'tudo' || alvo === 'fotos') empacotarFotos();
  if (alvo === 'tudo' || alvo === 'banco') empacotarBanco();
} finally {
  limpar(TMP);
}
