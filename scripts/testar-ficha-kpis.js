'use strict';
/* Cartões do resumo da ficha interativos (07/11/2026, pedido do Cleiton sobre o print): roda o gestor.js de verdade em jsdom,
   nos regimes RDM/RDA e C.V. Gasto e Saldo com RDM e RDA separados, Recebido com repasses e recargas (corrigir e apagar),
   Faturamento do mês por categoria. Sai com código 1 se algum caso falhar.
     node scripts/testar-ficha-kpis.js */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));

const JS = path.join(__dirname, '..', 'rda-rdm-app', 'js');
const fonte = n => fs.readFileSync(path.join(JS, n), 'utf8');
let falhas = 0;
const confere = (ok, texto) => { console.log(`${ok ? '  ok ' : 'FALHOU'} ${texto}`); if (!ok) falhas++; };

let seq = 0;
const nota = (user_id, valor, campos = {}) => ({ id: 'n' + (++seq), user_id, tipo: 'RDM', subtipo: 'Outros', valor, data: '2026-11-05', mes: 11, ano: 2026, deleted: false, pagamento: null, foto_path: 'f', razao_social: 'Posto ' + seq, ...campos });
const rep = (user_id, valor, campos = {}) => ({ id: 'r' + (++seq), user_id, tipo: 'RDM', kind: 'received', valor, data: '2026-11-03', mes: 11, ano: 2026, descricao: 'Repasse ' + seq, ...campos });

function montar() {
  const dom = new JSDOM('<main id="app-content"></main>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(`
    var MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    var MESES_LONGO = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    var esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    var _at = esc;
    var brl = v => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
    var fmtData = d => String(d || '');
    var ini = () => 'X';
    var toast = () => {};
    var setLoading = () => {};
    var FusoBR = { data: () => '07/11/2026', hora: () => '12:00', partes: () => ({ ano: 2026, mes: 11, dia: 7 }), hojeISO: () => '2026-11-07' };
    var $ = id => document.getElementById(id);
    var _ehGestorOuAdmin = () => true;
    var currentUser = { id: 'g1', role: 'admin', nome: 'Cleiton' };
  `);
  w.eval('var sb = { fechamento: { aguardando: async () => ({ notas: [] }), lista: async () => ({ fechados: [] }) } };');
  w.DB = { getMeta: async () => [], setMeta: async () => {} };
  w.eval(fonte('fechamento.js'));
  { const app = fonte('app.js'); w.eval(app.slice(app.indexOf('const CATEGORIAS_CV = ['), app.indexOf('/* ─── Resumo de gastos e saldo devedor')).replace(/^const /gm, 'var ')); }
  w.eval(fonte('gestor.js') + ';window.Gestor = Gestor;');
  return w;
}

async function ficha(colab, notas, reps) {
  const w = montar();
  const doFiltro = (arr, q) => arr.filter(x => (!q.ano || x.ano === q.ano) && (!q.mes || x.mes === q.mes));
  const sb = {
    notas: { list: async q => doFiltro(notas, q) },
    repasses: { list: async q => doFiltro(reps, q) },
    colaboradores: { get: async () => colab },
  };
  const el = w.document.createElement('div');
  w.document.body.appendChild(el);
  w.Gestor.abrir(colab.id);
  await w.Gestor.renderDashboard(el, sb, { id: 'g1', role: 'admin', nome: 'Cleiton' }, () => {}, { mes: 11, ano: 2026 });
  return { w, el };
}
const txt = n => (n ? n.textContent.replace(/\s+/g, '') : '');   // sem espaço: rótulo e valor ficam colados

(async () => {
  console.log('Regime RDM/RDA');
  {
    const colab = { id: 'u1', nome: 'Ana', email: 'a@x', role: 'colaborador', regime: 'rdm_rda' };
    const notas = [
      nota('u1', 200, { subtipo: 'Abastecimento' }), nota('u1', 15.5, { subtipo: 'Pedágio' }), nota('u1', 80, { tipo: 'RDA', subtipo: null }),
      nota('u1', 700, { subtipo: 'Hospedagem', pagamento: 'empresa' }),
      nota('u1', 50, { mes: 10, data: '2026-10-10' }),
    ];
    const reps = [rep('u1', 300), rep('u1', 120, { tipo: 'RDA' }), rep('u1', 40, { kind: 'request' }), rep('u1', 100, { mes: 10, data: '2026-10-02' })];
    const { w, el } = await ficha(colab, notas, reps);
    const toques = [...el.querySelectorAll('button.cdet-kpi[data-painel]')].map(b => b.dataset.painel);
    confere(['kpi-gasto', 'kpi-rec', 'kpi-saldo', 'kpi-fat'].every(p => toques.includes(p)), `os quatro cartões são botões (${toques.join(', ')})`);
    const gasto = el.querySelector('[data-painel="kpi-gasto"].cdet-kpi');
    confere(/RDMR\$215,50/.test(txt(gasto)) && /RDAR\$80,00/.test(txt(gasto)), `Gasto mostra RDM e RDA (${txt(gasto)})`);
    const saldo = el.querySelector('[data-painel="kpi-saldo"].cdet-kpi');
    confere(/RDMR\$84,50/.test(txt(saldo)) && /RDAR\$40,00/.test(txt(saldo)), `Saldo do mês separado (${txt(saldo)})`);
    const fat = el.querySelector('[data-painel="kpi-fat"].cdet-kpi');
    confere(/Faturamentodomês/i.test(txt(fat)) && /R\$995,50/.test(txt(fat)), `Faturamento diz que é do mês (${txt(fat)})`);

    const painel = p => el.querySelector(`.cdet-plan-det[data-painel="${p}"]`);
    confere(['kpi-gasto', 'kpi-rec', 'kpi-saldo', 'kpi-fat'].every(p => painel(p) && painel(p).hidden), 'painéis começam fechados');
    w.Gestor.alternarPlanilha('kpi-rec');
    confere(!painel('kpi-rec').hidden && painel('kpi-gasto').hidden, 'tocar em Recebido abre só o painel dele');
    confere(el.querySelector('[data-painel="kpi-rec"].cdet-kpi').classList.contains('on'), 'e o cartão fica marcado');
    const pr = painel('kpi-rec');
    confere(pr.querySelectorAll('[onclick^="editarRepasseDeOutro"]').length === 2 && pr.querySelectorAll('[onclick^="excluirRepasseDeOutro"]').length === 2, 'Recebido lista os 2 repasses do mês com corrigir e apagar');
    confere(/1pedido/.test(txt(pr)), 'e avisa do pedido pendente');
    confere(!!pr.querySelector('[onclick^="abrirFormRepasse"]'), 'e tem o botão de lançar repasse');
    w.Gestor.alternarPlanilha('kpi-rec');
    confere(painel('kpi-rec').hidden, 'tocar de novo fecha');

    confere(painel('kpi-gasto').querySelectorAll('.cdet-plan-nota').length === 3, 'Gasto lista as 3 notas próprias do mês (sem a da empresa nem a de outubro)');
    const ps = txt(painel('kpi-saldo'));
    confere(/=SaldoacumuladoR\$134,50R\$40,00/.test(ps), `Saldo traz o acumulado RDM e RDA (${ps.slice(0, 220)})`);
    const pf = painel('kpi-fat');
    const cats = [...pf.querySelectorAll('.cdet-cat')].map(c => txt(c));
    confere(cats.length === 4, `Faturamento por categoria: ${cats.length} categorias`);
    confere(/Hospedagem/.test(cats[0]) && /700,00/.test(cats[0]), `maior primeiro (${cats[0]})`);
    confere(/PagopelaempresaR\$700,00/.test(txt(pf)), 'e separa o que a empresa pagou');
  }

  console.log('Regime C.V.');
  {
    const colab = { id: 'c1', nome: 'Bia', email: 'b@x', role: 'colaborador', regime: 'cv' };
    const notas = [
      nota('c1', 100, { pagamento: 'carteira', subtipo: 'Abastecimento' }), nota('c1', 60, { pagamento: 'cartao', tipo: 'RDA', subtipo: null }),
      nota('c1', 40, { pagamento: 'cartao', subtipo: 'Pedágio' }), nota('c1', 500, { pagamento: 'empresa', subtipo: 'Hospedagem' }),
    ];
    const reps = [rep('c1', 90), rep('c1', 200, { destino: 'recarga' }), rep('c1', 50, { destino: 'recarga', tipo: 'RDA' })];
    const { w, el } = await ficha(colab, notas, reps);
    const toques = [...el.querySelectorAll('button.cdet-kpi[data-painel]')].map(b => b.dataset.painel);
    confere(['kpi-gasto', 'kpi-rec', 'kpi-recarga', 'kpi-fat'].every(p => toques.includes(p)) && !toques.includes('kpi-saldo'), `C.V. tem os cartões interativos, saldo fica na faixa (${toques.join(', ')})`);
    const painel = p => el.querySelector(`.cdet-plan-det[data-painel="${p}"]`);
    const pg = txt(painel('kpi-gasto'));
    confere(/Carteira\(RDM\/RDA\)R\$100,00/.test(pg) && /Cartão\(RDM\/RDA\)R\$100,00/.test(pg), `Gasto separa carteira e cartão (${pg.slice(0, 200)})`);
    confere(/Cartão:RDMR\$40,00·RDAR\$60,00/.test(pg), 'e cada um em RDM e RDA');
    const pr = painel('kpi-rec');
    confere(pr.querySelectorAll('[onclick^="editarRepasseDeOutro"]').length === 3, 'Recebido lista repasse e recargas, todos editáveis');
    confere([...pr.querySelectorAll('[onclick^="abrirFormRepasse"]')].length === 2, 'e lança repasse ou recarga');
    confere(painel('kpi-recarga').querySelectorAll('[onclick^="excluirRepasseDeOutro"]').length === 2, 'Recarga lista as 2 recargas com apagar');
    const pf = txt(painel('kpi-fat'));
    confere(/FaturamentodomêsR\$700,00/.test(pf) && /CarteiraR\$100,00/.test(pf) && /PagopelaempresaR\$500,00/.test(pf), `Faturamento C.V. por quem pagou (${pf.slice(0, 220)})`);
    const det = el.querySelector('.cdet-kpis-det');
    confere(det.style.display === 'none', 'painéis escondidos junto com o resumo fechado');
    w.Gestor.alternarKpis(el.querySelector('.cdet-mais'));
    confere(det.style.display === '', 'e aparecem ao abrir o resumo');
  }

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
