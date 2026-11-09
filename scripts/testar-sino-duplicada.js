#!/usr/bin/env node
// Teste do aviso de nota duplicada no sino da gestão e do link do push (08/11/2026). Sem navegador e sem servidor:
//   node scripts/testar-sino-duplicada.js
// Roda as funções tiradas do próprio app.js, com jsdom. Sai com código 1 se algum caso falhar.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));

const app = fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'app.js'), 'utf8');
const trecho = (de, ate) => { const i = app.indexOf(de); const f = app.indexOf(ate, i); if (i < 0 || f < 0) throw new Error('trecho: ' + de); return app.slice(i, f); };
const var_ = t => t.replace(/^(const|let) /gm, 'var ');
const notificacoes = var_(trecho('function _notificacoes() {', 'function fmtDataBR(d)'));
const regras = var_(trecho('function _mesmoFornecedor(a, b) {', '/* ── Duplicata contra a EQUIPE inteira'));
const mapa = var_(trecho('function _mapaDuplicatas(lista) {', 'function _resumoNota(n)'));
const link = var_(trecho('function _abrirSinoPelaUrl(urlDoAviso) {', "if ('serviceWorker' in navigator)"));

let falhas = 0;
const confere = (ok, msg) => { console.log((ok ? '  ok  ' : '  FALHOU  ') + msg); if (!ok) falhas++; };

const dom = new JSDOM('<div></div>', { runScripts: 'dangerously', url: 'http://localhost/rda-rdm-app/' });
const w = dom.window;
w.eval(`
  var user = null, notas = [], notasEquipe = [], vistosSet = new Set(), abertas = [], sinoAberto = 0;
  var justificativasSino = [], avisosCorrecaoSino = [], repassesEquipe = [], repasses = [], equipePorId = {};
  var _notifVistos = () => vistosSet;
  var _ehGestorOuAdmin = () => ['gestor','admin'].includes(user && user.role);
  var _ehContabilidade = () => user && user.role === 'contabilidade';
  var _veEquipe = () => _ehGestorOuAdmin();
  var _fotoMarcadaEmBranco = () => false, _equipeCartaoBaixo = () => [], _equipeDevedora = () => [];
  var _repassePendente = () => false, _repasseEhPedido = () => false;
  var _rotuloProprietario = n => n.user_id ? 'Alguém' : 'Faturamento';
  var _digitos = s => String(s || '').replace(/\\D/g, '');
  var _notaPorId = id => notas.find(x => x.id === id) || notasEquipe.find(x => x.id === id) || null;
  var BrasilAPI = { formatar: x => x };
  var brl = v => 'R$ ' + Number(v).toFixed(2).replace('.', ',');
  var fmtDataBR = d => d;
  var editarNota = id => abertas.push(id), abrirNotificacoes = () => sinoAberto++, switchView = () => {};
`);
w.eval(regras);
w.eval(mapa);
w.eval(notificacoes);
w.eval(link);

const agora = Date.now();
const iso = diasAtras => new Date(agora - diasAtras * 86400_000).toISOString();
const nota = (id, extra = {}) => ({
  id, user_id: 'ana', created_by: 'ana', user_nome: 'Ana', tipo: 'RDA', valor: 87.5, data: '2026-11-07',
  cnpj: '11222333000181', razao_social: 'POSTO SANTA FE', numero: '4521', serie: '1', deleted: false, created_at: iso(2), ...extra,
});
const entra = role => w.eval(`user = { id: 'gestor1', role: '${role}' }`);
const poe = (equipe, minhas = []) => { w.notasEquipe = equipe; w.notas = minhas; };
const dups = () => w.eval('_notificacoes()').filter(i => i.tipo === 'duplicada');

/* ── sino ───────────────────────────────────────────────── */
entra('gestor');
poe([nota('a'), nota('b', { user_id: 'joao', created_by: 'joao', user_nome: 'João', created_at: iso(1) })]);
let d = dups();
confere(d.length === 1, 'par duplicado da equipe vira UM aviso no sino');
confere(d[0] && d[0].notaId === 'b' && d[0].outraId === 'a', 'o aviso é da nota mais nova, apontando a que já existia');
confere(d[0] && /João lançou uma nota que já existe/.test(d[0].titulo), 'título diz quem lançou');
confere(d[0] && /mesmo número de nota e fornecedor; já lançada por Ana/.test(d[0].sub), 'detalhe traz o motivo e quem lançou antes');

w.eval("vistosSet = new Set(['dup:b'])");
confere(dups().length === 0, '"OK, vi" some com o aviso');
w.eval('vistosSet = new Set()');

poe([nota('a'), nota('b', { created_by: 'gestor1', created_at: iso(1) })]);
confere(dups().length === 0, 'a duplicata que o próprio gestor lançou não aparece para ele');

poe([nota('a', { created_at: iso(60) }), nota('b', { user_id: 'joao', created_by: 'joao', created_at: iso(40) })]);
confere(dups().length === 0, 'duplicata lançada há mais de 30 dias não entra no sino');

poe([nota('a'), nota('b', { user_id: 'joao', created_by: 'joao', numero: '9999', valor: 40, created_at: iso(1) })]);
confere(dups().length === 0, 'notas diferentes não avisam');

/* 09/11/2026: Casa das Balanças nº 31703 e 31704, R$ 70 no mesmo dia, uma com a chave cortada na foto */
const balanca = { tipo: 'RDM', subtipo: 'Outros', valor: 70, cnpj: '25654468000120', razao_social: 'CANUTO E CIA LTDA', serie: '002' };
poe([nota('a', { ...balanca, numero: '0000031703', chave_nfce: '31261125654468000120550020000317031547533851' }),
     nota('b', { ...balanca, user_id: 'joao', created_by: 'joao', numero: '31704', chave_nfce: '31261125654468000120550020000317041658', created_at: iso(1) })]);
confere(dups().length === 0, 'número diferente separa fora do pedágio, mesmo com a chave cortada');
poe([nota('a', { ...balanca, numero: '0000031703', chave_nfce: '31261125654468000120550020000317031547533851' }),
     nota('b', { ...balanca, user_id: 'joao', created_by: 'joao', numero: '', chave_nfce: '31261125654468000120550020000317041658', created_at: iso(1) })]);
confere(dups().length === 0, 'sem número gravado, o número sai de dentro da chave cortada');
poe([nota('a', { ...balanca, numero: '' }), nota('b', { ...balanca, user_id: 'joao', created_by: 'joao', numero: '', created_at: iso(1) })]);
confere(dups().length === 1, 'sem número nenhum, mesmo fornecedor, dia e valor ainda avisa');

poe([nota('a', { deleted: true }), nota('b', { user_id: 'joao', created_by: 'joao', created_at: iso(1) })]);
confere(dups().length === 0, 'nota na lixeira não conta');

poe([nota('a', { user_id: null, created_by: 'gestor1', user_nome: null, pagamento: 'empresa' }), nota('b', { user_id: 'joao', created_by: 'joao', user_nome: 'João', created_at: iso(1) })]);
d = dups();
confere(d.length === 1 && /já lançada por Faturamento/.test(d[0].sub), 'duplicata de nota do Faturamento aparece');

entra('colaborador');
poe([], [nota('a'), nota('b', { created_at: iso(1) })]);
confere(dups().length === 0, 'colaborador comum não recebe o aviso no sino');

/* ── link do push ───────────────────────────────────────── */
entra('gestor');
poe([nota('a'), nota('b', { user_id: 'joao', created_at: iso(1) })]);
w.eval("abertas = []; sinoAberto = 0; _abrirSinoPelaUrl('./?abrir=nota&id=b')");
confere(w.abertas.length === 1 && w.abertas[0] === 'b' && w.sinoAberto === 0, 'tocar no push abre a nota direto');

w.eval("abertas = []; sinoAberto = 0; _abrirSinoPelaUrl('./?abrir=nota&id=nao-chegou')");
confere(w.abertas.length === 0 && w.sinoAberto === 1, 'nota que ainda não chegou ao aparelho: abre o sino');

entra('colaborador');
w.eval("abertas = []; sinoAberto = 0; _abrirSinoPelaUrl('./?abrir=nota&id=b')");
confere(w.abertas.length === 0, 'colaborador comum não abre nota de outro pelo link');

entra('gestor');
w.history.replaceState(null, '', '/rda-rdm-app/?abrir=nota&id=b');
w.eval('abertas = []; _abrirSinoPelaUrl()');
confere(w.abertas[0] === 'b' && w.location.search === '', 'app aberto pelo link: abre a nota e limpa o endereço');

console.log(falhas ? `\n${falhas} caso(s) falharam` : '\nTudo certo');
process.exit(falhas ? 1 : 0);
