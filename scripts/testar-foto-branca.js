#!/usr/bin/env node
// Teste da foto em branco (21/10/2026) — sem navegador e sem servidor.
//   node scripts/testar-foto-branca.js
// Cobre: a medida de "tinta" (js/foto-branca.js) com os mesmos números do servidor (FotoEmBranco.php), os casos que NÃO
// podem ser barrados (manuscrito curto, cupom claro, PDF/XML, imagem que não decodifica) e o comportamento do bloqueio
// no app (_fotoEmBrancoBarrada) e da pendência (_motivosDaNota), extraídos do app.js de verdade. Sai com 1 se falhar.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let falhas = 0;
const confere = (ok, msg) => { console.log((ok ? '  ok  ' : '  FALHOU  ') + msg); if (!ok) falhas++; };

const raiz = path.join(__dirname, '..', 'rda-rdm-app', 'js');
global.window = {};
require(path.join(raiz, 'foto-branca.js'));
const FB = global.window.FotoBranca;

/* ── a medida ─────────────────────────────────────────────── */
console.log('A medida');
// o MESMO padrão do teste do servidor (api/tests/Feature/FotoEmBrancoTest::test_a_mesma_regra_roda_igual_no_aparelho)
{
  const w = 120, h = 90, g = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g.push(200 + ((x * 7 + y * 13) % 9) - ((((x >> 4) + (y >> 4)) % 2 === 0) ? 0 : 36));
  confere(Math.abs(FB.tintaDoCinza(g, w, h) - 15.3333) < 0.0001, `mesmo número do PHP no padrão determinístico (${FB.tintaDoCinza(g, w, h).toFixed(4)} = 15,3333)`);
}

const W = 640, H = 480;
const raster = f => { const g = new Float64Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = f(x, y); return g; };
let semente = 12345;
const rnd = () => { semente = (semente * 1103515245 + 12345) & 0x7fffffff; return semente / 0x7fffffff; };   // ruído repetível

const papelLiso = raster((x, y) => 236 - 22 * y / H);
confere(FB.tintaDoCinza(papelLiso, W, H) === 0, 'papel liso com degradê de sombra: 0 % de tinta');
const papelRuido = raster((x, y) => 232 - 22 * y / H + (rnd() - 0.5) * 12);     // ruído de ±6 níveis (foto escura)
confere(FB.tintaDoCinza(papelRuido, W, H) < FB.TINTA_MIN, 'papel liso com ruído de foto escura: em branco');
const sombraSuave = raster((x, y) => 230 * (1 - 0.35 * Math.exp(-(((x - 440) / 180) ** 2 + ((y - 340) / 180) ** 2))));
confere(FB.tintaDoCinza(sombraSuave, W, H) < FB.TINTA_MIN, 'sombra de mão (degradê forte, sem borda dura): em branco');
const lenteTampada = raster(() => 12 + rnd() * 2);
confere(FB.tintaDoCinza(lenteTampada, W, H) < FB.TINTA_MIN, 'imagem preta (lente tampada): sem dados de nota');

// "texto": traços escuros de 2 px a cada 14 px, em blocos de linhas
const cupom = raster((x, y) => (y > 80 && y < 400 && (y % 14) < 2 && x > 120 && x < 520 && ((x * 3 + y) % 11) < 8) ? 40 : 238);
confere(FB.tintaDoCinza(cupom, W, H) > 50 * FB.TINTA_MIN, `cupom com texto: ${FB.tintaDoCinza(cupom, W, H).toFixed(2)} % — muito acima do corte`);
// manuscrito curto: 8 riscos de 14×2 px (≈ "R$ 14")
const manuscrito = raster((x, y) => (y >= 240 && y < 242 && ((x - 300) % 24) < 14 && x >= 300 && x < 492) ? 50 : 238);
confere(FB.tintaDoCinza(manuscrito, W, H) >= FB.TINTA_MIN, `manuscrito curto ("R$ 14"): ${FB.tintaDoCinza(manuscrito, W, H).toFixed(3)} % — NÃO é barrado`);
// cupom térmico desbotado: contraste de só 35 níveis
const desbotado = raster((x, y) => (y > 80 && y < 400 && (y % 14) < 2 && x > 120 && x < 520 && ((x * 3 + y) % 11) < 8) ? 205 : 240);
confere(FB.tintaDoCinza(desbotado, W, H) >= FB.TINTA_MIN, 'cupom térmico desbotado (contraste 35): NÃO é barrado');
confere(FB.tintaDoCinza(new Float64Array(8 * 8).fill(200), 8, 8) === 0, 'imagem minúscula (8×8) não quebra');

/* ── o app: _fotoEmBrancoBarrada e a pendência, extraídos do app.js de verdade ───────────────── */
console.log('O app');
const fonte = fs.readFileSync(path.join(raiz, 'app.js'), 'utf8');
function extrai(nome) {
  const i = fonte.search(new RegExp(`(async )?function ${nome}\\(`));
  if (i < 0) throw new Error('não achei ' + nome);
  let d = 0, k = fonte.indexOf('{', i);
  for (let j = k; j < fonte.length; j++) {
    if (fonte[j] === '{') d++;
    else if (fonte[j] === '}' && --d === 0) return fonte.slice(i, j + 1);
  }
  throw new Error('chaves não fecham em ' + nome);
}
function extraiConst(nome) {
  const i = fonte.indexOf(`const ${nome} = {`);
  if (i < 0) throw new Error('não achei const ' + nome);
  return fonte.slice(i, fonte.indexOf('\n};', i) + 3);
}

function montar({ resposta, lanca = false } = {}) {
  const chamadas = { avisos: [], medidas: 0, inputLimpo: false };
  const ctx = {
    window: { FotoBranca: { emBranco: async () => { chamadas.medidas++; if (lanca) throw new Error('boom'); return resposta; } } },
    mostrarAviso: async a => { chamadas.avisos.push(a); },
    _EXTS_OK: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'pdf', 'xml'],
    _soDigitos: s => String(s || '').replace(/\D/g, ''), _numeroSerieDaChave: () => null, _dataNoFuturo: () => null, _dupMapa: new Map(),
    console,
  };
  ctx.FotoBranca = ctx.window.FotoBranca;
  vm.createContext(ctx);
  vm.runInContext([extrai('_extDoArquivo'), 'function _ehImagemExt(e){return ["jpg","png","webp","gif","heic"].includes(e);}',
    extraiConst('_MSG_FOTO_EM_BRANCO'), extrai('_fotoEmBrancoBarrada'),
    extrai('_fotoMarcadaEmBranco'), extrai('_ehRecibo'), extrai('_motivosDaNota')].join('\n'), ctx);
  return { ctx, chamadas };
}
const arq = (nome, tipo) => ({ name: nome, type: tipo, size: 1000 });

(async () => {
  {
    const { ctx, chamadas } = montar({ resposta: true });
    const input = { value: 'C:\\fakepath\\nota.jpg' };
    const barrou = await ctx._fotoEmBrancoBarrada(arq('nota.jpg', 'image/jpeg'), input, 'arquivo');
    confere(barrou === true, 'imagem em branco: barrada');
    confere(chamadas.avisos.length === 1 && chamadas.avisos[0].titulo === 'Essa foto está em branco', 'mostra o aviso "Essa foto está em branco" (mostrarAviso, nunca alert)');
    confere(input.value === '', 'o campo do arquivo é limpo — nada fica anexado');
    confere(chamadas.avisos[0].botao === 'Entendi' && /fotografe a nota/.test(chamadas.avisos[0].mensagem), 'arquivo: pede para escolher outro ou fotografar');
  }
  {
    const { ctx, chamadas } = montar({ resposta: true });
    await ctx._fotoEmBrancoBarrada(arq('nota.jpg', 'image/jpeg'), null, 'camera');
    confere(chamadas.avisos[0].botao === 'Tirar de novo' && /Aponte a câmera/.test(chamadas.avisos[0].mensagem), 'câmera: pede para tirar de novo');
    const b2 = await ctx._fotoEmBrancoBarrada(arq('nota.jpg', 'image/jpeg'), null, 'salvar');
    confere(b2 === true && /antes de salvar/.test(chamadas.avisos[1].mensagem), 'ao salvar: pede para trocar a foto antes de salvar');
  }
  {
    const { ctx, chamadas } = montar({ resposta: false });
    const f = arq('cupom.jpg', 'image/jpeg');
    confere(await ctx._fotoEmBrancoBarrada(f, null) === false && chamadas.avisos.length === 0, 'imagem com conteúdo: passa, sem aviso');
    confere(f.__brancaConferida === true, 'e fica marcada como conferida');
    await ctx._fotoEmBrancoBarrada(f, null);
    confere(chamadas.medidas === 1, 'conferida uma vez não é medida de novo (salvar não repete a conta)');
  }
  {
    const { ctx, chamadas } = montar({ resposta: true });
    confere(await ctx._fotoEmBrancoBarrada(arq('nota.pdf', 'application/pdf'), null) === false && chamadas.medidas === 0, 'PDF nunca é medido nem barrado');
    confere(await ctx._fotoEmBrancoBarrada(arq('nfe.xml', 'text/xml'), null) === false && chamadas.medidas === 0, 'XML nunca é medido nem barrado');
    confere(await ctx._fotoEmBrancoBarrada(null, null) === false, 'sem arquivo: nada a fazer');
  }
  {
    const { ctx, chamadas } = montar({ resposta: null });
    confere(await ctx._fotoEmBrancoBarrada(arq('foto.heic', 'image/heic'), null) === false && chamadas.avisos.length === 0, 'não deu para medir (HEIC no Chrome etc.): nunca barra');
  }
  {
    const { ctx, chamadas } = montar({ lanca: true });
    confere(await ctx._fotoEmBrancoBarrada(arq('nota.jpg', 'image/jpeg'), null) === false && chamadas.avisos.length === 0, 'erro na medida: nunca barra');
  }
  {
    const { ctx, chamadas } = montar({ resposta: true });
    confere(await ctx._fotoEmBrancoBarrada(arq('sem-tipo.jpg', ''), null) === true && chamadas.avisos.length === 1, 'arquivo sem tipo MIME mas com extensão .jpg: é medido');
  }
  {
    const { ctx } = montar({ resposta: false });
    const base = { valor: 14, cnpj: '11222333000181', numero: '5', foto_path: 'u/x.jpg', sync_status: 'ok', documento: 'nfce' };
    const motivos = n => ctx._motivosDaNota(n);
    confere(motivos({ ...base, foto_em_branco: true }).includes('foto em branco'), 'pendência: nota marcada pelo servidor mostra "foto em branco"');
    confere(motivos({ ...base, foto_em_branco: 1 }).includes('foto em branco'), '...também quando a coluna vem como 1');
    confere(!motivos({ ...base, foto_em_branco: false }).includes('foto em branco'), 'foto com conteúdo: sem a etiqueta');
    confere(!motivos({ ...base, foto_em_branco: null }).includes('foto em branco'), 'não medida (null): sem a etiqueta');
    confere(!motivos({ ...base }).includes('foto em branco'), 'nota antiga sem o campo: sem a etiqueta');
    confere(motivos({ ...base, foto_em_branco: true, numero: '' }).join('|').includes('foto em branco|sem nº'), 'a etiqueta aparece ao lado das outras pendências');
  }
  console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})();
