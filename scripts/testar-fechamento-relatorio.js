'use strict';
/* Nota que aguarda conferência nos relatórios do app (06/11/2026): roda fechamento.js, excel.js e gestor.js de verdade, em jsdom.
   O Excel e o CSV ficam sem a nota e dizem isso; a ficha mostra o dinheiro real e avisa. Só a SheetJS é falsa: ela vem da internet.
     node scripts/testar-fechamento-relatorio.js */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));

const JS = path.join(__dirname, '..', 'rda-rdm-app', 'js');
const fonte = n => fs.readFileSync(path.join(JS, n), 'utf8');
let falhas = 0;
const confere = (ok, texto) => { console.log(`${ok ? '  ok ' : 'FALHOU'} ${texto}`); if (!ok) falhas++; };

const nota = (id, valor, campos = {}) => ({ id, user_id: 'u1', tipo: 'RDM', subtipo: 'Outros', valor, data: '2026-10-20', mes: 10, ano: 2026, deleted: false, pagamento: null, ...campos });
const reter = n => ({ id: n.id, user_id: n.user_id, ano: n.ano, mes: n.mes, valor: n.valor, tipo: n.tipo, pagamento: n.pagamento });

function montar({ aguardando = [], online = true, guardada = [], falhaServidor = false } = {}) {
  const dom = new JSDOM('<main id="app-content"></main>', { runScripts: 'outside-only' });
  const w = dom.window;
  const arquivos = [];
  const meta = { notas_aguardando: guardada };
  Object.defineProperty(w.navigator, 'onLine', { value: online, configurable: true });
  const cel = ({ r, c }) => `${String.fromCharCode(65 + c)}${r + 1}`;
  w.XLSX = {
    utils: {
      encode_cell: cel, encode_col: c => String.fromCharCode(65 + c),
      encode_range: ({ s, e }) => `${cel(s)}:${cel(e)}`, decode_range: x => x,
      book_new: () => ({ abas: {} }), book_append_sheet: (wb, ws, nome) => { wb.abas[nome] = ws; },
      aoa_to_sheet: linhas => ({ linhas }),
    },
    writeFile: (wb, nome) => arquivos.push({ wb, nome }),
  };
  w.eval(`
    var MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    var MESES_LONGO = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    var esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    var _at = esc;
    var brl = v => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
    var ini = () => 'X';
    var toast = () => {};
    var setLoading = () => {};
    var BrasilAPI = { paraPlanilha: c => c || '' };
    var FusoBR = { data: () => '06/11/2026', hora: () => '12:00', partes: () => ({ ano: 2026, mes: 11, dia: 6 }), hojeISO: () => '2026-11-06' };
    var $ = id => document.getElementById(id);
    var _ehGestorOuAdmin = () => true;
  `);
  w.DB = { getMeta: async k => meta[k], setMeta: async (k, v) => { meta[k] = v; } };
  w.sbAguardando = async () => { if (falhaServidor) throw new Error('fora do ar'); return { notas: aguardando }; };
  w.eval('var sb = { fechamento: { aguardando: () => window.sbAguardando(), lista: async () => ({ fechados: [] }) } };');
  w.eval(fonte('fechamento.js'));
  w.eval(fonte('excel.js'));
  { const app = fonte('app.js'); w.eval(app.slice(app.indexOf('const CATEGORIAS_CV = ['), app.indexOf('/* ─── Resumo de gastos e saldo devedor')).replace(/^const /gm, 'var ')); }   // a ficha usa as categorias do app.js
  w.eval(fonte('gestor.js') + ';window.Gestor = Gestor;');
  return { w, arquivos, meta };
}

/* mesma conta do app.js, recortada do arquivo: se o app mudar, o teste vê */
function comExportacoes(w, notas, user) {
  const a = fonte('app.js');
  const i = a.indexOf('async function _notasParaRelatorio');
  const f = a.indexOf('/* ── Boot', i);
  w.notasApp = notas;
  w.userApp = user;
  w.repassesApp = [];
  w.eval(`var notas = window.notasApp, user = window.userApp, repasses = window.repassesApp, filAno = 2026, filMes = 10;
    ${a.slice(i, f)}; window.exportCSV = exportCSV; window.exportExcel = exportExcel;`);
}

const textoDe = ws => Object.values(ws).filter(c => c && c.t === 's').map(c => c.v).join(' | ');

(async () => {
  const presa = nota('presa', 287.49);
  const velha = nota('velha', 50, { data: '2025-12-20', mes: 12, ano: 2025 });
  const normal = nota('normal', 100);

  console.log('Frase e recorte');
  {
    const { w } = montar();
    const F = w.Fechamento;
    confere(F.frase([presa, nota('x', 0)], 'nesta planilha') === '2 notas (R$ 287,49) aguardam conferência e não entram nesta planilha', 'plural, igual ao servidor');
    confere(F.frase([presa], 'neste relatório') === '1 nota (R$ 287,49) aguarda conferência e não entra neste relatório', 'singular');
    const a = F.avisos([presa, velha].map(reter), { ano: 2026 });
    confere(a.length === 2 && /de anos anteriores aguarda conferência e não entra no saldo do ano anterior/.test(a[1]), 'o saldo trazido tem frase própria');
    confere(F.avisos([presa].map(reter), { ano: 2026, mes: 9 }).length === 0, 'mês do relatório sem a nota: sem aviso');
    confere(F.avisos([nota('e', 9, { pagamento: 'empresa' })].map(reter), { ano: 2026 }).length === 0, 'Faturamento não conta no aviso de colaborador');
    confere(F.avisos([presa].map(reter), { ano: 2026, ids: ['outro'] }).length === 0, 'nota de outra pessoa não conta');
  }

  console.log('Excel anual e CSV do colaborador');
  {
    const { w, arquivos } = montar({ aguardando: [presa, velha].map(reter) });
    comExportacoes(w, [normal, presa], { id: 'u1', nome: 'Ana' });
    w.Gestor.aberturaAnual = async (_sb, _id, _ano, fora) => { w.foraRecebido = fora; return { RDM: 0, RDA: 0 }; };
    await w.exportExcel();
    const resumo = arquivos[0].wb.abas.RESUMO;
    const t = textoDe(resumo);
    confere(/1 nota \(R\$ 287,49\) aguarda conferência e não entra nesta planilha/.test(t), 'o RESUMO avisa');
    confere(/de anos anteriores aguarda/.test(t), 'e fala do saldo trazido');
    const out = Object.values(resumo).find(c => c && c.v === 'Out');
    const linha = Object.keys(resumo).find(k => resumo[k] === out).slice(1);
    confere(resumo[`B${linha}`].v === 100, `outubro soma só o que entra (deu ${resumo[`B${linha}`].v})`);
    confere(resumo['!autofilter'].ref.startsWith('A6:'), `o filtro acompanha o cabeçalho (${resumo['!autofilter'].ref})`);
    confere(w.foraRecebido.has('velha'), 'a abertura do ano recebe quem ficou de fora');
    confere(w.notasApp.length === 2, 'a lista da tela continua com a nota');

    await w.exportCSV();
    const linhas = arquivos[1].wb.abas.Out.linhas;
    confere(linhas[1][0] === '1 nota (R$ 287,49) aguarda conferência e não entra neste arquivo', 'o CSV avisa');
    confere(linhas.filter(l => l[0] === 'RDM').length === 1, 'e tem uma nota só');
  }
  {
    const { w, arquivos } = montar();
    comExportacoes(w, [normal, presa], { id: 'u1', nome: 'Ana' });
    w.Gestor.aberturaAnual = async () => ({ RDM: 0, RDA: 0 });
    await w.exportExcel();
    const resumo = arquivos[0].wb.abas.RESUMO;
    confere(!/aguarda/.test(textoDe(resumo)), 'sem pendência não há aviso');
    confere(resumo['!autofilter'].ref.startsWith('A4:'), 'e o arquivo fica como antes');
  }

  console.log('Sem rede vale a última lista');
  {
    const { w } = montar({ online: false, guardada: [reter(presa)] });
    confere((await w.Fechamento.aguardando()).length === 1, 'offline usa a guardada');
    const b = montar({ falhaServidor: true, guardada: [reter(presa)] });
    confere((await b.w.Fechamento.aguardando()).length === 1, 'servidor fora do ar usa a guardada');
    const c = montar({ aguardando: [] , guardada: [reter(presa)] });
    confere((await c.w.Fechamento.aguardando()).length === 0, 'com rede vale a do servidor: conferida sai');
    confere((await c.w.DB.getMeta('notas_aguardando')).length === 0, 'e a guardada acompanha');
  }

  const colabs = [{ id: 'u1', nome: 'Ana', email: 'a@x', role: 'colaborador', regime: 'rdm_rda', nucleo: 'N1' }, { id: 'c1', nome: 'Bia', email: 'b@x', role: 'colaborador', regime: 'cv', nucleo: 'N1' }];
  const ncv = nota('cv-ok', 100, { user_id: 'c1', pagamento: 'cv' });
  const presaCv = nota('cv-presa', 30, { user_id: 'c1', pagamento: 'cv' });
  const deSetembro = nota('rdm-out', 40, { data: '2026-09-20', mes: 9 });
  const todas = [normal, presa, ncv, presaCv, deSetembro];

  console.log('Excel da equipe');
  {
    const { w, arquivos } = montar({ aguardando: [presa, presaCv, deSetembro].map(reter) });
    const local = { notas: { list: async () => todas }, repasses: { list: async () => [] }, colaboradores: { list: async () => colabs } };
    await w.Gestor.exportEquipeExcel(local, { nome: 'Gestor' }, 10, 2026);
    const ws = arquivos[0].wb.abas.EQUIPE;
    const t = textoDe(ws);
    confere(/2 notas \(R\$ 317,49\) aguardam conferência e não entram neste relatório/.test(t), 'avisa com a soma da equipe');
    confere(/1 nota \(R\$ 40,00\) de meses anteriores aguarda/.test(t), 'e fala do saldo trazido');
    const cab = Object.keys(ws).find(k => ws[k]?.v === 'Núcleo').slice(1);
    const lin = Number(cab) + 1;
    confere(ws[`D${lin}`].v === 100, `gasto RDM de Ana sem a nota (deu ${ws[`D${lin}`].v})`);
    confere(ws[`C${lin}`].v === 0, `anterior sem a nota de setembro (deu ${ws[`C${lin}`].v})`);
    const cvCab = Object.keys(ws).find(k => ws[k]?.v === 'Cartão Ano Anterior').slice(1);
    confere(ws[`E${Number(cvCab) + 1}`].v === 100, `C.V.: gasto do cartão sem a nota (deu ${ws[`E${Number(cvCab) + 1}`].v})`);
  }
  {
    const { w, arquivos } = montar({ aguardando: [reter(presa)] });
    const local = { notas: { list: async () => todas }, repasses: { list: async () => [] }, colaboradores: { list: async () => colabs } };
    await w.Gestor.exportEquipeExcel(local, { nome: 'Gestor' }, 10, 2026, ['c1']);
    confere(!/aguarda/.test(textoDe(arquivos[0].wb.abas.EQUIPE)), 'quem não foi marcado no seletor não entra no aviso');
  }
  {
    const { w, arquivos } = montar();
    const local = { notas: { list: async () => todas }, repasses: { list: async () => [] }, colaboradores: { list: async () => colabs } };
    await w.Gestor.exportEquipeExcel(local, { nome: 'Gestor' }, 10, 2026);
    const ws = arquivos[0].wb.abas.EQUIPE;
    confere(!/aguarda/.test(textoDe(ws)), 'sem pendência não há aviso');
    confere(ws.A4?.v === 'Núcleo', 'e o cabeçalho fica na linha de sempre');
  }

  console.log('Ficha da Equipe');
  {
    const ficha = async aguardando => {
      const { w } = montar({ aguardando });
      const colab = { id: 'u1', nome: 'Ana', email: 'a@x', role: 'colaborador', regime: 'rdm_rda' };
      const lista = async q => [normal, presa].filter(n => (!q.mes || n.mes === q.mes));
      const sb = { notas: { list: lista }, repasses: { list: async () => [] }, colaboradores: { get: async () => colab } };
      const el = w.document.createElement('div');
      w.document.body.appendChild(el);
      w.Gestor.abrir('u1');
      await w.Gestor.renderDashboard(el, sb, { id: 'g1', role: 'gestor', nome: 'Gestor' }, () => {}, { mes: 10, ano: 2026 });
      return el;
    };
    const com = await ficha([reter(presa)]);
    const t = com.textContent.replace(/\s+/g, ' ');
    confere(/1 nota \(R\$ 287,49\) aguarda conferência e não entra na planilha/.test(t), 'avisa a divergência');
    confere(com.querySelector('.cdet-bal-val').textContent.includes('387,49'), `e o saldo segue real (${com.querySelector('.cdet-bal-val').textContent})`);
    const sem = await ficha([]);
    confere(!/aguarda conferência/.test(sem.textContent), 'sem pendência a ficha não avisa');
    const deOutro = await ficha([reter(nota('y', 9, { user_id: 'outra' }))]);
    confere(!/aguarda conferência/.test(deOutro.textContent), 'nota de outra pessoa não avisa nesta ficha');
    const doAnoSeguinte = await ficha([reter(nota('z', 9, { ano: 2027, data: '2027-01-02', mes: 1 }))]);
    confere(!/aguarda conferência/.test(doAnoSeguinte.textContent), 'nota de ano depois do aberto não muda esta planilha');
    /* 06/11/2026: Faturamento fica fora do saldo da ficha e da planilha do colaborador, então não cria diferença entre os dois */
    const faturamento = reter(nota('fat', 500, { pagamento: 'empresa' }));
    const soFaturamento = await ficha([faturamento]);
    confere(!/aguarda conferência/.test(soFaturamento.textContent), 'nota de Faturamento retida não avisa');
    const misturadas = (await ficha([reter(presa), faturamento])).textContent.replace(/\s+/g, ' ');
    confere(/1 nota \(R\$ 287,49\) aguarda conferência e não entra na planilha/.test(misturadas), 'com as duas, conta só a que muda a planilha');
  }

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
