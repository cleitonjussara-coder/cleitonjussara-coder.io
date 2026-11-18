'use strict';
/* "✓ Conferido" na ficha da Equipe (build 630, 18/11/2026, Lote 3 da revisão do gestor). Roda o gestor.js de verdade em jsdom:
   botão em cada nota e repasse, "mudou depois de conferida", contagem nas faixas, filtro "Falta conferir" e marcar/desmarcar
   chamando o servidor (PUT /conferencias).
     node scripts/testar-conferido.js */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));
const JS = path.join(__dirname, '..', 'rda-rdm-app', 'js');
const fonte = n => fs.readFileSync(path.join(JS, n), 'utf8');
let falhas = 0;
const confere = (ok, texto) => { console.log(`${ok ? '  ok ' : 'FALHOU'} ${texto}`); if (!ok) falhas++; };
const limpa = t => String(t || '').replace(/\s+/g, ' ').trim();

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
    var pedirConfirmacao = async () => true;
    var FusoBR = { data: () => '18/11/2026', hora: () => '12:00', partes: () => ({ ano: 2026, mes: 11, dia: 18 }), hojeISO: () => '2026-11-18' };
    var $ = id => document.getElementById(id);
    var _ehGestorOuAdmin = () => true;
    var currentUser = { id: 'g1', role: 'gestor', nome: 'Paulo' };
    var cardNotaHTML = n => '<div class="nota-card com-thumb" data-tipo="' + n.tipo + '" data-pag="' + (n.pagamento || 'cartao') + '">' + n.razao_social + '</div>';
    Element.prototype.scrollIntoView = function () {};
  `);
  w.DB = { getMeta: async () => [], setMeta: async () => {} };
  w.eval(`var sb = { fechamento: { aguardando: async () => ({ notas: [] }), lista: async () => ({ fechados: [] }) } };`);
  w.eval(fonte('fechamento.js'));
  { const app = fonte('app.js'); w.eval(app.slice(app.indexOf('const CATEGORIAS_CV = ['), app.indexOf('/* ─── Resumo de gastos e saldo devedor')).replace(/^const /gm, 'var ')); }
  w.eval(fonte('gestor.js') + ';window.Gestor = Gestor;');
  return w;
}

(async () => {
  const w = montar();
  const colab = { id: 'u1', nome: 'Romário', regime: 'RDM/RDA', role: 'colaborador', ativo: true };
  const nota = (id, valor, upd) => ({ id, user_id: 'u1', tipo: 'RDM', subtipo: 'Outros', valor, data: '2026-11-05', mes: 11, ano: 2026, pagamento: 'carteira', foto_path: 'f', razao_social: 'Posto ' + id, updated_at: upd });
  const notas = [nota('n1', 100, '2026-11-17T10:00:00Z'), nota('n2', 50, '2026-11-18T15:00:00Z'), nota('n3', 30, '2026-11-17T10:00:00Z')];
  const reps = [{ id: 'r1', user_id: 'u1', tipo: 'RDM', kind: 'received', valor: 150, data: '2026-11-17', mes: 11, ano: 2026, updated_at: '2026-11-17T10:00:00Z' },
    { id: 'r2', user_id: 'u1', tipo: 'RDM', kind: 'received', valor: 300, data: '2026-11-04', mes: 11, ano: 2026, updated_at: '2026-11-04T10:00:00Z' }];
  const marcas = [
    { tipo: 'nota', registro_id: 'n1', conferido: true, conferido_por_nome: 'Paulo', conferido_em: '2026-11-18T12:00:00Z' },
    { tipo: 'nota', registro_id: 'n2', conferido: true, conferido_por_nome: 'Paulo', conferido_em: '2026-11-18T12:00:00Z' },   // corrigida às 15h: mudou depois
    { tipo: 'repasse', registro_id: 'r1', conferido: true, conferido_por_nome: 'Paulo', conferido_em: '2026-11-18T12:00:00Z' },
  ];
  const salvos = [];
  const sbFicha = {
    notas: { list: async q => notas.filter(x => !q.mes || x.mes === q.mes) },
    repasses: { list: async q => reps.filter(x => !q.mes || x.mes === q.mes) },
    colaboradores: { get: async () => colab },
    conferencias: {
      list: async () => marcas,
      salvar: async b => { salvos.push(b); return { tipo: b.tipo, registro_id: b.registro_id, conferido: b.conferido, conferido_por_nome: 'Paulo', conferido_em: '2026-11-18T16:00:00Z' }; },
    },
  };
  w.sb.conferencias = sbFicha.conferencias;
  Object.defineProperty(w.navigator, 'onLine', { value: true, configurable: true });
  const el = w.document.createElement('div'); w.document.body.appendChild(el);
  w.Gestor.abrir('u1');
  await w.Gestor.renderDashboard(el, sbFicha, { id: 'g1', role: 'gestor', nome: 'Paulo' }, () => {}, { mes: 11, ano: 2026 });

  const bt = (sel) => el.querySelector(sel + ' .conf-bt');
  const quem = sel => limpa(el.querySelector(sel + ' .conf-quem')?.textContent);
  confere(limpa(bt('[data-nid="n1"]')?.textContent) === '✓ Conferida' && /por Paulo/.test(quem('[data-nid="n1"]')), `nota conferida: "${limpa(bt('[data-nid="n1"]')?.textContent)}" ${quem('[data-nid="n1"]')}`);
  confere(limpa(bt('[data-nid="n2"]')?.textContent) === '☐ Conferir de novo' && /mudou depois de conferida/.test(quem('[data-nid="n2"]')), `nota corrigida depois: "${limpa(bt('[data-nid="n2"]')?.textContent)}" ${quem('[data-nid="n2"]')}`);
  confere(limpa(bt('[data-nid="n3"]')?.textContent) === '☐ Conferir', 'nota sem marca: "☐ Conferir"');
  confere(limpa(bt('[data-rid="r1"]')?.textContent) === '✓ Conferido', 'repasse conferido: "✓ Conferido"');
  const faixaN = () => limpa(el.querySelector('#cdet-filtro-info .txt').textContent);
  confere(/✓ 1 de 3 conferidas/.test(faixaN()), `faixa das notas conta: "${faixaN()}"`);
  const faixaR = () => limpa(el.querySelector('#cdet-filtro-reps .txt').textContent);
  confere(/✓ 1 de 2 conferidos/.test(faixaR()), `faixa dos repasses conta: "${faixaR()}"`);
  const chip = el.querySelector('#cdet-filtros-notas [data-fn="falta"]');
  confere(!!chip && /Falta conferir 2/.test(limpa(chip.textContent)), `botão "Falta conferir": "${limpa(chip && chip.textContent)}"`);
  w.Gestor.filtrarNotas('falta');
  const vis = () => [...el.querySelectorAll('#notas-list .nota-card')].filter(c => c.style.display !== 'none').map(c => c.dataset.nid);
  confere(vis().join() === 'n2,n3', `Falta conferir mostra a corrigida e a sem marca (${vis().join()})`);
  await w.Gestor.conferir('nota', 'n3', bt('[data-nid="n3"]'));   // o onclick do botão chama isto (jsdom não roda onclick em atributo)
  await new Promise(r => setTimeout(r, 20));
  confere(salvos.at(-1)?.registro_id === 'n3' && salvos.at(-1)?.conferido === true, 'tocar em Conferir manda marcar no servidor');
  confere(limpa(bt('[data-nid="n3"]')?.textContent) === '✓ Conferida' && vis().join() === 'n2', `a nota marcada sai do "Falta conferir" (${vis().join()})`);
  await w.Gestor.conferir('nota', 'n1', bt('[data-nid="n1"]'));
  await new Promise(r => setTimeout(r, 20));
  confere(salvos.at(-1)?.registro_id === 'n1' && salvos.at(-1)?.conferido === false, 'tocar em Conferida desmarca (depois da confirmação)');
  w.Gestor.filtrarNotas('falta');   // desliga o filtro
  confere(/✓ 1 de 3 conferidas/.test(faixaN()), `contagem acompanha: "${faixaN()}"`);

  console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo ok');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
