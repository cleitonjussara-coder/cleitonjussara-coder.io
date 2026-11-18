'use strict';
/* Lote 2 da revisão do gestor (build 629, 17/11/2026): achar e navegar.
   - Histórico: filtros por ação e por pessoa, toque na nota abre o histórico dela, "Ver mais" no lugar do corte em 200.
   - Arquivos: dentro do mês as setas andam de mês (e viram o ano em dez → jan); nota sem anexo abre os dados.
   - Rastreio: texto ao lado da bolinha e botões para a ficha e para o Campo.
   Roda os componentes compilados (svelte-historico.js, svelte-arquivos.js) e o rastreio.js de verdade em jsdom.
     node scripts/testar-navegacao-gestor.js */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));
const JS = path.join(__dirname, '..', 'rda-rdm-app', 'js');
const fonte = n => fs.readFileSync(path.join(JS, n), 'utf8');
let falhas = 0;
const confere = (ok, texto) => { console.log(`${ok ? '  ok ' : 'FALHOU'} ${texto}`); if (!ok) falhas++; };
const limpa = t => String(t || '').replace(/\s+/g, ' ').trim();
const espera = (ms = 30) => new Promise(r => setTimeout(r, ms));

function base() {
  const dom = new JSDOM('<main id="app-content"></main>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.eval(`
    var esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    var _at = esc;
    var brl = v => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
    var $ = id => document.getElementById(id);
  `);
  return w;
}

(async () => {
  console.log('Histórico');
  {
    const w = base();
    const agora = Date.now();
    const iso = k => new Date(agora - k * 60000).toISOString();
    const notas = [];
    for (let i = 0; i < 230; i++) notas.push({ id: 'n' + i, user_id: i % 2 ? 'u1' : 'u2', tipo: 'RDM', subtipo: 'Outros', valor: 10 + i, data: '2026-11-10', razao_social: 'Posto ' + i, deleted: i === 5, created_at: iso(i), updated_at: iso(i), created_by: 'u1', updated_by: i === 7 ? 'g1' : (i % 2 ? 'u1' : 'u2') });
    notas[3].updated_at = iso(1); notas[3].created_at = iso(500);   // editada
    const abertas = [];
    w.SB = {
      notas: { list: async () => notas, apagadasDetalhe: async () => [] },
      repasses: { list: async () => [{ id: 'r1', user_id: 'u1', tipo: 'RDM', valor: 50, kind: 'received', created_at: iso(2), updated_at: iso(2), updated_by: 'g1' }] },
      colaboradores: { historico: async () => [] },
      justificativas: { list: async () => [] },
    };
    w.eval(fonte('svelte-historico.js'));
    const el = w.document.getElementById('app-content');
    w.SvelteHistorico.montar(el, { sb: w.SB, user: { id: 'g1', nome: 'Paulo' }, equipePorId: { u1: { nome: 'Romário' }, u2: { nome: 'José' }, g1: { nome: 'Paulo' } },
      brl: w.brl, esc: w.esc, formatarCnpj: x => x, abrirHistoricoNota: id => abertas.push(id) });
    await espera(80);
    const itens = () => el.querySelectorAll('.db-pend-item');
    confere(itens().length === 200, `mostra 200 de início (${itens().length})`);
    const mais = [...el.querySelectorAll('.hist-mais')].map(x => limpa(x.textContent))[0] || '';
    confere(/Mostrando 200 de 231/.test(mais), `avisa o corte: "${mais}"`);
    el.querySelector('.hist-mais button').click(); await espera();
    confere(itens().length === 231, `"Ver mais" mostra o resto (${itens().length})`);
    const chip = rot => [...el.querySelectorAll('.hist-chip')].find(b => b.textContent.startsWith(rot));
    confere(/Apagou 1/.test(chip('Apagou').textContent) && /Editou 1/.test(chip('Editou').textContent), `contagem nos chips: ${[...el.querySelectorAll('.hist-chip')].map(b => limpa(b.textContent)).join(' | ')}`);
    chip('Apagou').click(); await espera();
    confere(itens().length === 1 && /apagou/.test(itens()[0].textContent), 'Apagou mostra só a apagada');
    chip('Todos').click(); await espera();
    const sel = el.querySelector('.hist-filtros select');
    sel.value = 'u2'; sel.dispatchEvent(new w.Event('change', { bubbles: true })); await espera();
    confere(itens().length > 0 && [...itens()].every(i => /José/.test(i.textContent)), `filtro de pessoa: só José (${itens().length})`);
    const linhaNota = el.querySelector('button.db-pend-item');
    linhaNota.click();
    confere(abertas.length === 1 && /^n\d+$/.test(abertas[0]), `tocar na nota abre o histórico dela (${abertas[0]})`);
    sel.value = 'u1'; sel.dispatchEvent(new w.Event('change', { bubbles: true })); await espera();
    const rep = [...itens()].find(i => /recebido/.test(i.textContent));
    confere(!!rep && rep.tagName !== 'BUTTON', 'repasse não vira botão (não tem histórico de nota)');
  }

  console.log('Arquivos');
  {
    const w = base();
    const pedidos = [];
    const notasDe = (ano, mes) => mes ? [
      { id: `a${ano}${mes}`, razao_social: `Posto ${mes}/${ano}`, valor: 100, data: `${ano}-${String(mes).padStart(2, '0')}-05`, grupo: 'RDM · ABASTECIMENTO', foto_path: 'x.jpg', ext: 'jpg' },
      { id: `s${ano}${mes}`, razao_social: 'Sem Anexo', valor: 90, data: `${ano}-${String(mes).padStart(2, '0')}-06`, grupo: 'RDM · ABASTECIMENTO', foto_path: null },
    ] : [];
    const semAnexo = [];
    const dep = {
      sb: { arquivos: {
        resumo: async ano => ({ colaboradores: [{ user_id: 'u1', nome: 'Romário', qtd: 2, total: 190 }] }),
        notas: async (uid, ano, mes) => { pedidos.push(`${ano}-${mes}`); return { notas: notasDe(ano, mes) }; },
      } },
      user: { id: 'g1', nome: 'Paulo' }, esc: w.esc, brl: w.brl, fmtData: d => String(d).split('-').reverse().join('/'), filAno: 2026,
      MESES: ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'],
      MESES_LONGO: ['', 'Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'],
      veEquipe: () => true, toast: () => {}, setLoading: () => {}, voltarRodape: () => {}, carregarAvatares: () => {},
      verFotoCompartilhado: n => semAnexo.push('foto:' + n.id), verNotaSemAnexo: (n, pasta) => semAnexo.push('dados:' + n.id + ':' + pasta.user_id),
    };
    w.eval(fonte('svelte-arquivos.js'));
    const el = w.document.getElementById('app-content');
    w.Arquivos.montar(el, dep); await espera(60);
    w.Arquivos.abrirColab('u1'); await espera(60);
    w.Arquivos.abrirMes(12); await espera(60);
    const rotulo = () => limpa(el.querySelector('.arq-hd .mes-label')?.textContent);
    confere(rotulo() === 'Dez 2026', `cabeçalho do mês: "${rotulo()}"`);
    el.querySelectorAll('.arq-hd .btn-mes-nav')[1].click(); await espera(60);
    confere(rotulo() === 'Jan 2027' && pedidos.at(-1) === '2027-1', `› em dezembro vai para janeiro do ano seguinte: "${rotulo()}" (${pedidos.at(-1)})`);
    el.querySelectorAll('.arq-hd .btn-mes-nav')[0].click(); await espera(60);
    confere(rotulo() === 'Dez 2026', `‹ volta para dezembro: "${rotulo()}"`);
    el.querySelectorAll('.arq-hd .btn-mes-nav')[0].click(); await espera(60);
    confere(rotulo() === 'Nov 2026', `‹ de novo: "${rotulo()}"`);
    el.querySelector('.arq-cat-hd')?.click(); await espera();
    const lin = [...el.querySelectorAll('.arq-lin-abrir')];
    confere(lin.length === 2 && lin.every(b => b.tagName === 'BUTTON'), `as duas linhas são tocáveis (${lin.map(b => b.tagName).join(',')})`);
    lin.find(b => /Sem Anexo/.test(b.textContent)).click();
    lin.find(b => /Posto/.test(b.textContent)).click();
    confere(semAnexo.join() === 'dados:s202611:u1,foto:a202611', `sem anexo abre os dados, com anexo abre o anexo (${semAnexo.join()})`);
  }

  console.log('Rastreio');
  {
    const w = base();
    const hoje = new Date();
    const diasAtras = d => new Date(hoje.getTime() - d * 86400000).toISOString();
    w.eval(`
      var PAPEL_NOME = { colaborador: 'Colaborador' };
      var navegou = [];
      var switchView = v => navegou.push(v);
      var _veCampo = () => true;
      var Gestor = { abrir: id => navegou.push('ficha:' + id) };
      var Campo = { verPessoa: id => navegou.push('campo:' + id) };
      var sb = { colaboradores: { atividade: async () => ({ gerado_em: new Date().toISOString(), equipe: [
        { id: 'u1', nome: 'Romário', role: 'colaborador', ultimo_lancamento_em: '${diasAtras(0)}', visto_em: '${diasAtras(0)}', hoje: 1, recentes: [] },
        { id: 'u2', nome: 'José', role: 'colaborador', ultimo_lancamento_em: '${diasAtras(2)}', visto_em: '${diasAtras(0)}', recentes: [] },
        { id: 'u3', nome: 'Ana', role: 'colaborador', ultimo_lancamento_em: '${diasAtras(9)}', recentes: [] },
      ] }) } };
      var toast = () => {}; var brl = v => 'R$ ' + v;
    `);
    w.eval(fonte('rastreio.js'));
    w.Rastreio.render(); await espera(60);
    const el = w.document.getElementById('app-content');
    const sit = nome => limpa([...el.querySelectorAll('.rs-card')].find(c => c.textContent.includes(nome))?.querySelector('.rs-sit')?.textContent);
    confere(sit('Romário') === 'lançou hoje' && sit('José') === 'há 2 dias' && sit('Ana') === 'há 9 dias', `texto ao lado da bolinha: ${sit('Romário')} | ${sit('José')} | ${sit('Ana')}`);
    w.Rastreio.abrir('u2');
    const bts = [...el.querySelectorAll('.rs-card .rs-ac .rs-bt')].map(b => limpa(b.textContent));
    confere(bts.includes('👤 Abrir a ficha') && bts.includes('📍 Atividade em campo'), `botões no cartão aberto: ${bts.join(' | ')}`);
    w.Rastreio.verFicha('u2'); w.Rastreio.verCampo('u2'); await espera(450);
    confere(w.eval('navegou.join()') === 'equipe,campo,ficha:u2,campo:u2', `vai para a ficha e para o Campo da pessoa (${w.eval('navegou.join()')})`);
  }

  console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo ok');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
