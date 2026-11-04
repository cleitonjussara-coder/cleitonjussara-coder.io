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
  vm.runInContext(['_repasseEhPedido', '_repasseEhRecebido', '_repasseEhCarteira', '_notaDoCartao', '_naoEhFaturamento', '_saldoCartaoDe', '_saldosCvDoAno', '_cartaoPorTipo', '_devedorDe',
    '_saldoAcumuladoAte', '_parcelasAnteriores', '_comSentido', '_kpiAnteriorHTML', '_heroAnteriorHTML'].map(funcaoDoApp).join('\n'), ctx);
  return ctx;
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
  igual(s(2026).aReceberAnterior, (40 + 60) - 25, 'a receber anterior: carteira − repasse RDM, mesmos filtros do cartão');
  igual(s(2026).aReceber, 75 + (70 + 30) - 50, 'a receber no ano');
  igual(s(2026).aReceber, s(2026).aReceberAnterior + 100 - 50, 'as linhas do cartão fecham');
  igual(s(2026).rdaAnterior, 15, 'RDA recebido de anos anteriores');
  igual(s(2026).rdaRecebido, 15 + 20, 'RDA recebido acumulado');
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
  confere(app._comSentido(s.aReceberAnterior, true) === ' (a empresa deve)', 'RDM recebido +100: a empresa deve');
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
    const el = w.document.createElement('div');
    w.document.body.appendChild(el);
    await G.renderDashboard(el, sb, { id: 'g1', role: 'gestor', nome: 'Gestor' }, () => {}, { mes: 3, ano: 2026 });
    G.abrirCvEquipe();
    const marcados = [...w.document.querySelectorAll('.sel-chk:checked')].map(c => c.value).sort();
    w.document.querySelector('.modal-overlay.open').remove();
    confere(marcados.join() === 'cv-so-bolso,cv-so-recarga,lancou,rdm-carrega', `marcados: ${marcados.join()}`);
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
