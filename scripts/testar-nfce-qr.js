'use strict';
/* Teste de regressão do parser do QR da NFC-e (rda-rdm-app/js/nfce.js).
 *   node scripts/testar-nfce-qr.js
 *
 * Caso real de 10/10/2026: cupom de GO de R$ 45,26 aparecia com valor 69 no formulário.
 * O QR traz o hash (cHashQRCode) na posição do valor, e parseFloat("69A3F5…") devolve 69 —
 * esse "valor" do QR passava na frente da leitura correta da nota. O campo só vale se a string
 * inteira for um valor. */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const w = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'nfce.js'), 'utf8'), { window: w, URL, console });
const NFCE = w.NFCE;

const chave = '52260905764979000198650020002561181002761186';
const go = 'http://nfe.sefaz.go.gov.br/nfeweb/sites/nfce/danfeNFCe?p=';
const casos = [
  ['hash começando com 69 (caso do print)', `${go}${chave}|2|1|1|69A3F5C2D81B07E94A6C3D5F1E2B8A907C4D6E13`, null],
  ['hash em notação científica (3E8...)', `${go}${chave}|2|1|1|3E8A1B2C3D4E5F60718293A4B5C6D7E8F9012345`, null],
  ['valor de verdade no 5º campo (GO 19/09/2026)', `${go}${chave}|3|1|18|124.36|||HASHXYZ`, 124.36],
  ['valor inteiro', `http://x.gov.br/q?p=${chave}|3|1|18|45|||HASH`, 45],
  ['valor com vírgula', `http://x.gov.br/q?p=${chave}|3|1|18|45,26|||HASH`, 45.26],
  ['vNF por parâmetro', `http://x.gov.br/q?chave=${chave}&vNF=45.26`, 45.26],
  ['vNF com lixo no fim', `http://x.gov.br/q?chave=${chave}&vNF=69abc`, null],
  ['três casas decimais não é valor', `http://x.gov.br/q?p=${chave}|3|1|18|45.263|||HASH`, null],
];

let falhas = 0;
for (const [nome, url, esperado] of casos) {
  const r = NFCE.parseQRUrl(url);
  const ok = r.valor === esperado;
  if (!ok) falhas++;
  console.log(`${ok ? 'ok  ' : 'FALHA'} ${nome}: valor=${r.valor} (esperado ${esperado})`);
}
if (falhas) { console.error(`\n${falhas} falha(s)`); process.exit(1); }
console.log('\ntudo certo');
