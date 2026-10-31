#!/usr/bin/env node
// Teste do front da Planilha de KM (frota-planilha.js) com jsdom — sem navegador e sem servidor.
//   node scripts/testar-frota-planilha.js
// Cobre: chips de colaboradores, totais, célula → leitura do dia, planilha individual, id com aspas (XSS),
// exportação (pessoas e modo) e resposta de ano antigo. Sai com código 1 se algum caso falhar.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));
const fonte = fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'frota-planilha.js'), 'utf8');
let falhas = 0;
const confere = (ok, msg) => { console.log((ok ? '  ok  ' : '  FALHOU  ') + msg); if (!ok) falhas++; };
const espera = ms => new Promise(r => setTimeout(r, ms));

const ID_RUIM = `x'"><img src=x onerror=window.__xss=1>`;
const anual = {
  ano: 2026,
  motoristas: [
    { user_id: 'a', nome: 'Ana Paula', meses: Array(12).fill(0), total: 300, leituras: 2 },
    { user_id: 'b', nome: 'Bruno Lima', meses: Array(12).fill(0), total: 120, leituras: 1 },
    { user_id: ID_RUIM, nome: 'Carlos <b>X</b>', meses: Array(12).fill(0), total: 50, leituras: 1 },
  ],
  leituras: [
    { id: '1', data: '2026-10-05', mes: 10, placa: 'AAA1A11', user_id: 'a', motorista: 'Ana Paula', odometro: 1100, odometro_anterior: 1000, km_rodado: 100, observacao: 'campo' },
    { id: '2', data: '2026-10-12', mes: 10, placa: 'AAA1A11', user_id: 'a', motorista: 'Ana Paula', odometro: 1300, odometro_anterior: 1100, km_rodado: 200, observacao: '' },
    { id: '3', data: '2026-10-05', mes: 10, placa: 'BBB2B22', user_id: 'b', motorista: 'Bruno Lima', odometro: 520, odometro_anterior: 400, km_rodado: 120, observacao: null },
    { id: '4', data: '2026-09-30', mes: 9, placa: 'CCC3C33', user_id: ID_RUIM, motorista: 'x', odometro: 90, odometro_anterior: 40, km_rodado: 50, observacao: '' },
  ],
};

async function montar() {
  const dom = new JSDOM('<main><div id="fq-corpo"></div></main>', { runScripts: 'dangerously', url: 'http://localhost/' });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'onLine', { get: () => true, configurable: true });
  w.__anual = anual; w.__exp = []; w.__anos = [];
  w.eval(`
    var $ = id => document.getElementById(id);
    var esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var toast = () => {}; var setLoading = () => {};
    var user = { id: 'u1' };
    var FusoBR = { hojeISO: () => '2026-10-31' };
    var DB = { setMeta: async () => {}, getMeta: async () => null };
    var sb = { hojeDoServidor: () => '2026-10-31', frota: { anual: async ano => { __anos.push(ano); return JSON.parse(JSON.stringify(__anual)); } } };
    var Excel = { exportarFrotaPlanilha: async (a, p, o) => { __exp.push({ p: p.map(x => x.user_id), o }); return p.length; } };
  `);
  w.eval(fonte);
  await w.FrotaPlanilha.montar(w.document.getElementById('fq-corpo'));
  return w;
}

(async () => {
  const w = await montar();
  const d = w.document, corpo = () => d.getElementById('fq-corpo');
  console.log('Tela inicial');
  confere(d.querySelectorAll('.fp-chips .chip:not(.todos)').length === 3, '3 chips de colaborador');
  confere(/Outubro 2026/.test(corpo().textContent), 'mês atual (Outubro 2026)');
  confere(/420/.test(corpo().textContent), 'total do mês = 420 km (só Ana + Bruno; o de setembro não entra)');
  confere(d.querySelector('.fp-tab tr.tot') && /Total/.test(d.querySelector('.fp-tab tr.tot').textContent), 'linha de total');
  confere(!w.__xss && !d.querySelector('img[src="x"]'), 'id/nome com aspas e HTML não vira código');

  console.log('Escolher colaboradores');
  w.FrotaPlanilha.todos();                                     // todos marcados → limpar
  confere(/Escolha ao menos um/.test(corpo().textContent), 'sem ninguém marcado avisa');
  w.FrotaPlanilha.alternar('a');
  confere(d.querySelectorAll('.fp-chips .chip.active').length === 1, 'um chip ativo');
  confere(/Ana Paula · Outubro/.test(corpo().textContent), 'um só escolhido abre a planilha individual');
  confere(/1\.300/.test(corpo().textContent) && /1\.100/.test(corpo().textContent), 'individual mostra leitura anterior e atual');
  confere(/Planilha de Ana/.test(corpo().textContent), 'botão de Excel individual');

  console.log('Dois escolhidos, célula e ranking');
  w.FrotaPlanilha.alternar('b');
  confere(!/Ana Paula · Outubro/.test(corpo().textContent), 'com dois, a individual some');
  const cel = [...d.querySelectorAll('td.c')].find(td => td.dataset.id === 'a' && td.dataset.d === '5');
  cel.click();
  confere(/Anterior <b>1\.000|Anterior 1\.000/.test(corpo().innerHTML) && /100 km/.test(corpo().textContent), 'toque na célula mostra a leitura do dia');
  w.FrotaPlanilha.ver('pessoa');
  const rk = d.querySelectorAll('.fp-rk');
  confere(rk.length === 2 && /Ana/.test(rk[0].textContent), 'ranking ordena por km (Ana primeiro)');
  rk[0].click();
  confere(/Ana Paula · Outubro/.test(corpo().textContent) && d.querySelector('.fp-ind button'), 'toque no ranking abre a individual com Voltar');
  w.FrotaPlanilha.fechar();
  confere(!d.querySelector('.fp-ind'), 'Voltar fecha a individual');

  console.log('Exportar');
  await w.FrotaPlanilha.exportar(true);
  await w.FrotaPlanilha.exportar(false);
  confere(JSON.stringify(w.__exp[0]) === JSON.stringify({ p: ['a', 'b'], o: { mes: 10, separado: true } }), 'um arquivo por colaborador: só os escolhidos, mês 10');
  confere(w.__exp[1].o.separado === false, 'Excel junto');

  console.log('Mês e ano');
  await w.FrotaPlanilha.mes(-1);
  confere(/Setembro 2026/.test(corpo().textContent), 'mês anterior');
  w.FrotaPlanilha.mes(1);
  confere(d.querySelector('.fq-nav button:last-child').disabled, 'não passa do mês atual');
  for (let i = 0; i < 10; i++) await w.FrotaPlanilha.mes(-1);
  await espera(20);
  confere(w.__anos.includes(2025), 'cruzar o ano busca o ano anterior');

  console.log('Logout');
  w.FrotaPlanilha.esquecer();
  confere(true, 'esquecer() não quebra');

  console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})();
