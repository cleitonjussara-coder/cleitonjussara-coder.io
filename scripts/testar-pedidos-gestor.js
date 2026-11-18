'use strict';
/* Lote 1 da revisão do gestor (build 628, 17/11/2026): pedidos de repasse com rastro e sem pagamento em dobro.
   - Repasses e recargas: faixa "⏳ N pedidos abertos · R$" e selo "✔ pago pelo sino · pedido de dd/mm" no recebido
     que veio de um pedido; os pedidos não entram na lista nem no total.
   - Sino: abrirNotificacoes('pedido') mostra só os pedidos, com o total no título.
   - Aviso de devedores: com pedido aberto, o botão vira "✔ Pagar o pedido de R$ X" (não lança outro repasse).
   Roda o código de verdade (repasses-equipe.js inteiro e trechos do app.js) em jsdom.
     node scripts/testar-pedidos-gestor.js */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));
const JS = path.join(__dirname, '..', 'rda-rdm-app', 'js');
const fonte = n => fs.readFileSync(path.join(JS, n), 'utf8');
const app = fonte('app.js');
const trecho = (de, ate) => { const i = app.indexOf(de); const f = app.indexOf(ate, i); if (i < 0 || f < 0) throw new Error('trecho: ' + de); return app.slice(i, f); };
let falhas = 0;
const confere = (ok, texto) => { console.log(`${ok ? '  ok ' : 'FALHOU'} ${texto}`); if (!ok) falhas++; };
const limpa = t => String(t || '').replace(/\s+/g, ' ').trim();

function base() {
  const dom = new JSDOM('<main id="app-content"></main>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(`
    var MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    var esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    var _at = esc;
    var brl = v => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
    var fmtDataBR = d => String(d || '').slice(0, 10).split('-').reverse().join('/');
    var $ = id => document.getElementById(id);
    var toast = () => {};
    var filMes = 11, filAno = 2026, viewAtual = 'repasses';
    var _ehGestorOuAdmin = () => true;
    var _veEquipe = () => true;
    var equipePorId = {};
    var _repasseEhPedido = r => ['requested','request','pedido','solicitado'].includes(String(r && r.kind || '').toLowerCase());
    var _repasseEhRecebido = r => !_repasseEhPedido(r);
    var _repassePendente = r => _repasseEhPedido(r) && !r.atendido_em && !r.deleted;
  `);
  return w;
}

const pedidoPago = { id: 'p1', user_id: 'u1', tipo: 'RDM', kind: 'request', valor: 150, data: '2026-11-17', mes: 11, ano: 2026, descricao: 'Pedágio', atendido_em: '2026-11-17 10:00:00' };
const pedidoAberto = { id: 'p2', user_id: 'u2', tipo: 'RDM', kind: 'request', valor: 300, data: '2026-11-16', mes: 11, ano: 2026, descricao: 'Combustível' };
const pedidoAberto2 = { id: 'p3', user_id: 'u1', tipo: 'RDA', kind: 'request', valor: 80, data: '2026-11-15', mes: 11, ano: 2026 };
const recebidoDoPedido = { id: 'r1', user_id: 'u1', tipo: 'RDM', kind: 'received', valor: 150, data: '2026-11-17', mes: 11, ano: 2026, descricao: 'Repasse', pedido_id: 'p1' };
const recebidoAvulso = { id: 'r2', user_id: 'u1', tipo: 'RDM', kind: 'received', valor: 300, data: '2026-11-04', mes: 11, ano: 2026, descricao: 'Repasse' };

(async () => {
  console.log('Repasses e recargas');
  {
    const w = base();
    w.eval(`var sb = { repasses: { list: async () => ${JSON.stringify([pedidoPago, pedidoAberto, pedidoAberto2, recebidoDoPedido, recebidoAvulso])} },
      colaboradores: { listTodos: async () => [{ id: 'u1', nome: 'Romário' }, { id: 'u2', nome: 'José' }] } };`);
    w.eval(fonte('repasses-equipe.js'));
    w.RepassesEquipe.render();
    await new Promise(r => setTimeout(r, 20));
    const el = w.document.getElementById('app-content');
    const faixa = el.querySelector('.rep-faixa-pedidos');
    confere(!!faixa && /2 pedidos abertos/.test(faixa.textContent) && /R\$ 380,00/.test(faixa.textContent), `faixa dos pedidos abertos: "${limpa(faixa && faixa.textContent)}"`);
    confere(faixa && /abrirNotificacoes\('pedido'\)/.test(faixa.getAttribute('onclick')), 'a faixa abre o sino só com os pedidos');
    const itens = [...el.querySelectorAll('.cdet-rep')];
    confere(itens.length === 2, `lista só com os 2 recebidos (sem os pedidos): ${itens.length}`);
    const selo = el.querySelector('.rep-selo-pedido');
    confere(!!selo && /pago pelo sino · pedido de 17\/11\/2026 “Pedágio”/.test(selo.textContent), `selo no recebido do pedido: "${limpa(selo && selo.textContent)}"`);
    confere(el.querySelectorAll('.rep-selo-pedido').length === 1, 'repasse avulso fica sem selo');
    confere(/Total da lista: R\$ 450,00/.test(limpa(el.textContent)), 'total só dos recebidos (R$ 450,00)');
    w.RepassesEquipe.pessoa('u1');
    const f2 = el.querySelector('.rep-faixa-pedidos');
    confere(!!f2 && /1 pedido aberto de Romário · R\$ 80,00/.test(limpa(f2.textContent)), `com uma pessoa escolhida, só os pedidos dela: "${limpa(f2 && f2.textContent)}"`);
  }

  console.log('Sino filtrado em pedidos');
  {
    const w = base();
    w.eval(`
      var _itens = [
        { id: 'p2', tipo: 'pedido', rep: ${JSON.stringify(pedidoAberto)}, titulo: 'José pediu R$ 300,00 (RDM)', sub: '16/11/2026' },
        { id: 'p3', tipo: 'pedido', rep: ${JSON.stringify(pedidoAberto2)}, titulo: 'Romário pediu R$ 80,00 (RDA)', sub: '15/11/2026' },
        { id: 'x1', tipo: 'cartao', userId: 'u1', nome: 'Romário', titulo: 'Cartão baixo', sub: '' },
      ];
      var _notificacoes = () => _itens;
      var _pintarSinoPush = () => {}; var _pintarSinoEquipe = () => {};
    `);
    w.eval(trecho('let _sinoFiltro = null;', '/* ═══'));
    w.abrirNotificacoes('pedido');
    const ov = w.document.getElementById('notif-overlay');
    const tit = limpa(ov.querySelector('h3').textContent);
    confere(tit === '💸 Pedidos de repasse (2) · R$ 380,00', `título com o total: "${tit}"`);
    confere(ov.querySelectorAll('.notif-item').length === 2 && !ov.querySelector('.notif-item.cartao'), 'só os pedidos, sem o aviso de cartão');
    confere(/Ver todas as notificações \(3\)/.test(ov.textContent), 'botão para ver todas');
    ov.remove();
    w.abrirNotificacoes();
    const ov2 = w.document.getElementById('notif-overlay');
    confere(/Notificações \(3\)/.test(ov2.querySelector('h3').textContent) && ov2.querySelectorAll('.notif-item').length === 3, 'o sino normal continua com tudo');
  }

  console.log('Aviso de devedores');
  {
    const w = base();
    w.eval(`
      var user = { id: 'g1' }; var LIMITE_DEVEDOR = 500; var MESES_LONGO = MESES;
      var _histEq = { dados: {} };
      var _comSentido = () => '';
      var Gestor = { brlInteiro: v => brl(v) };
      var repassesEquipe = ${JSON.stringify([pedidoAberto, pedidoAberto2, pedidoPago])};
      var _equipeDevedora = () => [
        { id: 'u2', nome: 'José', valor: 1250, rda: 0, cv: false },
        { id: 'u1', nome: 'Romário', valor: 900, rda: 200, cv: false },
        { id: 'u3', nome: 'Ana', valor: 700, rda: 0, cv: false },
      ];
    `);
    w.eval(trecho('function _avisoEquipeDevedoraHTML() {', '\nfunction ') );
    const div = w.document.createElement('div');
    div.innerHTML = w._avisoEquipeDevedoraHTML();
    const linha = nome => [...div.querySelectorAll('.res-eq-linha')].find(l => l.textContent.includes(nome));
    const btns = l => [...l.querySelectorAll('button')].map(b => limpa(b.textContent));
    const jose = btns(linha('José')), rom = btns(linha('Romário')), ana = btns(linha('Ana'));
    confere(jose[0] === '✔ Pagar o pedido de R$ 300,00 (RDM)' && !jose.some(t => t.includes('💵 Repasse RDM')), `José tem pedido RDM aberto: ${jose.join(' | ')}`);
    confere(rom[0] === '💵 Repasse RDM' && rom[1] === '✔ Pagar o pedido de R$ 80,00 (RDA)', `Romário: RDM livre, RDA com pedido: ${rom.join(' | ')}`);
    confere(ana[0] === '💵 Repasse RDM', `Ana sem pedido segue com o botão de repasse: ${ana.join(' | ')}`);
    confere(/abrirModalAtenderPedido\(this\.dataset\.pedido\)/.test(linha('José').querySelector('.res-eq-pagar').getAttribute('onclick')), 'o botão abre a janela de pagar o pedido');
  }

  console.log('Recusar com motivo (Lote 3, 18/11/2026)');
  {
    const w = base();
    w.eval(`
      var equipePorId = { u2: { nome: 'José' } };
      var _ehGestorOuAdmin = () => true; var toast = () => {};
      var _repasseDaEquipe = id => (${JSON.stringify(pedidoAberto)});
      var _recarregarEquipe = async () => {}; var atualizarNotificacoes = async () => {}; var abrirNotificacoes = () => {};
      var _sinoFiltro = null;
      var _janela = null;
      var pedirCampos = async o => { _janela = o; return { motivo: 'Pedido em dobro' }; };
      var _chamadas = [];
      var sb = { repasses: { recusar: async (id, motivo) => { _chamadas.push(['recusar', id, motivo]); }, upsert: async r => { _chamadas.push(['upsert', r.id]); } } };
    `);
    Object.defineProperty(w.navigator, 'onLine', { value: true, configurable: true });
    w.eval(trecho('async function _recusarPedido(id, btn) {', '\nfunction dispensarNotificacao'));
    await w._recusarPedido(pedidoAberto.id, null);
    const ch = w.eval('_chamadas'), jan = w.eval('_janela');
    confere(ch.length === 1 && ch[0][0] === 'recusar' && ch[0][1] === pedidoAberto.id && ch[0][2] === 'Pedido em dobro', `chama /recusar com o motivo: ${JSON.stringify(ch)}`);
    confere(/José/.test(jan.titulo) && jan.campos[0].sugestoes.includes('Já foi pago'), `janela pergunta o motivo com sugestões: "${jan.titulo}"`);
    w.eval('pedirCampos = async () => null; _chamadas = [];');
    await w._recusarPedido(pedidoAberto.id, null);
    confere(w.eval('_chamadas').length === 0, 'cancelar a janela não recusa nada');
  }

  console.log('Sino do colaborador: pedido recusado (18/11/2026)');
  {
    const w = base();
    const agora = new Date().toISOString();
    const recusado = { ...pedidoAberto, user_id: 'u2', deleted: true, recusado_em: agora, recusado_por: 'g1', recusado_por_nome: 'Cleiton', motivo_recusa: 'Pedido em dobro' };
    const semMotivo = { ...pedidoAberto2, id: 'p9', user_id: 'u2', deleted: true, recusado_em: agora, recusado_por: 'g1' };
    const antigo = { ...pedidoAberto2, id: 'p8', user_id: 'u2', deleted: true, recusado_em: '2026-09-01T10:00:00Z', motivo_recusa: 'velho' };
    const deOutro = { ...pedidoAberto2, id: 'p7', user_id: 'u1', deleted: true, recusado_em: agora };
    const apagadoComum = { ...pedidoAberto2, id: 'p6', user_id: 'u2', deleted: true };
    w.eval(`
      var user = { id: 'u2', nome: 'José' }; var DEMO_MODE = false;
      var _ehGestorOuAdmin = () => false; var _veEquipe = () => false; var _ehContabilidade = () => false;
      var K_NOTIF_VISTOS = 'vistos'; var repasses = []; var repassesEquipe = []; var notas = []; var notasEquipe = [];
      var justificativasSino = []; var avisosCorrecaoSino = [];
      var FusoBR = { hora: () => '10:15', hojeISO: d => '2026-11-18', data: () => '18/11' };
      var DB = { getRepassesUser: async (id, inc) => inc ? ${JSON.stringify([recusado, semMotivo, antigo, deOutro, apagadoComum])} : [] };
      var _buscarJustificativas = async () => false; var _buscarAvisosCorrecao = async () => false;
      var _usaCartao = () => false; var _abriuForm = null; var abrirFormRepasse = (...a) => { _abriuForm = a; };
      var _pintarSinoPush = () => {}; var _pintarSinoEquipe = () => {};
    `);
    const memoria = {};   // about:blank do jsdom não tem localStorage
    Object.defineProperty(w, 'localStorage', { configurable: true, value: { getItem: k => memoria[k] ?? null, setItem: (k, v) => { memoria[k] = String(v); }, removeItem: k => { delete memoria[k]; } } });
    const pedaco = (de, ate) => trecho(de, ate);
    w.eval(pedaco('let repassesRecusados = [];', '\nlet repassesEquipe'));
    w.eval(pedaco('function _notifVistos()', '\nfunction _repassePendente'));
    w.eval(pedaco('function _notificacoes() {', '\nfunction fmtDataBR'));
    w.eval(pedaco('function _quandoJust(iso) {', '\nfunction _resumirTexto'));
    w.eval(pedaco('async function _pintarSino() {', '\n/* esperarJust'));
    w.eval(pedaco('async function atualizarNotificacoes(', '\n/* filtro ='));
    w.eval(pedaco('let _sinoFiltro = null;', '/* ═══'));
    w.eval(pedaco('function dispensarNotificacao(id)', '\nfunction dispensarTodasNotificacoes'));
    await w.atualizarNotificacoes();
    const itens = w._notificacoes().filter(i => i.tipo === 'recusado');
    confere(itens.length === 2, `só as recusas recentes do próprio colaborador: ${itens.map(i => i.id).join(', ')}`);
    const it = itens.find(i => i.id === 'recusa:p2');
    confere(it && it.titulo === 'Seu pedido de R$ 300,00 (RDM) foi recusado', `título: "${it && it.titulo}"`);
    confere(it && /16\/11\/2026 · Combustível · recusado por Cleiton hoje 10:15/.test(it.sub), `quem e quando: "${it && it.sub}"`);
    const s9 = itens.find(i => i.id === 'recusa:p9');
    confere(s9 && /recusado pela gestão/.test(s9.sub) && s9.motivo === '', 'sem nome nem motivo: "pela gestão"');
    w.abrirNotificacoes();
    const ov = w.document.getElementById('notif-overlay');
    const card = ov.querySelector('.notif-item.recusado');
    confere(!!card && /Motivo: “Pedido em dobro”/.test(card.textContent) && /🚫/.test(card.textContent), 'cartão vermelho com o motivo');
    const bts = [...card.querySelectorAll('button')].map(b => limpa(b.textContent));
    confere(bts.join(' | ') === '💸 Pedir de novo | OK, vi', `botões: ${bts.join(' | ')}`);
    const clicar = b => w.eval(`(function(){ ${b.getAttribute('onclick')} })`).call(b);   // onclick inline não roda no jsdom outside-only
    clicar(card.querySelector('button'));
    confere(w.eval('_abriuForm') && w.eval('_abriuForm[0]') === 'requested' && !w.document.getElementById('notif-overlay'), 'Pedir de novo abre o pedido de repasse');
    w.abrirNotificacoes();
    const ok = [...w.document.querySelectorAll('#notif-overlay .notif-item.recusado button')].find(b => /OK, vi/.test(b.textContent));
    clicar(ok);
    await new Promise(r => setTimeout(r, 10));
    const restam = w._notificacoes().filter(i => i.tipo === 'recusado').map(i => i.id);
    confere(restam.length === 1 && restam[0] === 'recusa:p9', `OK, vi tira só aquele aviso: ${restam.join(', ')}`);
  }

  console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo ok');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
