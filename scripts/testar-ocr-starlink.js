'use strict';
/* Leitura do recibo da Starlink no aparelho (25/11/2026).    node scripts/testar-ocr-starlink.js */
const vm = require('vm'), fs = require('fs'), path = require('path');
const w = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'ocr.js'), 'utf8'), { window: w, document: {}, console, setTimeout, CustomEvent: function () {} });
const recibo = inv => `STARLINK Recibo
ID do IVA: 17117768000142 ${inv}
Attn: Petermann 3 Morais Data da fatura: quarta-feira, 21 de outubro de
Localização: -16.0362, -47.4393 2026
, Federal District Data de vencimento: quarta-feira, 21 de outubro
de 2026
Conta do cliente: ACC-DF-12111550-42610-25
Descrição do produto Qtd Valor
Taxa de acesso ao terminal prioritário local (quarta-feira, 21 de outubro de 2026 -
sábado, 21 de novembro de 2026) 1 R$ 105,34
Bloco de Dados Prioritários Locais de 50 GB 1 R$ 85,83
Subtotal R$ 191,17
COFINS (3%) R$ 5,95
ICMS_ORIGIN (18%) R$ 21,78
Custos totais R$ 245,00
Pagamento R$ 245,00
Total devido R$ 0,00
Se o pagamento pelos serviços não for recebido até domingo, 20 de dezembro de 2026, seu serviço será suspenso
STARLINK BRAZIL SERVICOS DE INTERNET LTDA
Rua Libero Badaro, 293 andar 21, conj 21-B Sala 0`;
const comum = { valor: 245, data: '2026-10-21', cnpj: null, razao_social: 'STARLINK BRAZIL SERVICOS DE INTERNET LTDA' };
let falhas = 0;
for (const [nome, inv, numero] of [
  ['recibo real', 'INV-DF-BRA-24033363-67467-46', 'INV-DF-BRA-24033363-67467-46'],
  ['outra antena', 'INV-DF-BRA-24033364-11111-40', 'INV-DF-BRA-24033364-11111-40'],
  ['I lido como 1 e espaço', '1NV-DF-BRA- 24033363-67467-46', 'INV-DF-BRA-24033363-67467-46'],
  ['INV ilegível: nunca usa a conta ACC', '', null],
]) {
  const r = w.OCR.parseFiscalText(recibo(inv));
  for (const [k, v] of Object.entries({ ...comum, numero })) {
    const ok = r[k] === v; if (!ok) falhas++;
    console.log(`${ok ? 'ok   ' : 'FALHA'} ${nome} · ${k}: ${JSON.stringify(r[k])} (esperado ${JSON.stringify(v)})`);
  }
}
if (falhas) { console.error(`\n${falhas} falha(s)`); process.exit(1); }
console.log('\ntudo certo');
