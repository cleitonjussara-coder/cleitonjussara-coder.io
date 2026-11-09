'use strict';
/* Leitura do recibo de pedágio no aparelho (rda-rdm-app/js/ocr.js, parseFiscalText).    node scripts/testar-ocr-pedagio.js
 * Caso do Romário (09/11/2026): Rota dos Grãos, duas passagens no mesmo dia, mesmo valor e placa. O número fica em
 * "ID RECIBO/DFE:PKPM242B8334/" e o CNPJ vem partido na quebra de linha ("…/0001" e "-07" na linha de baixo). */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const w = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'ocr.js'), 'utf8'), { window: w, document: {}, console, setTimeout, CustomEvent: function () {} });

const rotaDosGraos = (via, hora, id) => `***BOA VIAGEM***
DOC. FISCAL EQUIVALENTE - IN 1731/17 Art.2
CONCESSIONARIA ROTA DOS GRAOS - 41.315.638/0001
-07
PRACA PEDAGIO:Primavera do Leste VIA:${via}
DATA:01.10.2026 HORA:${hora} OPERADOR:00418
VALOR PAGO:R$ 10.90 CAT.COB:01
F.PAGTO:DEBITO/CREDITO PLACA:UVK4H82
ID RECIBO/DFE:${id}/
Valor aprx. de tributos 18,24% (fonte:IBPT)
Para incluir PLACA/CPF/CNPJ acesse ate 7 dias
http://dfe.rotadosgraos.com.br
***0800 1300130***`;

const casos = [
  ['Rota dos Grãos 11:12', rotaDosGraos('03 Norte', '11:12:51', 'MNTQHC2B81IM'),
    { numero: 'MNTQHC2B81IM', cnpj: '41315638000107', placa: 'UVK4H82', hora: '11:12:51', valor: 10.9, data: '2026-10-01' }],
  ['Rota dos Grãos 17:48', rotaDosGraos('06 Sul', '17:48:34', 'PKPM242B8334'),
    { numero: 'PKPM242B8334', cnpj: '41315638000107', placa: 'UVK4H82', hora: '17:48:34', valor: 10.9, data: '2026-10-01' }],
  ['WAY 153 (DFE N:) continua', 'PEDAGIO WAY 153\nDFE N: JLEE546J82JK\nPlaca: REM8H68', { numero: 'JLEE546J82JK', placa: 'REM8H68' }],
  ['site dfe.xxx.com.br não vira número', 'PRACA PEDAGIO: X\nhttp://dfe.rotadosgraos.com.br', { numero: null }],
];
let falhas = 0;
for (const [nome, texto, esperado] of casos) {
  const r = w.OCR.parseFiscalText(texto);
  for (const [k, v] of Object.entries(esperado)) {
    const ok = r[k] === v;
    if (!ok) falhas++;
    console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome} · ${k}: ${JSON.stringify(r[k])} (esperado ${JSON.stringify(v)})`);
  }
}
if (falhas) { console.error(`\n${falhas} falha(s)`); process.exit(1); }
console.log('\ntudo certo');
