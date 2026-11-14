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

/* EPR Triângulo Mineiro (09/11/2026): duas passagens no mesmo dia, mesmo valor e placa; o OCR lê a placa TXI1F14 como "TX11F14". */
const epr = (hora, praca, dfe, placa) => `EPR TRIANGULO MINEIRO CNPJ: 48.127.012/0001-08
08.10.2026 ${hora}
${praca} Via:04 Leste Operador:00766
DFE N: ${dfe} Placa: ${placa} Classe: 01
R$14.00 DEBITO TRIB:18.24%(IBPT) Recibo:${dfe}
MASTERCARD DEBITO REDE
550209******9013 A:674164
DEBITO A VISTA VALOR:14,00
214671103074988 DOC:504295698 (SiTef)
Incluir placa, CPF/CNPJ no doc. fiscal em até 7 dias:
www.eprtriangulo.com.br DUVIDAS: 0800-452-0365`;

const stone = (hora, aut, servico) => `VIA CLIENTE stone
UBERABA/MG
COMPRA SONIA BEATRIZ RODRIGUE
14/11/2026 · ${hora} CNPJ: 53.801.766/0001-31
CRÉDITO R$ 15,99
MASTERCARD - ****6608 AUT ${aut}
SN PB09228N76551 | SDK v.:4.14.0
(Isso não é cupom fiscal)
Serviço de ${servico}
Quantidade: 1
Valor total: R$ 15,99`;

const casos = [
  ['EPR Indianópolis 11:47', epr('11:47:02', 'P4 - INDIANOPOLIS', 'NLOLUCVB828M', 'TXI1F14'),
    { numero: 'NLOLUCVB828M', cnpj: '48127012000108', placa: 'TXI1F14', hora: '11:47:02', valor: 14, data: '2026-10-08', portal_nfse: 'https://www.eprtriangulo.com.br' }],
  ['EPR Monte Carmelo 12:42', epr('12:42:50', 'P3 - MONTE CARMELO', 'SHTL9GVB8262', 'TXI1F14'),
    { numero: 'SHTL9GVB8262', placa: 'TXI1F14', hora: '12:42:50', valor: 14, data: '2026-10-08' }],
  ['EPR "DFE N:" lido como "OFE N;"', epr('11:47:02', 'P4', 'NLOLUCVB828M', 'TXI1F14').replace('DFE N:', 'OFE N;'), { numero: 'NLOLUCVB828M' }],
  ['EPR sem a linha do DFE (só Recibo:)', epr('11:47:02', 'P4', 'NLOLUCVB828M', 'TXI1F14').replace(/DFE N: \S+/, ''), { numero: 'NLOLUCVB828M' }],
  ['EPR placa lida como TX11F14', epr('11:47:02', 'P4 - INDIANOPOLIS', 'NLOLUCVB828M', 'TX11F14'), { placa: 'TXI1F14' }],
  ['Rota dos Grãos 11:12', rotaDosGraos('03 Norte', '11:12:51', 'MNTQHC2B81IM'),
    { numero: 'MNTQHC2B81IM', cnpj: '41315638000107', placa: 'UVK4H82', hora: '11:12:51', valor: 10.9, data: '2026-10-01' }],
  ['Rota dos Grãos 17:48', rotaDosGraos('06 Sul', '17:48:34', 'PKPM242B8334'),
    { numero: 'PKPM242B8334', cnpj: '41315638000107', placa: 'UVK4H82', hora: '17:48:34', valor: 10.9, data: '2026-10-01' }],
  ['WAY 153 (DFE N:) continua', 'PEDAGIO WAY 153\nDFE N: JLEE546J82JK\nPlaca: REM8H68', { numero: 'JLEE546J82JK', placa: 'REM8H68' }],
  ['site dfe.xxx.com.br não vira número', 'PRACA PEDAGIO: X\nhttp://dfe.rotadosgraos.com.br', { numero: null }],
  /* 14/11/2026: comprovantes Stone da lavanderia, R$ 15,99 no mesmo dia — só a hora separa (antes só lia hora em pedágio) */
  ['Stone lavanderia 16:10', stone('16:10', '043564', 'Lavagem'), { hora: '16:10', cnpj: '53801766000131', data: '2026-11-14' }],
  ['Stone lavanderia 16:56', stone('16:56', '075933', 'Secagem'), { hora: '16:56', cnpj: '53801766000131', data: '2026-11-14' }],
  ['Stone com ponto lido como -', stone('16:56', '075933', 'Secagem').replace('·', '-'), { hora: '16:56' }],
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
