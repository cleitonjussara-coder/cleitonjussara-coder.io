'use strict';
/* Regressão da regra "o valor registrado é o valor PAGO" no leitor de texto do aparelho
 * (rda-rdm-app/js/ocr.js, parseFiscalText).    node scripts/testar-ocr-valor-pago.js
 * Casos reais de 11/10/2026: padaria com acréscimo de R$ 0,04 (total 55,96 → pago 56,00). */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const w = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'ocr.js'), 'utf8'), { window: w, document: {}, console, setTimeout, CustomEvent: function () {} });
const parse = t => w.OCR.parseFiscalText(t).valor;

const casos = [
  ['acréscimo: vale o valor a pagar, não o total', 'QTD. TOTAL DE ITENS 001\nVALOR TOTAL R$ 55,96\nAcréscimos R$ +0,04\nVALOR A PAGAR R$ 56,00\nFORMA DE PAGAMENTO Valor Pago\nDinheiro 56,00', 56],
  ['acréscimo de R$ 1,80 em lanche', 'VALOR TOTAL R$ 100,00\nAcréscimos R$ 1,80\nVALOR A PAGAR R$ 100,00\nValor Pago 100,00', 100],
  ['sem "a pagar": vale a coluna Valor Pago (cartão)', 'Qtd. Itens 1\nValor Total R$ 21,00\nFORMA PAGAMENTO VALOR PAGO\nCartao de Credito 21,00', 21],
  ['desconto: pago menor que o total', 'VALOR TOTAL R$ 60,00\nDesconto R$ 5,00\nFORMA DE PAGAMENTO Valor Pago\nPix 55,00', 55],
  ['dinheiro com troco: entregue menos troco', 'VALOR TOTAL R$ 44,96\nFORMA DE PAGAMENTO Valor Pago\nDinheiro 100,00\nTroco 55,04', 44.96],
  ['cupom simples sem pagamento: cai no total', 'TOTAL R$ 45,26', 45.26],
];
let falhas = 0;
for (const [nome, texto, esperado] of casos) {
  const v = parse(texto);
  const ok = Math.abs((v || 0) - esperado) < 0.005;
  if (!ok) falhas++;
  console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome}: ${v} (esperado ${esperado})`);
}
if (falhas) { console.error(`\n${falhas} falha(s)`); process.exit(1); }
console.log('\ntudo certo');
