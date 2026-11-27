#!/usr/bin/env node
// Atualização automática não recarrega o app no meio de um lançamento (26/11/2026). Sem navegador e sem servidor:
//   node scripts/testar-recarga.js
// Roda as funções tiradas do próprio app.js, com jsdom. Sai com código 1 se algum caso falhar.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));

const app = fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'app.js'), 'utf8').replace(/\r/g, '');
const trecho = (de, ate) => { const i = app.indexOf(de); const f = app.indexOf(ate, i); if (i < 0 || f < 0) throw new Error('trecho: ' + de); return app.slice(i, f); };

let falhas = 0;
const confere = (nome, veio, esperado) => {
  const ok = veio === esperado;
  console.log((ok ? '  ok  ' : '  FALHOU  ') + nome + (ok ? '' : `  (veio ${veio}, esperado ${esperado})`));
  if (!ok) falhas++;
};

const telas = ['ocr-overlay', 'qr-overlay', 'cam-nota-overlay', 'crop-overlay', 'ef-ov'];
const dom = new JSDOM(telas.map(i => `<div id="${i}" style="display:none"></div>`).join('') +
  '<div id="nota-form-overlay" class="full-overlay" style="display:none"></div>', { runScripts: 'outside-only' });
const w = dom.window;
let escondido = false;
Object.defineProperty(w.document, 'hidden', { get: () => escondido });
w.eval(`
  var _salvandoRepasse = false, _salvandoNota = false, _formEsperandoLeitura = false;
  var _solta, _durante;
  var onFotoNota = () => new Promise(r => { _solta = r; });
  var onFotoNotaChange = async () => { _durante = !_momentoBomParaRecarregar(); };
  var onArquivoNotaChange = async () => { throw new Error('falhou'); };
`);
w.eval(trecho('/* Enquanto uma foto ou arquivo é tratado', 'async function _aplicarAtualizacao() {'));
const bom = () => w._momentoBomParaRecarregar();

(async () => {
  console.log('Pode recarregar?');
  confere('app parado: sim', bom(), true);
  for (const id of [...telas, 'nota-form-overlay']) {
    const el = w.document.getElementById(id);
    el.style.display = 'flex';
    confere(`com #${id} na tela: não`, bom(), false);
    el.style.display = 'none';
  }
  for (const [nome, liga, desliga] of [
    ['salvando a nota', '_salvandoNota = true', '_salvandoNota = false'],
    ['salvando repasse', '_salvandoRepasse = true', '_salvandoRepasse = false'],
    ['formulário esperando a foto', '_formEsperandoLeitura = true', '_formEsperandoLeitura = false'],
    ['lançamento de várias notas em andamento', 'window.LoteNotas = { ativo: true }', 'window.LoteNotas = { ativo: false }'],
  ]) { w.eval(liga); confere(`${nome}: não`, bom(), false); w.eval(desliga); }
  escondido = true; confere('app escondido (câmera do celular aberta): não', bom(), false); escondido = false;
  confere('terminou tudo: sim', bom(), true);

  console.log('Foto sendo tratada');
  const p = w.onFotoNota({});
  confere('segura enquanto lê a foto', bom(), false);
  w._solta(); await p;
  confere('libera ao terminar', bom(), true);
  await w.onFotoNotaChange({});
  confere('foto do formulário também segura', w._durante, true);
  await w.onArquivoNotaChange({}).catch(() => {});
  confere('libera mesmo se a leitura der erro', bom(), true);

  console.log(falhas ? `\n${falhas} caso(s) falharam.` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})();
