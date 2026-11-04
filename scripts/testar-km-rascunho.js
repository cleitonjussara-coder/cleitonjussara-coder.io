#!/usr/bin/env node
// Teste do rascunho do Registrar KM (frota.js) com jsdom — sem navegador e sem servidor.
//   node scripts/testar-km-rascunho.js
// Simula o que o Android faz: a página morre com o formulário aberto e o app volta do zero. Cada "página" é um JSDOM novo
// que só herda o que o celular guardaria de verdade: localStorage e IndexedDB (aqui, dois mapas compartilhados).
// Cobre: campos e foto voltam, mesmo id ao repetir o envio (não duplica), salvar e Voltar limpam, outra conta não vê,
// rascunho vencido some, foto perdida avisa, câmera do app é a preferida, e a recarga do service worker respeita o formulário.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));
const raiz = path.join(__dirname, '..', 'rda-rdm-app');
const fonte = fs.readFileSync(path.join(raiz, 'js', 'frota.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(raiz, 'js', 'app.js'), 'utf8');
let falhas = 0;
const confere = (ok, msg) => { console.log((ok ? '  ok  ' : '  FALHOU  ') + msg); if (!ok) falhas++; };

const inicio = indexHtml.indexOf('<div id="km-overlay"');
const fim = indexHtml.indexOf('<!-- ═══════════ PONTO: CORREÇÃO');
const formulario = indexHtml.slice(inicio, fim);
if (inicio < 0 || fim < 0) throw new Error('formulário de KM não encontrado no index.html');

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';
const VEICULOS = [{ id: V1, placa: 'AAA1A11', modelo: 'Hilux', ativo: true }, { id: V2, placa: 'BBB2B22', modelo: 'S10', ativo: true }];

function celular() { return { ls: new Map(), meta: new Map() }; }

/* uma "abertura do app": página nova, memória zerada, mesmo armazenamento do aparelho */
function abrirPagina(cel, { uid = 'u1', camera = true } = {}) {
  const dom = new JSDOM(`<main>${formulario}<div id="foto-viewer-overlay"></div></main>`, { runScripts: 'dangerously', url: 'http://localhost/' });
  const w = dom.window;
  Object.defineProperty(w.navigator, 'onLine', { get: () => true, configurable: true });
  Object.defineProperty(w, 'localStorage', { configurable: true, value: {
    getItem: k => (cel.ls.has(k) ? cel.ls.get(k) : null), setItem: (k, v) => { cel.ls.set(k, String(v)); }, removeItem: k => { cel.ls.delete(k); },
  } });
  w.__cel = cel; w.__uid = uid; w.__veiculos = VEICULOS; w.__puts = []; w.__fotos = []; w.__toasts = []; w.__camera = []; w.__clicks = 0;
  w.Blob = Blob;
  w.eval(`
    var $ = id => document.getElementById(id);
    var esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var toast = t => __toasts.push(t), setLoading = () => {};
    var user = { id: __uid, nome: 'Fulano' };
    var viewAtual = 'inicio', filAno = 2026, filMes = 11, MESES = [];
    var fmtData = d => d, _ehGestorOuAdmin = () => false, renderInicio = () => {};
    var pedirConfirmacao = async () => true;
    var FusoBR = { hojeISO: () => '2026-11-03' };
    var DB = { getMeta: async k => (__cel.meta.has(k) ? __cel.meta.get(k) : null), setMeta: async (k, v) => { __cel.meta.set(k, v); } };
    var sb = { hojeDoServidor: () => '2026-11-03', horaServidorMs: () => Date.now(), frota: {
      veiculos: async () => __veiculos,
      kmUpsert: async (id, p) => { __puts.push({ id, p }); },
      kmFoto: async (id, b) => { __fotos.push({ id, tamanho: b.size }); },
    } };
    var _comprimirImagem = async b => ({ blob: b, ext: 'jpg' });
  `);
  if (camera) w.eval(`var abrirCameraNota = (cancelar, opts) => { __camera.push(opts); window.__cancelar = cancelar; };`);
  w.eval(fonte);
  w.document.getElementById('km-foto').click = () => { w.__clicks++; };
  return w;
}

const digita = (w, id, valor) => {
  const el = w.document.getElementById(id);
  el.value = valor;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
};
const foto = (bytes = 2048) => ({ size: bytes, type: 'image/jpeg', arrayBuffer: async () => new ArrayBuffer(bytes) });
const valor = (w, id) => w.document.getElementById(id).value;
const aberto = w => w.document.getElementById('km-overlay').style.display === 'flex';
const aviso = w => w.document.getElementById('km-odo-aviso').textContent;

(async () => {
  console.log('Página morre com a câmera aberta (o caso do campo):');
  {
    const cel = celular();
    let w = abrirPagina(cel);
    await w.Frota.lancar();
    digita(w, 'km-veiculo', V2);
    digita(w, 'km-odometro', '85420');
    digita(w, 'km-obs', 'saída para Cristalina');
    w.Frota.fotografar();
    confere(w.__camera.length === 1 && w.__clicks === 0, 'usa a câmera de dentro do app, não a do sistema');
    confere(w.__camera[0].ladoMax <= 2048, 'pede foto menor que a da nota');

    w = abrirPagina(cel);                                  // página morreu: memória zerada
    confere(await w.Frota.restaurarRascunho() === true, 'ao voltar, o app reabre o formulário');
    confere(aberto(w), 'formulário aberto, não o Início');
    confere(valor(w, 'km-veiculo') === V2, 'veículo escolhido voltou');
    confere(valor(w, 'km-odometro') === '85420', 'odômetro voltou');
    confere(valor(w, 'km-obs') === 'saída para Cristalina', 'observação voltou');
    confere(/foto se perdeu/.test(aviso(w)), 'avisa que a foto se perdeu');
  }

  console.log('Página morre depois da foto (no recorte, na leitura ou na compressão):');
  {
    const cel = celular();
    let w = abrirPagina(cel);
    await w.Frota.lancar();
    digita(w, 'km-veiculo', V1);
    w.Frota.fotografar();
    await w.__camera[0].aoFoto(foto(4096));
    confere(cel.meta.get('frota_rascunho_foto_u1')?.blob?.size === 4096, 'foto gravada no aparelho assim que chega');

    w = abrirPagina(cel);
    await w.Frota.restaurarRascunho();
    confere(/com a foto/.test(aviso(w)), 'avisa que a foto voltou');
    digita(w, 'km-odometro', '1000');
    await w.Frota.salvar();
    confere(w.__puts.length === 1 && w.__fotos[0]?.tamanho === 4096, 'salva o registro e sobe a foto recuperada');
    confere(!aberto(w), 'formulário fecha ao salvar');
    confere(!cel.ls.has('frota_rascunho_u1') && !cel.meta.get('frota_rascunho_foto_u1'), 'rascunho e foto saem do aparelho');
    w = abrirPagina(cel);
    confere(await w.Frota.restaurarRascunho() === false, 'na abertura seguinte nada reaparece');
  }

  console.log('Página morre no meio do envio:');
  {
    const cel = celular();
    let w = abrirPagina(cel);
    await w.Frota.lancar();
    digita(w, 'km-veiculo', V1); digita(w, 'km-odometro', '500');
    w.eval(`sb.frota.kmUpsert = async (id, p) => { __puts.push({ id, p }); const e = new Error('Sem permissão'); e.status = 403; throw e; };`);
    await w.Frota.salvar();
    const idPrimeiro = w.__puts[0].id;
    confere(cel.ls.has('frota_rascunho_u1'), 'recusa do servidor mantém o rascunho');
    w = abrirPagina(cel);
    await w.Frota.restaurarRascunho();
    await w.Frota.salvar();
    confere(w.__puts[0]?.id === idPrimeiro, 'repetir usa o mesmo id: o servidor atualiza, não duplica');
  }

  console.log('Regras de quem e até quando:');
  {
    const cel = celular();
    let w = abrirPagina(cel);
    await w.Frota.lancar();
    digita(w, 'km-veiculo', V1); digita(w, 'km-odometro', '777');
    w = abrirPagina(cel, { uid: 'outra-conta' });
    confere(await w.Frota.restaurarRascunho() === false && !aberto(w), 'outra conta no aparelho não vê o rascunho');
    w = abrirPagina(cel);
    confere(await w.Frota.restaurarRascunho() === true, 'quem escreveu ainda recupera');
    w.Frota.fecharForm();
    confere(!cel.ls.has('frota_rascunho_u1'), 'Voltar descarta');

    w = abrirPagina(cel);
    await w.Frota.lancar();
    digita(w, 'km-veiculo', V1);
    const d = JSON.parse(cel.ls.get('frota_rascunho_u1'));
    d.em = Date.now() - 4 * 24 * 3600 * 1000;
    cel.ls.set('frota_rascunho_u1', JSON.stringify(d));
    w = abrirPagina(cel);
    confere(await w.Frota.restaurarRascunho() === false, 'rascunho com mais de 3 dias não volta');
  }

  console.log('Aparelho compartilhado:');
  {
    const cel = celular();
    let w = abrirPagina(cel);
    await w.Frota.lancar();
    digita(w, 'km-veiculo', V1); digita(w, 'km-odometro', '321');
    w = abrirPagina(cel, { uid: 'outra-conta' });
    await w.Frota.lancar();
    digita(w, 'km-veiculo', V2);
    w.Frota.fecharForm();
    w = abrirPagina(cel);
    confere(await w.Frota.restaurarRascunho() === true && valor(w, 'km-odometro') === '321', 'outra conta usando o formulário não apaga o rascunho');
  }

  console.log('Tocar em Lançar KM enquanto o rascunho volta:');
  {
    const cel = celular();
    let w = abrirPagina(cel);
    await w.Frota.lancar();
    digita(w, 'km-veiculo', V2); digita(w, 'km-odometro', '654');
    w.Frota.fotografar();
    await w.__camera[0].aoFoto(foto(1024));
    w = abrirPagina(cel);
    const volta = w.Frota.restaurarRascunho();
    await Promise.all([volta, w.Frota.lancar()]);
    confere(valor(w, 'km-odometro') === '654' && valor(w, 'km-veiculo') === V2, 'o formulário fica com o que voltou');
    confere(cel.meta.get('frota_rascunho_foto_u1')?.blob?.size === 1024, 'a foto não é apagada');
    await w.Frota.lancar();
    confere(valor(w, 'km-odometro') === '654', 'com o formulário aberto, Lançar KM não o zera');
  }

  console.log('Fila de leituras sem sinal:');
  {
    const cel = celular();
    const item = (id, extra = {}) => ({ id, uid: 'u1', payload: { veiculo_id: V1, data: '2026-11-03', odometro: 10, registrado_em: '2026-11-03T11:00:00.000Z' }, foto: null, criado_em: 'a', erro: null, ...extra });
    cel.meta.set('frota_fila', [item('A')]);
    let w = abrirPagina(cel);
    w.eval(`sb.frota.kmUpsert = async (id, p) => { __puts.push({ id, p }); await DB.setMeta('frota_fila', [...(await DB.getMeta('frota_fila')), __novo]); };`);
    w.__novo = item('B');
    await w.Frota.subirFila();
    confere(cel.meta.get('frota_fila').map(x => x.id).join() === 'B', 'leitura que entra na fila durante o envio não some');

    cel.meta.set('frota_fila', [item('C', { foto: { blob: new Blob(['x']), ext: 'jpg' } })]);
    w = abrirPagina(cel);
    w.eval(`sb.frota.kmFoto = async () => { throw new Error('sem rede'); };`);
    await w.Frota.subirFila();
    confere(cel.meta.get('frota_fila').map(x => x.id).join() === 'C', 'foto que caiu por falta de rede continua na fila');

    cel.meta.set('frota_fila', [item('D', { foto: { blob: new Blob(['xy']), ext: 'jpg' } })]);
    cel.ls.set('frota_rascunho_u1', JSON.stringify({ uid: 'u1', em: Date.now(), id: 'D', id_novo: null, veiculo_id: V1, data: '2026-11-03', odometro: '20', obs: '', camera: false, foto: false }));
    w = abrirPagina(cel);
    await w.Frota.restaurarRascunho();
    await w.Frota.salvar();
    confere(w.__puts[0]?.p.registrado_em === '2026-11-03T11:00:00.000Z', 'correção restaurada mantém a hora original da leitura');
    confere(w.__fotos[0]?.tamanho === 2, 'corrigir leitura da fila sobe a foto que estava guardada');
    confere(!cel.meta.get('frota_fila').length, 'e o item sai da fila');

    w = abrirPagina(cel);
    w.eval(`sb.frota.kmFoto = async () => { throw new Error('sem rede'); };`);
    await w.Frota.lancar();
    digita(w, 'km-veiculo', V1); digita(w, 'km-odometro', '30');
    w.Frota.fotografar();
    await w.__camera[0].aoFoto(foto(512));
    await w.Frota.salvar();
    confere(cel.meta.get('frota_fila').length === 1 && cel.meta.get('frota_fila')[0].foto?.blob, 'registro salvo com a foto caindo: a foto fica na fila');
  }

  console.log('Formulário só aberto, sem nada escrito:');
  {
    const cel = celular();
    const w = abrirPagina(cel);
    await w.Frota.lancar();
    confere(!cel.ls.has('frota_rascunho_u1'), 'não cria rascunho à toa');
  }

  console.log('Aparelho sem a câmera do app:');
  {
    const cel = celular();
    const w = abrirPagina(cel, { camera: false });
    await w.Frota.lancar();
    w.Frota.fotografar();
    confere(w.__clicks === 1, 'cai na câmera do sistema');
    confere(JSON.parse(cel.ls.get('frota_rascunho_u1')).camera === true, 'e o rascunho já está gravado antes de sair do app');
  }

  console.log('Recarga automática de versão nova:');
  {
    const trecho = indexHtml.slice(indexHtml.indexOf("addEventListener('controllerchange'"), indexHtml.indexOf('location.reload();'));
    confere(/_momentoBomParaRecarregar\(\)\)\s*return;/.test(trecho), 'a troca de service worker confere o formulário antes de recarregar');
    const fn = appJs.slice(appJs.indexOf('function _momentoBomParaRecarregar'), appJs.indexOf('async function _aplicarAtualizacao'));
    confere(fn.includes('#cam-nota-overlay') && fn.includes('#crop-overlay'), 'câmera e recorte abertos seguram a recarga');
  }

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
