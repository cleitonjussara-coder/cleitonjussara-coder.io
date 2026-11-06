#!/usr/bin/env node
// Teste da Equipe unificada (06/11/2026): a aba Equipe e o antigo Dashboard Equipe viraram uma tela com Resumo, Pessoas e Relatórios.
//   node scripts/testar-equipe-unificada.js
// Roda o gestor.js de verdade com jsdom e as categorias tiradas do próprio app.js. Os totais são comparados com as contas
// que as duas telas antigas faziam (escritas de novo aqui, de propósito). Sai com código 1 se algum caso falhar.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));

const JS = path.join(__dirname, '..', 'rda-rdm-app', 'js');
const fonteApp = fs.readFileSync(path.join(JS, 'app.js'), 'utf8');
const fonteGestor = fs.readFileSync(path.join(JS, 'gestor.js'), 'utf8');
const ini = fonteApp.indexOf('const CATEGORIAS_CV = [');
const fim = fonteApp.indexOf('/* ─── Resumo de gastos e saldo devedor');
const fonteCategorias = fonteApp.slice(ini, fim).replace(/^const /gm, 'var ');

let falhas = 0;
const confere = (ok, msg) => { console.log((ok ? '  ok  ' : '  FALHOU  ') + msg); if (!ok) falhas++; };

const dom = new JSDOM('<main id="app-content"></main>', { runScripts: 'dangerously' });
const w = dom.window;
w.eval(`
  var MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  var FusoBR = { partes: () => ({ mes: 3, ano: 2026, dia: 15 }), data: d => d };
  var brl = v => 'R$ ' + Number(v || 0).toFixed(2);
  var chipDelta = (a, b) => '<span class="dl">' + a.toFixed(2) + '|' + b.toFixed(2) + '</span>';
  var toast = () => {}; var navegou = [];
  var mudarMesEquipe = d => navegou.push('mes' + d); var mudarAnoEquipe = d => navegou.push('ano' + d);
  var equipePorId = {}, notas = [], notasEquipe = [];
`);
w.eval(fonteCategorias);
w.eval(fonteGestor + ';window.Gestor = Gestor;');
const G = w.Gestor;

const u = (id, nome, regime, extra = {}) => ({ id, nome, email: id + '@x.com', role: 'colaborador', regime, ativo: true, ...extra });
const colabs = [u('a', 'Ana', 'rdm_rda'), u('b', 'Bia', 'cv'), u('c', 'Caio', 'rdm_rda'), u('cont', 'Contador', 'rdm_rda', { role: 'contabilidade' }), u('g1', 'Gestor', 'rdm_rda', { role: 'gestor' }), u('x', 'Xico', 'cv', { ativo: false })];
let seq = 0;
const nota = (user_id, mes, tipo, subtipo, valor, pagamento = null, ano = 2026, dia = 10) => ({ id: 'n' + (++seq), user_id, mes, ano, tipo, subtipo, valor, pagamento, foto_path: 'f', deleted: false, data: `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}` });
const todas = [
  nota('a', 3, 'RDA', null, 100), nota('a', 3, 'RDM', 'Abastecimento', 200), nota('a', 3, 'RDM', 'Pedágio', 15.5), nota('a', 3, 'RDM', 'Hospedagem', 700, 'empresa'),
  nota('b', 3, 'RDM', 'Manutenção de Veículos', 400), nota('b', 3, 'RDM', 'Exames', 90, 'carteira'), nota('b', 3, 'RDM', 'Outros', 30),
  nota('c', 3, 'RDM', 'qualquer antigo', 10),
  nota('x', 3, 'RDA', null, 50),
  nota(null, 3, 'RDM', 'Locação de Veículos', 3000, 'empresa'), nota(null, 3, 'RDM', 'Contabilidade', 1450, 'empresa'),
  nota('a', 2, 'RDM', 'Abastecimento', 80), nota('a', 2, 'RDM', 'Abastecimento', 999, null, 2026, 20), nota('b', 1, 'RDM', 'Pedágio', 20), nota('a', 12, 'RDM', 'Abastecimento', 55, null, 2025), nota('a', 2, 'RDM', 'Abastecimento', 7, null, 2025),
];
const soma = arr => arr.reduce((t, n) => t + Number(n.valor), 0);
let chamadas = 0;
const sb = {
  notas: { list: async f => { chamadas++; return todas.filter(n => (!f.ano || n.ano === f.ano) && (!f.mes || n.mes === f.mes)); } },
  repasses: { list: async () => [] },
  colaboradores: { listTodos: async () => colabs },
};
const el = w.document.getElementById('app-content');
const gestor = { id: 'g1', role: 'gestor', nome: 'Gestor' };
const carregar = (mes = 3, ano = 2026, quem = gestor) => G.renderDashboard(el, sb, quem, () => {}, { mes, ano });
const texto = () => el.textContent.replace(/\s+/g, ' ');
const dinheiro = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);   // o mesmo formato do gestor.js
const numero = t => Number(String(t).replace(/[^0-9,-]/g, '').replace(',', '.'));
const hero = () => el.querySelector('.db-hero-val').textContent.trim();

(async () => {
  const mar = todas.filter(n => n.ano === 2026 && n.mes === 3);
  const gastoAntigo = soma(mar.filter(n => n.pagamento !== 'empresa'));   // "Gasto da equipe" do Dashboard
  const faturamentoAntigo = soma(mar);                                    // "Faturamento" das duas telas
  const pagoDiretoAntigo = soma(mar.filter(n => n.pagamento === 'empresa'));

  console.log('Resumo: os números das telas antigas');
  await carregar();
  confere(hero() === dinheiro(faturamentoAntigo), `Todos = Faturamento antigo (${hero()})`);
  const [btCol, btEmp] = el.querySelectorAll('.eqp-soma button');
  confere(btCol.querySelector('b').textContent === dinheiro(gastoAntigo), 'Colaboradores = Gasto da equipe antigo');
  confere(btEmp.querySelector('b').textContent === dinheiro(pagoDiretoAntigo), 'Empresa pagou = Pago direto antigo');
  G.eqFiltro('pag', 'colab');
  confere(hero() === dinheiro(gastoAntigo), 'filtro Colaboradores: o total é o Gasto antigo');
  G.eqFiltro('pag', 'colab');
  confere(hero() === dinheiro(faturamentoAntigo), 'tocar de novo desliga o filtro');
  G.eqFiltro('pag', 'empresa');
  confere(hero() === dinheiro(pagoDiretoAntigo), 'filtro Empresa: o total é o Pago direto antigo');
  G.eqLimpar();

  console.log('Categorias: todas aparecem e a soma fecha');
  const nomes = [...el.querySelectorAll('.eqp-cat-l > span')].map(s => s.textContent);
  for (const c of ['Alimentação', 'Abastecimento', 'Hospedagem', 'Pedágio', 'Manutenção de Veículos', 'Exames', 'Locação de Veículos', 'Contabilidade', 'Outros']) {
    confere(nomes.some(n => n.includes(c)), `${c} aparece`);
  }
  const somaCats = [...el.querySelectorAll('.eqp-cat-l b')].reduce((t, b) => t + numero(b.childNodes[0].textContent), 0);
  confere(Math.abs(somaCats - faturamentoAntigo) < 0.01, `soma das categorias = total (${somaCats})`);
  G.eqFiltro('cat', 'pedagio');
  confere(hero() === dinheiro(15.5), 'categoria Pedágio filtra o total');
  confere(el.querySelectorAll('.eqp-cat').length === nomes.length, 'as outras categorias continuam na lista');
  confere(el.querySelector('.dl').textContent === '15.50|0.00', 'comparação do mês anterior respeita o filtro');
  G.eqFiltro('cat', 'pedagio');
  confere(hero() === dinheiro(faturamentoAntigo), 'tocar de novo limpa a categoria');
  G.eqFiltro('cat', 'outros');
  confere(hero() === dinheiro(40), 'subtipo antigo cai em Outros, com o Outros de verdade');
  G.eqLimpar();

  console.log('Comparação: período em andamento para no mesmo dia');
  confere(el.querySelector('.dl').textContent.endsWith('|80.00'), `março em andamento compara com 1 a 15 de fevereiro, sem a nota do dia 20 (${el.querySelector('.dl').textContent})`);
  confere(/vs\. dia 1 a 15 de fevereiro/.test(texto()), 'e a tela diz qual é a comparação');
  await carregar(2);
  confere(el.querySelector('.dl').textContent.endsWith('|20.00') && /vs\. janeiro/.test(texto()), 'mês encerrado compara o mês inteiro');
  await carregar(3);

  console.log('Regime: nota sem colaborador não entra em nenhum');
  G.eqFiltro('reg', 'cv');
  confere(hero() === dinheiro(400 + 90 + 30 + 50), 'C.V.: só quem é C.V., com desativado pelo regime dele');
  G.eqFiltro('reg', 'rdm_rda');
  confere(hero() === dinheiro(100 + 200 + 15.5 + 700 + 10), 'RDM/RDA: sem a Locação e a Contabilidade sem dono, mesmo com gestor RDM/RDA logado');
  G.eqLimpar();
  G.eqFiltro('colab', 'b');
  confere(hero() === dinheiro(520), 'filtro de colaborador');
  G.eqLimpar();

  console.log('Ano');
  G.eqFiltro('modo', 'anual');
  confere(hero() === dinheiro(soma(todas.filter(n => n.ano === 2026))), 'modo Ano soma o ano');
  confere(el.querySelector('.dl').textContent.endsWith('|7.00') && /mesmo período de 2025/.test(texto()), `ano em andamento compara até o mesmo dia de 2025 (${el.querySelector('.dl').textContent})`);
  G.mudarPeriodo(-1);
  confere(w.eval('navegou.pop()') === 'ano-1', 'seta anda de ano');
  el.querySelectorAll('.evo-col')[2].click();
  confere(hero() === dinheiro(faturamentoAntigo), 'coluna do gráfico leva ao mês');
  G.mudarPeriodo(1);
  confere(w.eval('navegou.pop()') === 'mes1', 'e a seta volta a andar de mês');

  console.log('Pessoas: a soma fecha com o Resumo e nada se perde');
  const antes = chamadas;
  G.eqAba('pessoas');
  confere(chamadas === antes, 'trocar de aba não vai ao servidor');
  const valores = [...el.querySelectorAll('.eqp-gasto b')].map(b => numero(b.textContent));
  confere(Math.abs(valores.reduce((a, b) => a + b, 0) - faturamentoAntigo) < 0.01, `pessoas + desativados + sem colaborador = total (${valores.join(' + ')})`);
  const ordem = [...el.querySelectorAll('.colab-list .colab-card[data-uid]')].map(c => c.dataset.uid);
  confere(ordem[0] === 'a' && ordem[1] === 'b', `maior gasto primeiro (${ordem.join()})`);
  confere(/Faturamento geral \(sem colaborador\)/.test(texto()), 'linha do Faturamento sem colaborador');
  confere(/Desativados \(1\)/.test(texto()), 'desativados continuam');
  G.eqFiltro('ord', 'nome');
  confere(el.querySelector('.colab-card[data-uid]').dataset.uid === 'a' && [...el.querySelectorAll('.colab-card[data-uid]')][1].dataset.uid === 'b', 'A–Z');
  confere(!!el.querySelector('.colab-card [data-eid]') && !!el.querySelector('.colab-mais'), 'editar e prévia continuam no cartão');
  G.eqFiltro('ord', 'gasto');
  G.eqFiltro('cat', 'exames');
  confere(el.querySelector('.colab-card[data-uid]').dataset.uid === 'b', 'filtro vale na lista de pessoas');
  G.eqLimpar();
  G.filtrar('bia');
  const visiveis = [...el.querySelectorAll('.colab-card[data-busca]')].filter(c => c.style.display !== 'none');
  confere(visiveis.length === 1, 'busca filtra sem ir ao servidor');
  G.eqFiltro('cat', 'abastecimento');
  confere([...el.querySelectorAll('.colab-card[data-busca]')].filter(c => c.style.display !== 'none').length === 1, 'busca sobrevive ao redesenho');
  G.eqLimpar(); G.filtrar('');

  console.log('Relatórios');
  G.eqAba('rel');
  for (const f of ['abrirPdfEquipe', 'abrirExcelEquipe', 'abrirCvEquipe', 'abrirConvite', 'verNotasFaturamento', 'baixarRelatorioFaturamento', 'baixarPlanilhaFaturamento']) {
    confere(el.innerHTML.includes(f), `botão ${f}`);
  }
  confere(!!el.querySelector('#fech-quadro'), 'quadro do Fechamento');
  confere(el.innerHTML.includes("switchView('rastreio')") && el.innerHTML.includes("switchView('repasses')"), 'atalhos de Rastreio e Repasses');
  confere(!el.querySelector('.seg-btn'), 'relatório é do mês: sem Mês/Ano');

  console.log('Contador');
  G.reset();
  G.definirAba('rel');
  await carregar(3, 2026, { id: 'cont', role: 'contabilidade', nome: 'Contador' });
  confere(!el.innerHTML.includes('abrirConvite') && !el.innerHTML.includes("switchView('rastreio')"), 'sem Convidar e atalhos');
  confere(el.innerHTML.includes('abrirPdfEquipe'), 'mas baixa os relatórios');
  G.eqAba('resumo');
  confere(hero() === dinheiro(faturamentoAntigo), 'e vê o Resumo');

  console.log('Sem internet');
  const onLine = Object.getOwnPropertyDescriptor(w.Navigator.prototype, 'onLine');
  Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => false });
  w.eval('equipePorId = { a: ' + JSON.stringify(colabs[0]) + ' }; notas = []');
  w.notasLocal = todas.filter(n => n.user_id !== 'g1');
  w.eval('notasEquipe = window.notasLocal');
  const sbFora = { notas: { list: () => Promise.reject(new Error('sem rede')) }, repasses: { list: () => Promise.reject(new Error('sem rede')) }, colaboradores: { listTodos: () => Promise.reject(new Error('sem rede')) } };
  await G.renderDashboard(el, sbFora, gestor, () => {}, { mes: 3, ano: 2026 });
  confere(hero() === dinheiro(faturamentoAntigo) && /guardados neste aparelho/.test(texto()), 'Resumo com o que está no aparelho, avisando');
  confere(!el.querySelector('.eqp-abas'), 'sem as abas que dependem do servidor');
  delete w.navigator.onLine; if (onLine) Object.defineProperty(w.Navigator.prototype, 'onLine', onLine);

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
