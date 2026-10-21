#!/usr/bin/env node
// Teste do front da Frota/KM (frota-painel.js) com jsdom — sem navegador e sem servidor.
//   node scripts/testar-frota-painel.js
// Cobre o que a revisão de 21/10/2026 achou: id de registro com aspas não vira código (XSS), o detalhe/edição recebem o id
// exato, resposta de aba antiga não pinta por cima da aba atual, cópia offline some quando o sinal volta, filtros do
// colaborador comum e rótulos do gráfico. Sai com código 1 se algum caso falhar.
const fs = require('fs');
const path = require('path');
// JSDOM_DIR aponta para uma instalação do jsdom fora do OneDrive (arquivos "só na nuvem" dão erro de leitura em node_modules).
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));

const fonte = fs.readFileSync(process.env.FROTA_PAINEL_JS || path.join(__dirname, '..', 'rda-rdm-app', 'js', 'frota-painel.js'), 'utf8');   // FROTA_PAINEL_JS: testar outra versão do arquivo
let falhas = 0;
const confere = (ok, msg) => { console.log((ok ? '  ok  ' : '  FALHOU  ') + msg); if (!ok) falhas++; };
const espera = ms => new Promise(r => setTimeout(r, ms));

function montar({ gestor = true, historico, painel, online = true, erroRede = false } = {}) {
  const dom = new JSDOM('<main id="app-content"><div id="fq-corpo"></div></main><div id="km-det-overlay"><div id="km-det-corpo"></div></div>', { runScripts: 'dangerously', url: 'http://localhost/' });
  const w = dom.window;
  const chamadas = { abrirForm: [], excluir: [], verFoto: [], trocarAba: [], historico: 0 };
  Object.defineProperty(w.navigator, 'onLine', { get: () => online, configurable: true });
  w.__estado = { aba: 'hist', gestor, historico, painel, chamadas, meta: {}, erroRede };
  w.eval(`
    var $ = id => document.getElementById(id);
    var esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var toast = () => {};
    var fmtData = d => d.slice(8,10)+'/'+d.slice(5,7)+'/'+d.slice(0,4);
    var filMes = 10, filAno = 2026;
    var user = { id: 'u1' };
    var _ehGestorOuAdmin = () => __estado.gestor;
    var FusoBR = { hora: (d) => '10:00', data: () => '21/10/2026', hojeISO: () => '2026-10-21' };
    var DB = { setMeta: async (k, v) => { __estado.meta[k] = v; }, getMeta: async k => __estado.meta[k] || null };
    var sb = {
      hojeDoServidor: () => '2026-10-21',
      frota: { historico: async q => { __estado.chamadas.historico++; if (__estado.erroRede) throw new Error('sem rede'); return JSON.parse(JSON.stringify(__estado.historico)); },
               painel: async q => { if (__estado.erroRede) throw new Error('sem rede'); return JSON.parse(JSON.stringify(__estado.painel)); } },
      fotos: { urls: async () => ({}), url: async () => null },
    };
    var Frota = {
      abaAtiva: () => __estado.aba,
      trocarAba: k => { __estado.chamadas.trocarAba.push(k); },
      pendentes: () => [],
      abrirForm: id => { __estado.chamadas.abrirForm.push(id); },
      excluir: id => { __estado.chamadas.excluir.push(id); },
      verFoto: id => { __estado.chamadas.verFoto.push(id); },
      mudarMes() {}, exportarCSV() {}, exportarExcel() {},
    };
  `);
  w.eval(fonte);
  return w;
}

const item = (extra = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', veiculo_id: 'v1', placa: 'ABC1D23', modelo: 'Strada', user_id: 'u1', user_nome: 'Ana',
  data: '2026-10-21', odometro: 1500, registrado_em: '2026-10-21T14:00:00Z', km_rodado: 200, alerta: null,
  anterior_odometro: 1300, anterior_data: '2026-10-20', anterior_em: '2026-10-20T20:00:00Z', anterior_por: 'Bia',
  observacao: null, foto_path: null, editado_em: null, editado_por: null, pode_editar: true, ...extra,
});
const resposta = (itens, extra = {}) => ({ de: '2026-10-19', ate: '2026-10-25', total: itens.length, total_km: 200, por_dia: { '2026-10-21': 200 }, tem_mais: false, itens, colaboradores: [{ id: 'u1', nome: 'Ana' }], veiculos: [{ id: 'v1', placa: 'ABC1D23' }], ...extra });

(async () => {
  console.log('1. id de registro com aspas não vira código (XSS)');
  const veneno = "x');window.__pwned=1;('";
  const venenoAttr = 'y" onmouseover="window.__pwned=2" x="';
  {
    const w = montar({ historico: resposta([item({ id: veneno }), item({ id: venenoAttr, odometro: 1400 })]) });
    await w.FrotaPainel.historico(w.document.getElementById('fq-corpo'));
    const cartoes = [...w.document.querySelectorAll('.fq-item')];
    confere(cartoes.length === 2, 'os 2 cartões foram pintados');
    confere(cartoes.every(c => c.getAttributeNames().every(n => !n.startsWith('onmouse'))), 'nenhum atributo injetado nos cartões');
    cartoes[0].click();
    confere(w.__pwned === undefined, 'tocar no cartão com id malicioso não executa nada');
    confere(w.document.getElementById('km-det-overlay').style.display === 'flex', 'o detalhe abre para o id exato');
    w.document.querySelector('.kd-acoes button[data-id]').click();
    confere(w.__estado.chamadas.abrirForm[0] === veneno, 'Editar recebe o id exato, como texto');
    cartoes[1].click();
    confere(w.__pwned === undefined, 'id com aspas duplas também não executa');
    w.document.querySelectorAll('.kd-acoes button[data-id]')[1].click();
    confere(w.__estado.chamadas.excluir[0] === venenoAttr, 'Excluir recebe o id exato');
  }

  console.log('2. id inofensivo continua funcionando');
  {
    const w = montar({ historico: resposta([item()]) });
    await w.FrotaPainel.historico(w.document.getElementById('fq-corpo'));
    w.document.querySelector('.fq-item').click();
    const txt = w.document.getElementById('km-det-corpo').textContent;
    confere(txt.includes('1.500') && txt.includes('+200 km desde a leitura anterior'), 'detalhe mostra odômetro e km rodado');
    confere(txt.includes('por Bia'), 'gestor vê quem fez a leitura anterior');
  }

  console.log('3. colaborador comum: sem filtro de pessoa e sem nome de quem leu antes');
  {
    const w = montar({ gestor: false, historico: resposta([item({ anterior_por: null })], { colaboradores: [] }) });
    w.FrotaPainel.filtrar('user_id', 'outra-pessoa');           // o estado guarda, mas o histórico ignora para quem não é gestor
    await w.FrotaPainel.historico(w.document.getElementById('fq-corpo'));
    confere(!w.document.querySelector('select[aria-label="Colaborador"]'), 'não há seletor de colaborador');
    w.document.querySelector('.fq-item').click();
    confere(!w.document.getElementById('km-det-corpo').textContent.includes('por Bia'), 'não mostra quem fez a leitura anterior');
    confere(!w.document.getElementById('km-det-corpo').textContent.includes('Histórico de Ana'), 'sem atalho para histórico de pessoa');
  }

  console.log('4. resposta de aba antiga não pinta por cima da aba atual');
  {
    const w = montar({ historico: resposta([item()]) });
    const corpo = w.document.getElementById('fq-corpo');
    w.__estado.aba = 'painel';
    const p = w.FrotaPainel.historico(corpo);                   // pedido em voo…
    w.__estado.aba = 'vei'; corpo.innerHTML = '<p id="vei">veículos</p>'; w.FrotaPainel.cancelar();   // …o usuário foi para Veículos
    await p;
    confere(!!w.document.getElementById('vei') && !w.document.querySelector('.fq-item'), 'a aba Veículos continua intacta');
  }

  console.log('5. cópia offline some quando o sinal volta');
  {
    const w = montar({ historico: resposta([]), online: false, erroRede: true });
    w.__estado.meta['frota_hist_u1'] = { d: { ...resposta([item()]), _f: { user_id: '', veiculo_id: '' } }, em: '2026-10-21T10:00:00Z' };
    await w.FrotaPainel.historico(w.document.getElementById('fq-corpo'));
    confere(w.document.getElementById('fq-corpo').textContent.includes('Sem internet'), 'offline: mostra a cópia com o aviso');
    Object.defineProperty(w.navigator, 'onLine', { get: () => true, configurable: true });
    w.__estado.erroRede = false;
    w.__estado.historico = resposta([item(), item({ id: '22222222-2222-4222-8222-222222222222' })]);
    await w.FrotaPainel.historico(w.document.getElementById('fq-corpo'));
    const t = w.document.getElementById('fq-corpo');
    confere(!t.textContent.includes('Sem internet') && t.querySelectorAll('.fq-item').length === 2, 'online de volta: busca de novo e tira o aviso');
  }

  console.log('6. gráfico: alturas em px proporcionais e rótulo de mês com a inicial');
  {
    const serie = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(i => ({ ini: `2026-${String(i % 12 + 1).padStart(2, '0')}-01`, fim: `2026-${String(i % 12 + 1).padStart(2, '0')}-28`, km: i === 11 ? 10000 : 9500 - i * 100, leituras: 1 }));
    const painel = {
      modo: 'mes', ref: '2026-12-01', hoje: '2026-12-21', periodo: { ini: '2026-12-01', fim: '2026-12-31', atual: true }, anterior: { ini: '2026-11-01', fim: '2026-11-30' },
      total: 10000, total_anterior: 8400, variacao_pct: 19, comparacao_parcial: true, dias_decorridos: 21, leituras: 4, veiculos_rodaram: 2, veiculos_ativos: 3,
      contexto: { dia: { km: 1, leituras: 1, ini: '2026-12-01', fim: '2026-12-01' }, semana: { km: 1, leituras: 1, ini: '2026-11-30', fim: '2026-12-06' }, mes: { km: 1, leituras: 1, ini: '2026-12-01', fim: '2026-12-31' } },
      serie, colaboradores: [{ user_id: 'u1', nome: 'Ana', km: 10000, km_anterior: 8400, leituras: 4, ultima_data: '2026-12-20' }], veiculos: [],
    };
    const w = montar({ painel });
    w.__estado.aba = 'painel';
    await w.FrotaPainel.painel(w.document.getElementById('fq-corpo'));
    const alturas = [...w.document.querySelectorAll('.fq-col .b')].map(b => parseInt(b.style.height, 10));
    confere(alturas[11] === 113 && alturas[0] < 113 && new Set(alturas).size === alturas.length, 'barras próximas do máximo ainda se distinguem: ' + alturas.slice(0, 3).join('/') + '…' + alturas[11]);
    confere([...w.document.querySelectorAll('.fq-lab span')].every(s => s.textContent.length === 1), 'eixo de 12 meses usa 1 letra por mês');
    confere(/mesmos 21 dias/.test(w.document.querySelector('.fq-kpis').textContent), 'comparação diz que usa os mesmos dias');
    w.document.querySelector('.fq-rank-item').click();
    confere(w.__estado.chamadas.trocarAba.includes('hist'), 'tocar no ranking abre o histórico');
  }

  console.log('7. quem vê a Frota / KM no menu (regra de 21/10/2026: todos, menos o Contador)');
  {
    const vm = require('vm');
    const app = fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'app.js'), 'utf8');
    const funcao = nome => { const m = app.match(new RegExp('function ' + nome + '\\([^)]*\\)\\s*\\{[^}]*\\}')); if (!m) throw new Error('função não encontrada: ' + nome); return m[0]; };
    const ctx = vm.createContext({ MODULOS_EXTRAS: true, user: null });
    vm.runInContext(['_ehGestorOuAdmin', '_ehContabilidade', '_ehCV', '_veFrota'].map(funcao).join('\n'), ctx);
    const ve = (role, regime) => { ctx.user = { role, regime }; return vm.runInContext('_veFrota()', ctx); };
    confere(ve('colaborador', 'rdm_rda') === true, 'colaborador RDM/RDA vê');
    confere(ve('colaborador', 'cv') === true, 'colaborador C.V. vê');
    confere(ve('colaborador', undefined) === true, 'colaborador sem regime definido (padrão) vê');
    confere(ve('gestor', 'rdm_rda') === true && ve('admin', 'cv') === true, 'gestor e admin veem');
    confere(ve('contabilidade', 'rdm_rda') === false && ve('contabilidade', 'cv') === false, 'Contador não vê, de nenhum regime');
  }

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
