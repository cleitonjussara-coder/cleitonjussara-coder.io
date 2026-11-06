#!/usr/bin/env node
// Teste da regra de 04/11/2026: "valores acumulativo de um ano, acumula para o ano posterior, com especificação de
// saldo de ano anterior". Sem navegador e sem servidor:
//   node scripts/testar-saldo-ano-anterior.js
// Roda o gestor.js de verdade (Gestor.saldoAnoAnterior e a ficha da Equipe, com jsdom) e as funções do app.js
// (_cartaoPorTipo, _saldosCvDoAno, _saldoCartaoDe) tiradas do próprio arquivo. Sai com código 1 se algum caso falhar.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// JSDOM_DIR aponta para uma instalação do jsdom fora do OneDrive (arquivos "só na nuvem" dão erro de leitura em node_modules).
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));

const JS = path.join(__dirname, '..', 'rda-rdm-app', 'js');
const fonteGestor = fs.readFileSync(path.join(JS, 'gestor.js'), 'utf8');
const fonteApp = fs.readFileSync(path.join(JS, 'app.js'), 'utf8');
const _iniCat = fonteApp.indexOf('const CATEGORIAS_CV = [');
const fonteCategorias = fonteApp.slice(_iniCat, fonteApp.indexOf('/* ─── Resumo de gastos e saldo devedor')).replace(/^const /gm, 'var ');   // a ficha usa as categorias do app.js

let falhas = 0;
const confere = (ok, msg) => { console.log((ok ? '  ok  ' : '  FALHOU  ') + msg); if (!ok) falhas++; };
const igual = (a, b, msg) => confere(Math.abs(a - b) < 0.005, `${msg} (deu ${a}, esperado ${b})`);

/* ── dados: cada linha é um lançamento; data manda em mes/ano ── */
let seq = 0;
const nota = (data, valor, tipo, pagamento, extra = {}) => ({ id: 'n' + (++seq), user_id: 'u1', data, valor, tipo, pagamento, ano: +data.slice(0, 4), mes: +data.slice(5, 7), razao_social: 'Posto', ...extra });
const rep = (data, valor, tipo, destino = null, extra = {}) => ({ id: 'r' + (++seq), user_id: 'u1', data, valor, tipo, destino, kind: 'received', ano: +data.slice(0, 4), mes: +data.slice(5, 7), ...extra });

// três anos: 2024 e 2025 entram no anterior de 2026; 2025 sozinho não basta
const notas3 = [
  nota('2024-05-10', 100, 'RDM', 'cartao'),
  nota('2024-06-10', 40, 'RDM', 'carteira'),
  nota('2025-02-10', 200, 'RDA', null),                    // nota antiga sem pagamento conta como cartão
  nota('2025-03-10', 60, 'RDA', 'carteira'),
  nota('2025-04-10', 999, 'RDM', 'empresa'),               // Faturamento: fora de tudo
  nota('2025-04-11', 888, 'RDM', 'cartao', { deleted: true }),   // apagada: fora de tudo
  nota('2026-01-10', 300, 'RDM', 'cartao'),
  nota('2026-02-10', 70, 'RDM', 'carteira'),
  nota('2026-02-11', 30, 'RDA', 'carteira'),
  nota('2026-03-10', 500, 'RDA', 'empresa'),
];
const reps3 = [
  rep('2024-05-01', 1000, 'RDM', 'recarga'),
  rep('2024-06-01', 25, 'RDM'),
  rep('2025-02-01', 500, 'RDA', 'recarga'),
  rep('2025-03-01', 15, 'RDA'),
  rep('2025-03-02', 777, 'RDM', null, { kind: 'requested' }),        // pedido pendente: não é dinheiro
  rep('2025-03-03', 666, 'RDM', 'recarga', { kind: 'requested' }),   // pedido de recarga: idem
  rep('2025-03-04', 555, 'RDM', null, { deleted: true }),            // apagado: fora
  rep('2026-01-01', 400, 'RDA', 'recarga'),
  rep('2026-02-01', 50, 'RDM', null, { kind: null }),                // kind vazio é recebido
  rep('2026-02-02', 20, 'RDA'),
];

/* ── Gestor de verdade, com stubs só do que o arquivo pede ao carregar ── */
function montarGestor() {
  const dom = new JSDOM('<main id="app-content"></main>', { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(`
    var MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    var MESES_LONGO = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    var esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    var _at = esc;
    var brl = v => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
    var ini = () => 'X';
    var toast = () => {};
    var setLoading = () => {};
    var FusoBR = { partes: () => ({ ano: 2026, mes: 11, dia: 4 }), hojeISO: () => '2026-11-04' };
  `);
  w.eval(fonteCategorias);
  w.eval(fonteGestor + ';window.Gestor = Gestor;');
  return w;
}

/* ── funções do app.js, recortadas do arquivo ── */
function funcaoDoApp(nome) {
  const i = fonteApp.indexOf(`function ${nome}(`);
  if (i < 0) throw new Error('não achei ' + nome);
  let d = 0, ini = fonteApp.indexOf('{', fonteApp.indexOf(')', i));
  for (let p = ini; p < fonteApp.length; p++) {
    if (fonteApp[p] === '{') d++;
    else if (fonteApp[p] === '}' && --d === 0) return fonteApp.slice(i, p + 1);
  }
  throw new Error('fim de ' + nome);
}
function montarApp(Gestor) {
  const ctx = { Gestor, _n: v => Number(v) || 0 };
  vm.createContext(ctx);
  ctx.brl = v => (v < 0 ? '-' : '') + 'R$ ' + Math.abs(Number(v) || 0).toFixed(2).replace('.', ',');
  ctx.notas = []; ctx.repasses = [];   // _saldoAcumuladoAte lê as globais do app
  ctx._soma = arr => arr.reduce((a, x) => a + (Number(x.valor) || 0), 0);
  ctx.LIMITE_DEVEDOR = 1500; ctx.CARTAO_SALDO_MINIMO = 300; ctx.K_DEVEDORA = 'k';
  ctx.FusoBR = { partes: () => ({ ano: 2026, mes: 11, dia: 4 }) };
  vm.runInContext(['_repasseEhPedido', '_repasseEhRecebido', '_repasseEhCarteira', '_notaDoCartao', '_naoEhFaturamento', '_saldoCartaoDe', '_saldosCvDoAno', '_cartaoPorTipo', '_devedorDe',
    '_gastoBolsoPorTipo', '_equipeDevedora', '_equipeCartaoBaixo', '_saldoAcumuladoAte', '_parcelasAnteriores', '_comSentido', '_kpiAnteriorHTML', '_heroAnteriorHTML',
    '_heroSaldoCvHTML', '_valorInteiroHTML', '_heroAnteriorCvHTML', '_kpiReembCvHTML', '_cardReembCvHTML'].map(funcaoDoApp).join('\n'), ctx);
  return ctx;
}

/* ── excel.js de verdade, com o XLSX só no que buildEquipe usa ── */
function montarExcel() {
  const col = c => String.fromCharCode(65 + c);
  const ctx = { console, FusoBR: { data: () => '04/11/2026', hojeISO: () => '2026-11-04', partes: () => ({ ano: 2026, mes: 11, dia: 4 }) } };
  ctx.XLSX = { utils: { encode_cell: ({ r, c }) => col(c) + (r + 1), encode_range: ({ s, e }) => col(s.c) + (s.r + 1) + ':' + col(e.c) + (e.r + 1), decode_range: x => x } };
  /* 04/11/2026: para rodar exportarEquipe de verdade; a folha fica em ultimaFolha em vez de virar arquivo */
  ctx.XLSX.utils.book_new = () => ({});
  ctx.XLSX.utils.book_append_sheet = (_, ws) => { ctx.ultimaFolha = ws; };
  ctx.XLSX.writeFile = () => {};
  ctx.window = ctx; ctx.document = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(JS, 'excel.js'), 'utf8'), ctx);
  return Object.assign(Object.create(ctx.Excel), { folhaGerada: () => ctx.ultimaFolha });
}

const w = montarGestor();
const G = w.Gestor;
const app = montarApp(G);

console.log('Conta do ano anterior, 3 anos');
{
  const a = G.saldoAnoAnterior(notas3, reps3, 2026);
  igual(a.cartao, (1000 + 500) - (100 + 200), 'cartão soma 2024 e 2025, não só o último ano');
  igual(a.reemb, (25 + 15) - (40 + 60), 'CV reembolso soma todos os anos anteriores');
  igual(a.reembRDM, 25 - 40, 'CV reembolso RDM');
  igual(a.reembRDA, 15 - 60, 'CV reembolso RDA');
  igual(a.RDM, 25 - (100 + 40), 'RDM: recebido − gasto, sem recarga, sem Faturamento, sem apagado, sem pedido');
  igual(a.RDA, 15 - (200 + 60), 'RDA idem');
}

console.log('Conta do ano anterior, 2 anos e bordas');
{
  const a = G.saldoAnoAnterior(notas3, reps3, 2025);
  igual(a.cartao, 1000 - 100, 'em 2025 o anterior é só 2024');
  igual(a.RDM, 25 - 140, 'RDM de 2024');
  const b = G.saldoAnoAnterior(notas3, reps3, 2024);
  confere(Object.values(b).every(v => v === 0), 'sem ano anterior tudo é zero, nunca NaN');
  const c = G.saldoAnoAnterior(null, undefined, 2026);
  confere(c.cartao === 0 && c.RDM === 0, 'lista vazia não quebra');
  const d = G.saldoAnoAnterior([nota('2025-01-01', 0.1, 'RDM', 'cartao'), nota('2025-01-02', 0.2, 'RDM', 'cartao')], [rep('2025-01-01', 0.3, 'RDM', 'recarga')], 2026);
  confere(d.cartao === 0 && !Object.is(d.cartao, -0), 'resíduo de centavos não vira -0,00');
  const e = G.saldoAnoAnterior([nota('2025-12-31', 10, 'RDM', 'cartao'), nota('2026-01-01', 90, 'RDM', 'cartao')], [], 2026);
  igual(e.cartao, -10, '31/12 é do ano anterior, 01/01 não');
}

console.log('Saldo = anterior + ano, encadeando os anos');
{
  const sal = ano => app._cartaoPorTipo(notas3, reps3, 12, ano);
  igual(sal(2024).saldo, 1000 - 100, 'cartão 2024');
  igual(sal(2025).anterior, sal(2024).saldo, 'o anterior de 2025 é o saldo de 2024');
  igual(sal(2026).anterior, sal(2025).saldo, 'o anterior de 2026 é o saldo de 2025');
  igual(sal(2026).saldo, 1200 + 400 - 300, 'cartão 2026 = anterior + recargas − gasto');
  igual(sal(2026).saldo, app._saldoCartaoDe(notas3, reps3, true), 'no ano corrente bate com o saldo de hoje do Início e do sino');
  igual(sal(2026).total, 300, 'gasto segue sendo só do ano');
  igual(sal(2026).recarga, 400, 'recarga segue sendo só do ano');
  igual(sal(2026).gasto.RDM, 300, 'gasto por tipo segue só do ano');
}

console.log('Cartões C.V. da aba Saldo');
{
  const s = ano => app._saldosCvDoAno(notas3, reps3, ano);
  igual(s(2026).cartaoAnterior, 1200, 'anterior do cartão');
  igual(s(2026).cartao, 1300, 'saldo do cartão');
  igual(s(2026).cartao, app._cartaoPorTipo(notas3, reps3, 12, 2026).saldo, 'aba Saldo e aviso do gestor dão o mesmo número');
  igual(s(2025).cartao, 1200, 'olhando 2025, o saldo para em 2025 (não soma 2026)');
  // 04/11/2026: cada cartão é o reembolso do seu tipo; antes o de RDM dava +125 (carteira RDM+RDA menos só repasse RDM)
  igual(s(2026).RDM.ant, 25 - 40, 'reembolso RDM anterior: repasse RDM − carteira RDM');
  igual(s(2026).RDM.gasto, 70, 'carteira RDM do ano, sem a de RDA');
  igual(s(2026).RDM.rec, 50, 'repasse RDM do ano');
  igual(s(2026).RDM.saldo, -15 + 50 - 70, 'reembolso RDM = anterior + repasse − carteira, como a ficha');
  igual(s(2026).RDA.ant, 15 - 60, 'reembolso RDA anterior');
  igual(s(2026).RDA.saldo, -45 + 20 - 30, 'reembolso RDA: desconta repasse RDA, não só soma o recebido');
  igual(s(2026).reemb.saldo, s(2026).RDM.saldo + s(2026).RDA.saldo, 'reembolso total = RDM + RDA');
  igual(s(2026).reemb.saldo, -app._devedorDe(notas3, reps3, 12, 2026, true), 'e bate com o a receber de _devedorDe');
  igual(s(2025).RDM.saldo, G.saldoAnoAnterior(notas3, reps3, 2026).reembRDM, 'o saldo RDM de 2025 é o anterior de 2026');
  confere(s(2024).temRecarga && !app._saldosCvDoAno([], [rep('2025-01-01', 10, 'RDM')], 2026).temRecarga, 'repasse comum não conta como recarga');
  confere(!app._saldosCvDoAno([], [rep('2025-01-01', 10, 'RDM', 'recarga', { kind: 'requested' })], 2026).temRecarga, 'pedido de recarga também não');
  confere(!app._saldosCvDoAno([], [rep('2026-01-01', 10, 'RDM', 'recarga')], 2025).temRecarga, 'recarga de ano futuro não conta');
  const card = app._cardReembCvHTML('💵 Saldo de RDM Recebido', s(2026).RDM, 2026, 50).replace(/<[^>]+>/g, ' ').replace(/⁠/g, '').replace(/\s+/g, ' ');
  confere(/-R\$ 35,00/.test(card) && /Saldo do ano anterior -R\$ 15,00 \(a empresa deve\)/.test(card) && /A receber/.test(card), `aba Saldo mostra o número e o sentido (${card})`);
}

console.log('Painel do C.V.: cartão e reembolso, sem saldo acumulado somado');
{
  const semTags = h => h.replace(/<[^>]+>/g, ' ').replace(/⁠/g, '').replace(/\s+/g, ' ').trim();
  const sc = app._saldosCvDoAno(notas3, reps3, 2026);
  const hero = semTags(app._heroSaldoCvHTML(sc, 2026));
  confere(/Saldo do cartão · 2026 R\$ 1\.?300,00/.test(hero) && /Reembolso · 2026 -R\$ 90,00/.test(hero), `topo: os dois números (${hero})`);
  confere(/RDM -R\$ 35,00/.test(hero) && /RDA -R\$ 55,00/.test(hero), 'topo: reembolso aberto em RDM e RDA');
  confere(!/1\.?210,00/.test(hero), 'cartão e reembolso não viram uma soma');
  const ant = semTags(app._heroAnteriorCvHTML(sc));
  confere(/anterior do cartão R\$ 1\.?200,00 \(a favor da empresa\)/.test(ant) && /anterior do reembolso -R\$ 60,00 \(a empresa deve\)/.test(ant), `sinais diferentes dizem quem deve (${ant})`);
  const z = app._saldosCvDoAno([], [], 2026);
  const zt = semTags(app._heroAnteriorCvHTML(z));
  confere(/do cartão R\$ 0,00/.test(zt) && /do reembolso R\$ 0,00/.test(zt), 'zerado, a linha continua lá');
  const kpi = semTags(app._kpiReembCvHTML(sc.RDA, 2026));
  confere(/-R\$ 55,00/.test(kpi) && /Saldo do ano anterior -R\$ 45,00 \(a empresa deve\)/.test(kpi) && /carteira R\$ 30,00 · recebido R\$ 20,00/.test(kpi), `cartão RDA do Painel (${kpi})`);
  confere(/scPainel \? _heroSaldoCvHTML/.test(fonteApp) && /scPainel \? _kpiReembCvHTML\(scPainel\.RDM/.test(fonteApp), 'o Painel usa os quadros do C.V. quando a pessoa é C.V.');
}

console.log('Valor do C.V. inteiro numa linha (revisão de 04/11/2026: "-R$ 3.05" numa linha e "0,00" na outra)');
{
  const sc = app._saldosCvDoAno(notas3, reps3, 2026);
  const fig = (h, classe) => (h.match(new RegExp(`class="${classe}[^"]*"[^>]*>(.*?)</(?:span|div)>`)) || [])[0] || '';
  const inteiro = (h, msg) => {
    confere(/white-space:nowrap/.test(h) && !/white-space:normal/.test(h) && !/overflow-wrap:anywhere/.test(h), `${msg}: não parte entre os dígitos`);
    confere(/font-size:min\(1em,/.test(h), `${msg}: a letra encolhe para caber`);
  };
  inteiro(fig(app._kpiReembCvHTML(sc.RDM, 2026), 'db-kpi-val'), 'Painel, cartão RDM');
  inteiro(fig(app._cardReembCvHTML('x', sc.RDM, 2026, 0), 'saldo-val'), 'aba Saldo');
  const hero = app._heroSaldoCvHTML({ ...sc, cartao: -157901.21, reemb: { ...sc.reemb, saldo: -241975.11 } }, 2026);
  const vals = [...hero.matchAll(/class="db-hero-val[^"]*"[^>]*>(.*?)<\/div>/g)].map(m => m[0]);
  confere(vals.length === 2, 'topo do Painel tem os dois valores');
  vals.forEach(v => { inteiro(v, 'topo do Painel'); confere(v.includes('-⁠R$'), 'topo do Painel: o menos não fica sozinho na linha de cima'); });
  confere(/<b class="neg">-⁠R\$\s35,00<\/b>/.test(app._heroSaldoCvHTML(sc, 2026)), 'RDM do topo: o menos também gruda no valor');
  const rot = fonteApp.slice(fonteApp.indexOf('<div class="saldo-label">💳 Saldo do cartão'), fonteApp.indexOf('Recarga em ${MESES[filMes-1]}'));
  confere(/saldo-val">\$\{_valorInteiroHTML\(saldoCartao/.test(rot), 'aba Saldo: o saldo do cartão usa o mesmo valor inteiro');
}

console.log('Aviso do gestor: repasse por tipo, como o reembolso');
{
  const ctx = { Gestor: G, brl: app.brl, _at: x => x, esc: x => x, filAno: 2026, user: { id: 'g' }, LIMITE_DEVEDOR: 1500, _histEq: { dados: {} } };
  vm.createContext(ctx);
  vm.runInContext(['_comSentido', '_avisoEquipeDevedoraHTML', 'lancarRepasseDoAviso'].map(funcaoDoApp).join('\n'), ctx);
  const cartao = { total: 0, gasto: { RDM: 0, RDA: 0 }, recarga: 0, anterior: 0, saldo: 0 };
  const cv = (rdm, rda) => ({ id: 'c1', nome: 'Cv', valor: rdm, rda, total: rdm + rda, cv: true, bolso: { RDM: rdm, RDA: 0 }, cartao });
  const semTags = h => h.replace(/<[^>]+>/g, ' ').replace(/⁠/g, '').replace(/\s+/g, ' ').trim();
  let abriu = null, lista = [];
  ctx._equipeDevedora = () => lista;
  ctx.equipePorId = { c1: { id: 'c1', nome: 'Cv' } };
  ctx._ehCV = () => lista[0].cv;
  ctx.abrirFormRepasse = (modo, pre, alvo, destino) => { abriu = { pre, destino }; };

  lista = [cv(1625, 25)];
  let h = ctx._avisoEquipeDevedoraHTML();
  confere(/lancarRepasseDoAviso\(this\.dataset\.uid,'RDM'\)/.test(h) && /lancarRepasseDoAviso\(this\.dataset\.uid,'RDA'\)/.test(h) && !/lancarRepasseDoAviso\(this\.dataset\.uid,''\)/.test(h), 'C.V.: um botão de repasse para cada tipo, nenhum sem tipo');
  confere(/Repasse RDM/.test(h) && /Repasse RDA/.test(h) && /Recarga/.test(h), 'C.V.: recarga continua no aviso');
  ctx.lancarRepasseDoAviso('c1', 'RDM');
  confere(abriu.pre.tipo === 'RDM' && abriu.pre.valor === '1625.00' && abriu.destino === 'carteira', `botão RDM preenche só o RDM (${JSON.stringify(abriu)})`);
  ctx.lancarRepasseDoAviso('c1', 'RDA');
  confere(abriu.pre.tipo === 'RDA' && abriu.pre.valor === '25.00' && abriu.destino === 'carteira', 'botão RDA preenche só o RDA: pagos os dois, zera os dois');
  confere(/RDM R\$ 1625,00 · RDA R\$ 25,00 a receber/.test(semTags(h)), 'dois a receber: frase de sempre');

  lista = [cv(2000, -300)];
  h = ctx._avisoEquipeDevedoraHTML();
  const t = semTags(h);
  confere(/RDM R\$ 2000,00 \(a empresa deve\) · RDA -R\$ 300,00 \(a favor da empresa\)/.test(t), `sinais diferentes dizem quem deve (${t.slice(0, 90)})`);
  confere(!/-R\$ 300,00 a receber/.test(t), 'negativo não vira "a receber"');
  confere(!/lancarRepasseDoAviso\(this\.dataset\.uid,'RDA'\)/.test(h), 'sem RDA a receber, sem botão de RDA');
  ctx.lancarRepasseDoAviso('c1', 'RDM');
  confere(abriu.pre.valor === '2000.00', 'botão RDM sugere o RDM, não o total de 1.700');

  // regime RDM/RDA não muda
  lista = [{ id: 'c1', nome: 'Rd', valor: 1625, rda: 25, total: 1650, cv: false }];
  h = ctx._avisoEquipeDevedoraHTML();
  confere(/RDM R\$ 1625,00 · RDA R\$ 25,00 a receber/.test(semTags(h)) && /Repasse RDM/.test(h) && /Repasse RDA/.test(h) && !/Recarga/.test(h), 'RDM/RDA: mesma frase e mesmos botões');
  ctx.lancarRepasseDoAviso('c1', 'RDA');
  confere(abriu.pre.tipo === 'RDA' && abriu.pre.valor === '25.00' && abriu.destino === null, 'RDM/RDA: mesmo preenchimento');
}

console.log('Ajuda e dica do Excel falam do C.V.');
{
  const raiz = path.join(__dirname, '..');
  const copias = ['svelte-ajuda/src/ajuda-conteudo.html', 'api/resources/ajuda/ajuda-conteudo.html', 'rda-rdm-app/js/svelte-ajuda.js'].map(f => [f, fs.readFileSync(path.join(raiz, f), 'utf8')]);
  copias.forEach(([f, txt]) => {
    confere(/Em cada cartão de RDM\/RDA o saldo é sempre o acumulado/.test(txt) && !/Em cada cartão o saldo é sempre o acumulado/.test(txt), `${f}: a regra do acumulado ficou só para RDM/RDA`);
    confere(/Quem é do C\.V\. mostra <b>Cartão<\/b> e <b>Reembolso<\/b> do ano/.test(txt), `${f}: diz o que o cartão do C.V. mostra`);
  });
  confere(/quadro próprio de cartão e reembolso/.test(fonteGestor), 'dica do Excel cita o quadro do C.V.');
}

console.log('Aviso de devedor e sino');
{
  const cvUser = { id: 'u1', nome: 'Cv', regime: 'cv', role: 'colaborador' };
  const g = (ns, rs, quem = cvUser) => {
    Object.assign(app, { _ehGestorOuAdmin: () => true, _veEquipe: () => true, sb: {}, DEMO_MODE: false, navigator: { onLine: true }, user: { id: 'gestor', regime: 'rdm_rda' }, notas: [], repasses: [], equipePorId: { [quem.id]: quem },
      notasEquipe: [], repassesEquipe: [], filMes: 12, filAno: 2026, _histEq: { dados: null, buscando: false }, _histEquipeServidor: () => ({ notas: ns, repasses: rs }), _ehCV: u => u?.regime === 'cv', _usaCartao: u => u?.regime === 'cv', localStorage: { setItem() {}, getItem() { return null; } }, _devedoraUltima: [] });
    return { baixo: app._equipeCartaoBaixo(), dev: app._equipeDevedora() };
  };
  // C.V. que nunca teve recarga: só nota de carteira e nota sem pagamento gravado
  const semRecarga = [nota('2026-03-01', 100, 'RDM', 'carteira'), nota('2026-03-02', 50, 'RDM', null)];
  confere(g(semRecarga, []).baixo.length === 0, 'C.V. sem recarga nunca teve cartão: o sino não avisa');
  confere(g(semRecarga, [rep('2026-03-01', 500, 'RDA')]).baixo.length === 0, 'repasse comum não vira cartão');
  const baixo = g([nota('2026-03-01', 900, 'RDM', 'cartao')], [rep('2025-03-01', 1000, 'RDM', 'recarga')]).baixo;
  confere(baixo.length === 1, 'com recarga antiga e saldo abaixo do mínimo, o sino avisa');
  igual(baixo[0]?.saldo, 100, 'o saldo do aviso atravessa os anos');
  confere(g([nota('2026-03-01', 100, 'RDM', 'cartao')], [rep('2026-03-01', 1000, 'RDM', 'recarga')]).baixo.length === 0, 'cartão com saldo não avisa');
  confere(g([], [], { id: 'u1', nome: 'R', regime: 'rdm_rda', role: 'colaborador' }).baixo.length === 0, 'RDM/RDA não tem aviso de cartão');
  // a dívida de RDM é só RDM: R$ 1.000 + R$ 800 de carteira não passam de R$ 1.500 em RDM
  const soma2 = [nota('2026-03-01', 1000, 'RDM', 'carteira'), nota('2026-03-02', 800, 'RDA', 'carteira')];
  confere(g(soma2, []).dev.length === 0, 'C.V.: aviso de RDM não soma a carteira de RDA');
  const passa = g([nota('2026-03-01', 1600, 'RDM', 'carteira'), nota('2026-03-02', 200, 'RDA', 'carteira'), nota('2026-03-03', 9000, 'RDM', 'cartao')], [rep('2026-03-01', 100, 'RDA'), rep('2026-03-01', 9000, 'RDM', 'recarga')]).dev;
  confere(passa.length === 1 && passa[0].cv, 'C.V.: acima do limite em RDM avisa; o gasto do cartão não é dívida');
  igual(passa[0]?.valor, 1600, 'valor = reembolso RDM a receber');
  igual(passa[0]?.rda, 100, 'rda = reembolso RDA a receber, com o repasse do tipo certo');
  igual(passa[0]?.total, 1700, 'total = os dois');
  const r = { id: 'u1', nome: 'R', regime: 'rdm_rda', role: 'colaborador' };
  const rdm = g([nota('2026-03-01', 1600, 'RDM', null), nota('2026-03-02', 300, 'RDA', null)], [], r).dev;
  igual(rdm[0]?.valor, 1600, 'RDM/RDA: aviso igual ao de antes'); igual(rdm[0]?.rda, 300, 'RDM/RDA: RDA igual'); igual(rdm[0]?.total, 1900, 'RDM/RDA: total igual');
  app.notas = []; app.repasses = [];
}

console.log('Painel: mesma linha da aba Saldo, separada por tipo, e sempre visível');
{
  app.notas = notas3; app.repasses = reps3;
  const semTags = h => h.replace(/<[^>]+>/g, ' ').replace(/⁠/g, '').replace(/\s+/g, ' ').trim();
  confere(G.brlInteiro(-5).startsWith('-⁠R$'), 'o menos não se separa do valor na quebra de linha');
  confere(G.brlInteiro(5) === G.brlInteiro(5).replace('⁠', ''), 'valor positivo fica igual');
  const rdm = app._saldoAcumuladoAte(3, 2026, 'RDM'), rda = app._saldoAcumuladoAte(3, 2026, 'RDA');
  const pRdm = app._parcelasAnteriores(notas3, reps3, 'RDM', 2026, rdm.pendenciaAnterior);
  const pRda = app._parcelasAnteriores(notas3, reps3, 'RDA', 2026, rda.pendenciaAnterior);
  igual(pRdm.anoAnt, 25 - 140, 'RDM: o anterior do Painel é o mesmo do Gestor.saldoAnoAnterior');
  igual(pRdm.mesesAno, 50 - 370, 'RDM: meses anteriores são só os de 2026');
  igual(pRdm.anoAnt + pRdm.mesesAno, rdm.pendenciaAnterior, 'RDM: as duas parcelas fecham com o que o saldo já somava');
  igual(pRda.anoAnt + pRda.mesesAno, rda.pendenciaAnterior, 'RDA: as duas parcelas fecham');
  const kpi = semTags(app._kpiAnteriorHTML(pRdm, 3, 2026));
  confere(/Saldo do ano anterior -R\$ 115,00/.test(kpi) && /Meses anteriores de 2026 -R\$ 320,00/.test(kpi), `cartão RDM do Painel separa ano e meses (${kpi})`);
  confere(!/Meses anteriores/.test(app._kpiAnteriorHTML(pRdm, 1, 2026)), 'em janeiro não há meses anteriores do ano');
  const hero = semTags(app._heroAnteriorHTML(pRdm, pRda, 3, 2026));
  confere(/Saldo do ano anterior -R\$ 360,00/.test(hero), `topo do Painel soma RDM e RDA, como o total acima dele (${hero})`);
  app.notas = []; app.repasses = [];
  const z = app._parcelasAnteriores([], [], 'RDM', 2026, app._saldoAcumuladoAte(3, 2026, 'RDM').pendenciaAnterior);
  confere(/Saldo do ano anterior R\$ 0,00/.test(semTags(app._kpiAnteriorHTML(z, 3, 2026))), 'com tudo zerado a linha do cartão continua lá');
  confere(/Saldo do ano anterior R\$ 0,00/.test(semTags(app._heroAnteriorHTML(z, z, 3, 2026))), 'e a do topo também');
  confere(!/Pend\. anterior/.test(fonteApp), 'o rótulo "Pend. anterior" saiu do app');
  confere(!/>Pend\. \$\{brl|>Créd\. \$\{brl/.test(fonteApp), 'os selos Pend./Créd. saíram do Painel');
}

console.log('Sentido do saldo: o mesmo rótulo com sinais opostos diz quem deve');
{
  confere(G.sentidoSaldo(-100) === 'a empresa deve', 'cartão/ficha: negativo = a empresa deve');
  confere(G.sentidoSaldo(100) === 'a favor da empresa', 'cartão/ficha: positivo = a favor da empresa');
  confere(G.sentidoSaldo(100, true) === 'a empresa deve', 'a receber: positivo = a empresa deve');
  confere(G.sentidoSaldo(-100, true) === 'a favor da empresa', 'a receber: negativo = a favor da empresa');
  confere(G.sentidoSaldo(0) === '' && G.sentidoSaldo(0.001, true) === '', 'zero não diz nada');
  // o caso do revisor: R$ 100 de carteira e R$ 100 de cartão em 2025, nada pago
  const ns = [nota('2025-05-10', 100, 'RDM', 'carteira'), nota('2025-05-11', 100, 'RDM', 'cartao')];
  const s = app._saldosCvDoAno(ns, [], 2026);
  confere(app._comSentido(s.cartaoAnterior) === ' (a empresa deve)', 'cartão -100: a empresa deve');
  confere(app._comSentido(s.RDM.ant) === ' (a empresa deve)', 'reembolso RDM -100: a empresa deve');
  confere(app._comSentido(0) === '', 'sem valor, sem parênteses');
}

console.log('Quem saiu do C.V.: recarga antiga não vira recebido no aviso de devedor');
{
  // achado no cruzamento com o servidor (04/11/2026): _devedorDe contava a recarga, _saldoAcumuladoAte e as planilhas não
  const ns = [nota('2025-03-01', 100, 'RDM', null)];
  const rs = [rep('2025-02-01', 80, 'RDM'), rep('2025-02-02', 500, 'RDM', 'recarga')];
  igual(app._devedorDe(ns, rs, 12, 2025, false, 'RDM'), 20, 'gasto − repasse, sem a recarga');
  igual(app._devedorDe(ns, rs, 12, 2025, false), 20, 'o total também');
}

console.log('Excel anual: rótulo do ano anterior');
{
  const m = fs.readFileSync(path.join(JS, 'excel.js'), 'utf8').match(/`Saldo do ano anterior:[^`]*`/);
  confere(!!m, 'a linha existe');
  const t = vm.runInNewContext(m[0], { brlTxt: v => 'R$ ' + v.toFixed(2).replace('.', ','), abRDM: 10, abRDA: 5 });
  confere(t.startsWith('Saldo do ano anterior: RDM R$ 10,00 · RDA R$ 5,00'), `espaço depois de RDM (${t})`);
}

/* ── Ficha da Equipe de verdade ── */
async function ficha(regime, mes, ano, { semHistorico = false, ns = notas3, rs = reps3 } = {}) {
  const colab = { id: 'u1', nome: 'Fulano', email: 'f@x.com', role: 'colaborador', regime };
  const lista = (arr, q) => {
    if (semHistorico && !q.ano) return Promise.reject(new Error('sem rede'));
    return Promise.resolve(arr.filter(x => (!q.ano || x.ano === ano) && (!q.mes || x.mes === mes) && !(q.deleted === '0' && x.deleted)));
  };
  const sb = { notas: { list: q => lista(ns, q) }, repasses: { list: q => lista(rs, q) }, colaboradores: { get: async () => colab } };
  const el = w.document.createElement('div');
  w.document.body.appendChild(el);
  G.abrir('u1');
  await G.renderDashboard(el, sb, { id: 'g1', role: 'gestor', nome: 'Gestor' }, () => {}, { mes, ano });
  return el;
}

const texto = el => el.textContent.replace(/⁠/g, '').replace(/\s+/g, ' ').trim();
const celula = (aba, rot) => [...aba.querySelectorAll('.cdet-plan-cel')].find(c => texto(c.querySelector('.l')) === rot);
const valor = c => texto(c.querySelector('b'));

(async () => {
  console.log('Ficha da Equipe, regime C.V., 3 anos');
  {
    const el = await ficha('cv', 3, 2026);
    const [cartao, reemb] = el.querySelectorAll('.cdet-plan-aba');
    confere(cartao && reemb, 'as duas faixas apareceram');
    const c0 = cartao.querySelectorAll('.cdet-plan-cel')[0];
    confere(texto(c0.querySelector('.l')) === 'Saldo do ano anterior', 'a primeira célula do cartão é o Saldo do ano anterior');
    confere(valor(c0) === 'R$ 1.200,00', `cartão: anterior (deu ${valor(c0)})`);
    confere(valor(celula(cartao, 'Saldo')) === 'R$ 1.300,00', `cartão: saldo = anterior + recargas − gasto (deu ${valor(celula(cartao, 'Saldo'))})`);
    const r0 = celula(reemb, 'Saldo do ano anterior');
    confere(valor(r0) === '-R$ 60,00', `reembolso: anterior (deu ${valor(r0)})`);
    confere(/RDM\s*-R\$ 15,00/.test(texto(r0)) && /RDA\s*-R\$ 45,00/.test(texto(r0)), `reembolso: anterior em RDM e RDA (${texto(r0)})`);
    confere(/a empresa deve/.test(texto(r0)), `reembolso anterior negativo diz quem deve (${texto(r0)})`);
    confere(/a favor da empresa/.test(texto(c0)), `cartão anterior positivo diz a favor de quem (${texto(c0)})`);
    confere(valor(celula(reemb, 'Saldo')) === '-R$ 90,00', `reembolso: saldo = -60 + 70 − 100 (deu ${valor(celula(reemb, 'Saldo'))})`);
    const conta = el.querySelector('[data-painel="reemb-saldo-RDM"] .cdet-plan-conta');
    const linhas = [...conta.children].map(texto);
    confere(/^Saldo do ano anterior\s*-R\$ 15,00$/.test(linhas[0]), `a conta abre com o ano anterior (${linhas[0]})`);
    confere(/^= Saldo RDM\s*-R\$ 35,00$/.test(linhas[linhas.length - 1]), `e fecha no saldo (${linhas[linhas.length - 1]})`);
  }

  console.log('Ficha da Equipe, regime RDM/RDA');
  {
    const el = await ficha('rdm', 3, 2026);
    const [rdm] = el.querySelectorAll('.cdet-bal');
    confere(/Saldo do ano anterior -R\$ 115,00/.test(texto(rdm)), `cartão RDM mostra o ano anterior (${texto(rdm)})`);
    confere(/Meses anteriores de 2026 -R\$ 320,00/.test(texto(rdm)), 'e separa os meses do ano');
    confere(texto(rdm.querySelector('.cdet-bal-val')) === '-R$ 435,00', 'saldo não muda: a soma das parcelas é a mesma de antes');
    const linhas = [...el.querySelector('[data-painel="reg-RDM"] .cdet-plan-conta').children].map(texto);
    confere(/^Saldo do ano anterior\s*-R\$ 115,00$/.test(linhas[0]), `a conta abre com o ano anterior (${linhas[0]})`);
    confere(/^= Saldo RDM\s*-R\$ 435,00$/.test(linhas[linhas.length - 1]), `e fecha no saldo (${linhas[linhas.length - 1]})`);
    const jan = await ficha('rdm', 1, 2026);
    confere(!/Meses anteriores/.test(texto(jan.querySelector('.cdet-bal'))), 'em janeiro não há meses anteriores do ano');
    const zerado = await ficha('rdm', 3, 2026, { ns: [], rs: [] });
    confere(/Saldo do ano anterior R\$ 0,00/.test(texto(zerado.querySelector('.cdet-bal'))), 'a linha aparece mesmo com R$ 0,00');
  }

  console.log('Planilhas da equipe: quem só carrega saldo já vem marcado, como no servidor (SaldoAnterior::quemCarrega)');
  {
    const u = (id, regime) => ({ id, nome: id, email: id + '@x.com', role: 'colaborador', regime, ativo: true });
    const colabs = [u('rdm-carrega', 'rdm_rda'), u('cv-so-recarga', 'cv'), u('cv-so-bolso', 'cv'), u('zerado', 'rdm_rda'), u('lancou', 'rdm_rda')];
    const ns = [nota('2025-03-01', 10, 'RDM', null, { user_id: 'rdm-carrega' }), nota('2025-03-01', 7, 'RDA', 'carteira', { user_id: 'cv-so-bolso' }),
      nota('2025-03-01', 10, 'RDM', null, { user_id: 'zerado' }), nota('2026-03-01', 5, 'RDM', null, { user_id: 'lancou' })];
    const rs = [rep('2025-01-01', 300, 'RDM', 'recarga', { user_id: 'cv-so-recarga' }), rep('2025-01-01', 10, 'RDM', null, { user_id: 'zerado' })];
    const q = (arr, f) => Promise.resolve(arr.filter(x => (!f.ano || x.ano === f.ano) && (!f.mes || x.mes === f.mes)));
    const sb = { notas: { list: f => q(ns, f) }, repasses: { list: f => q(rs, f) }, colaboradores: { listTodos: async () => colabs } };
    G.fechar();
    G.definirAba('pessoas');
    const el = w.document.createElement('div');
    w.document.body.appendChild(el);
    await G.renderDashboard(el, sb, { id: 'g1', role: 'gestor', nome: 'Gestor' }, () => {}, { mes: 3, ano: 2026 });
    G.abrirCvEquipe();
    const marcados = [...w.document.querySelectorAll('.sel-chk:checked')].map(c => c.value).sort();
    w.document.querySelector('.modal-overlay.open').remove();
    confere(marcados.join() === 'cv-so-bolso,cv-so-recarga,lancou,rdm-carrega', `marcados: ${marcados.join()}`);
  }

  /* a lista da Equipe de verdade, com um C.V. e um RDM/RDA */
  const mudar = (arr, id) => arr.map(x => ({ ...x, user_id: id }));
  const nsDois = [...mudar(notas3, 'cv1'), ...mudar(notas3, 'rd1')], rsDois = [...mudar(reps3, 'cv1'), ...mudar(reps3, 'rd1')];
  const colabsDois = [{ id: 'cv1', nome: 'Carla', email: 'c@x.com', role: 'colaborador', regime: 'cv', nucleo: 'A', ativo: true }, { id: 'rd1', nome: 'Rui', email: 'r@x.com', role: 'colaborador', regime: 'rdm_rda', nucleo: 'A', ativo: true }];
  async function lista(mes, ano, { semHistorico = false } = {}) {
    const q = (arr, f) => (semHistorico && !f.ano) ? Promise.reject(new Error('sem rede'))
      : Promise.resolve(arr.filter(x => (!f.ano || x.ano === f.ano) && (!f.mes || x.mes === f.mes) && !(f.deleted === '0' && x.deleted)));
    const sb = { notas: { list: f => q(nsDois, f) }, repasses: { list: f => q(rsDois, f) }, colaboradores: { listTodos: async () => colabsDois } };
    G.fechar();
    G.definirAba('pessoas');
    const el = w.document.createElement('div');
    w.document.body.appendChild(el);
    await G.renderDashboard(el, sb, { id: 'g1', role: 'gestor', nome: 'Gestor' }, () => {}, { mes, ano });
    return { el, cartao: id => el.querySelector(`.colab-card[data-uid="${id}"]`) };
  }

  console.log('Lista da Equipe: C.V. com os números da ficha, RDM/RDA como sempre');
  {
    const { cartao } = await lista(3, 2026);
    const [c, r] = cartao('cv1').querySelectorAll('.bal-box');
    const tc = texto(c), tr = texto(r);
    confere(/Cartão · 2026/.test(tc) && texto(c.querySelector('.bal-val')) === 'R$ 1.300,00', `cartão igual à ficha (${tc})`);
    confere(/Saldo do ano anterior R\$ 1\.200,00 \(a favor da empresa\)/.test(tc) && /Gasto R\$ 300,00/.test(tc) && /Recargas R\$ 400,00/.test(tc), 'cartão: anterior, gasto e recargas do ano');
    confere(/Reembolso · 2026/.test(tr) && texto(r.querySelector('.bal-val')) === '-R$ 90,00', `reembolso igual à ficha (${tr})`);
    confere(/RDM -R\$ 35,00/.test(tr) && /RDA -R\$ 55,00/.test(tr), 'reembolso aberto em RDM e RDA');
    confere(/Saldo do ano anterior -R\$ 60,00 \(a empresa deve\)/.test(tr), 'anterior do reembolso com o sentido');
    confere(!/saldo acumulado/.test(texto(cartao('cv1'))), 'o C.V. não mostra mais o saldo acumulado RDM/RDA');
    confere(cartao('cv1').querySelector('.bal-box.neg') === r && !c.classList.contains('neg'), 'só o negativo fica vermelho');
    // a 360 e 390 px o valor partia nos dígitos, como no Painel (medido no Chrome, 04/11/2026)
    [c, r].forEach(b => confere(/white-space:nowrap/.test(b.querySelector('.bal-val').innerHTML) && /font-size:min\(1em,/.test(b.querySelector('.bal-val').innerHTML), 'lista: o valor fica inteiro e a letra encolhe'));

    const fich = await ficha('cv', 3, 2026);
    const [abaC, abaR] = fich.querySelectorAll('.cdet-plan-aba');
    confere(valor(celula(abaC, 'Saldo')) === texto(c.querySelector('.bal-val')) && valor(celula(abaR, 'Saldo')) === texto(r.querySelector('.bal-val')), 'lista e ficha dão o mesmo número');
    const s = app._saldosCvDoAno(notas3, reps3, 2026);
    confere(valor(celula(abaC, 'Saldo')) === 'R$ 1.300,00' && s.cartao === 1300 && s.reemb.saldo === -90, 'e o app do colaborador também');

    const [m, a] = cartao('rd1').querySelectorAll('.bal-box');
    confere(texto(m.querySelector('.bal-type')) === 'RDM · saldo acumulado' && texto(m.querySelector('.bal-val')) === '-R$ 435,00', `RDM/RDA: RDM sem mudança (${texto(m)})`);
    confere(texto(a.querySelector('.bal-type')) === 'RDA · saldo acumulado', 'RDM/RDA: RDA sem mudança');
    confere(/Meses anteriores de 2026/.test(texto(m)), 'RDM/RDA: continua abrindo os meses anteriores');

    const sem = await lista(3, 2026, { semHistorico: true });
    const t = texto(sem.cartao('cv1').querySelector('.bal-box'));
    confere(/só o ano/.test(t) && /Saldo do ano anterior: indisponível/.test(t), `sem histórico diz, não chuta (${t})`);
  }

  console.log('Excel da equipe: dois quadros, cada total diz o que soma');
  {
    const X = montarExcel();
    const reg = (id, m, a) => nsDois.filter(n => n.user_id === id && n.mes === m && n.ano === a && !n.deleted && n.pagamento !== 'empresa');
    const ns = [...reg('cv1', 2, 2026), ...reg('rd1', 2, 2026)];
    const rs = rsDois.filter(r => r.mes === 2 && r.ano === 2026 && !r.deleted && r.destino !== 'recarga');
    const anterior = Object.fromEntries(G.saldoAnteriorPorUsuario(nsDois, rsDois, 2, 2026));
    const cv = { cv1: G.saldoCvDoAno(nsDois.filter(n => n.user_id === 'cv1'), rsDois.filter(r => r.user_id === 'cv1'), 2026) };
    const ws = X.buildEquipe(ns, rs, colabsDois, 2, 2026, anterior, cv);
    const celulas = Object.keys(ws).filter(k => /^[A-Z]+\d+$/.test(k));
    const achar = v => celulas.find(k => ws[k].v === v);
    const linha = k => celulas.filter(c => c.replace(/\D/g, '') === k.replace(/\D/g, '')).sort((p, q) => p.localeCompare(q)).map(c => ws[c].v);
    const rui = linha(achar('Rui')), carla = linha(achar('Carla'));
    confere(rui.length === 10, `RDM/RDA continua na tabela de 10 colunas (${rui.join(' | ')})`);
    igual(rui[2], -415, 'RDM Anterior sem mudança'); igual(rui[5], -435, 'RDM Saldo Acum. sem mudança');
    confere(carla.length === 13, `C.V. no quadro próprio (${carla.join(' | ')})`);
    igual(carla[5], 1300, 'Cartão Saldo'); igual(carla[2], 1200, 'Cartão Anterior'); igual(carla[3], 400, 'Cartão Recargas'); igual(carla[4], 300, 'Cartão Gasto');
    igual(carla[9], -90, 'Reemb. Saldo'); igual(carla[10], -35, 'Saldo RDM'); igual(carla[11], -55, 'Saldo RDA'); igual(carla[12], 100, 'Gasto do mês');
    confere(!achar('TOTAL GERAL'), 'não há total geral misturando os dois regimes');
    confere(!!achar('TOTAL DO REGIME RDM/RDA') && !!achar('TOTAL DO REGIME C.V.'), 'cada total diz o regime');
    const tot = linha(achar('TOTAL DO REGIME RDM/RDA'));
    igual(tot[2], 70, 'o total do RDM/RDA soma só quem é do RDM/RDA');
    const so = X.buildEquipe(reg('rd1', 2, 2026), rs.filter(r => r.user_id === 'rd1'), colabsDois.filter(c => c.id === 'rd1'), 2, 2026, anterior, {});
    confere(Object.values(so).some(c => c && c.v === 'TOTAL GERAL') && so['!ref'].endsWith(':J' + so['!ref'].match(/(\d+)$/)[1]), 'sem C.V. a planilha fica como sempre foi');
    const semH = X.buildEquipe(ns, rs, colabsDois, 2, 2026, null, null);
    confere(Object.values(semH).some(c => c && /Saldo do C\.V\. não calculado.*Carla/.test(String(c.v))), 'sem histórico diz que não calculou o C.V.');
  }

  /* Decisão do dono (04/11/2026): o quadro C.V. do Excel de um mês corta no fim do mês, igual ao PDF da equipe. Passa pelo
     caminho real (renderForExcel + exportarEquipe); os números vêm escritos à mão, não da mesma conta que o código usa. */
  console.log('Excel da equipe: o quadro C.V. corta no fim do mês');
  {
    const notasDepois = [nota('2026-05-10', 40, 'RDM', 'cartao'), nota('2026-07-10', 15, 'RDA', 'carteira')];
    const repsDepois = [rep('2026-05-01', 100, 'RDA', 'recarga'), rep('2026-07-02', 5, 'RDM')];
    const nsC = [...nsDois, ...mudar(notasDepois, 'cv1'), ...mudar(notasDepois, 'rd1')];
    const rsC = [...rsDois, ...mudar(repsDepois, 'cv1'), ...mudar(repsDepois, 'rd1')];
    const fonte = semHistorico => {
      const q = (arr, f) => (semHistorico && !f.ano) ? Promise.reject(new Error('sem rede'))
        : Promise.resolve(arr.filter(x => (!f.ano || x.ano === f.ano) && (!f.mes || x.mes === f.mes) && !(f.deleted === '0' && x.deleted)));
      return { notas: { list: f => q(nsC, f) }, repasses: { list: f => q(rsC, f) }, colaboradores: { list: async () => colabsDois, listTodos: async () => colabsDois } };
    };
    const X = montarExcel();
    const folha = async (mes, semHistorico = false) => {
      const d = await G.renderForExcel(fonte(semHistorico), { id: 'g1', role: 'gestor', nome: 'Gestor' }, mes, 2026);
      await X.exportarEquipe(d.notas, d.repasses, d.collabs, d.mes, d.ano, 'Gestor', d.anterior, d.cv);
      const ws = X.folhaGerada();
      const celulas = Object.keys(ws).filter(k => /^[A-Z]+[0-9]+$/.test(k));
      const num = k => k.replace(/[A-Z]/g, '');
      const linhaDe = v => { const k = celulas.find(c => ws[c].v === v); return celulas.filter(c => num(c) === num(k)).sort((p, q) => p.localeCompare(q)).map(c => ws[c].v); };
      return { linhaDe, textos: celulas.map(k => String(ws[k].v)), ws };
    };
    const bate = (lido, nums) => lido.length === nums.length && nums.every((v, i) => Math.abs(lido[i] - v) < 0.005);
    /* cartão: ano anterior, recargas, gasto, saldo | reembolso: ano anterior, gasto, recebido, saldo | saldo RDM, saldo RDA | gasto do mês */
    const esperado = {
      1: [1200, 400, 300, 1300, -60, 0, 0, -60, -15, -45, 300],
      2: [1200, 400, 300, 1300, -60, 100, 70, -90, -35, -55, 100],
      4: [1200, 400, 300, 1300, -60, 100, 70, -90, -35, -55, 0],
      5: [1200, 500, 340, 1360, -60, 100, 70, -90, -35, -55, 40],
      7: [1200, 500, 340, 1360, -60, 115, 75, -100, -30, -70, 15],
      12: [1200, 500, 340, 1360, -60, 115, 75, -100, -30, -70, 0],
    };
    for (const [mes, nums] of Object.entries(esperado)) {
      const f = await folha(+mes);
      const carla = f.linhaDe('Carla').slice(2), tot = f.linhaDe('TOTAL DO REGIME C.V.').slice(1);
      confere(bate(carla, nums), `mês ${mes}: Carla ${carla.join(' | ')} (esperado ${nums.join(' | ')})`);
      confere(bate(tot, nums), `mês ${mes}: o total do C.V. segue o corte (${tot.join(' | ')})`);
    }
    const f5 = await folha(5);
    confere(f5.textos.some(t => t.startsWith('REGIME C.V. — até o fim de Mai/2026')) && !f5.textos.some(t => t.includes('ano de 2026')), 'o rótulo diz até quando vai a conta');
    confere(['Cartão Ano Anterior', 'Cartão Recargas até Mai', 'Cartão Gasto até Mai', 'Cartão Saldo fim Mai', 'Reemb. Ano Anterior', 'Reemb. Gasto até Mai', 'Reemb. Recebido até Mai', 'Reemb. Saldo fim Mai', 'Saldo RDM fim Mai', 'Saldo RDA fim Mai', 'Gasto em Mai'].every(h => f5.textos.includes(h)), 'o cabeçalho diz o período de cada coluna');
    const larguras = f5.ws['!cols'].map(c => c.wch);
    confere(larguras.length === 13 && larguras[8] >= 'Reemb. Recebido até Mai'.length, `o título cabe na coluna, sem depender de quebra de linha (${larguras.join(', ')})`);
    /* RDM/RDA não muda: Anterior, Gasto, Repasse e Saldo Acum. do mês, nos dois tipos */
    const ruiEsperado = {
      2: [-415, 70, 50, -435, -245, 30, 20, -255],
      5: [-435, 40, 0, -475, -255, 0, 0, -255],
      7: [-475, 0, 5, -470, -255, 15, 0, -270],
    };
    for (const [mes, nums] of Object.entries(ruiEsperado)) {
      const rui = (await folha(+mes)).linhaDe('Rui').slice(2);
      confere(bate(rui, nums), `mês ${mes}: Rui do RDM/RDA sem mudança (${rui.join(' | ')})`);
    }
    const semH = await folha(5, true);
    confere(semH.textos.some(t => /Saldo do C\.V\. não calculado.*Carla/.test(t)), 'sem histórico continua dizendo que não calculou');
    confere(!semH.textos.includes('Cartão Saldo fim Mai'), 'sem histórico não mostra coluna de saldo');
  }

  console.log('Ficha sem histórico: diz, não chuta');
  for (const regime of ['cv', 'rdm']) {
    const el = await ficha(regime, 3, 2026, { semHistorico: true });
    const t = texto(el.querySelector('.cdet-bal'));
    confere(/Saldo do ano anterior: indisponível/.test(t) && /histórico indisponível/.test(t), `${regime}: avisa que faltou o histórico`);
    confere(!el.querySelector('.cdet-plan-aba'), `${regime}: não mostra faixa sem o anterior`);
  }

  console.log(falhas ? `\n${falhas} caso(s) falharam` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})();
