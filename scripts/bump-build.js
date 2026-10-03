#!/usr/bin/env node
// Sobe o número do build nos 3 marcadores de uma vez:
//   APP_BUILD  em rda-rdm-app/js/app.js
//   CACHE      em rda-rdm-app/sw.js        ('petermann-vNNN')
//   ?v=NNN     em rda-rdm-app/index.html   (só os que valem o build atual;
//                                           ícones/logo têm versão própria e ficam)
// Uso: node scripts/bump-build.js [novo]   (sem argumento: build atual + 1)
//      node scripts/bump-build.js --ver    (só mostra o estado dos 3)
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'rda-rdm-app');
const f = n => path.join(dir, n);
const ler = n => fs.readFileSync(f(n), 'utf8');

const re = {
  app: /(const APP_BUILD = )(\d+)/,
  sw: /(const CACHE\s*=\s*'petermann-v)(\d+)(')/,
};
const tagRe = n => new RegExp('[?]v=' + n + '(?![0-9])', 'g');
const atual = Number(ler('js/app.js').match(re.app)[2]);
const nSw = Number(ler('sw.js').match(re.sw)[2]);
const html = ler('index.html');
const tags = [...html.matchAll(tagRe(atual))].length;

if (process.argv[2] === '--ver') {
  console.log(`APP_BUILD=${atual}  CACHE=v${nSw}  index.html ?v=${atual}: ${tags} tags`);
  process.exit(atual === nSw && tags > 0 ? 0 : 1);
}
if (atual !== nSw) {
  console.error(`Marcadores já divergem (APP_BUILD=${atual}, CACHE=v${nSw}). Alinhe à mão antes.`);
  process.exit(1);
}
const novo = process.argv[2] ? Number(process.argv[2]) : atual + 1;
if (!Number.isInteger(novo) || novo <= atual) {
  console.error(`Novo build tem de ser inteiro maior que ${atual}.`);
  process.exit(1);
}
fs.writeFileSync(f('js/app.js'), ler('js/app.js').replace(re.app, `$1${novo}`));
fs.writeFileSync(f('sw.js'), ler('sw.js').replace(re.sw, `$1${novo}$3`));
fs.writeFileSync(f('index.html'), html.replace(tagRe(atual), `?v=${novo}`));
console.log(`build ${atual} -> ${novo}  (APP_BUILD, CACHE, ${tags} tags ?v= no index.html)`);
console.log('Lembrete: seção "Como usar" atualizada? commit com "(build ' + novo + ')".');
