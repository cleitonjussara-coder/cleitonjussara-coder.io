#!/usr/bin/env node
// Teste do visualizador de anexos (07/11/2026). Sem navegador e sem servidor:
//   node scripts/testar-anexo-viewer.js
// Roda as funções tiradas do próprio app.js, com jsdom. Sai com código 1 se algum caso falhar.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));

const raiz = path.join(__dirname, '..', 'rda-rdm-app');
const app = fs.readFileSync(path.join(raiz, 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
const trecho = (de, ate) => { const i = app.indexOf(de); const f = app.indexOf(ate, i); if (i < 0 || f < 0) throw new Error('trecho: ' + de); return app.slice(i, f); };
const var_ = t => t.replace(/^(const|let) /gm, 'var ');

let falhas = 0;
const confere = (ok, msg) => { console.log((ok ? '  ok  ' : '  FALHOU  ') + msg); if (!ok) falhas++; };

const marcacao = html.slice(html.indexOf('<div id="foto-viewer-overlay"'), html.indexOf('</div>', html.indexOf('id="foto-viewer-acoes"')) + 6) + '</div>';
const dom = new JSDOM('<body>' + marcacao + '</body>', { runScripts: 'dangerously', url: 'http://localhost/' });
const w = dom.window;
w.eval(`
  var avisos = [], abertos = [], compartilhou = [], respostaFetch = null;
  var $ = id => document.getElementById(id), toast = t => avisos.push(t), esc = s => String(s);
  var _fotoSeq = [], _atualizarSetasFoto = () => {};
  window.open = u => abertos.push(u);
  window.fetch = u => respostaFetch ? respostaFetch(u) : Promise.resolve({ ok: true, blob: async () => new Blob(['x'], { type: 'application/pdf' }) });
`);
w.eval(var_(trecho('function _nomeDoAnexo(base, ext) {', 'function fecharFotoViewer() {')));
w.eval(var_(trecho('function fecharFotoViewer() {', '/* Baixar / compartilhar o anexo aberto')));
w.eval(var_(trecho('let _fotoViewerAtual = null;', '/* ── Ajuda / Como usar')));
const $ = id => w.document.getElementById(id);
const espera = () => new Promise(r => setTimeout(r, 5));

(async () => {
  console.log('Tela');
  w._mostrarViewer({ url: 'http://x/a.pdf', ext: 'pdf', nome: 'nota.pdf', html: 'RDM' });
  confere($('foto-viewer-overlay').style.display === 'flex' && $('foto-viewer-doc').style.display === 'flex' && $('foto-viewer-img').style.display === 'none', 'PDF abre no visualizador');
  confere($('foto-viewer-abrir').href === 'http://x/a.pdf' && $('foto-viewer-abrir').target === '_blank' && !w.eval('abertos.length'), 'abre por link tocado, sem janela automática');
  confere(!!$('foto-viewer-acoes').querySelector('[onclick*="baixarFotoViewer"]') && !!$('foto-viewer-acoes').querySelector('[onclick*="compartilharFotoViewer"]'), 'tem Baixar e Compartilhar');
  w.fecharFotoViewer();
  w._mostrarViewer({ url: 'http://x/a.jpg', ext: 'jpg', nome: 'nota.jpg', html: 'RDA' });
  confere($('foto-viewer-doc').style.display === 'none' && $('foto-viewer-img').style.display === '' && $('foto-viewer-img').src === 'http://x/a.jpg', 'foto continua na imagem');
  confere(/z-index:120/.test(html.slice(html.indexOf('id="foto-viewer-overlay"'), html.indexOf('id="foto-viewer-overlay"') + 200)), 'fica acima das janelas do app');

  console.log('Nome do arquivo');
  confere(w._nomeDoAnexo('Nota do Posto.pdf', 'pdf') === 'Nota_do_Posto.pdf', 'sem espaço e sem extensão repetida');
  confere(w._nomeDoAnexo('', undefined) === 'anexo.jpg', 'nome vazio');

  console.log('Compartilhar');
  w.Object.defineProperty(w.navigator, 'canShare', { value: () => true, configurable: true });
  w.Object.defineProperty(w.navigator, 'share', { value: async d => { w.eval('compartilhou').push(d.files[0].name); }, configurable: true });
  w._mostrarViewer({ url: 'http://x/a.pdf', ext: 'pdf', nome: 'nota.pdf', html: 'RDM' });
  await espera();
  await w.compartilharFotoViewer();
  confere(w.eval('compartilhou.pop()') === 'nota.pdf', 'compartilha o arquivo já baixado');
  w.eval(`respostaFetch = () => Promise.reject(new Error('fora'))`);
  w._mostrarViewer({ url: 'http://x/b.pdf', ext: 'pdf', nome: 'b.pdf', html: 'RDM' });
  await espera();
  await w.compartilharFotoViewer();
  confere(/não carregou/.test(w.eval('avisos.pop()')), 'sem arquivo, avisa');
  await w.baixarFotoViewer();
  confere(w.eval('abertos.pop()') === 'http://x/b.pdf', 'Baixar cai em abrir');
  w.eval(`respostaFetch = null`);
  w.Object.defineProperty(w.navigator, 'share', { value: async () => { const e = new Error('x'); e.name = 'NotAllowedError'; throw e; }, configurable: true });
  w._mostrarViewer({ url: 'http://x/c.pdf', ext: 'pdf', nome: 'c.pdf', html: 'RDM' });
  await w.compartilharFotoViewer();
  confere(/de novo/.test(w.eval('avisos.pop()')), 'iPhone perdeu o gesto: pede outro toque');

  console.log('Anexo do aparelho');
  w.Object.defineProperty(w.navigator, 'share', { value: async d => { w.eval('compartilhou').push(d.files[0].name); }, configurable: true });
  w.eval(`window.fetch = () => { throw new Error('não busca'); }`);
  w.anexo = new w.Blob(['y'], { type: 'image/jpeg' });
  w._mostrarViewer({ url: 'blob:x', ext: 'jpg', nome: 'l.jpg', html: 'RDA', blob: w.anexo });
  await w.compartilharFotoViewer();
  confere(w.eval('compartilhou.pop()') === 'l.jpg', 'usa o arquivo guardado, sem rede');

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
