'use strict';
/* Lista de repasses da ficha separada em Recebidos / Pedidos pagos / Pendentes (build 627, áudio do Paulo de 17/11/2026:
   "o que for pedido fica no pedido, o que foi recebido fica no recebido"). Roda o gestor.js de verdade em jsdom, com o
   caso do print (RDM: 2 recebidos de 150 e 300 + os 2 pedidos pagos iguais, que são o mesmo dinheiro).
     node scripts/testar-repasses-situacao.js */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));
const JS = path.join(__dirname, '..', 'rda-rdm-app', 'js');
const fonte = n => fs.readFileSync(path.join(JS, n), 'utf8');
let falhas = 0;
const confere = (ok, texto) => { console.log(`${ok ? '  ok ' : 'FALHOU'} ${texto}`); if (!ok) falhas++; };
let seq = 0;
const rep = (valor, campos = {}) => ({ id: 'r' + (++seq), user_id: 'u1', tipo: 'RDM', kind: 'received', valor, data: '2026-11-03', mes: 11, ano: 2026, descricao: 'Repasse ' + seq, ...campos });

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
    var ini = () => 'X'; var toast = () => {}; var setLoading = () => {};
    var FusoBR = { data: () => '17/11/2026', hora: () => '12:00', partes: () => ({ ano: 2026, mes: 11, dia: 17 }), hojeISO: () => '2026-11-17' };
    var $ = id => document.getElementById(id);
    var _ehGestorOuAdmin = () => true;
    var currentUser = { id: 'g1', role: 'gestor', nome: 'Paulo' };
    var cardNotaHTML = n => '<div class="nota-card com-thumb" data-tipo="' + n.tipo + '" data-pag="' + (n.pagamento || 'cartao') + '">' + n.razao_social + '</div>';
    Element.prototype.scrollIntoView = function () {};
  `);
  w.eval('var sb = { fechamento: { aguardando: async () => ({ notas: [] }), lista: async () => ({ fechados: [] }) } };');
  w.DB = { getMeta: async () => [], setMeta: async () => {} };
  w.eval(fonte('fechamento.js'));
  { const app = fonte('app.js'); w.eval(app.slice(app.indexOf('const CATEGORIAS_CV = ['), app.indexOf('/* ─── Resumo de gastos e saldo devedor')).replace(/^const /gm, 'var ')); }
  w.eval(fonte('gestor.js') + ';window.Gestor = Gestor;');
  return w;
}

(async () => {
  const colab = { id: 'u1', nome: 'Romário', regime: 'RDM/RDA', role: 'colaborador', ativo: true };
  const reps = [
    rep(150, { data: '2026-11-17', descricao: 'Repasse' }),
    rep(150, { kind: 'request', atendido_em: '2026-11-17 10:00:00', descricao: 'Pedágio.' }),
    rep(300, { data: '2026-11-04', descricao: 'Repasse' }),
    rep(300, { kind: 'request', atendido_em: '2026-11-03 10:00:00', descricao: 'Pedágio' }),
    rep(500, { tipo: 'RDA' }),
    rep(200, { tipo: 'RDA', kind: 'request', descricao: 'Combustível' }),
  ];
  const w = montar();
  const notasMes = [
    { id: 'n1', user_id: 'u1', tipo: 'RDM', subtipo: 'Outros', valor: 100, data: '2026-11-05', mes: 11, ano: 2026, pagamento: 'carteira', foto_path: 'f', razao_social: 'Posto A' },
    { id: 'n2', user_id: 'u1', tipo: 'RDM', subtipo: 'Outros', valor: 50, data: '2026-11-06', mes: 11, ano: 2026, pagamento: 'carteira', foto_path: null, razao_social: 'Posto B' },
    { id: 'n3', user_id: 'u1', tipo: 'RDA', subtipo: 'Outros', valor: 0, data: '2026-11-07', mes: 11, ano: 2026, pagamento: 'carteira', foto_path: 'f', razao_social: 'Restaurante' },
  ];
  const sb = { notas: { list: async q => notasMes.filter(x => (!q.mes || x.mes === q.mes)) }, repasses: { list: async q => reps.filter(x => (!q.mes || x.mes === q.mes)) }, colaboradores: { get: async () => colab } };
  const el = w.document.createElement('div'); w.document.body.appendChild(el);
  w.Gestor.abrir('u1');
  const render = () => w.Gestor.renderDashboard(el, sb, { id: 'g1', role: 'gestor', nome: 'Paulo' }, () => {}, { mes: 11, ano: 2026 });
  await render();
  const vis = () => [...el.querySelectorAll('#cdet-replista .cdet-rep')].filter(it => it.style.display !== 'none');
  const faixa = () => el.querySelector('#cdet-filtro-reps .txt').textContent.replace(/\s+/g, ' ').trim();
  const chip = v => el.querySelector(`#cdet-filtros-rep [data-fr="${v}"]`);

  confere(!!chip('sit:rec') && !!chip('sit:pago') && !!chip('sit:pend') && !chip('sit:fin'), 'Situação tem Recebidos, Pedidos pagos e Pendentes (sem "Finalizados")');
  confere(chip('sit:rec').textContent.trim() === '✅ Recebidos 3' && chip('sit:pago').textContent.trim() === '💸 Pedidos pagos 2' && chip('sit:pend').textContent.trim() === '⏳ Pendentes 1', 'contagem por situação: 3 / 2 / 1');
  confere(vis().length === 2 && vis().every(it => it.dataset.sit === 'rec' && it.dataset.tp === 'RDM'), 'abre em RDM + Recebidos (2 itens)');
  confere(faixa() === 'Só RDM · Recebidos: 2 de 6 · R$ 450,00', `soma sem duplicidade: "${faixa()}"`);
  confere(chip('tp:RDM').classList.contains('btn-primary') && chip('sit:rec').classList.contains('btn-primary'), 'chips RDM e Recebidos acesos');

  w.Gestor.filtrarReps('sit', 'pago');
  confere(vis().length === 2 && vis().every(it => it.dataset.sit === 'pago'), 'Pedidos pagos lista só os 2 pedidos');
  confere(faixa() === 'Só RDM · Pedidos pagos: 2 de 6 · R$ 450,00', `faixa dos pedidos: "${faixa()}"`);

  w.Gestor.filtrarReps('sit', 'todos');
  confere(vis().length === 4, 'RDM + Todos mostra os 4');
  confere(/recebido R\$ 450,00/.test(faixa()) && /2 pedidos pagos \(já estão no recebido\)/.test(faixa()), `Todos soma só o recebido e avisa: "${faixa()}"`);

  w.Gestor.filtrarRepasses(null);   // Limpar filtros
  confere(vis().length === 6, 'Limpar filtros mostra tudo');
  confere(/recebido R\$ 950,00/.test(faixa()) && /2 pedidos pagos/.test(faixa()) && /1 pendente/.test(faixa()), `tudo: "${faixa()}"`);
  confere(el.querySelector('#cdet-filtro-reps button').style.display === 'none', 'sem filtro, o botão Limpar some');

  await render();   // ficha redesenhada (ex.: corrigiu um repasse): não volta ao padrão
  confere(vis().length === 6, 'redesenho da mesma ficha mantém o filtro limpo');

  console.log('Lote 1: notas, pendências, atalhos e filtro lembrado entre meses');
  const faixaN = () => el.querySelector('#cdet-filtro-info .txt').textContent.replace(/\s+/g, ' ').trim();
  const visN = () => [...el.querySelectorAll('#notas-list .nota-card')].filter(c => c.style.display !== 'none');
  confere(faixaN() === '3 notas no mês · R$ 150,00', `faixa das notas sem filtro traz a soma: "${faixaN()}"`);
  w.Gestor.filtrarNotas(null, 'RDM');
  confere(faixaN() === 'Só RDM: 2 de 3 notas · R$ 150,00', `filtro RDM com soma: "${faixaN()}"`);
  w.Gestor.filtrarNotas(null);
  const kpiPend = el.querySelector('.cdet-kpi[data-filtro="pend"]');
  confere(!!kpiPend, 'cartão Pendências é tocável quando há pendência');
  w.Gestor.filtrarNotas('pend');
  confere(visN().length === 2 && /pendências/.test(faixaN()), `Pendências lista só as 2 notas (sem foto / sem valor): "${faixaN()}"`);
  w.Gestor.filtrarNotas('pend');
  confere(visN().length === 3, 'tocar de novo em Pendências volta à lista inteira');
  const atalhos = [...el.querySelectorAll('.cdet-atalhos button')].map(b => b.textContent.trim());
  confere(atalhos.length === 2 && /Notas 3/.test(atalhos[0]) && /Repasses 6/.test(atalhos[1]), `atalhos no topo: ${atalhos.join(' | ')}`);
  w.Gestor.filtrarReps('tp', 'RDA'); w.Gestor.filtrarReps('sit', 'rec');
  await w.Gestor.renderDashboard(el, sb, { id: 'g1', role: 'gestor', nome: 'Paulo' }, () => {}, { mes: 10, ano: 2026 });
  await render();
  confere(vis().length === 1 && vis()[0].dataset.tp === 'RDA' && vis()[0].dataset.sit === 'rec', 'outro mês e volta: RDA + Recebidos continua marcado');
  w.Gestor.filtrarRepasses(null);

  w.Gestor.filtrarReps('sit', 'pend');
  confere(vis().length === 1 && faixa() === 'Só Pedidos pendentes: 1 de 6 · R$ 200,00', `Pendentes: "${faixa()}"`);
  w.Gestor.filtrarReps('tp', 'RDM');
  confere(vis().length === 0 && /Nenhum repasse/.test(faixa()), `RDM + Pendentes vazio avisa: "${faixa()}"`);
  console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo ok');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
