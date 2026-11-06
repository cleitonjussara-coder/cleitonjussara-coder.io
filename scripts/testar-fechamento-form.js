'use strict';
/* Fechamento de mês no formulário (06/11/2026): roda o rda-rdm-app/js/fechamento.js de verdade, em jsdom.
   Cobre o que a revisão achou: nota que ainda não chegou ao servidor não trava, e salvar e excluir não esperam a rede.
     node scripts/testar-fechamento-form.js */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));

const FONTE = fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'fechamento.js'), 'utf8');
let falhas = 0;
const confere = (ok, texto) => { console.log(`${ok ? '  ok ' : 'FALHOU'} ${texto}`); if (!ok) falhas++; };
const pausa = ms => new Promise(r => setTimeout(r, ms));

async function tela({ fechados = ['2026-10'], gestor = false, lista = null, online = true, data = '2026-10-20' } = {}) {
  const dom = new JSDOM(`<input id="nf-data" value="${data}"><button id="nf-btn-salvar"></button>
    <div id="nf-fechamento" style="display:none"><b id="nf-fech-titulo"></b><p id="nf-fech-texto"></p><button id="nf-fech-reabrir"></button></div>`, { runScripts: 'outside-only' });
  const w = dom.window;
  const avisos = [];
  Object.defineProperty(w.navigator, 'onLine', { value: online, configurable: true });
  Object.assign(w, {
    $: id => w.document.getElementById(id),
    sb: { fechamento: { lista: () => (lista ? lista() : Promise.resolve({ fechados: fechados.map(k => ({ ano: +k.slice(0, 4), mes: +k.slice(5) })) })) } },
    DB: { getMeta: async () => fechados, setMeta: async () => {} },
    FusoBR: {}, mostrarAviso: async m => { avisos.push(m); }, _ehGestorOuAdmin: () => gestor,
  });
  w.eval(FONTE);
  return {
    w, F: w.Fechamento, avisos,
    salvar: () => w.$('nf-btn-salvar').style.display,
    banner: () => w.$('nf-fechamento').style.display,
    texto: () => w.$('nf-fech-texto').textContent,
  };
}

const FALHOU = { id: 'n1', data: '2026-10-20', synced: false, sync_status: 'failed', sync_error: 'Anexo vazio (0 KB)' };
const ENVIADA = { id: 'n2', data: '2026-10-20', synced: true, sync_status: 'synced', server_updated_at: 'S1' };

(async () => {
  console.log('Nota que o servidor ainda não tem');
  for (const [nome, nota] of [['em falhou', FALHOU], ['pendente', { ...FALHOU, sync_status: 'pending', sync_error: null }]]) {
    const t = await tela();
    await t.F.atualizar();
    t.F.abrirForm(nota);
    await pausa(0);
    confere(t.salvar() !== 'none', `${nome}: abre com Salvar`);
    confere(t.banner() === 'flex' && /conferência/.test(t.texto()), `${nome}: aviso é o de nota nova`);
    confere(await t.F.conferirAoSalvar() === true, `${nome}: salva`);
    confere(await t.F.barrarNotas([nota]) === false, `${nome}: pode excluir`);
  }
  {
    const t = await tela({ data: '2026-11-03' });
    await t.F.atualizar();
    t.F.abrirForm({ ...FALHOU, data: '2026-11-03' });
    await pausa(0);
    t.w.$('nf-data').value = '2026-10-20';
    confere(await t.F.conferirAoSalvar() === true, 'mover nota não enviada para mês fechado salva, como nota nova');
    confere(t.salvar() !== 'none', 'e o Salvar continua na tela');
  }

  console.log('Nota que já está no servidor segue travada');
  for (const [nome, nota] of [
    ['enviada', ENVIADA],
    ['editada aqui, à espera de subir', { ...ENVIADA, synced: false, sync_status: 'pending' }],
    ['aberta pela Equipe, sem campos do aparelho', { id: 'n3', data: '2026-10-20' }],
  ]) {
    const t = await tela();
    await t.F.atualizar();
    t.F.abrirForm(nota);
    await pausa(0);
    confere(t.salvar() === 'none', `${nome}: abre sem Salvar`);
    confere(await t.F.conferirAoSalvar() === false, `${nome}: não salva`);
    confere(await t.F.barrarNotas([nota]) === true, `${nome}: não exclui`);
  }
  {
    const t = await tela({ data: '2026-11-03' });
    await t.F.atualizar();
    t.F.abrirForm({ ...ENVIADA, data: '2026-11-03' });
    await pausa(0);
    t.w.$('nf-data').value = '2026-10-20';
    confere(await t.F.conferirAoSalvar() === false, 'nota enviada não vai para mês fechado');
  }
  {
    const t = await tela({ gestor: true });
    await t.F.atualizar();
    t.F.abrirForm(ENVIADA);
    await pausa(0);
    confere(t.w.$('nf-fech-reabrir').style.display !== 'none', 'gestor vê Reabrir na nota travada');
    t.F.abrirForm(FALHOU);
    await pausa(0);
    confere(t.w.$('nf-fech-reabrir').style.display === 'none', 'na nota não enviada não há o que reabrir');
  }
  {
    const t = await tela();
    await t.F.atualizar();
    t.F.abrirForm({});
    await pausa(0);
    confere(t.salvar() !== 'none' && await t.F.conferirAoSalvar() === true, 'nota nova sem id continua salvando');
  }

  console.log('Salvar e excluir não esperam a rede');
  {
    let pedidos = 0;
    const t = await tela({ lista: () => { pedidos++; return new Promise(() => {}); } });
    t.F.abrirForm(ENVIADA);
    const parou = await Promise.race([
      (async () => { for (let i = 0; i < 3; i++) await t.F.conferirAoSalvar(); await t.F.barrarNotas([ENVIADA]); return false; })(),
      pausa(200).then(() => true),
    ]);
    confere(!parou, 'servidor que nunca responde não segura Salvar nem excluir');
    confere(pedidos >= 1, 'a pergunta ao servidor sai mesmo assim');
    confere(await t.F.barrarNotas([ENVIADA]) === true, 'e vale a lista guardada');
  }
  {
    const t = await tela({ online: false, fechados: [] });
    t.F.abrirForm(ENVIADA);
    confere(await t.F.conferirAoSalvar() === true, 'sem rede e sem lista, salva: o servidor decide depois');
  }
  {
    /* a resposta atrasada não se perde: a próxima abertura já enxerga */
    let responde;
    const t = await tela({ fechados: [], lista: () => new Promise(r => { responde = r; }) });
    await t.F.conferirAoSalvar();
    await pausa(0);
    responde({ fechados: [{ ano: 2026, mes: 10 }] });
    await pausa(0);
    confere(t.F.estaFechado('2026-10-20'), 'resposta atrasada atualiza a lista');
  }

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
