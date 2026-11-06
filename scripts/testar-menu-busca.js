#!/usr/bin/env node
// Teste do menu por grupos e da busca geral (06/11/2026). Sem navegador e sem servidor:
//   node scripts/testar-menu-busca.js
// Roda o busca.js de verdade e as funções do menu tiradas do app.js. Sai com código 1 se algum caso falhar.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));

const JS = path.join(__dirname, '..', 'rda-rdm-app', 'js');
const app = fs.readFileSync(path.join(JS, 'app.js'), 'utf8');
const trecho = (de, ate) => { const i = app.indexOf(de); const f = app.indexOf(ate, i); if (i < 0 || f < 0) throw new Error('trecho: ' + de); return app.slice(i, f); };
const categorias = trecho('const CATEGORIAS_CV = [', '/* ─── Resumo de gastos e saldo devedor').replace(/^const /gm, 'var ');
const menu = trecho('function _itensMenu() {', 'function fecharMenu()').replace(/^const /gm, 'var ');

let falhas = 0;
const confere = (ok, msg) => { console.log((ok ? '  ok  ' : '  FALHOU  ') + msg); if (!ok) falhas++; };

const html = `<div id="menu-drawer-overlay"></div><span id="menu-busca-txt"></span><ul id="menu-lista"></ul><main id="app-content"></main>`;
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/' });
const w = dom.window;
w.eval(`
  var user = null, sb = null, MODULOS_EXTRAS = true, PAPEL_NOME = {}, feito = [], pendentes = [], avisos = [];
  var $ = id => document.getElementById(id);
  var esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  var _at = esc;
  var brl = v => 'R$ ' + Number(v).toFixed(2);
  var fmtDataBR = d => d;
  var _ehGestorOuAdmin = () => ['gestor','admin'].includes(user.role);
  var _ehContabilidade = () => user.role === 'contabilidade';
  var _veEquipe = () => _ehGestorOuAdmin() || _ehContabilidade();
  var _veFrota = () => !_ehContabilidade();
  var _usaCartao = () => false, _ehCV = () => false;
  var _notasComPendencia = () => pendentes;
  var _notificacoes = () => avisos;
  var fecharMenu = () => document.getElementById('menu-drawer-overlay').classList.remove('open');
  var garantirNotasNaLista = l => feito.push('garantir:' + l[0].id);
  var editarNota = id => feito.push('nota:' + id);
  var verCartaoDoColaborador = id => feito.push('ficha:' + id);
  var switchView = v => feito.push('tela:' + v);
  var irParaNotas = () => feito.push('tela:notas');
  var abrirAjuda = () => feito.push('ajuda');
  var _armarNav = () => {};
  window.Fechamento = { aguardando: async () => window.nFech || [] };
`);
w.eval(categorias);
w.eval(menu);
w.eval(fs.readFileSync(path.join(JS, 'busca.js'), 'utf8'));
const B = w.Busca;
const entra = papel => w.eval(`user = { id: 'u1', nome: 'Quem', role: '${papel}' }`);
const textoMenu = () => w.document.getElementById('menu-lista').textContent.replace(/\s+/g, ' ');
const corpo = () => w.document.getElementById('bsg-corpo');
const espera = ms => new Promise(r => setTimeout(r, ms));
const feito = () => w.eval('feito.splice(0)');

(async () => {
  console.log('Menu por papel');
  entra('admin');
  w.eval(`avisos = [{ tipo: 'pedido' }, { tipo: 'pedido' }, { tipo: 'novo' }]; pendentes = [{ nota: {}, motivos: ['sem anexo'] }]`);
  w.abrirMenu();
  let t = textoMenu();
  for (const g of ['Precisa de você', 'Meu dia a dia', 'Gestão da equipe', 'Controle']) confere(t.includes(g), `admin vê ${g}`);
  confere(/2pedidos de repasse/.test(t) && /1nota para corrigir/.test(t) && /1cadastro para liberar/.test(t), `pendências com número (${t.slice(0, 90)})`);
  confere(t.indexOf('Controle') < t.indexOf('Apagados'), 'Apagados fica em Controle');
  confere(!t.includes('Perfil'), 'Perfil saiu da lista (fica fixo embaixo)');
  confere(w.document.querySelector('.menu-item-num')?.textContent === '2', 'número em Repasses e recargas');
  const telasAdmin = w._itensMenu().map(i => i.lbl);
  for (const x of ['Início', 'Painel', 'Minhas notas', 'Apagados', 'RDM/RDA e Planilhas', 'Equipe', 'Arquivos', 'Repasses e recargas', 'Histórico', 'Rastreio da equipe', 'Frota / KM', 'Ponto', 'Perfil']) confere(telasAdmin.includes(x), `nenhuma tela perdida: ${x}`);
  w.nFech = [{}, {}];
  w.abrirMenu();
  await espera(20);
  confere(/2notas no fechamento/.test(textoMenu()), 'fechamento entra depois, sem segurar o menu');
  confere(w.document.querySelectorAll('.menu-pend').length === 1, 'um quadro só, mesmo abrindo o menu de novo');
  w.nFech = [];

  entra('colaborador');
  w.eval(`avisos = [{ tipo: 'justificativa' }]; pendentes = []`);
  w.abrirMenu();
  t = textoMenu();
  confere(!t.includes('Gestão da equipe') && !t.includes('Controle') && !t.includes('Repasses e recargas'), 'colaborador sem gestão');
  confere(t.includes('Apagados') && /1justificativa pedida/.test(t), 'colaborador com Apagados e a justificativa');
  entra('contabilidade');
  w.eval(`avisos = []; pendentes = []`);
  w.abrirMenu();
  t = textoMenu();
  confere(!t.includes('Precisa de você') && t.includes('Equipe') && t.includes('Arquivos') && !t.includes('Painel') && !t.includes('Frota'), `Contador só com o que usa (${t})`);

  console.log('Busca');
  entra('gestor');
  let chamadas = [], resposta = { notas: [], repasses: [], pessoas: [], total_notas: 0, total_repasses: 0 };
  w.busca = { geral: async q => { chamadas.push(q); return resposta; } };
  w.eval('sb = { busca: window.busca }');
  B.abrir();
  confere(/Atalhos/.test(corpo().textContent) && /Faturamento do mês/.test(corpo().textContent), 'abre com os atalhos');

  resposta = {
    notas: [{ id: 'n1', user_id: 'b', user_nome: '<b>Bia</b>', tipo: 'RDM', subtipo: 'Pedágio', valor: 12, data: '2026-10-01', razao_social: `A"'><img src=x onerror=alert(1)>` }],
    total_notas: 40, repasses: [{ id: 'r1', user_id: 'b', user_nome: 'Bia', tipo: 'RDM', valor: 100, kind: 'received', data: '2026-10-02' }], total_repasses: 1,
    pessoas: [{ id: 'b', nome: 'Bia', regime: 'cv', ativo: true }],
  };
  B.digitar('p');
  await espera(350);
  confere(chamadas.length === 0, 'uma letra não vai ao servidor');
  B.digitar('rep'); B.digitar('repa'); B.digitar('repasses');
  await espera(350);
  confere(chamadas.length === 1 && chamadas[0].q === 'repasses', `espera parar de digitar (${JSON.stringify(chamadas)})`);
  const c = corpo();
  confere(/Repasses e recargas/.test(c.textContent), 'acha a tela, sem acento na comparação');
  confere(/Pedágio/.test(c.textContent) && /1 de 40/.test(c.textContent), 'mostra categoria e o corte do total');
  confere(!c.querySelector('img') && !c.querySelector('b b'), 'texto da nota não vira HTML');
  [...c.querySelectorAll('.chip')].find(b => b.textContent.startsWith('Notas')).click();
  confere(!/Repasse RDM/.test(corpo().textContent) && /Pedágio/.test(corpo().textContent), 'filtro Notas');
  B.filtrar('tudo');
  [...corpo().querySelectorAll('.bsg-l')].find(b => /Pedágio/.test(b.textContent)).click();
  confere(feito().join() === 'garantir:n1,nota:n1' && !w.document.getElementById('busca-overlay'), 'toque na nota fecha a busca e abre a nota');

  B.abrir();
  confere(/repasses/.test(corpo().textContent), 'busca recente guardada');
  B.digitar('repasses');
  await espera(350);
  [...corpo().querySelectorAll('.bsg-l')].find(b => /abrir ficha/.test(b.textContent)).click();
  confere(feito().join() === 'ficha:b', 'toque na pessoa abre a ficha');

  B.abrir();
  B.digitar('xx1');
  let velho;
  w.busca.geral = q => new Promise(ok => { velho = () => ok({ ...resposta, notas: [], repasses: [], pessoas: [], total_notas: 0, total_repasses: 0 }); });
  await espera(350);
  B.digitar('painel');
  w.busca.geral = async () => ({ ...resposta, notas: [], repasses: [], pessoas: [], total_notas: 0, total_repasses: 0 });
  await espera(350);
  velho?.();
  await espera(10);
  confere(/Painel/.test(corpo().textContent), 'resposta atrasada não pinta por cima');
  B.digitar('zzzz');
  await espera(350);
  confere(/Nada encontrado/.test(corpo().textContent) && /Como usar/.test(corpo().textContent), 'sem resultado oferece o Como usar');

  w.busca.geral = async () => { throw new Error('fora'); };
  w.eval('sb = { busca: { geral: window.busca.geral } }');
  B.digitar('painel');
  await espera(350);
  confere(/Painel/.test(corpo().textContent) && /Não deu para buscar/.test(corpo().textContent), 'servidor fora: as telas continuam e avisa');

  w.eval(`pendentes = [{ nota: { id: 'd1', razao_social: 'Dup', user_id: 'b', tipo: 'RDA', valor: 5 }, motivos: ['possível duplicata'] }, { nota: { id: 'd2', tipo: 'RDA' }, motivos: ['sem valor'] }]`);
  B.atalho('duplicata');
  confere(/Dup/.test(corpo().textContent) && corpo().querySelectorAll('.bsg-l').length === 1, 'atalho de duplicata usa a lista do app');
  B.limpar();
  confere(/Atalhos/.test(corpo().textContent), 'limpar volta ao início');
  B.fechar();

  entra('colaborador');
  B.abrir();
  confere(!/Faturamento do mês/.test(corpo().textContent) && !w.document.getElementById('bsg-inp').placeholder.includes('pessoa'), 'colaborador sem atalho de Faturamento nem busca de pessoa');
  B.fechar();
  entra('contabilidade');
  B.abrir();
  confere(!/Pedidos abertos/.test(corpo().textContent) && !/duplicata/.test(corpo().textContent), 'Contador sem atalhos que não usa');
  B.fechar();

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
