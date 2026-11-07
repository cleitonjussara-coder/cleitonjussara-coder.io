#!/usr/bin/env node
// Teste das abas RDA e RDM no regime C.V. (06/11/2026). Sem navegador e sem servidor:
//   node scripts/testar-abas-cv.js
// Roda _abaCard, lancarNaAba e o seletor tirados do próprio app.js, com jsdom. Sai com código 1 se algum caso falhar.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));

const app = fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'app.js'), 'utf8');
const trecho = (de, ate) => { const i = app.indexOf(de); const f = app.indexOf(ate, i); if (i < 0 || f < 0) throw new Error('trecho: ' + de); return app.slice(i, f); };
const var_ = t => t.replace(/^(const|let) /gm, 'var ');

let falhas = 0;
const confere = (ok, msg) => { console.log((ok ? '  ok  ' : '  FALHOU  ') + msg); if (!ok) falhas++; };

const dom = new JSDOM('<main id="app-content"></main>', { runScripts: 'dangerously', url: 'http://localhost/' });
const w = dom.window;
w.eval(`
  var notas = [], filMes = 11, filAno = 2026, _pagamentoCV = null, qr = 0, seletor = [], _abaPreEscolhida = null;
  var MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  var esc = s => String(s == null ? '' : s), _n = Number, brlCurto = v => 'R$ ' + v;
  var _notaDoCartao = n => n.pagamento !== 'carteira' && n.pagamento !== 'empresa';
  var iniciarQR = () => { qr++; };
  var abrirSeletorTipoLancamento = d => seletor.push({ ...d, tipoPre: _abaPreEscolhida, pag: _pagamentoPreEscolhido });
`);
w.eval(var_(trecho('const ABAS_DESPESA = {', 'let _abaDespesa = null;')));
w.eval('var _abaDespesa = null;');
w.eval(var_(trecho('let _pagamentoPreEscolhido = null;', 'function abrirAbaDespesa(tipo)')));
w.eval(var_(trecho('function lancarNaAba(tipo, modo) {', 'function renderDespesas()')));

const nota = (tipo, pagamento, valor) => ({ tipo, pagamento, valor, mes: 11, ano: 2026, deleted: false });
w.notasTeste = [nota('RDA', 'cv', 62), nota('RDA', 'carteira', 35), nota('RDM', 'cv', 284), nota('RDM', 'cv', 18), nota('RDM', 'empresa', 500), nota('RDM', null, 10)];
w.eval('notas = window.notasTeste');
const card = t => { const d = w.document.createElement('div'); d.innerHTML = w._abaCard(t); return d.textContent.replace(/\s+/g, ' '); };

console.log('Nomes');
confere(/Relatório de Despesa de Alimentação/.test(card('RDA')), 'RDA');
confere(/Relatório de Despesas Mensais/.test(card('RDM')) && /Todas as outras despesas/.test(card('RDM')), 'RDM');

console.log('Total por forma de pagamento');
w.eval(`_pagamentoCV = 'cv'`);
confere(/R\$ 62 · 1 nota/.test(card('RDA')), `cartão: RDA (${card('RDA').slice(0, 30)})`);
confere(/R\$ 312 · 3 notas/.test(card('RDM')), `cartão: RDM sem Faturamento, nota antiga sem pagamento conta (${card('RDM').slice(0, 30)})`);
w.eval(`_pagamentoCV = 'carteira'`);
confere(/R\$ 35 · 1 nota/.test(card('RDA')), 'repasse: RDA');
confere(/nenhuma nota/.test(card('RDM')), 'repasse: RDM vazio');
w.eval(`_pagamentoCV = null`);
confere(/R\$ 97 · 2 notas/.test(card('RDA')), 'regime RDM/RDA continua contando tudo');

console.log('Lançamento leva a forma de pagamento');
w.eval(`_pagamentoCV = 'carteira'`);
w.lancarNaAba('RDM', 'manual');
let s = w.eval('seletor.pop()');
confere(s.tipo === 'RDM' && s.pag === 'carteira', 'sem QR');
w.eval(`_pagamentoPreEscolhido = null; _pagamentoCV = 'cv'`);
w.lancarNaAba('RDA', 'qr');
confere(w.eval('qr') === 1 && w.eval('_abaPreEscolhida') === 'RDA' && w.eval('_pagamentoPreEscolhido') === 'cv', 'QR');
w.eval(`_pagamentoPreEscolhido = null; _pagamentoCV = null`);
w.lancarNaAba('RDM', 'manual');
s = w.eval('seletor.pop()');
confere(!s.pag, 'regime RDM/RDA não recebe pagamento');

console.log('Tela');
const render = trecho('function renderDespesas() {', '/* ═══════════════════════════════════════════════════════════\n   VIEW: INÍCIO');
confere(!render.includes('_catCardCV') && render.includes("_abaCard('RDA') + _abaCard('RDM')"), 'C.V. usa as abas');
confere(!app.includes('lancarNaCategoriaCV'), 'cartões de categoria saíram');

console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo');
process.exit(falhas ? 1 : 0);
