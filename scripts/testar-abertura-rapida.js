#!/usr/bin/env node
// Abertura do app com sinal fraco (27/11/2026, verificação de 26/11, fase 2 item 1) — sem navegador e sem servidor.
//   node scripts/testar-abertura-rapida.js
// Carrega o api.js de verdade com um fetch que demora. Com perfil guardado, o auth.init() não pode esperar o /me
// mais de ~2,5 s; sem perfil guardado (1º acesso) espera como antes; 401 que chega depois ainda derruba a sessão.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let falhas = 0;
const confere = (ok, msg) => { console.log((ok ? '  ok  ' : '  FALHOU  ') + msg); if (!ok) falhas++; };
const FONTE = fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'api.js'), 'utf8');
const PERFIL = { id: 'u1', nome: 'Ana', role: 'colaborador', confirmado_em: '2026-10-01' };

function carregar({ guardado, atrasoMs, status = 200, corpo = { ...PERFIL, nome: 'Ana Nova' } }) {
  const ls = new Map(Object.entries(guardado || {}));
  const eventos = [];
  const sb = {
    console, setTimeout, clearTimeout, AbortController, URLSearchParams,
    location: { hostname: 'app.exemplo', hash: '', search: '', pathname: '/' },
    history: { replaceState() {} },
    localStorage: { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) },
    fetch: (url, op) => new Promise((ok, falha) => {
      const t = setTimeout(() => ok({ status, ok: status < 300, headers: { get: () => null }, text: async () => JSON.stringify(corpo) }), atrasoMs);
      op?.signal?.addEventListener?.('abort', () => { clearTimeout(t); const e = new Error('abort'); e.name = 'AbortError'; falha(e); });
    }),
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(FONTE, sb);
  sb.API.auth.onChange(ev => eventos.push(ev));
  return { API: sb.API, ls, eventos };
}
const espera = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  {
    const a = carregar({ guardado: { api_token: 't1', api_user: JSON.stringify(PERFIL) }, atrasoMs: 10_000 });
    const t0 = Date.now();
    const boot = await a.API.auth.init();
    const ms = Date.now() - t0;
    confere(ms < 3200, `com perfil guardado e /me lento, abre em ${ms} ms (antes esperava até 30 s)`);
    confere(boot.user?.id === 'u1', 'abre com o perfil guardado');
  }
  {
    const a = carregar({ guardado: { api_token: 't1', api_user: JSON.stringify(PERFIL) }, atrasoMs: 50 });
    const boot = await a.API.auth.init();
    confere(boot.user?.nome === 'Ana Nova', 'com rede boa, usa o perfil novo do servidor');
  }
  {
    const a = carregar({ guardado: { api_token: 't1' }, atrasoMs: 3500 });
    const boot = await a.API.auth.init();
    confere(boot.user?.nome === 'Ana Nova', '1º acesso (sem perfil guardado) espera o servidor');
  }
  {
    const a = carregar({ guardado: { api_token: 't1', api_user: JSON.stringify(PERFIL) }, atrasoMs: 3000, status: 401, corpo: { message: 'Unauthenticated.' } });
    const boot = await a.API.auth.init();
    confere(boot.user?.id === 'u1', 'token vencido: abre com o perfil guardado...');
    await espera(800);
    confere(!a.ls.has('api_token') && a.eventos.includes('SIGNED_OUT'), '...e o 401 que chega depois derruba a sessão (volta ao login)');
  }
  console.log(falhas ? `\n${falhas} caso(s) FALHARAM` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('ERRO NO TESTE:', e); process.exit(1); });
