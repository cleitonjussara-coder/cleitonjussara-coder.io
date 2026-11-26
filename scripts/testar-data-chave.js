#!/usr/bin/env node
// Data da nota com chave de 44 dígitos (26/11/2026). Sem navegador e sem servidor:
//   node scripts/testar-data-chave.js
// A chave só diz mês e ano: o "dia 01" que sai dela não pode passar por cima do dia lido na nota.
// Roda as funções tiradas do próprio app.js, com jsdom. Sai com código 1 se algum caso falhar.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));

const js = n => fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', n), 'utf8');
const app = js('app.js').replace(/\r/g, '');
const trecho = (de, ate) => { const i = app.indexOf(de); const f = app.indexOf(ate, i); if (i < 0 || f < 0) throw new Error('trecho: ' + de); return app.slice(i, f); };

let falhas = 0;
const confere = (nome, veio, esperado) => {
  const ok = veio === esperado;
  console.log((ok ? '  ok  ' : '  FALHOU  ') + nome + (ok ? '' : `  (veio ${veio}, esperado ${esperado})`));
  if (!ok) falhas++;
};

const ids = ['data', 'mes', 'ano', 'valor', 'cnpj', 'razao', 'chave', 'qr-url', 'uf', 'numero', 'serie', 'placa', 'hora', 'portal', 'consumidor'];
const dom = new JSDOM(ids.map(i => `<input id="nf-${i}">`).join('') + '<div id="ocr-overlay"></div><div id="ocr-progress"></div><span id="captura-badge"></span>', { runScripts: 'outside-only', url: 'http://localhost/' });
const w = dom.window;
w.eval(js('sefaz.js') + ';window.SEFAZ = SEFAZ;');
w.eval(`
  var HOJE = '2026-11-20';
  var $ = id => document.getElementById(id);
  var hoje = () => HOJE;
  var _digitos = s => String(s || '').replace(/[^0-9]/g, '');
  var toast = () => {}, buscarRazaoSocial = () => {}, _atualizarLinkConsulta = () => {}, _atualizarDocumentoAuto = () => {};
  var BrasilAPI = { formatar: c => c };
  var NFCE = { parseChave44: c => ({ chave: c, cnpj: c.slice(6, 20), uf: 'GO', mes: Number(c.slice(4, 6)), ano: 2000 + Number(c.slice(2, 4)) }), parseChaveNfse50: () => null, fromScan: t => ({ ...NFCE.parseChave44(t), data: '2026-11-01' }) };
  var _qr = null, _lerQRdaImagem = async () => _qr, _ehUrlNfse = () => false;
  var _preencherNumeroSerie = () => {}, _placaLimpa = x => x, _horaLimpa = () => '', _portalLimpo = () => null, _portalDoCnpj = () => null;
  var _docEscolhidoManual = false;
`);
w.eval(trecho('async function enriquecerViaSefaz(chave) {', 'function fecharFormNota() {'));
w.eval(trecho('async function extrairDadosDaFoto(file, ocrPronto = null) {', 'function atualizarPreviewFoto(url) {'));

// chave de 11/2026 com dígito verificador válido
const base = '5226111234567800019965001000000123100000012';
let soma = 0, p = 2;
for (let i = 42; i >= 0; i--) { soma += Number(base[i]) * p; p = p === 9 ? 2 : p + 1; }
const CHAVE = base + (soma % 11 < 2 ? 0 : 11 - (soma % 11));

const form = data => { ids.forEach(i => { w.$('nf-' + i).value = ''; }); w.$('nf-data').value = data; w.$('nf-chave').value = CHAVE; };
const foto = async (noCampo, lida) => { form(noCampo); await w.extrairDadosDaFoto({}, lida === undefined ? { valor: 10 } : { valor: 10, data: lida }); return w.$('nf-data').value; };

(async () => {
  console.log('Ao abrir o formulário (consulta pela chave)');
  form('2026-11-17'); await w.enriquecerViaSefaz(CHAVE);
  confere('mantém o dia já preenchido', w.$('nf-data').value, '2026-11-17');
  confere('mês vem da chave', w.$('nf-mes').value, '11');
  form('2026-12-03'); await w.enriquecerViaSefaz(CHAVE);
  confere('data de outro mês cai no mês da chave', w.$('nf-data').value, '2026-11-01');

  console.log('Foto anexada ao formulário');
  confere('dia lido na nota vale', await foto('2026-11-01', '2026-11-14'), '2026-11-14');
  confere('sem dia lido, mantém o que está no campo', await foto('2026-11-17'), '2026-11-17');
  confere('"dia 01" vindo da chave não apaga o dia do campo', await foto('2026-11-17', '2026-11-01'), '2026-11-17');
  confere('dia 01 lido na nota vale sobre o "hoje" do formulário', await foto('2026-11-20', '2026-11-01'), '2026-11-01');
  confere('leitura de outro mês é ignorada', await foto('2026-11-17', '2026-10-30'), '2026-11-17');
  confere('sem nada no mês da chave, dia 01', await foto('2026-12-02'), '2026-11-01');

  console.log('"Ler por foto da nota" (QR + IA)');
  w.eval(`
    var _aberto = null, abrirFormNota = async d => { _aberto = d; };
    var fecharCaptura = () => {}, _anexoUtilizavel = async () => true, _fotoEmBrancoBarrada = async () => false, _normalizarOrientacao = async f => f, _endireitarComAviso = async f => f;
    var _camNotaScannerOn = false, _qrProvisorio = null, _ia = {}, _lerNota = async () => _ia, _ensureJsQR = async () => {}, _lerQRDeImagem = async () => _qrTxt, _qrTxt = null;
    var _salvarUrlQR = () => {}, _cortadoBarra = () => false, _extDoArquivo = () => 'jpg', atualizarPreviewFoto = () => {};
    var fotoBlob, fotoOriginal, fotoExt, fotoURL;
    window.URL.createObjectURL = () => 'blob:x';
  `);
  w.eval(trecho('async function onFotoNota(e) {', '/* ── Form Nota '));
  const ler = async (qr, ia) => { w._qrTxt = qr; w._ia = ia; w._aberto = null; await w.onFotoNota({ target: { files: [{}], value: '' } }); return w._aberto?.data; };
  confere('QR + dia lido pela IA: vale o dia lido', await ler(CHAVE, { valor: 10, data: '2026-11-14' }), '2026-11-14');
  confere('QR sem dia lido: fica no mês da chave', await ler(CHAVE, { valor: 10 }), '2026-11-01');
  confere('QR + IA de outro mês: fica no mês da chave', await ler(CHAVE, { valor: 10, data: '2026-10-30' }), '2026-11-01');
  confere('sem QR: vale a data da IA', await ler(null, { valor: 10, data: '2026-10-30' }), '2026-10-30');
  confere('sem QR e sem data: hoje', await ler(null, { valor: 10 }), '2026-11-20');

  console.log(falhas ? `\n${falhas} caso(s) falharam.` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})();
