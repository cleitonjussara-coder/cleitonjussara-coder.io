'use strict';
/* Fila da atividade em campo (24/11/2026, caso Romário: a saída ficava presa no celular).
   Roda o campo.js de verdade em jsdom, com o servidor e o IndexedDB simulados.
     node scripts/testar-campo-fila.js */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));
const fonte = fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'campo.js'), 'utf8');
let falhas = 0;
const confere = (ok, t) => { console.log(`${ok ? '  ok ' : 'FALHOU'} ${t}`); if (!ok) falhas++; };
const espera = ms => new Promise(r => setTimeout(r, ms));
const fim = (id, extra = {}) => ({ tipo: 'finalizar', id, dados: { hora: '2026-11-23T14:00:00Z' }, uid: 'u1', erro: null, ...extra });

function abrir(fila, { online = true } = {}) {
  const dom = new JSDOM('<main id="app-content"></main>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'onLine', { configurable: true, get: () => w.__online });
  w.__online = online; w.__meta = { campo_fila: fila }; w.__env = []; w.__responde = async () => ({});
  w.eval(`
    var user = { id: 'u1' }, viewAtual = 'inicio', filAno = 2026, filMes = 11, MESES = [];
    var $ = id => document.getElementById(id), esc = s => String(s), fmtData = d => d, setLoading = () => {}, __toasts = [];
    var toast = t => __toasts.push(t);
    var FusoBR = { TZ: 'America/Sao_Paulo', hora: () => '' };
    var _acompanhaCampo = () => false, _registraCampo = () => true, pedirCampos = async () => null, pedirConfirmacao = async () => true;
    var DB = { getMeta: async k => JSON.parse(JSON.stringify(__meta[k] || null)), setMeta: async (k, v) => { __meta[k] = JSON.parse(JSON.stringify(v)); } };
    var sb = { atividadesCampo: {
      iniciar: async d => { __env.push('iniciar:' + d.id); return __responde('iniciar', d.id); },
      finalizar: async id => { __env.push('finalizar:' + id); return __responde('finalizar', id); } } };
  `);
  w.eval(fonte);
  return w;
}
const erro = (status, message) => Object.assign(new Error(message || 'erro'), { status });

(async () => {
  {
    const w = abrir([fim('a1')]);
    w.dispatchEvent(new w.Event('focus'));
    await espera(50);
    confere(w.__env.includes('finalizar:a1') && w.__meta.campo_fila.length === 0, 'abrir/voltar ao app em qualquer tela envia a saída presa');
    w.close();
  }
  {
    const w = abrir([fim('a1')]);
    w.document.dispatchEvent(new w.Event('visibilitychange'));
    await espera(50);
    confere(w.__env.length === 1, 'voltar do segundo plano também envia');
    w.close();
  }
  {
    const w = abrir([fim('a1')], { online: false });
    w.dispatchEvent(new w.Event('focus')); await espera(30);
    confere(w.__env.length === 0 && w.__meta.campo_fila.length === 1, 'sem internet não envia nem perde');
    w.close();
  }
  {
    const w = abrir([fim('a1', { qid: 'q1' })]);
    let solta; w.__responde = () => new Promise(r => { solta = r; });
    const p = w.Campo.subirFila();
    await espera(20);
    /* enquanto a 1ª sobe, a pessoa registra outra: entra na fila */
    w.__meta.campo_fila.push(fim('a2', { qid: 'q2' }));
    solta({}); await p;
    confere(w.__meta.campo_fila.length === 1 && w.__meta.campo_fila[0].id === 'a2', 'registro feito durante o envio não é apagado');
    w.close();
  }
  {
    const w = abrir([fim('a1', { qid: 'q1' })]);
    w.__responde = async () => { throw erro(503, 'fora do ar'); };
    await w.Campo.subirFila();
    confere(w.__meta.campo_fila.length === 1 && !w.__meta.campo_fila[0].erro, 'servidor fora do ar (503) não vira "recusado"');
    w.__responde = async () => { throw erro(422, 'mais de 24 horas'); };
    await w.Campo.subirFila();
    confere(w.__meta.campo_fila[0].erro === 'mais de 24 horas', 'recusa de verdade (422) fica na fila com o motivo');
    const antes = w.__env.length;
    await w.Campo.subirFila({ auto: true });
    confere(w.__env.length === antes, 'o envio sozinho não insiste no que foi recusado');
    w.close();
  }
  {
    const w = abrir([fim('a1', { qid: 'q1' }), fim('b1', { uid: 'outro', qid: 'q9' })]);
    await w.Campo.subirFila();
    confere(w.__env.join() === 'finalizar:a1' && w.__meta.campo_fila.length === 1 && w.__meta.campo_fila[0].uid === 'outro', 'registro de outra conta do aparelho fica guardado');
    w.close();
  }
  console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
