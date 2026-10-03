#!/usr/bin/env node
/* Teste de carga da API — simula a equipe inteira usando o app ao mesmo tempo.
 *
 * SÓ contra a homologação (o script recusa qualquer URL que não seja
 * teste/localhost). Roteiro completo: scripts/carga/LEIA-ME.md
 *
 *   node scripts/carga/teste-carga.mjs --tokens carga-tokens.json \
 *        [--url https://api.pmservicosagronomicos.com.br/teste/api] \
 *        [--n 80] [--notas 6] [--janela 30] [--planilhas 2] [--simultaneas 25]
 *
 * Fases:
 *   1 abertura   — todos abrem o app: /me, /notas, /repasses
 *   2 fechamento — todos lançam `notas` notas com foto, espalhados na `janela` (s)
 *   3 planilhas  — o gestor gera `planilhas` relatórios RDM/RDA ao mesmo tempo
 *                  enquanto 20 aparelhos continuam sincronizando
 * Em paralelo, uma sonda faz GET /ping a cada 500 ms: é o que um colaborador
 * sentiria se abrisse o app naquele instante.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const aqui = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

const URL_API = arg('url', 'https://api.pmservicosagronomicos.com.br/teste/api').replace(/\/$/, '');
const N = +arg('n', 80);
const NOTAS = +arg('notas', 6);
const JANELA = +arg('janela', 30) * 1000;
const PLANILHAS = +arg('planilhas', 2);
const SIMULT = +arg('simultaneas', 0);   // 0 = sem limite; o nginx da Locaweb devolve 429 acima de ~50 requisições simultâneas do MESMO IP
const ARQ_TOKENS = arg('tokens', join(aqui, 'carga-tokens.json'));

const host = new URL(URL_API).hostname;
if (!/(^|[.-])teste([.-]|$)|^localhost$|^127\.0\.0\.1$/.test(host) && !URL_API.includes('/teste/')) {
  console.error(`RECUSADO: ${URL_API} não parece homologação. Este teste nunca roda em produção.`);
  process.exit(1);
}

const tokens = JSON.parse(readFileSync(ARQ_TOKENS, 'utf8'));
const gestor = tokens.find(t => t.role === 'gestor');
const colabs = tokens.filter(t => t.role === 'colaborador').slice(0, N);
if (!gestor || !colabs.length) { console.error('Tokens sem gestor/colaboradores — rode carga:preparar.'); process.exit(1); }
const foto = readFileSync(join(aqui, 'foto-exemplo.jpg'));

const dormir = ms => new Promise(r => setTimeout(r, ms));
const hojeSP = () => new Date(Date.now() - 3 * 3600e3);

/* ── medição ─────────────────────────────────────────────── */
const fases = {};
let faseAtual = 'inicio';
const reg = (fase, rotulo, ms, status) => {
  const f = (fases[fase] ??= {});
  (f[rotulo] ??= []).push({ ms, status });
};

let emVoo = 0; const fila = [];
async function vaga() { if (!SIMULT) return; while (emVoo >= SIMULT) await new Promise(r => fila.push(r)); emVoo++; }
function solta() { if (!SIMULT) return; emVoo--; fila.shift()?.(); }

async function chamar(rotulo, t, metodo, caminho, corpo, extra = {}) {
  const fase = faseAtual;
  await vaga();
  const ini = performance.now();
  let status = 0;
  try {
    const r = await fetch(URL_API + caminho, {
      method: metodo,
      headers: { Authorization: 'Bearer ' + t.token, Accept: 'application/json', ...(corpo && !(corpo instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? (corpo instanceof FormData ? corpo : JSON.stringify(corpo)) : undefined,
      signal: AbortSignal.timeout(extra.timeout ?? 120000),
    });
    status = r.status;
    await r.arrayBuffer();
  } catch (e) {
    status = e.name === 'TimeoutError' ? -1 : -2;   // -1 estourou o tempo, -2 falha de rede
  }
  solta();
  reg(fase, rotulo, performance.now() - ini, status);
  return status;
}

/* sonda: GET /ping sem login */
let sondando = true;
async function sonda() {
  while (sondando) {
    const fase = faseAtual, ini = performance.now();
    let status = 0;
    try { status = (await fetch(URL_API + '/ping', { signal: AbortSignal.timeout(30000) })).status; }
    catch (e) { status = e.name === 'TimeoutError' ? -1 : -2; }
    reg(fase, 'sonda /ping', performance.now() - ini, status);
    await dormir(500);
  }
}

/* ── fases ───────────────────────────────────────────────── */
async function abertura() {
  await Promise.all(colabs.map(async t => {
    await chamar('GET /me', t, 'GET', '/me');
    await chamar('GET /notas', t, 'GET', '/notas?ano=' + hojeSP().getUTCFullYear());
    await chamar('GET /repasses', t, 'GET', '/repasses');
  }));
}

async function lancar(t, i) {
  await dormir(Math.random() * JANELA);
  for (let k = 0; k < NOTAS; k++) {
    const id = randomUUID();
    const fd = new FormData();
    fd.append('file', new Blob([foto], { type: 'image/jpeg' }), id + '.jpg');
    fd.append('ext', 'jpg');
    fd.append('user_id', t.id);
    const s = await chamar('POST foto', t, 'POST', `/notas/${id}/foto`, fd);
    if (s >= 400 || s <= 0) continue;   // o app também não grava a nota sem a foto
    const d = new Date(hojeSP().getTime() - Math.floor(Math.random() * 10) * 864e5);
    await chamar('PUT nota', t, 'PUT', `/notas/${id}`, {
      user_id: t.id, tipo: k % 2 ? 'RDA' : 'RDM', subtipo: k % 2 ? null : 'Outros',
      pagamento: 'carteira', cnpj: '11222333000181', razao_social: 'EMPRESA DE TESTE LTDA',
      valor: +(20 + Math.random() * 480).toFixed(2), data: d.toISOString().slice(0, 10),
      mes: d.getUTCMonth() + 1, ano: d.getUTCFullYear(), metodo_captura: 'manual', documento: 'outro',
    });
    await dormir(500 + Math.random() * 1500);   // tempo de digitar a próxima
  }
  await chamar('GET /notas (sync)', t, 'GET', '/notas?since=' + new Date(Date.now() - 3600e3).toISOString());
}

async function planilhas() {
  const ano = hojeSP().getUTCFullYear();
  let rodando = true;
  const fundo = Promise.all(colabs.slice(0, 20).map(async t => {
    while (rodando) { await chamar('GET /notas (sync)', t, 'GET', '/notas?since=' + new Date(Date.now() - 3600e3).toISOString()); await dormir(2000); }
  }));
  await Promise.all(Array.from({ length: PLANILHAS }, (_, i) =>
    chamar('GET rdmrda (planilha)', gestor, 'GET', `/relatorio/rdmrda?ano=${ano}&user_id=${colabs[i % colabs.length].id}`, null, { timeout: 240000 })));
  rodando = false;
  await fundo;
}

/* ── relatório ───────────────────────────────────────────── */
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0;
const fmt = ms => ms >= 10000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';

function relatorio(durTotal) {
  const L = [`# Teste de carga — ${new Date().toLocaleString('pt-BR')}`, '',
    `API: \`${URL_API}\` · ${colabs.length} colaboradores · ${NOTAS} notas cada (janela ${JANELA / 1000}s) · ${PLANILHAS} planilhas simultâneas · duração ${(durTotal / 1000).toFixed(0)} s`, ''];
  let falhas = 0, lento = 0;
  for (const [fase, rots] of Object.entries(fases)) {
    L.push(`## Fase: ${fase}`, '', '| Chamada | Qtde | OK | Erros | p50 | p95 | Máx |', '|---|---|---|---|---|---|---|');
    for (const [rot, v] of Object.entries(rots)) {
      const ok = v.filter(x => x.status >= 200 && x.status < 300);
      const erros = v.length - ok.length;
      const ms = ok.map(x => x.ms).sort((a, b) => a - b);
      const cods = {};
      v.filter(x => !(x.status >= 200 && x.status < 300)).forEach(x => cods[x.status] = (cods[x.status] || 0) + 1);
      L.push(`| ${rot} | ${v.length} | ${ok.length} | ${erros}${erros ? ' (' + Object.entries(cods).map(([c, n]) => `${c}×${n}`).join(' ') + ')' : ''} | ${fmt(pct(ms, .5))} | ${fmt(pct(ms, .95))} | ${fmt(ms.at(-1) ?? 0)} |`);
      if (rot !== 'sonda /ping' && rot !== 'GET rdmrda (planilha)') falhas += erros;
      if (rot === 'sonda /ping' && pct(ms, .95) > 2000) lento++;
    }
    L.push('');
  }
  L.push('## Leitura', '',
    '- **Erros 5xx / -1 / -2** em POST foto ou PUT nota = a hospedagem não aguentou a rajada (processos esgotados, banco travado ou tempo estourado).',
    '- **Erro 429** = o limite de requisições do Laravel/servidor, não falta de capacidade.',
    '- **Sonda /ping com p95 alto** durante a fase 3 = a planilha está segurando os processos e o app fica lento para todo mundo.',
    '- Meta sugerida para ficar na hospedagem atual: zero erros nas fases 1–2 e `sonda /ping` p95 < 2 s em todas as fases.', '',
    falhas === 0 && !lento ? '**Veredito automático: passou nos critérios.**' : `**Veredito automático: NÃO passou** (${falhas} erros em lançamento/sync; ${lento} fase(s) com sonda lenta).`);
  return L.join('\n');
}

/* ── execução ────────────────────────────────────────────── */
const t0 = performance.now();
const sondaP = sonda();
console.log(`Alvo: ${URL_API} — ${colabs.length} colaboradores`);
faseAtual = '1 abertura'; console.log('Fase 1: abertura do app…'); await abertura();
faseAtual = '2 fechamento'; console.log(`Fase 2: ${colabs.length * NOTAS} notas com foto em ${JANELA / 1000} s…`); await Promise.all(colabs.map(lancar));
faseAtual = '3 planilhas'; console.log(`Fase 3: ${PLANILHAS} planilhas RDM/RDA simultâneas + sync…`); await planilhas();
sondando = false; await sondaP;

const md = relatorio(performance.now() - t0);
const saida = join(aqui, `resultado-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`);
writeFileSync(saida, md);
console.log('\n' + md + `\n\nSalvo em ${saida}`);
