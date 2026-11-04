#!/usr/bin/env node
// Detecção do papel com fundo mais claro que a nota (print de 04/11/2026: piso branco no canto, cupom no meio da mesa).
//   node scripts/testar-papel-fundo-claro.js
// Scanner.achar e Recorte._papelPorCor são cálculo puro: rodam aqui sem navegador. Sai com código 1 se algum caso falhar.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const js = n => fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', n), 'utf8');
const ctx = { window: {}, document: {}, console };
vm.createContext(ctx);
vm.runInContext(js('scanner.js'), ctx);
vm.runInContext(js('recorte.js'), ctx);
const { Scanner, Recorte } = ctx.window;
let falhas = 0;
const confere = (ok, msg) => { console.log((ok ? '  ok  ' : '  FALHOU  ') + msg); if (!ok) falhas++; };

const W = 320, H = 430;
function cena(pinta) {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = pinta(x, y), i = (y * W + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  return d;
}
const cupom = (x, y, claro) => {
  if (x < 95 || x > 225 || y < 50 || y > 390) return null;
  return y % 9 < 2 && x > 108 && x < 212 ? 70 : claro;      // linhas de texto
};
/* mapa no formato do Recorte._analisar, com o 1º limiar por Otsu */
function mapa(d) {
  const cinza = new Uint8Array(W * H), croma = new Uint8Array(W * H), hist = new Uint32Array(256);
  for (let p = 0; p < W * H; p++) { cinza[p] = d[p * 4]; hist[cinza[p]]++; }
  let tot = W * H, soma = 0;
  for (let t = 0; t < 256; t++) soma += t * hist[t];
  let sB = 0, pB = 0, melhor = -1, limiar = 128;
  for (let t = 0; t < 256; t++) {
    pB += hist[t]; if (!pB) continue;
    const pF = tot - pB; if (!pF) break;
    sB += t * hist[t];
    const e = pB * pF * (sB / pB - (soma - sB) / pF) ** 2;
    if (e > melhor) { melhor = e; limiar = t; }
  }
  return { W, H, cinza, croma, hist, limiar };
}
const noCupom = r => r && r.x0 > 70 && r.x1 < 250;
const centroX = q => q.reduce((s, c) => s + c.x, 0) / 4;

console.log('Piso branco no canto, cupom menos claro no meio da mesa:');
{
  const d = cena((x, y) => cupom(x, y, 165) ?? (x < 55 ? 228 : 50));
  const r = Scanner.achar(d, W, H);
  confere(r && !r.cortada && Math.abs(centroX(r.quad) - 0.5) < 0.08, 'o scanner acha o cupom, não o piso');
  confere(noCupom(Recorte._papelPorCor(mapa(d))), 'o recorte enquadra o cupom, não o piso');
}
console.log('Piso branco no canto, cupom tão claro quanto ele:');
{
  const d = cena((x, y) => cupom(x, y, 228) ?? (x < 55 ? 228 : 50));
  const r = Scanner.achar(d, W, H);
  confere(r && !r.cortada && Math.abs(centroX(r.quad) - 0.5) < 0.08, 'o scanner acha o cupom');
  confere(noCupom(Recorte._papelPorCor(mapa(d))), 'o recorte enquadra o cupom');
}
console.log('Nota que passa da borda da foto continua avisando:');
{
  const d = cena((x, y) => (x > 95 && x < 225 && y < 390 ? (y % 9 < 2 && x > 108 && x < 212 ? 70 : 228) : 50));
  const r = Scanner.achar(d, W, H);
  confere(!r || r.cortada, 'não finge que a nota está inteira');
}
console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo');
process.exit(falhas ? 1 : 0);
