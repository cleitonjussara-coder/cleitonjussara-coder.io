#!/usr/bin/env node
// Service worker com sinal fraco (27/11/2026, verificação de 26/11, fase 2 item 2) — sem navegador.
//   node scripts/testar-sw-rede-lenta.js
// Roda o sw.js de verdade com caches/fetch simulados e confere o handler de arquivos do app:
// rede lenta + cópia guardada → usa a cópia em ~3 s (e a rede ainda atualiza o cache); sem cópia → espera a rede;
// rede boa → resposta nova; sem rede → cópia guardada.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let falhas = 0;
const confere = (ok, msg) => { console.log((ok ? '  ok  ' : '  FALHOU  ') + msg); if (!ok) falhas++; };
const FONTE = fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'sw.js'), 'utf8');
const ORIGEM = 'https://app.exemplo';
const URL_APP = ORIGEM + '/rda-rdm-app/js/app.js?v=999';

function worker({ atrasoMs, falhaRede = false, guardado = true }) {
  const cache = new Map();
  if (guardado) cache.set(URL_APP.split('?')[0], 'VELHO');
  const ouvintes = {};
  const caches = {
    open: async () => ({ put: async (req, r) => { cache.set(String(req.url || req).split('?')[0], r.corpo); }, match: async () => undefined, addAll: async () => {} }),
    match: async (req, op) => { const k = String(req.url || req).split('?')[0]; return cache.has(k) ? { corpo: cache.get(k), ok: true } : undefined; },
    keys: async () => [], delete: async () => true,
  };
  const resp = corpo => ({ ok: true, status: 200, type: 'basic', corpo, clone() { return resp(corpo); } });
  const sb = {
    console, setTimeout, clearTimeout, URL, Promise, caches,
    importScripts() {},
    fetch: () => new Promise((ok, falha) => setTimeout(() => (falhaRede ? falha(new TypeError('Failed to fetch')) : ok(resp('NOVO'))), atrasoMs)),
    self: null,
  };
  sb.self = { location: { origin: ORIGEM }, registration: { scope: ORIGEM + '/rda-rdm-app/' }, addEventListener: (t, fn) => { ouvintes[t] = fn; }, skipWaiting() {}, clients: { claim() {} } };
  Object.assign(sb, { addEventListener: sb.self.addEventListener, registration: sb.self.registration, location: sb.self.location, clients: sb.self.clients });
  vm.createContext(sb);
  vm.runInContext(FONTE, sb);
  return {
    cache,
    pedir() {
      let resposta, extras = [];
      ouvintes.fetch({ request: { url: URL_APP }, respondWith: p => { resposta = p; }, waitUntil: p => extras.push(p) });
      return { resposta: Promise.resolve(resposta), extras };
    },
  };
}

(async () => {
  {
    const w = worker({ atrasoMs: 8000 });
    const t0 = Date.now();
    const { resposta, extras } = w.pedir();
    const r = await resposta;
    const ms = Date.now() - t0;
    confere(r?.corpo === 'VELHO' && ms < 3600, `rede lenta: usa a cópia guardada em ${ms} ms (antes esperava a rede)`);
    await Promise.all(extras); await new Promise(ok => setTimeout(ok, 20));
    confere(w.cache.get(URL_APP.split('?')[0]) === 'NOVO', 'a rede lenta ainda atualiza a cópia para a próxima abertura');
  }
  {
    const w = worker({ atrasoMs: 4000, guardado: false });
    const r = await w.pedir().resposta;
    confere(r?.corpo === 'NOVO', 'sem cópia guardada: espera a rede');
  }
  {
    const w = worker({ atrasoMs: 30 });
    const r = await w.pedir().resposta;
    confere(r?.corpo === 'NOVO', 'rede boa: resposta nova');
  }
  {
    const w = worker({ atrasoMs: 30, falhaRede: true });
    const r = await w.pedir().resposta;
    confere(r?.corpo === 'VELHO', 'sem rede: cópia guardada');
  }
  console.log(falhas ? `\n${falhas} caso(s) FALHARAM` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('ERRO NO TESTE:', e); process.exit(1); });
