'use strict';
/* Conferir em lote (27/11/2026, verificação de 26/11, fase 3 item 2). Roda o gestor.js de verdade em jsdom: com
   "☐ Falta conferir" ligado, a caixa verde conta só as notas sem pendência (com foto, com valor, sem duplicata), e o botão
   manda só essas ao servidor (PUT /conferencias/lote) e pinta a marca.
     node scripts/testar-conferir-lote.js */
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
  w.eval(`var _mapaDuplicatas = l => new Map(l.filter(n => n.id === 'n4').map(n => [n.id, { nota: n, motivo: 'igual' }])); window._mapaDuplicatas = _mapaDuplicatas;`);
  const colab = { id: 'u1', nome: 'Romário', regime: 'RDM/RDA', role: 'colaborador', ativo: true };
  const nota = (id, valor, foto = 'f') => ({ id, user_id: 'u1', tipo: 'RDM', subtipo: 'Outros', valor, data: '2026-11-05', mes: 11, ano: 2026, pagamento: 'carteira', foto_path: foto, razao_social: 'Posto ' + id, updated_at: '2026-11-17T10:00:00Z' });
  const notas = [nota('n1', 100.125), nota('n2', 50), nota('n3', 30, ''), nota('n4', 20), nota('n5', 0)];
  const marcas = [{ tipo: 'nota', registro_id: 'n1', conferido: true, conferido_por_nome: 'Paulo', conferido_em: '2026-11-18T12:00:00Z' }];
  const lotes = [];
  const sbFicha = {
    notas: { list: async () => notas },
    repasses: { list: async () => [] },
    colaboradores: { get: async () => colab },
    conferencias: {
      list: async () => marcas,
      salvar: async () => ({}),
      lote: async ids => { lotes.push(ids); return { conferidas: ids.map(id => ({ tipo: 'nota', registro_id: id, conferido: true, conferido_por_nome: 'Paulo', conferido_em: '2026-11-27T16:00:00Z' })), pulados: [] }; },
    },
  };
  w.sb.conferencias = sbFicha.conferencias;
  Object.defineProperty(w.navigator, 'onLine', { value: true, configurable: true });
  const el = w.document.createElement('div'); w.document.body.appendChild(el);
  w.Gestor.abrir('u1');
  await w.Gestor.renderDashboard(el, sbFicha, { id: 'g1', role: 'gestor', nome: 'Paulo' }, () => {}, { mes: 11, ano: 2026 });
  const caixa = () => el.querySelector('#cdet-lote');
  confere(caixa() && caixa().hidden, 'sem o filtro "Falta conferir", a caixa do lote fica escondida');
  w.Gestor.filtrarNotas('falta');
  const txt = limpa(caixa()?.textContent);
  confere(caixa() && !caixa().hidden && /1 nota sem pendência/.test(txt) && /R\$ 50,00/.test(txt), `com o filtro: só a n2 entra no lote — "${txt}"`);
  confere(/As 3 com pendência ficam/.test(txt), 'avisa que sem foto, duplicata e sem valor ficam para olhar uma a uma');
  await w.Gestor.conferirLote();
  confere(lotes.length === 1 && JSON.stringify(lotes[0]) === '["n2"]', `manda só a nota sem pendência: ${JSON.stringify(lotes)}`);
  confere(limpa(el.querySelector('[data-nid="n2"] .conf-bt')?.textContent) === '✓ Conferida', 'a nota do lote aparece conferida');
  confere(caixa().hidden, 'depois do lote, a caixa some (nada mais sem pendência para marcar)');
  console.log(falhas ? `\n${falhas} FALHARAM` : '\ntudo ok');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('ERRO NO TESTE:', e); process.exit(1); });
