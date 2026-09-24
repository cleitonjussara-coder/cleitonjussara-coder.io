'use strict';
/* ─────────────────────────────────────────────────────────────
   app.js — Core Petermann PWA
   Servidor: Petermann API (Laravel + MySQL na Locaweb) — ver js/api.js.
   O endereço da API está lá; aqui não há credencial nenhuma.
───────────────────────────────────────────────────────────── */
const DEMO_MODE = false;   // modo demo antigo (sem servidor); "Usar sem conta" continua existindo

/* Login social. Só o Google está ligado: o backend faz o OAuth
   (api/auth/google/redirect) com o cliente do projeto CLEITON-PM. Os
   outros ficam `ativo:false` até existirem no backend. Ordem = ordem na tela. */
const PROVEDORES_SOCIAIS = [
  { id:'google',   nome:'Google',    ativo:true,
    icone:'<svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>' },
  { id:'azure',    nome:'Microsoft', ativo:false, opcoes:{ scopes:'email' },
    icone:'<svg viewBox="0 0 23 23"><rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="12" y="1" width="10" height="10" fill="#7FBA00"/><rect x="1" y="12" width="10" height="10" fill="#00A4EF"/><rect x="12" y="12" width="10" height="10" fill="#FFB900"/></svg>' },
  { id:'facebook', nome:'Facebook',  ativo:false,
    icone:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#1877F2"/><path fill="#fff" d="M15.5 12.7h-2.3V21h-3.3v-8.3H8.3V9.9h1.6V8.2c0-2.3 1-3.7 3.7-3.7h2v2.8h-1.3c-1 0-1.1.4-1.1 1.1v1.5h2.5l-.2 2.8z"/></svg>' },
  { id:'apple',    nome:'Apple',     ativo:false,
    icone:'<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>' },
];

/* ── Estado global ───────────────────────────────────────── */
let sb        = null;
let user      = null;   // { id, email, nome, role, nucleo }
let notas     = [];      // SÓ as minhas (20/09/2026): Minhas notas, Painel, Saldo, Início, exportações
let notasEquipe = [];    // gestor/admin: notas dos outros, para editar/ver pelo detalhe da Equipe
/* Uma nota pelo id, seja minha, da equipe ou desenhada num cartão avulso. */
function _notaPorId(id) {
  if (!id) return null;
  return notas.find(x => x.id === id) || notasEquipe.find(x => x.id === id)
      || (typeof _notasDesenhadas !== 'undefined' ? _notasDesenhadas.get(id) : null) || null;
}
let repasses  = [];
let driveOk   = false;
let viewAtual = 'home';
let filMes    = new Date().getMonth() + 1;
let filAno    = new Date().getFullYear();
let _drivePullInterval = null;
let filtroPeriodo = 'mensal';
let equipePorId = {};

/* câmera */
let qrStream  = null;
let qrFrame   = null;

/* arquivo (foto / PDF / XML) selecionado na edição */
let fotoBlob  = null;
/* A foto como veio da câmera, antes do enquadramento. O QR costuma ficar
   no rodapé do cupom, fora do recorte que a pessoa faz para ler o valor —
   o botão "Ler QR da foto" precisa procurar na foto inteira. */
let fotoOriginal = null;
let fotoURL   = null;
let fotoExt   = null;   // 'jpg' | 'png' | 'pdf' | 'xml' | …
let fotoRender    = null;   // imagem renderizada da 1ª página do PDF (preview + QR/OCR)
let fotoRenderURL = null;

const MESES   = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
/* Versão do PRODUTO — é o que o colaborador vê. Sobe quando o app ganha
   algo que muda o uso dele, não a cada publicação. */
const APP_VERSION = 'v4';

/* Número da PUBLICAÇÃO — contador interno, sobe a cada deploy. Vive nas
   query strings `?v=` do index.html e no CACHE do sw.js, e é ele que
   permite verificar o que está no ar de verdade (com "v1" fixo não daria
   para distinguir uma publicação da outra). Aparece só no diagnóstico e
   nas telas técnicas, para suporte. */
const APP_BUILD = 262;
/* Frota/KM e Ponto: visíveis SÓ para gestor/admin (decisão de 19/09/2026);
   colaborador não vê. false = some para todos. */
const MODULOS_EXTRAS = true;
const _driveDiag = { googleTokenNoRetorno: '—', setToken: '—', init: '—', automatico: '—' };   // diagnóstico do Drive (Perfil)

/* Dados fixos da aba CABEÇALHO da planilha padrão da empresa */
const EMPRESA = {
  razao:     'PETERMANN & MORAIS LTDA ME',
  cnpj:      '17.117.768/0001-42',
  endereco:  'Rua Natal Vasconcelos Montes, 185 - Sala 01. Centro.',
  cep:       '75.503-340',
  cidade:    'Itumbiara, Goiás',
  titulo:    'DESPESAS CORPORATIVAS',
  subtitulo: 'Relatório de Despesas Mensais (RDM) e Relatório de Despesas com Alimentações (RDA)',
};

/* Safra e exercício são a mesma coisa aqui: o ano civil. O "25/26" que aparece
   na planilha modelo é rótulo daquele documento, não uma regra do app. */

/* Trimestres da aba BANCO DE DADOS: T1 = Jan-Mar, T2 = Abr-Jun, T3 = Jul-Set, T4 = Out-Dez */
const TRIMESTRES = [
  { id:'T1', meses:[1,2,3],    rotulo:'Jan–Mar' },
  { id:'T2', meses:[4,5,6],    rotulo:'Abr–Jun' },
  { id:'T3', meses:[7,8,9],    rotulo:'Jul–Set' },
  { id:'T4', meses:[10,11,12], rotulo:'Out–Dez' },
];

/* ── Helpers ─────────────────────────────────────────────── */
const brl  = v => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v||0);
const hoje = () => new Date().toISOString().split('T')[0];
const esc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const $    = id => document.getElementById(id);
const fmtData = d => { try { return new Date(d+'T00:00:00').toLocaleDateString('pt-BR'); } catch(_){return d;} };
const _digitos = s => String(s||'').replace(/\D/g,'');

/* ── Tipo de arquivo anexado (foto / PDF / XML) ───────────── */
const _EXTS_OK = ['jpg','jpeg','png','webp','heic','gif','pdf','xml'];
function _extDoArquivo(file) {
  const nome = (file?.name || '').toLowerCase();
  const m = nome.match(/\.([a-z0-9]+)$/);
  if (m && _EXTS_OK.includes(m[1])) return m[1] === 'jpeg' ? 'jpg' : m[1];
  const t = (file?.type || '').toLowerCase();
  if (t === 'application/pdf') return 'pdf';
  if (t === 'text/xml' || t === 'application/xml') return 'xml';
  if (t === 'image/png')  return 'png';
  if (t === 'image/webp') return 'webp';
  if (t === 'image/heic' || t === 'image/heif') return 'heic';
  if (t === 'image/gif')  return 'gif';
  if (t.startsWith('image/')) return 'jpg';
  return 'jpg';
}
/* 'image' | 'pdf' | 'xml' a partir da extensão */
function _kindDoExt(ext) {
  ext = String(ext || '').toLowerCase();
  if (!ext) return null;
  if (ext === 'pdf') return 'pdf';
  if (ext === 'xml') return 'xml';
  return 'image';
}
const _ehImagemExt = ext => _kindDoExt(ext) === 'image';
const _extDeUrl = url => { const m = String(url).match(/\.([a-z0-9]+)(?:[?#]|$)/i); return m ? m[1].toLowerCase() : null; };

function _setFotoRender(blob) {
  fotoRender    = blob || null;
  fotoRenderURL = blob ? URL.createObjectURL(blob) : null;
}

/* ── PDF → imagem (pdf.js sob demanda, como o Tesseract) ──── */
const _PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build';
async function _ensurePdfJs() {
  if (window.pdfjsLib) return;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = `${_PDFJS_BASE}/pdf.min.js`;
    s.onload  = res;
    s.onerror = () => rej(new Error('Falha ao carregar o leitor de PDF'));
    document.head.appendChild(s);
  });
  // worker via blob (CDN é cross-origin); se falhar, o pdf.js usa o fallback na thread principal
  try {
    const t = await (await fetch(`${_PDFJS_BASE}/pdf.worker.min.js`)).text();
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([t], { type: 'text/javascript' }));
  } catch (_) {}
}

/* Renderiza a 1ª página do PDF como JPEG e extrai o texto embutido (se houver) */
async function _renderPdfPagina1(file) {
  await _ensurePdfJs();
  const doc  = await pdfjsLib.getDocument({
    data: await file.arrayBuffer(),
    // fontes padrão (Helvetica etc.) e cmaps vêm do CDN — sem isso o render trava
    standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/standard_fonts/',
    cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
    cMapPacked: true,
  }).promise;
  const page = await doc.getPage(1);
  const vp1  = page.getViewport({ scale: 1 });
  const vp   = page.getViewport({ scale: Math.min(3, 1600 / vp1.width) });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  // intent 'print' usa setTimeout em vez de requestAnimationFrame —
  // não trava se o app for para segundo plano durante a leitura
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp, intent: 'print' }).promise;
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));

  let texto = '';
  try {
    const tc = await page.getTextContent();
    const porY = {};
    for (const it of tc.items) {
      const y = Math.round(it.transform[5]);
      (porY[y] = porY[y] || []).push(it.str);
    }
    // PDF tem origem no canto inferior → ordena do topo para a base
    texto = Object.keys(porY).map(Number).sort((a, b) => b - a)
      .map(y => porY[y].join(' ')).join('\n');
  } catch (_) {}
  return { blob, texto };
}

/* ── Link de consulta da nota (SEFAZ) ───────────────────────
   Só a URL lida do QR abre a nota exata — ela carrega o hash assinado com
   o CSC do emitente, que não dá para recalcular a partir da chave (ver o
   cabeçalho do sefaz.js). Sem ela sobra o portal nacional com a chave
   preenchida, que é palpite com captcha: por isso devolvemos {exato}, para
   a UI avisar em vez de prometer o que não entrega. */
/* O QR da BA vem em http:// e o Chrome abre com "Não seguro" (e implica com
   os redirecionamentos do site). O mesmo endereço em https mostra o DANFE
   igual (conferido em 16/09/2026). Só troca em host que sabidamente aceita —
   SEFAZ sem https daria erro de certificado no lugar da nota. */
const _QR_HOSTS_HTTPS = ['nfe.sefaz.ba.gov.br'];
function _qrUrlSegura(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' && _QR_HOSTS_HTTPS.includes(u.hostname)) { u.protocol = 'https:'; return u.toString(); }
  } catch (_) {}
  return url;
}

async function resolverLinkConsulta(chaveRaw, qrUrlDaNota) {
  const chave = _digitos(chaveRaw);
  if (chave.length !== 44) return null;

  if (/^https?:\/\//i.test(qrUrlDaNota || '')) return { url: _qrUrlSegura(qrUrlDaNota), exato: true };

  // notas escaneadas antes da v59 têm a URL só em meta, neste aparelho
  let raw = null;
  try { raw = await DB.getMeta('qr_' + chave); } catch (_) {}
  if (raw) return { url: _qrUrlSegura(raw), exato: true };

  const fallback = window.SEFAZ?.linkConsulta ? SEFAZ.linkConsulta(chave) : null;
  return fallback ? { url: fallback, exato: false } : null;
}

function abrirConsultaChave(chaveRaw, qrUrlDaNota) {
  // NFS-e: não tem chave de 44, mas o QR dela é um link direto para a nota
  if (_digitos(chaveRaw).length !== 44 && /^https?:\/\//i.test(qrUrlDaNota || '')) { window.open(qrUrlDaNota, '_blank'); return; }
  if (_digitos(chaveRaw).length !== 44) { toast('Esta nota não tem chave nem QR para consulta', 'err'); return; }
  const w = window.open('', '_blank');           // abre já, evita bloqueio de popup
  resolverLinkConsulta(chaveRaw, qrUrlDaNota).then(r => {
    if (!r) { if (w) w.close(); toast('Não foi possível montar o link de consulta', 'err'); return; }
    if (w) w.location.href = r.url; else window.open(r.url, '_blank');
    if (!r.exato) toast('Nota não foi lida por QR — abrindo o portal nacional com a chave (pede captcha)');
  });
}

/* ── Aba/categoria automática pelo fornecedor ────────────────────────────
   Pedido em 16/09/2026 ("automatizar as informações"). Ordem de confiança:
   1. histórico — esse CNPJ já foi lançado: repete a aba/categoria mais usada;
   2. CNAE principal do CNPJ (BrasilAPI, guardado no cache de CNPJ);
   3. palavras no nome (posto, hotel, restaurante, peças…).
   Só SUGERE: a pessoa vê a aba escolhida e troca com um toque. */
const _CNAE_ABA = [
  [/^4731/,                         { tipo:'RDM', subtipo:'Abastecimento', rotulo:'posto de combustível' }],
  [/^(5510|5590)/,                  { tipo:'RDM', subtipo:'Hospedagem',    rotulo:'hotel/pousada' }],
  [/^(5611|5612|5620|4721|4722|4723|4729|1091|1092|4711|4712)/, { tipo:'RDA', subtipo:null, rotulo:'alimentação' }],
  [/^(4530|4520|4541|4744|2219|4763|4789|4751|4752|4753|4754|4755|4759|4771|4772|4773|4774|4781|4782|4783|4784|4785|3314|9529)/, { tipo:'RDM', subtipo:'Outros', rotulo:'peças/serviços/loja' }],
];
const _NOME_ABA = [
  [/\b(auto\s*posto|posto|combust[íi]ve)/i,                        { tipo:'RDM', subtipo:'Abastecimento', rotulo:'posto' }],
  [/\b(hotel|pousada|hospedagem|motel|hostel)/i,                    { tipo:'RDM', subtipo:'Hospedagem',    rotulo:'hospedagem' }],
  [/\b(restaurante|lanchonete|churrascaria|panificadora|padaria|pizzaria|bar\b|espetinho|marmita|sorveteria|supermercado|mercado|alimentos|refei[çc])/i, { tipo:'RDA', subtipo:null, rotulo:'alimentação' }],
  [/\b(pe[çc]as|oficina|borracharia|pneus?|auto\s*center|ferragens|el[ée]trica|mec[âa]nica)/i, { tipo:'RDM', subtipo:'Outros', rotulo:'peças/serviços' }],
];
function _sugestaoPorHistorico(cnpj) {
  const c = _digitos(cnpj);
  if (c.length !== 14 || /^0+$/.test(c)) return null;
  const cont = new Map();
  for (const n of notas) {
    if (n.deleted || _digitos(n.cnpj || '') !== c || !n.tipo) continue;
    const k = n.tipo + '|' + (n.tipo === 'RDM' ? (n.subtipo || 'Outros') : '');
    cont.set(k, (cont.get(k) || 0) + 1);
  }
  if (!cont.size) return null;
  const [k, q] = [...cont.entries()].sort((a, b) => b[1] - a[1])[0];
  const [tipo, subtipo] = k.split('|');
  return { tipo, subtipo: subtipo || null, rotulo: `histórico (${q} nota${q > 1 ? 's' : ''})`, fonte: 'historico' };
}
function _sugestaoPorCnae(cnae) {
  const c = _digitos(cnae);
  if (!c) return null;
  for (const [re, s] of _CNAE_ABA) if (re.test(c)) return { ...s, fonte: 'cnae' };
  return null;
}
function _sugestaoPorNome(nome) {
  const t = String(nome || '');
  if (!t) return null;
  for (const [re, s] of _NOME_ABA) if (re.test(t)) return { ...s, fonte: 'nome' };
  return null;
}
/* Assíncrona só quando precisa do CNAE (BrasilAPI); histórico e nome são
   instantâneos. Devolve {tipo, subtipo, rotulo, fonte} ou null. */
async function sugerirAba({ cnpj, razao_social, chave } = {}) {
  const c = _digitos(cnpj) || (_digitos(chave).length === 44 ? _digitos(chave).slice(6, 20) : '');
  let s = _sugestaoPorHistorico(c) || _sugestaoPorNome(razao_social);
  if (s) return s;
  if (c.length === 14 && navigator.onLine) {
    try {
      const info = await Promise.race([BrasilAPI.consultar(c, sb), new Promise(r => setTimeout(() => r(null), 5000))]);
      s = _sugestaoPorCnae(info?.cnae) || _sugestaoPorNome(info?.razao_social || info?.nome_fantasia);
      if (s && info?.cnae_descricao && s.fonte === 'cnae') s.rotulo = info.cnae_descricao.toLowerCase().slice(0, 40);
    } catch (_) {}
  }
  return s || null;
}
function _aplicarSugestaoNoForm(s) {
  if (!s) return;
  $('nf-tipo').value = s.tipo;
  if (s.tipo === 'RDM' && s.subtipo) $('nf-subtipo').value = s.subtipo;
  toggleSubtipo();
}
/* Depois que o OCR/QR revelou o fornecedor com o formulário já aberto: mostra
   a sugestão no banner da aba, sem trocar sozinho (a pessoa já escolheu). */
let _sugestaoPendente = null;
async function _sugerirAbaNoFormulario() {
  const s = await sugerirAba({ cnpj: $('nf-cnpj').value, razao_social: $('nf-razao').value, chave: $('nf-chave').value });
  const box = $('nota-aba-sugestao');
  if (!box) return;
  const atualTipo = $('nf-tipo').value, atualSub = $('nf-subtipo').value;
  const igual = s && s.tipo === atualTipo && (s.tipo !== 'RDM' || !s.subtipo || s.subtipo === atualSub);
  if (!s || igual) { box.style.display = 'none'; _sugestaoPendente = null; return; }
  _sugestaoPendente = s;
  box.style.display = 'flex';
  $('nota-aba-sugestao-txt').textContent = `Sugestão: ${s.tipo}${s.tipo === 'RDM' && s.subtipo ? ' · ' + s.subtipo : ''} (${s.rotulo})`;
}
function aplicarSugestaoAba() {
  if (_sugestaoPendente) _aplicarSugestaoNoForm(_sugestaoPendente);
  const box = $('nota-aba-sugestao'); if (box) box.style.display = 'none';
  _sugestaoPendente = null;
}

/* ── Valor oficial pela URL do QR (servidor abre o portal do SEFAZ) ──────
   O QR não traz o valor; a página do SEFAZ que ele aponta traz. A API lê a
   página (BA e GO verificados em 16/09/2026) e devolve valor/data/emitente.
   Roda em segundo plano assim que o QR é lido; quando responde, preenche o
   formulário se a chave ainda for a mesma e a pessoa não tiver digitado o
   valor à mão. Falhou? Fica o OCR, como sempre. */
const _sefazQrCache = new Map();   // chave → resultado (ou null)
let _valorEditadoManual = false;
async function _sefazPorQr(qrUrl, chave) {
  const c = _digitos(chave);
  if (!/^https?:\/\//i.test(qrUrl || '') || !sb || !navigator.onLine) return null;
  const k = c || qrUrl;
  if (_sefazQrCache.has(k)) return _sefazQrCache.get(k);
  const p = sb.notas.consultarQr(qrUrl, c || null).catch(() => null);
  _sefazQrCache.set(k, p);
  const r = await p;
  _sefazQrCache.set(k, r);
  if (r) _aplicarSefazNoForm(r, c);
  return r;
}
function _aplicarSefazNoForm(r, chave) {
  const ov = $('nota-form-overlay');
  if (!ov || !r) return;
  if (chave && _digitos($('nf-chave').value) !== chave) return;    // já é outra nota
  const mudou = [];
  if (typeof r.valor === 'number' && r.valor > 0 && !_valorEditadoManual) {
    const atual = parseFloat($('nf-valor').value);
    if (!(Math.abs(atual - r.valor) < 0.005)) { $('nf-valor').value = r.valor.toFixed(2); mudou.push('valor'); }
  }
  if (r.data && /^\d{4}-\d{2}-\d{2}$/.test(r.data) && $('nf-data').value !== r.data) {
    $('nf-data').value = r.data; mudou.push('data');
    const d = new Date(r.data + 'T00:00:00'); $('nf-mes').value = d.getMonth() + 1; $('nf-ano').value = d.getFullYear();
  }
  if (r.razao_social && !$('nf-razao').value) { $('nf-razao').value = r.razao_social; mudou.push('empresa'); }
  if (r.cnpj && !_digitos($('nf-cnpj').value)) { $('nf-cnpj').value = BrasilAPI.formatar(r.cnpj); mudou.push('CNPJ'); }
  const b = $('captura-badge'); if (b) b.textContent = '🌐 Valor conferido no SEFAZ';
  if (mudou.length && ov.style.display !== 'none') toast(`SEFAZ confirmou: ${mudou.join(', ')} ✔`);
}

/* ── Documento fiscal: NFC-e / NF-e / DANFE / NFS-e / outro ─────────────
   Pedido em 16/09/2026. A chave de 44 dígitos já diz o modelo (posições
   21–22): 65 = NFC-e, 55 = NF-e. Um 55 fotografado em papel é DANFE; vindo
   de XML/PDF é NF-e. NFS-e (serviço, municipal) não tem chave de 44 — o
   que a identifica é o QR/URL com "nfse". Sem nada disso, a pessoa escolhe. */
const DOC_LABEL = { nfce:'🧾 NFC-e', nfe:'📄 NF-e', danfe:'🖨️ DANFE', nfse:'🧰 NFS-e', outro:'🗒️ Outro' };
let _docEscolhidoManual = false;   // a pessoa mexeu no select → não sobrescrever

function _docPelaChave(chave, ext) {
  const c = _digitos(chave);
  if (c.length !== 44) return null;
  const modelo = c.slice(20, 22);
  if (modelo === '65') return 'nfce';
  if (modelo === '55') return /^(xml|pdf)$/i.test(ext || '') ? 'nfe' : 'danfe';
  return null;
}
function _ehUrlNfse(txt) { return /^https?:\/\/\S+/i.test(txt || '') && /nfse/i.test(txt); }
function docDaNota(n) {
  if (!n) return null;
  if (n.documento && DOC_LABEL[n.documento]) return n.documento;
  const ext = n.foto_path ? String(n.foto_path).split('.').pop() : (n.foto_local || '');
  return _docPelaChave(n.chave_nfce, ext) || (_ehUrlNfse(n.qr_url) ? 'nfse' : null);
}
function _numeroSerieHTML(n) {
  const ns = (n?.numero) ? { numero: n.numero, serie: n.serie } : _numeroSerieDaChave(n?.chave_nfce);
  if (!ns?.numero) return '';
  return `<div class="nota-cnpj">nº ${esc(String(ns.numero))}${ns.serie != null && ns.serie !== '' ? ` · série ${esc(String(ns.serie))}` : ''}</div>`;
}
function docBadgeHTML(n) {
  const d = docDaNota(n);
  return d ? `<span class="doc-tag ${d}">${DOC_LABEL[d]}</span>`
           : `<span class="doc-tag vazio" title="Documento não informado — edite a nota para escolher">documento?</span>`;
}
/* Número e série vêm da própria chave (série = 23–25, número = 26–34).
   Só preenche campo vazio: o que a pessoa digitou fica. */
function _numeroSerieDaChave(chave) {
  const c = _digitos(chave);
  if (c.length !== 44) return null;
  return { numero: c.slice(25, 34).replace(/^0+/, '') || '0', serie: c.slice(22, 25).replace(/^0+/, '') || '0' };
}
function _preencherNumeroSerie(numero, serie, sobrescrever = false) {
  const n = $('nf-numero'), s = $('nf-serie');
  if (n && numero && (sobrescrever || !n.value)) n.value = String(numero);
  if (s && serie  != null && serie !== '' && (sobrescrever || !s.value)) s.value = String(serie);
}
function _atualizarNumeroSerieAuto() {
  const ns = _numeroSerieDaChave($('nf-chave').value);
  if (ns) _preencherNumeroSerie(ns.numero, ns.serie, true);   // a chave é autoritativa
}

/* Preenche o select pelo que já se sabe (chave/anexo/QR), sem passar por
   cima de escolha manual. */
function _atualizarDocumentoAuto() {
  const sel = $('nf-documento');
  if (!sel || _docEscolhidoManual) return;
  const salva = _notaPorId($('nf-id').value);
  const ext = fotoExt || (fotoBlob ? _extDoArquivo(fotoBlob) : '') || (salva?.foto_path ? String(salva.foto_path).split('.').pop() : '');
  const auto = _docPelaChave($('nf-chave').value, ext) || (_ehUrlNfse($('nf-qr-url').value) ? 'nfse' : null);
  if (auto) sel.value = auto;
  const dica = $('nf-documento-dica');
  if (dica) {
    const c = _digitos($('nf-chave').value);
    dica.style.display = auto ? 'block' : 'none';
    dica.textContent = auto === 'nfse' ? 'Identificado pelo QR da NFS-e'
      : auto ? `Identificado pela chave (modelo ${c.slice(20, 22)})${auto === 'danfe' ? ' — anexo em foto: DANFE; se for o XML/PDF, escolha NF-e' : ''}` : '';
  }
}

/* Cartões de nota de OUTRAS pessoas (Equipe → colaborador) não estão em
   `notas` (só as minhas). cardNotaHTML registra cada nota que desenha aqui,
   senão o 🔗 dessas notas dizia "não tem chave" — parecia problema do SEFAZ
   de outro estado, mas era só a busca na lista errada. */
const _notasDesenhadas = new Map();
function consultarNota(id) {
  const n = _notaPorId(id);
  abrirConsultaChave(n?.chave_nfce || '', n?.qr_url || null);
}

/* guarda a URL real lida de um QR, indexada pela chave.
   Só salva se for mesmo uma URL (QR) — código de barras traz a chave pura,
   que não serve como link e deixaria a montagem por modelo (NF-e/NFC-e) acontecer. */
function _salvarUrlQR(chave, url) {
  const c = _digitos(chave);
  if (c.length === 44 && /^https?:\/\//i.test(url)) DB.setMeta('qr_' + c, url).catch(() => {});
}

let _toastTimer;
function toast(msg, tipo='ok') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast toast-${tipo} show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

let _telaAtual = 'auth';

/* `msg` é opcional: operações longas (ex.: migração de pastas do Drive)
   reexibem o overlay a cada passo com o progresso, o que também rearma o
   timeout de segurança — sem isso ele se esconderia no meio do trabalho. */
function setLoading(on, msg = '') {
  const el = $('loading-overlay');
  const tx = $('loading-msg');
  if (tx) tx.textContent = on ? msg : '';
  if (on) {
    el.style.display = 'flex';
    setTimeout(() => { if (el.style.display === 'flex') el.style.display = 'none'; }, 15000);
  } else {
    el.style.display = 'none';
  }
}

async function syncBadge(syncing) {
  const dot = $('sync-dot');
  const txt = $('sync-txt');
  const banner = $('offline-banner');
  const bannerText = $('offline-banner-text');
  if (!dot || !txt) return;

  if (syncing) {
    dot.className = 'sync-dot syncing';
    txt.textContent = 'sincronizando';
    return;
  }

  let summary = { count: 0, failedCount: 0, scheduledCount: 0 };
  if (DB?.getSyncQueueSummary) {
    try { summary = await DB.getSyncQueueSummary(); } catch (_) {}
  }

  if (!navigator.onLine) {
    dot.className = 'sync-dot offline';
    txt.textContent = 'offline';
    if (banner && bannerText) {
      bannerText.textContent = summary.count
        ? `📡 Offline — ${summary.count} item${summary.count === 1 ? '' : 's'} aguardando sincronização`
        : '📡 Você está offline. As alterações ficam salvas no celular e sincronizam quando a rede voltar.';
      banner.style.display = 'flex';
    }
    return;
  }

  dot.className = 'sync-dot online';
  txt.textContent = 'online';
  if (banner && bannerText) {
    if (summary.count) {
      const suffix = summary.failedCount ? ` · ${summary.failedCount} com falha` : '';
      const retryText = summary.scheduledCount ? ' · reprocessando em breve' : '';
      bannerText.textContent = `🔄 ${summary.count} item${summary.count === 1 ? '' : 's'} pendente${summary.count === 1 ? '' : 's'} de sincronização${suffix}${retryText}`;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }
}

/* ── Loaders sob demanda (lazy) ──────────────────────────── */
function _loadScript(src, erro) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload  = () => res();
    s.onerror = () => rej(new Error(erro));
    document.head.appendChild(s);
  });
}

/* Cliente da API — `sb` continua sendo o nome da variável (é "o servidor"
   em todo o código), mas agora aponta para window.API (js/api.js), que
   fala com a Petermann API na Locaweb. UMA promessa, UM listener. */
let _sbPromise = null;
function _ensureSb() {
  if (_sbPromise) return _sbPromise;
  _sbPromise = (async () => {
    if (!window.API) throw new Error('Falha ao carregar autenticação');
    sb = window.API;
    sb.auth.onChange(ev => {
      /* Token revogado/expirado (401) ou logout: volta para a tela de
         entrada. Durante a troca de senha pelo link não há sessão mesmo. */
      if (ev === 'SIGNED_OUT' && !_recuperandoSenha && _telaAtual !== 'auth') {
        user = null;
        _telaAtual = 'auth';
        showTela('auth');
        renderAuth('login');
      }
    });
    return sb;
  })();
  return _sbPromise;
}

let _jsqrPromise = null;
function _ensureJsQR() {
  if (typeof jsQR !== 'undefined') return Promise.resolve();
  if (!_jsqrPromise) {
    _jsqrPromise = _loadScript(
      'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
      'Falha ao carregar leitor QR');
  }
  return _jsqrPromise;
}

/* Homologação (21/09/2026): em teste.pmservicosagronomicos.com.br o app fala
   com a API de teste. Faixa laranja fixa + título + manifest próprio, para
   ninguém confundir com a produção nem instalar o ícone errado. */
function _marcarHomologacao() {
  if (!window.API?.HOMOLOG) return;
  document.body.classList.add('homolog');
  document.title = '🧪 TESTE — ' + document.title;
  const m = document.querySelector('link[rel="manifest"]');
  if (m) m.href = 'manifest-teste.json?v=' + APP_BUILD;
  const f = document.createElement('div');
  f.className = 'homolog-faixa';
  f.textContent = '🧪 AMBIENTE DE TESTE — nada daqui vale para a empresa';
  document.body.appendChild(f);
}

/* Faixa do usuário na moldura do app (23/09/2026): foto, saudação, papel e
   os botões Perfil e Sair. Vale para todas as abas; some na tela de login. */
function _pintarBarraUsuario() {
  const el = $('barra-usuario');
  if (!el) return;
  if (!user || _telaAtual !== 'app') { el.style.display = 'none'; return; }
  const hora = new Date().getHours();
  const saud = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
  const nome = (user?.nome || user?.email || '').split(' ')[0] || '';
  const hojeTxt = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  /* versão curta para o celular: "23 set" cabe ao lado da etiqueta do papel
     sem empurrar a saudação para a segunda linha (23/09/2026) */
  const hojeCurto = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
  const papel = user?.role || 'colaborador';
  el.style.display = '';
  el.innerHTML = `
    <div class="avatar ${user?.foto_path ? 'clicavel' : ''}" ${user?.foto_path ? `data-foto="${esc(user.foto_path)}" data-nome="${esc(user?.nome || '')}" data-sub="${esc(PAPEL_NOME[papel] || papel)}" onclick="Gestor.verFoto(this)"` : 'onclick="switchView(\'perfil\')" title="Adicionar foto no Perfil"'}>${esc((user?.nome || user?.email || '?')[0].toUpperCase())}</div>
    <div class="ini-ola-txt">
      <h2>${saud}${nome ? ', ' + esc(nome) : ''} 👋</h2>
      <span><span class="role-pill role-${esc(papel)}">${esc(PAPEL_NOME[papel] || papel)}</span><span class="ini-ola-data"> · <span class="data-longa">${esc(hojeTxt)}</span><span class="data-curta">${esc(hojeCurto)}</span></span></span>
    </div>
    <div class="ini-ola-acoes">
      <button class="btn btn-sm btn-outline" onclick="switchView('perfil')">👤 Perfil</button>
      <button class="btn btn-sm btn-danger-outline" onclick="if(confirm('Sair da conta neste aparelho?')) logout()">🚪 Sair</button>
    </div>`;
  _mostrarAvatar();
}

/* Mostra (ou esconde) a pílula "voltar" do rodapé. `acao` é o código que o
   botão executa — o mesmo que ficava no botão de dentro da tela. */
function _voltarRodape(acao, rotulo) {
  const b = $('btn-voltar-rodape');
  if (!b) return;
  if (!acao) { b.style.display = 'none'; document.body.classList.remove('tem-voltar-rodape'); return; }
  b.textContent = rotulo || '‹ Voltar';
  b.onclick = () => { try { (new Function(acao))(); } catch (e) { console.warn('voltar:', e); } };
  b.style.display = '';
  document.body.classList.add('tem-voltar-rodape');
}

/* ── Inicialização ───────────────────────────────────────── */
async function init() {
  syncBadge(false);
  if (!DEMO_MODE) {
    try {
      await _ensureSb();
      _marcarHomologacao();
      /* Lê a URL (retorno do Google, link de senha) e valida o token guardado */
      const boot = await sb.auth.init();
      if (boot.authError) {
        toast(boot.authError === 'cancelado'    ? 'Login com Google cancelado'
            : boot.authError === 'desativada'   ? 'Conta desativada. Fale com o gestor ou o administrador.'
            : boot.authError === 'indisponivel' ? 'Login com Google ainda não está liberado'
            : 'Não foi possível entrar com o Google', 'err');
      }
      if (boot.driveBackup) {
        /* voltou da autorização do Drive para o backup: avisa e abre o Perfil */
        _abrirPerfilAoEntrar = true;
        toast(boot.driveBackup === 'ok'        ? 'Google Drive conectado ao backup ✅'
            : boot.driveBackup === 'cancelado' ? 'Autorização do Drive cancelada'
            : 'Não consegui conectar o Drive — tente de novo', boot.driveBackup === 'ok' ? 'ok' : 'err');
      }
      /* Login Google com escopo do Drive devolve o token do Google junto.
         Entrega ao GDrive antes de abrir o app: é assim que gestor/admin
         entram já conectados, sem botão. ~55 min de vida. */
      _driveDiag.googleTokenNoRetorno = boot.googleToken ? 'sim' : 'não';
      if (boot.googleToken && window.GDrive?.setToken) {
        if (GDrive.setToken(boot.googleToken.token, boot.googleToken.exp || Date.now() + 55 * 60_000)) {
          driveOk = true; updateDriveBadge();
          _driveDiag.setToken = 'ok';
        }
      }
      if (boot.recovery) {
        /* veio do link do e-mail: pede a nova senha antes de qualquer coisa */
        _recuperacao = boot.recovery;
        _recuperandoSenha = true;
        showTela('auth'); renderAuth('nova-senha');
      } else if (boot.convite && !(sb.auth.isLogged() && boot.user)) {
        /* veio do link de convite do gestor: cadastro já com o papel */
        showTela('auth');
        try {
          const c = await sb.convites.ver(boot.convite);
          if (c.valido) { _convite = { token: boot.convite, ...c }; renderAuth('reg'); }
          else { renderAuth('reg'); toast(c.motivo || 'Convite inválido', 'err'); }
        } catch (_) { renderAuth('reg'); toast('Não consegui conferir o convite — tente de novo com internet', 'err'); }
        try { const q = new URLSearchParams(location.search); q.delete('convite'); history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '')); } catch (_) {}
      } else if (sb.auth.isLogged() && boot.user) {
        await onLogin(boot.user);
      } else {
        showTela('auth'); renderAuth();
      }
    } catch (_) {
      // sem rede no boot — mostra login mesmo assim
      showTela('auth'); renderAuth();
    }
  } else {
    // modo demo sem servidor
    $('demo-banner').style.display = 'flex';
    await DB.open();
    user = { id:'demo-user', email:'demo@petermann.app', nome:'Demo', role:'admin', nucleo:'Cristalina' };
    await carregarDadosLocais();
    showTela('app');
    switchView('inicio');
  }

  initDrive();
  _drivePullInterval = setInterval(async () => {
    if (driveOk && user && navigator.onLine) await pullFromDrive();
  }, 5 * 60_000);
  window.addEventListener('online', async () => {
    syncBadge(false);
    if (sb && user) {
      await DB.sync(sb, user.id);
      if (driveOk) await pullFromDrive();
    }
  });
  window.addEventListener('offline', () => syncBadge(false));
  _instalarPuxarParaAtualizar();
  window.addEventListener('db-synced', async e => {
    syncBadge(false);
    if (driveOk) await pullFromDrive().catch(() => {});
    await carregarDadosLocais();
    if (viewAtual==='home')   renderHome();
    if (viewAtual==='notas') renderNotas();
    if (viewAtual==='lixeira') renderNotasApagadas();
    if (viewAtual==='saldo') renderSaldo();
    const {ok,pulled,fotosFail,erroFoto} = e.detail||{};
    if ((ok||0)+(pulled||0) > 0) toast(`Sincronizado: ${ok||0} enviados, ${pulled||0} recebidos`);
    if (fotosFail) _avisarFalhaAnexo(fotosFail, erroFoto);
  });
  window.addEventListener('ocr-progress', e => {
    const el = $('ocr-progress');
    if (el) el.textContent = `Processando… ${e.detail}%`;
  });
}

async function onLogin(authUser) {
  _histViews = [];
  /* Entrada ainda não confirmada pelo gestor (22/09/2026): não abre o app —
     a API recusaria tudo de qualquer jeito (403 pendente). */
  if (authUser && 'confirmado_em' in authUser && !authUser.confirmado_em) {
    user = authUser;
    setLoading(false);
    showTela('auth');
    renderAuth('espera');
    return;
  }
  setLoading(true);
  try {
    await DB.open();
    // perfil em cache → app abre na hora; sem cache, usa padrão
    let perfil = null;
    try { perfil = JSON.parse(localStorage.getItem('perfil_' + authUser.id) || 'null'); } catch (_) {}
    /* sem cache: aproveita o que o login/cadastro já devolveu (papel incluso —
       o Início e o hub Despesas mudam conforme o papel, 21/09/2026) */
    user = perfil || { id:authUser.id, email:authUser.email, nome:authUser.nome||'', role:authUser.role||'colaborador', nucleo:authUser.nucleo||'Cristalina', foto_path:authUser.foto_path||null };
    DB.setupAutoSync(sb, () => user?.id);
    _driveAutomatico();                       // perfil em cache já diz se é gestor/admin
    await carregarDadosLocais();
    showTela('app');
    switchView(_abrirPerfilAoEntrar ? 'perfil' : 'inicio');   // voltou da autorização do Drive → direto no Perfil
    _abrirPerfilAoEntrar = false;
    setLoading(false);

    // perfil oficial em background (não bloqueia a tela)
    if (!DEMO_MODE && sb) {
      sb.auth.me()
        .then(data => {
          if (!data) return;
          const mudou = JSON.stringify(data) !== JSON.stringify(perfil);
          user = data;
          try { localStorage.setItem('perfil_' + authUser.id, JSON.stringify(data)); } catch (_) {}
          if (mudou) {
            showTela('app');                       // atualiza menu Equipe conforme o cargo
            if (['perfil', 'inicio', 'despesas'].includes(viewAtual)) switchView(viewAtual);   // telas que dependem do papel/foto
          }
          _maybeAutoConsolidarFotos();             // papel de gestor confirmado → tenta organizar (se Drive já conectado)
          _driveAutomatico();                      // ...e conecta o Drive se ainda não estiver
        }).catch(() => {});
    }

    // sync de dados em background
    DB.sync(sb, user.id).catch(() => {});
    if (driveOk) pullFromDrive().catch(() => {});
  } catch (_) { setLoading(false); }
}

/* Falha ao subir anexo era engolida em silêncio: a foto ficava tentando de
   novo a cada 60s e a nota aparecia como "sem anexo" sem explicação nenhuma.
   Agora avisa — no máximo 1 vez a cada 5 min, p/ não virar spam de toast. */
let _ultimoAvisoAnexo = 0;
function _avisarFalhaAnexo(qtd, motivo) {
  console.warn('[anexo] não subiu:', motivo);
  if (Date.now() - _ultimoAvisoAnexo < 5 * 60_000) return;
  _ultimoAvisoAnexo = Date.now();
  toast(`⚠️ ${qtd} anexo${qtd > 1 ? 's' : ''} não subiu — tentando de novo`, 'err');
}

function _ehGestorOuAdmin() {
  return user?.role === 'gestor' || user?.role === 'admin';
}
/* Papel Contabilidade (reunião de 21/09/2026): só VÊ e BAIXA — Equipe,
   cartões, relatórios, Arquivos. Não lança, não edita, não exclui. */
function _ehContabilidade() { return user?.role === 'contabilidade'; }
/* Regime (fase 3, 21/09/2026): cv = cartão corporativo; rdm_rda = dinheiro em conta (padrão) */
function _ehCV(u = user) { return (u?.regime || 'rdm_rda') === 'cv'; }
/* quem enxerga a equipe inteira (leitura): gestor, admin e contabilidade */
function _veEquipe() { return _ehGestorOuAdmin() || _ehContabilidade(); }
/* Corrigir a nota de QUALQUER colaborador: só gestor e admin. A
   contabilidade consulta e baixa relatório — decisão do Cleiton, mantida em
   24/09/2026 depois de experimentarmos o contrário. */
function _corrigeNotaDeOutro() { return _ehGestorOuAdmin(); }

function _ehNotaDeOutroUsuario(n) {
  return !!n?.user_id && !!user?.id && n.user_id !== user.id;
}

function _rotuloProprietario(n) {
  if (!n) return 'Você';
  if (n.user_id === user?.id) return user?.nome || 'Você';
  return equipePorId[n.user_id]?.nome || n.user_nome || 'Colaborador';
}

let _reparoAnexosFeito = false;
async function carregarDadosLocais() {
  if (!user) return;
  const notasLocais = await DB.getNotasUser(user.id);
  const repassesLocais = await DB.getRepassesUser(user.id);
  notas = notasLocais;
  repasses = repassesLocais;

  if (_veEquipe() && sb && !DEMO_MODE) {
    try {
      /* Sem recorte por núcleo: gestor e admin veem TODOS os colaboradores.
         É o que a policy `notas_sel` já permite, o que o comentário do
         supabase_setup.sql declara e o que a aba Equipe (gestor.js) sempre
         fez com `select('*')`. Só esta consulta filtrava por núcleo, e o
         efeito era o gestor não enxergar quem estivesse cadastrado em
         outro núcleo — mesmo tendo permissão para isso no banco. */
      const collabs = navigator.onLine ? await sb.colaboradores.listTodos() : Object.values(equipePorId);   // inclui desativados: o nome deles continua nas notas antigas
      equipePorId = {};
      (collabs || []).forEach(c => { equipePorId[c.id] = c; });
      /* 20/09/2026: as notas da equipe já chegam neste aparelho pelo mesmo
         pull do sync (a API devolve ao gestor as de todos). Antes havia aqui
         um GET /notas de TUDO a cada carregamento — com centenas de notas por
         dia ficava pesado, e era um dos caminhos que ressuscitavam nota
         apagada. Agora lê o store local: sem rede, e a exclusão feita aqui
         já vale (a linha local tem deleted=true). */
      /* 20/09/2026: as notas da equipe NÃO entram mais em `notas` — o admin
         e o gestor viam as notas de todo mundo em "Minhas notas", no Painel,
         no Saldo e no Início. Ficam em `notasEquipe`, só para o detalhe da
         Equipe (editar/ver anexo/excluir pelo id). */
      notasEquipe = (await DB.getNotasEquipe(user.id)).map(n => ({
        ...n,
        user_nome: equipePorId[n.user_id]?.nome || null,
      }));
    } catch (err) {
      console.warn('carregarDadosLocais equipe:', err.message);
      notasEquipe = [];
      equipePorId = {};
    }
  }

  atualizarNotificacoes().catch(() => {});

  // uma vez por aparelho: libera o espaço dos anexos duplicados no IndexedDB
  if (!_reparoAnexosFeito) {
    _reparoAnexosFeito = true;
    DB.repararFotosLocais().then(r => {
      if (r?.trocados) console.info(
        `[anexo] ${r.trocados} cópia(s) local(is) liberada(s), ${r.recuperados} recuperada(s) p/ envio`);
    }).catch(() => {});
  }
}

/* ── Telas ───────────────────────────────────────────────── */
function showTela(t) {
  _telaAtual = t;
  const authEl = $('auth-screen');
  const appEl  = $('app-screen');
  if (authEl) authEl.style.display = t === 'auth' ? 'flex' : 'none';
  { const sino = $('hdr-sino'); if (sino && t !== 'app') sino.style.display = 'none'; }
  if (appEl)  appEl.style.display  = t === 'app'  ? 'flex' : 'none';
  if (t==='app') {
    const navEq = $('nav-equipe');
    if (navEq) navEq.style.display = _veEquipe() ? 'flex' : 'none';
    syncBadge(false);
  }
}

/* ── Instalar como app (PWA) ─────────────────────────────────
   O app atendia todos os requisitos de instalação mas nunca OFERECIA:
   só explicava o caminho do menu na tela de ajuda, e quem não achava o
   menu ficava sem. Agora o próprio app pede.

   Android/Chrome dispara beforeinstallprompt quando considera o site
   instalável; guardamos o evento porque ele só pode ser disparado de
   dentro de um clique do usuário, e vale uma vez só.

   iPhone é outro mundo: o Safari não tem esse evento e nunca mostra
   prompt. O único caminho é Compartilhar → Adicionar à Tela de Início, e
   só pelo Safari (pelo Chrome no iOS a opção nem aparece). Lá o botão
   vira instrução. */
let _promptInstalar = null;

const _ehIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const _jaInstalado = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();          // sem isto o Chrome mostra a barra dele e o evento se perde
  _promptInstalar = e;
  _pintarBotaoInstalar();
});
window.addEventListener('appinstalled', () => {
  _promptInstalar = null;
  _pintarBotaoInstalar();
  toast('App instalado! Procure o ícone na tela inicial.');
});

/* Preenche todos os pontos que oferecem a instalação (login e perfil).
   Chamado a cada render e quando o navegador avisa que dá para instalar. */
function _pintarBotaoInstalar() {
  const slots = document.querySelectorAll('.install-slot');
  if (!slots.length) return;
  let html = '';
  if (!_jaInstalado()) {
    const acao = _promptInstalar ? 'instalarApp()' : 'comoInstalar()';
    html = `<button class="btn btn-outline btn-full" style="margin-bottom:8px"
              onclick="${acao}">📱 Instalar app no celular</button>`;
  }
  slots.forEach(s => { s.innerHTML = html; });
}

async function instalarApp() {
  if (!_promptInstalar) { comoInstalar(); return; }
  const evt = _promptInstalar;
  _promptInstalar = null;                 // o evento vale uma vez só
  try {
    evt.prompt();
    const { outcome } = await evt.userChoice;
    if (outcome !== 'accepted') toast('Instalação cancelada — dá para instalar depois pelo menu do navegador');
  } catch (e) {
    toast('Não consegui abrir a instalação: ' + e.message, 'err');
  } finally {
    _pintarBotaoInstalar();               // sem o evento, o botão vira instrução
  }
}

function comoInstalar() {
  alert(_ehIOS()
    ? 'Para instalar no iPhone:\n\n'
      + '1. Abra este link no SAFARI (pelo Chrome a opção não aparece)\n'
      + '2. Toque em Compartilhar — o quadrado com a seta para cima\n'
      + '3. Role a lista e toque em "Adicionar à Tela de Início"\n'
      + '4. Toque em Adicionar\n\n'
      + 'O ícone aparece junto dos outros apps.'
    : 'Para instalar no Android:\n\n'
      + '1. Abra o menu do navegador — os três pontinhos (⋮)\n'
      + '2. Toque em "Adicionar à tela inicial" ou "Instalar app"\n'
      + '3. Confirme\n\n'
      + 'A opção NÃO APARECE no menu quando:\n\n'
      + '• "Site para computador" está marcado no mesmo menu — desmarque e recarregue;\n'
      + '• o app já está instalado — procure o ícone na tela inicial;\n'
      + '• a aba é anônima — abra numa aba normal.\n\n'
      + 'Se nenhum for o caso, use "Diagnóstico de instalação" no Perfil.');
}

/* Mostra o que o NAVEGADOR DESTE APARELHO pensa da instalação. Existe
   porque o manifesto e o servidor podem estar perfeitos (e estão) e ainda
   assim o Chrome não oferecer instalar — o motivo só aparece no aparelho.
   Sem isto vira adivinhação por foto de tela. */
async function diagnosticoInstalacao() {
  const L = [];
  const sn = b => (b ? 'SIM' : 'não');

  L.push('COMO O NAVEGADOR VÊ O APP');
  L.push('');
  L.push(`Endereço seguro (https): ${sn(location.protocol === 'https:')}`);
  L.push(`Já rodando como app instalado: ${sn(_jaInstalado())}`);
  L.push(`Navegador ofereceu instalar: ${sn(!!_promptInstalar)}`);
  L.push(`Aparelho iPhone/iPad: ${sn(_ehIOS())}`);
  L.push('');

  const link = document.querySelector('link[rel="manifest"]');
  L.push(`Manifesto declarado na página: ${sn(!!link)}`);
  if (link) {
    try {
      const r = await fetch(link.href, { cache: 'no-store' });
      const m = await r.json();
      L.push(`  carregou: SIM (HTTP ${r.status})`);
      L.push(`  display: ${m.display} | ícones: ${(m.icons || []).map(i => i.sizes).join(', ')}`);
    } catch (e) { L.push(`  FALHOU: ${e.message}`); }
  }
  L.push('');

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      L.push(`Service worker registrado: ${sn(!!reg)}`);
      if (reg) {
        L.push(`  escopo: ${reg.scope}`);
        L.push(`  controlando esta página: ${sn(!!navigator.serviceWorker.controller)}`);
      }
    } catch (e) { L.push(`Service worker: erro — ${e.message}`); }
  } else {
    L.push('Service worker: não suportado neste navegador');
  }
  L.push('');

  /* A pergunta que mais importa quando a opção some do menu do Chrome:
     ele esconde "Instalar app" quando o app JÁ ESTÁ instalado.
     Atenção: getInstalledRelatedApps só enxerga o que o manifesto declara
     em related_applications. Sem essa declaração ele devolve lista vazia
     SEMPRE — instalado ou não —, e a resposta nao significa nada. Por isso
     o manifesto passou a se auto-declarar; se ainda vier vazio aqui, ai sim
     e sinal de que nao esta instalado. */
  if (navigator.getInstalledRelatedApps) {
    try {
      const apps = await navigator.getInstalledRelatedApps();
      L.push(`Já instalado neste aparelho: ${apps.length ? 'SIM' : 'não'}`);
    } catch (e) { L.push(`Checagem de instalado: falhou (${e.message})`); }
  } else {
    L.push('Checagem de instalado: navegador não suporta');
  }
  L.push('');
  L.push(`Versão do app: ${APP_VERSION} (publicação ${APP_BUILD})`);
  L.push(`Navegador: ${navigator.userAgent.slice(0, 110)}`);

  alert(L.join('\n'));
}

/* ── Auth ────────────────────────────────────────────────── */

/* RECUPERAÇÃO DE SENHA.
   O link do e-mail volta para o app com ?reset=<token>&email=<e-mail>. O
   token NÃO é sessão: só serve para POST /auth/reset, junto da senha nova.
   Enquanto _recuperandoSenha estiver ligado, a tela de nova senha tem
   prioridade sobre qualquer outra (init() e o listener da API respeitam). */
let _recuperandoSenha = false;
let _recuperacao = null;          // { token, email } lidos da URL por API.auth.init()
let _abrirPerfilAoEntrar = false; // retorno da autorização do Drive p/ backup (21/09/2026)
/* Convite por link (21/09/2026): token lido da URL (?convite=…) e os dados
   que o servidor devolveu (papel, nome sugerido, quem convidou). */
let _convite = null;              // { token, role, nome, gestor }
const PAPEL_NOME = { colaborador: 'Colaborador', gestor: 'Gestor', admin: 'Administrador', contabilidade: 'Contabilidade' };
function _limparUrlRecuperacao() {
  _recuperandoSenha = false;
  _recuperacao = null;
  try {
    const q = new URLSearchParams(location.search);
    q.delete('reset'); q.delete('email');
    const qs = q.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  } catch (_) {}
}

let authMode = 'login';
/* Campo de senha com o olho de mostrar/ocultar. O botão fica por cima da
   borda direita do input, e o `padding-right` do .pass-wrap abre espaço para
   ele não cobrir o que a pessoa digita. */
function _campoSenha(id, placeholder, autocomplete, grande = true) {   // 19/09: grande em todas as telas
  /* grande = botão com texto ("Mostrar"), pedido em 19/09/2026 para a tela de
     nova senha: o olho pequeno passava despercebido. */
  return `
    <div class="pass-wrap ${grande ? 'pass-wrap-grande' : ''}">
      <input class="inp" id="${id}" type="password" placeholder="${placeholder}" autocomplete="${autocomplete}">
      <button type="button" class="pass-toggle ${grande ? 'pass-toggle-grande' : ''}" aria-label="Mostrar senha"
              title="Mostrar senha" onclick="alternarSenha('${id}', this)">${grande ? '👁️ Mostrar' : '👁️'}</button>
    </div>`;
}

/* Alterna entre texto e senha. Devolve o foco ao campo porque clicar no botão
   o tira, e quem está conferindo o que digitou quer continuar digitando. */
function alternarSenha(id, btn) {
  const inp = $(id);
  if (!inp) return;
  const estavaVisivel = inp.type === 'text';
  inp.type = estavaVisivel ? 'password' : 'text';
  const grande = btn.classList.contains('pass-toggle-grande');
  btn.textContent = estavaVisivel ? (grande ? '👁️ Mostrar' : '👁️') : (grande ? '🙈 Ocultar' : '🙈');
  const rotulo = estavaVisivel ? 'Mostrar senha' : 'Ocultar senha';
  btn.setAttribute('aria-label', rotulo);
  btn.setAttribute('title', rotulo);
  inp.focus();
}

/* Botões "Continuar com …" + o divisor "ou". Vazio se nenhum provedor
   estiver ativo, e o formulário fica igual ao de sempre. */
function _botoesSociais() {
  const ativos = PROVEDORES_SOCIAIS.filter(p => p.ativo);
  if (!ativos.length) return '';
  return `
    <div class="auth-social">
      ${ativos.map(p => `
      <button type="button" class="btn auth-social-btn" onclick="loginSocial('${p.id}')">
        <span class="auth-social-ico">${p.icone}</span>Continuar com ${p.nome}
      </button>`).join('')}
    </div>
    <div class="auth-ou"><span>ou</span></div>`;
}

/* Vai para o Google (pela API) e volta para o app já logado: a API troca o
   código pelo perfil, emite o token e devolve para FRONT_URL#token=…, que
   API.auth.init() lê no boot. Só o Google existe no backend por enquanto. */
async function loginSocial(id) {
  const p = PROVEDORES_SOCIAIS.find(x => x.id === id);
  if (!p) return;
  if (p.id !== 'google') { toast(`Login com ${p.nome} ainda não está liberado`, 'err'); return; }
  if (!navigator.onLine) { toast('Sem conexão para entrar','err'); return; }
  setLoading(true);
  try { await _ensureSb(); } catch (_) { setLoading(false); toast('Sem conexão para entrar','err'); return; }
  if (!(await sb.auth.googleDisponivel())) {
    setLoading(false); toast('Login com Google ainda não está liberado', 'err'); return;
  }
  location.href = sb.auth.googleUrl();
  /* o navegador está saindo para o Google — o loading fica */
}

function renderAuth(mode='login') {
  authMode = mode;
  const rodape = `
    <div style="margin-top:8px;text-align:center">
      <hr class="auth-hr">
      <div class="install-slot"></div>
      <button class="btn btn-outline btn-full auth-local"
              onclick="usarSemConta()">Usar sem conta (modo local)</button>
      <p class="auth-versao">Versão ${APP_VERSION}</p>
    </div>`;

  if (mode === 'reset') {
    $('auth-body').innerHTML = `
      <h2 class="auth-title">Recuperar senha</h2>
      <p class="auth-texto">
        Informe o e-mail da sua conta. Você receberá um link para definir uma senha nova.
      </p>
      <input class="inp" id="a-email" type="email" placeholder="E-mail" autocomplete="email">
      <button class="btn btn-primary btn-full" id="a-btn-reset" onclick="pedirRecuperacao()">Enviar link</button>
      <p class="auth-switch"><a onclick="renderAuth('login')">Voltar para o login</a></p>
      ${rodape}`;
    _pintarBotaoInstalar();
    return;
  }

  /* Cadastro novo aguardando o gestor (22/09/2026): a conta existe e o token
     é válido, mas a API só responde /me até alguém confirmar a entrada. */
  if (mode === 'espera') {
    const nome = (user?.nome || sb?.auth?.user?.nome || '').split(' ')[0];
    $('auth-body').innerHTML = `
      <h2 class="auth-title">⏳ Aguardando liberação</h2>
      <p class="auth-texto">
        ${nome ? esc(nome) + ', s' : 'S'}eu cadastro foi criado e já chegou para o gestor.
        Assim que ele confirmar a sua entrada, o app libera sozinho — normalmente no mesmo dia.
      </p>
      <p class="auth-texto" style="opacity:.85">
        Se precisar, avise o gestor de que você se cadastrou como
        <b>${esc(user?.email || sb?.auth?.user?.email || '')}</b>.
      </p>
      <button class="btn btn-primary btn-full" id="a-btn-espera" onclick="conferirLiberacao()">🔄 Já fui liberado, conferir</button>
      <p class="auth-switch"><a onclick="logout()">Sair desta conta</a></p>
      ${rodape}`;
    return;
  }

  if (mode === 'nova-senha') {
    $('auth-body').innerHTML = `
      <h2 class="auth-title">Nova senha</h2>
      <p class="auth-texto">
        Escolha a senha que você vai usar a partir de agora.
      </p>
      ${_campoSenha('a-pass', 'Nova senha (min. 6 caracteres)', 'new-password', true)}
      ${_campoSenha('a-pass2', 'Repita a nova senha', 'new-password', true)}
      <button class="btn btn-primary btn-full" id="a-btn-nova" onclick="definirNovaSenha()">Salvar senha</button>
      <p class="auth-switch"><a onclick="cancelarRecuperacao()">Cancelar</a></p>`;
    return;
  }

  $('auth-body').innerHTML = mode==='login' ? `
    <h2 class="auth-title">Entrar</h2>
    ${_botoesSociais()}
    <input class="inp" id="a-email" type="email" placeholder="E-mail" autocomplete="email">
    ${_campoSenha('a-pass', 'Senha', 'current-password')}
    <button class="btn btn-primary btn-full" onclick="login()">Entrar</button>
    <p class="auth-switch"><a onclick="renderAuth('reset')">Esqueci minha senha</a></p>
    <p class="auth-switch">Não tem conta? <a onclick="renderAuth('reg')">Cadastrar</a></p>
    ${rodape}
  ` : `
    <h2 class="auth-title">${_convite ? 'Aceitar convite' : 'Criar conta'}</h2>
    ${_convite ? `<div class="ini-dica" style="margin-bottom:10px">✉️ <b>${esc(_convite.gestor || 'O gestor')}</b> convidou você para entrar como <b>${esc(PAPEL_NOME[_convite.role] || _convite.role)}</b>. Crie sua conta abaixo — o papel já vem definido.</div>` : _botoesSociais()}
    <input class="inp" id="a-nome"  type="text"     placeholder="Seu nome" autocomplete="name" autocapitalize="words" value="${esc(_convite?.nome || '')}">
    <input class="inp" id="a-email" type="email"    placeholder="E-mail" autocomplete="email">
    ${_campoSenha('a-pass', 'Senha (min. 6 caracteres)', 'new-password', true)}
    <button class="btn btn-primary btn-full" onclick="register()">${_convite ? 'Aceitar e criar conta' : 'Criar conta'}</button>
    <p class="auth-switch">Já tem conta? <a onclick="renderAuth('login')">Entrar</a></p>
    <div style="margin-top:8px;text-align:center">
      <hr class="auth-hr">
      <div class="install-slot"></div>
      <button class="btn btn-outline btn-full auth-local"
              onclick="usarSemConta()">Usar sem conta (modo local)</button>
    </div>
  `;
  _pintarBotaoInstalar();
}

/* Modo local sem autenticação — acessa QR/OCR sem depender do Supabase */
/* "Já fui liberado, conferir": relê o próprio perfil no servidor e entra se
   o gestor já tiver confirmado (22/09/2026). */
async function conferirLiberacao() {
  if (!navigator.onLine) { toast('Sem conexão — tente de novo com internet', 'err'); return; }
  const b = $('a-btn-espera'); if (b) { b.disabled = true; b.textContent = 'Conferindo…'; }
  try {
    const u = await sb.auth.me();
    if (u?.confirmado_em) { toast('Entrada liberada! Bem-vindo 🎉'); await onLogin(u); return; }
    toast('Ainda não foi liberado. O gestor já foi avisado.', 'err');
  } catch (e) {
    toast(e.status === 401 ? 'Sua conta foi desativada. Fale com o gestor.' : (e.message || 'Não consegui conferir agora'), 'err');
  }
  if (b) { b.disabled = false; b.textContent = '🔄 Já fui liberado, conferir'; }
}

async function usarSemConta() {
  $('demo-banner').style.display = 'flex';
  await DB.open();
  user = { id:'local-user', email:'local@petermann.app', nome:'Usuário Local', role:'admin', nucleo:'Cristalina' };
  await carregarDadosLocais();
  showTela('app');
  switchView('inicio');
}

/* Dispara o e-mail de redefinição. O link do e-mail aponta para FRONT_URL
   (config da API) com ?reset=…&email=… — precisa ser o endereço do app. */
let _pedindoRecuperacao = false;
async function pedirRecuperacao() {
  if (_pedindoRecuperacao) return;
  const email = $('a-email').value.trim();
  if (!email) { toast('Informe o e-mail da conta','err'); return; }

  _pedindoRecuperacao = true;
  const btn = $('a-btn-reset');
  if (btn) btn.disabled = true;
  setLoading(true);
  try {
    await _ensureSb();
    await sb.auth.forgot(email);
    /* Resposta genérica de propósito: dizer "e-mail não cadastrado" revelaria
       quem tem conta para qualquer um que digite endereços na tela. */
    toast('Se este e-mail tiver conta, o link chega em instantes. Verifique também o spam.');
    renderAuth('login');
  } catch (e) {
    toast('Não consegui enviar: ' + e.message, 'err');
  } finally {
    _pedindoRecuperacao = false;
    if (btn) btn.disabled = false;
    setLoading(false);
  }
}

/* Grava a senha nova com o token que veio no link (vale 1 h, uma vez). */
let _definindoSenha = false;
async function definirNovaSenha() {
  if (_definindoSenha) return;
  const nova  = $('a-pass').value;
  const nova2 = $('a-pass2').value;
  if (!nova || nova.length < 6) { toast('A senha precisa de pelo menos 6 caracteres','err'); return; }
  if (nova !== nova2)           { toast('As duas senhas não são iguais','err'); return; }

  _definindoSenha = true;
  const btn = $('a-btn-nova');
  if (btn) btn.disabled = true;
  setLoading(true);
  try {
    await _ensureSb();
    if (!_recuperacao) throw new Error('link inválido');
    await sb.auth.reset({ email: _recuperacao.email, token: _recuperacao.token, password: nova });
    /* Manda para o login: a pessoa estreia a senha nova (o servidor já
       derrubou as sessões antigas). */
    _limparUrlRecuperacao();
    sb.auth.clearLocal();
    toast('Senha alterada! Entre com ela agora.');
    showTela('auth');
    renderAuth('login');
  } catch (e) {
    /* O link vale uma hora e uma vez só — é o erro mais provável aqui. */
    toast('Não consegui alterar: ' + e.message + ' — se o link expirou, peça outro.', 'err');
  } finally {
    _definindoSenha = false;
    if (btn) btn.disabled = false;
    setLoading(false);
  }
}

async function cancelarRecuperacao() {
  _limparUrlRecuperacao();
  try { sb?.auth?.clearLocal(); } catch (_) {}
  showTela('auth');
  renderAuth('login');
}

async function login() {
  const email = $('a-email').value.trim();
  const pass  = $('a-pass').value;
  if (!email||!pass) { toast('Preencha e-mail e senha','err'); return; }
  setLoading(true);
  try { await _ensureSb(); } catch (_) { setLoading(false); toast('Sem conexão para entrar','err'); return; }
  let logado;
  try { logado = await sb.auth.login({ email, password:pass }); }
  catch (e) { setLoading(false); toast(e.message,'err'); return; }
  if (logado && _telaAtual !== 'app') await onLogin(logado);
  setLoading(false);
}

async function register() {
  const nome  = $('a-nome')?.value.trim()  || '';
  const email = $('a-email').value.trim();
  const pass  = $('a-pass').value;
  if (!email||!pass) { toast('Preencha os campos','err'); return; }
  if (pass.length < 6) { toast('Senha deve ter ao menos 6 caracteres','err'); return; }
  setLoading(true);
  try { await _ensureSb(); } catch (_) { setLoading(false); toast('Sem conexão para cadastrar','err'); return; }
  /* A API cria o perfil e já devolve o token: entra direto, sem e-mail de
     confirmação (era exigência do Supabase, não do app). */
  let criado;
  try { criado = await sb.auth.register({ nome, email, password:pass, convite: _convite?.token }); }
  catch (e) { setLoading(false); toast(e.message,'err'); return; }
  toast(_convite ? `Conta criada como ${PAPEL_NOME[_convite.role] || _convite.role}! Bem-vindo(a).` : 'Conta criada! Bem-vindo(a).');
  _convite = null;
  if (criado && _telaAtual !== 'app') await onLogin(criado);
  setLoading(false);
}

async function logout() {
  try {
    if (sb) await sb.auth.logout();
  } catch (_) {}
  user = null; notas = []; repasses = []; equipePorId = {};
  document.getElementById('demo-banner').style.display = 'none';
  showTela('auth');
  renderAuth('login');
}

/* ── Google Drive ────────────────────────────────────────── */
async function initDrive() {
  if (!window.GDrive?.isConfigured()) return;
  try {
    // init() restaura token do sessionStorage sem abrir nenhum popup
    driveOk = await GDrive.init();
    _driveDiag.init = driveOk ? 'ok' : 'sem token salvo / falhou';
    updateDriveBadge();
    if (driveOk && user) {
      await pullFromDrive();
      _maybeAutoConsolidarFotos();          // gestor abriu o app com Drive → organiza fotos da equipe
    }
  } catch (e) { console.warn('Drive init:', e.message); }
}

/* ── Drive sem botão (build 123) ──────────────────────────────
   Popup do Google só abre com clique, então "conectar sozinho" nunca deu
   pelo caminho antigo. O caminho novo é o login Google do Supabase com o
   escopo do Drive: gestor/admin que abre o app sem Drive é levado ao
   Google (consentimento só na primeira vez, depois é uma passagem de 2 s)
   e volta logado na MESMA conta — quem entrou por senha também, porque o
   e-mail é o mesmo — com o token do Drive na sessão.
   Uma tentativa por aba: se o usuário negar, não fica em loop; na próxima
   abertura tenta de novo. Colaborador nunca passa por aqui. */
async function _driveAutomatico() {
  if (!_ehGestorOuAdmin() || DEMO_MODE || !sb || !navigator.onLine) { _driveDiag.automatico = 'não é gestor/admin ou offline'; return; }
  if (!window.GDrive?.isConfigured()) return;
  if (driveOk && GDrive.isConnected()) { _driveDiag.automatico = 'já conectado'; return; }
  const K = 'drive_auto_tentado';
  try {
    if (sessionStorage.getItem(K)) { _driveDiag.automatico = 'já tentou nesta sessão'; return; }
    sessionStorage.setItem(K, '1');
  } catch (_) { _driveDiag.automatico = 'sem sessionStorage'; return; }
  _driveDiag.automatico = 'redirecionou ao Google';
  /* A API pede o escopo do Drive ao Google e devolve o token no retorno
     (#google_token=…); init() entrega ao GDrive. Volta logado na MESMA
     conta porque o e-mail é o mesmo. Sem Google no servidor, não sai daqui. */
  if (!(await sb.auth.googleDisponivel())) return;
  location.href = sb.auth.googleUrl({ drive: true, hint: user?.email || '' });
}

/* Ação explícita que precisa do Drive (planilha, fotos da equipe) com o
   token vencido: renova pelo popup silencioso — o clique da própria ação é
   o que permite o popup abrir, e com consentimento já dado ele fecha só. */
async function _garantirDrive() {
  if (driveOk && GDrive.isConnected()) return true;
  if (!window.GDrive?.isConfigured() || !navigator.onLine) {
    toast('Sem conexão com o Google Drive', 'err'); return false;
  }
  try {
    await GDrive.requestAccess(true);
    driveOk = true; updateDriveBadge();
    return true;
  } catch (e) {
    toast('Drive: ' + (e.message || 'não conectou'), 'err');
    return false;
  }
}

function _driveDiagTexto() {
  const g = window.GDrive?.diagnostico?.() || {};
  return [
    `token do Google no retorno do login: ${_driveDiag.googleTokenNoRetorno}`,
    `setToken: ${_driveDiag.setToken}`,
    `init (restaurar da sessão): ${_driveDiag.init}`,
    `conexão automática: ${_driveDiag.automatico}`,
    `token em memória: ${g.token} (expira em ${g.expiraEm})`,
    `Google Identity: ${g.gis} · salvo na sessão: ${g.salvoNaSessao}`,
    `erro do init: ${g.erroInit}`,
    `papel: ${user?.role || '—'} · online: ${navigator.onLine} · instalado: ${matchMedia('(display-mode: standalone)').matches}`,
    `build ${APP_BUILD}`,
  ].join('\n');
}
/* Popup do Google (precisa do toque) — o caminho quando o automático falhou. */
async function conectarDriveAgora() {
  if (await _garantirDrive()) { toast('Drive conectado ✅'); renderPerfil(); }
  else renderPerfil();
}
/* Refaz o login pelo Google pedindo o Drive junto (token vem no retorno). */
async function reconectarDrivePeloGoogle() {
  if (!sb || !(await sb.auth.googleDisponivel())) { toast('Login com Google indisponível', 'err'); return; }
  try { sessionStorage.removeItem('drive_auto_tentado'); } catch (_) {}
  location.href = sb.auth.googleUrl({ drive: true, hint: user?.email || '' });
}

async function testarDrive() {
  setLoading(true);
  try {
    const r = await GDrive.testarConexao();
    toast(`✅ Drive OK — pasta "${r.nome}" acessível!`);
  } catch (e) {
    toast(e.message, 'err');
  } finally { setLoading(false); }
}

/* Reorganiza o que já está no Drive no layout da pasta modelo da empresa
   ({Colaborador}/{Ano}/RDM DESPESAS CORPORATIVAS/{CATEGORIA}/{01 jan}).
   Só move arquivo — não apaga nada, e rodar de novo é inofensivo. */
async function migrarPastasDrive() {
  if (!(await _garantirDrive())) return;
  if (!confirm('Reorganizar as fotos já enviadas no padrão de pastas da empresa?\n\n'
             + 'Os arquivos são movidos, nunca apagados. As pastas antigas ficam onde estão, vazias.')) return;

  setLoading(true);
  try {
    /* mapa id → nome oficial: é ele que funde as pastas antigas de um mesmo
       colaborador (ex.: "cleitonjussara", do tempo em que o nome não estava
       preenchido, e "cleiton"). O gestor enxerga todos; quem não enxerga fica
       só com o próprio, e as pastas dos outros seguem intactas. */
    const nomePorUserId = {};
    if (sb && !DEMO_MODE) {
      const collabs = await sb.colaboradores.list().catch(() => []);
      (collabs || []).forEach(c => { if (c.nome) nomePorUserId[c.id] = c.nome; });
    }
    if (user.nome) nomePorUserId[user.id] = user.nome;   // o próprio perfil manda

    /* As notas de verdade: a migração usa elas em vez do appProperties, que
       pode ter sido gravado incompleto por um envio antigo. Locais primeiro,
       servidor por cima (o gestor enxerga a equipe toda). */
    const notaPorId = {};
    notas.forEach(n => { notaPorId[n.id] = n; });
    if (sb && !DEMO_MODE) {
      const data = await sb.notas.list({ fields: 'id,user_id,tipo,subtipo,mes,ano,data' }).catch(() => []);
      (data || []).forEach(n => { notaPorId[n.id] = n; });
    }

    const r = await GDrive.migrarParaModeloPadrao({
      nomePorUserId, notaPorId,
      onProgress : (feitos, total) => setLoading(true, `Movendo ${feitos}/${total}…`),
    });
    const extra = r.metaCorrigidos ? `, ${r.metaCorrigidos} com dados corrigidos` : '';
    if (!r.total)      toast('Nenhuma foto encontrada no Drive');
    else if (r.falhas) toast(`${r.movidos} movidas, ${r.falhas} falharam — veja o console`, 'err');
    else               toast(`✅ ${r.movidos} movidas${extra}, ${r.jaOk} já no lugar`);
    if (r.erros.length) console.warn('Migração Drive — falhas:', r.erros);
  } catch (e) {
    toast(e.message, 'err');
  } finally { setLoading(false); }
}

async function pullFromDrive() {
  if (!driveOk || !user) return;
  /* Com Supabase no ar, o Drive é só cópia de segurança: aparelho novo
     recebe tudo pelo pullIncremental (last_sync começa em 1970). Repor a
     partir do Drive aqui só serviria para ressuscitar o que foi apagado
     definitivamente — o Storage e o banco não têm mais, o Drive ainda tem. */
  if (sb && !DEMO_MODE) return;
  try {
    const remote = await GDrive.loadNotas(user.id);
    if (!remote) return;
    await DB.upsertFromDrive('notas',    remote.notas);
    await DB.upsertFromDrive('repasses', remote.repasses);
    await carregarDadosLocais();
    if (viewAtual === 'home')  renderHome();
    if (viewAtual === 'notas') renderNotas();
    if (viewAtual === 'lixeira') renderNotasApagadas();
    if (viewAtual === 'saldo') renderSaldo();
  } catch (e) { console.warn('Drive pull:', e.message); }
}

async function syncToDrive() {
  if (!driveOk || !user || !GDrive.isConnected()) return;
  syncBadge(true);
  try {
    const [notasParaDrive, repassesParaDrive] = await Promise.all([
      DB.getNotasUser(user.id, true),
      DB.getRepassesUser(user.id, true),
    ]);
    await GDrive.syncNotas(user.id, notasParaDrive, repassesParaDrive);
  } catch (e) {
    console.error('Drive sync:', e.message);
    toast('Drive: ' + e.message, 'err');
    if (!GDrive.isConnected()) { driveOk = false; updateDriveBadge(); }
  } finally { syncBadge(false); }
}

function updateDriveBadge() {
  const badge = $('drive-badge');
  if (!badge) return;
  if (!window.GDrive?.isConfigured() || !_ehGestorOuAdmin()) { badge.style.display = 'none'; return; }
  badge.style.display = 'flex';
  const ok  = driveOk && GDrive.isConnected();
  const min = ok ? GDrive.minutosRestantes() : 0;
  $('drive-dot').style.background = ok ? '#74C69D' : '#94A3B8';
  $('drive-txt').textContent       = ok ? `Drive (${min}min)` : 'Drive';
  badge.title = ok ? `Drive conectado — sessão expira em ${min} min` : 'Drive desconectado — clique para conectar';
}

/* ── Navegação ───────────────────────────────────────────── */
/* ── Puxar para atualizar (21/09/2026, reunião) ─────────────────
   Com a tela no topo, arrastar o dedo para baixo mostra "solte para
   atualizar"; soltando, sincroniza com o servidor, recarrega os dados
   locais, procura versão nova do app e redesenha a tela atual. */
function _instalarPuxarParaAtualizar() {
  const el = $('app-content');
  if (!el || el.dataset.ptr) return;
  el.dataset.ptr = '1';
  const ind = document.createElement('div');
  ind.id = 'ptr-indicador';
  ind.innerHTML = '<span class="ptr-seta">↓</span><span class="ptr-txt">Puxe para atualizar</span>';
  el.parentNode.insertBefore(ind, el);
  const LIMIAR = 72;
  let y0 = null, dy = 0, ocupado = false;
  el.addEventListener('touchstart', e => {
    if (ocupado || el.scrollTop > 0 || document.querySelector('.modal-overlay.open, .modal-overlay[style*="flex"]')) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0 || el.scrollTop > 0) { ind.style.height = '0px'; return; }
    const h = Math.min(dy * 0.55, 90);
    ind.style.height = h + 'px';
    ind.classList.toggle('pronto', dy > LIMIAR);
    ind.querySelector('.ptr-txt').textContent = dy > LIMIAR ? 'Solte para atualizar' : 'Puxe para atualizar';
  }, { passive: true });
  const soltar = async () => {
    if (y0 === null) return;
    const puxou = dy > LIMIAR; y0 = null;
    if (!puxou) { ind.style.height = '0px'; ind.classList.remove('pronto'); return; }
    ocupado = true;
    ind.classList.add('girando'); ind.style.height = '54px';
    ind.querySelector('.ptr-txt').textContent = 'Atualizando…';
    try {
      if (sb && user && navigator.onLine) { await DB.sync(sb, user.id); }
      await carregarDadosLocais();
      navigator.serviceWorker?.getRegistration?.().then(r => r?.update()).catch(() => {});
      verificarVersao().catch(() => {});
      switchView(viewAtual);
      toast(navigator.onLine ? 'Atualizado ✅' : 'Sem internet — mostrando o que está no aparelho', navigator.onLine ? 'ok' : 'err');
    } catch (e) { toast('Não atualizou: ' + (e.message || 'erro'), 'err'); }
    finally {
      ind.classList.remove('girando', 'pronto'); ind.style.height = '0px';
      ind.querySelector('.ptr-txt').textContent = 'Puxe para atualizar';
      ocupado = false;
    }
  };
  el.addEventListener('touchend', soltar, { passive: true });
  el.addEventListener('touchcancel', soltar, { passive: true });
}

/* ═══════════════════════════════════════════════════════════
   NOTIFICAÇÕES NO APP (reunião de 21/09/2026)
   • gestor/admin: pedidos de repasse PENDENTES (kind=requested, sem
     atendido_em) de toda a equipe — botão "Marcar como pago" chama
     PATCH /repasses/{id}/atendido; o servidor cria o repasse recebido.
   • colaborador: os SEUS pedidos que o gestor marcou como pagos e você
     ainda não viu (ids "vistos" ficam no aparelho).
   O número aparece no sininho do topo e no ícone do app (Badging API:
   Android direto; iOS só com o app instalado na tela inicial).
═══════════════════════════════════════════════════════════ */
let repassesEquipe = [];   // gestor/admin/contabilidade: repasses de todos (do store local)
const K_NOTIF_VISTOS = 'notif_vistos_v1';
function _notifVistos() { try { return new Set(JSON.parse(localStorage.getItem(K_NOTIF_VISTOS) || '[]')); } catch (_) { return new Set(); } }
function _notifMarcarVistos(ids) {
  try { const s = _notifVistos(); ids.forEach(i => s.add(i)); localStorage.setItem(K_NOTIF_VISTOS, JSON.stringify([...s].slice(-300))); } catch (_) {}
}
function _repassePendente(r) { return _repasseEhPedido(r) && !r.atendido_em && !r.deleted; }

/* lista de notificações do usuário atual */
function _notificacoes() {
  if (!user) return [];
  const out = [];
  if (_ehGestorOuAdmin()) {
    repassesEquipe.filter(_repassePendente)
      .sort((a, b) => String(a.data || '').localeCompare(String(b.data || '')))
      .forEach(r => out.push({
        id: r.id, tipo: 'pedido', rep: r,
        titulo: `${equipePorId[r.user_id]?.nome || 'Colaborador'} ${_ehCV(equipePorId[r.user_id]) ? 'registrou reembolso de' : 'pediu'} ${brl(r.valor)} (${r.tipo})`,
        sub: `${fmtDataBR(r.data)}${r.descricao ? ' · ' + r.descricao : ''}`,
      }));
  }
  /* Cadastro novo aguardando liberação (22/09/2026). Não é dispensável: some
     quando o gestor confirma ou recusa. */
  if (_ehGestorOuAdmin()) {
    const VIA = { convite: 'pelo link de convite', google: 'entrando com o Google', livre: 'pelo cadastro do app' };
    Object.values(equipePorId)
      .filter(c => c && c.ativo !== false && 'confirmado_em' in c && !c.confirmado_em)
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
      .forEach(c => out.push({
        id: 'novo:' + c.id, tipo: 'novo', userId: c.id,
        titulo: `${c.nome || c.email} se cadastrou e aguarda liberação`,
        sub: `${c.email || ''} · ${VIA[c.criado_via] || 'pelo app'}${c.created_at ? ' em ' + fmtDataBR(String(c.created_at).slice(0, 10)) : ''} · papel: ${PAPEL_NOME[c.role] || c.role || 'colaborador'}`,
      }));
  }
  /* Cartão corporativo acabando (24/09/2026): quem recarrega é o gestor, e
     sem saldo o colaborador passa a pagar do bolso. O id carrega a faixa de
     centenas, então o aviso volta se o saldo cair mais. */
  if (_ehGestorOuAdmin()) {
    _equipeCartaoBaixo().forEach(c => {
      const id = `cartao:${c.id}:${Math.floor(c.saldo / 100)}`;
      out.push({
        id, tipo: 'cartao', userId: c.id,
        titulo: `💳 Cartão de ${c.nome} com ${brl(c.saldo)}`,
        sub: `Abaixo de ${brl(CARTAO_SALDO_MINIMO)} — faça a recarga antes que ele passe a pagar do bolso.`,
      });
    });
  }
  const vistos = _notifVistos();
  /* Saldo devedor acima do limite (22/09/2026): a empresa deve mais de
     R$ 1.500 a alguém. O id carrega a faixa do valor (centenas), então o
     aviso volta se a dívida crescer depois de dispensado. */
  if (_ehGestorOuAdmin()) {
    _equipeDevedora().forEach(c => {
      const id = `devedor:${c.id}:${Math.floor(c.valor / 100)}`;
      if (vistos.has(id)) return;
      out.push({
        id, tipo: 'devedor', userId: c.id,
        titulo: `${c.nome}: RDM a receber de ${brl(c.valor)}`,
        sub: `Acima do limite de ${brl(LIMITE_DEVEDOR)} em RDM — gastos sem repasse acumulados até ${MESES[filMes - 1]}/${filAno}${Math.abs(c.total - c.valor) >= 1 ? ` (com RDA, ${brl(c.total)} no total)` : ''}.`,
      });
    });
  }
  const lim = Date.now() - 30 * 86400_000;
  repasses.filter(r => _repasseEhPedido(r) && r.atendido_em && !vistos.has(r.id) && new Date(r.atendido_em).getTime() > lim)
    .forEach(r => out.push({
      id: r.id, tipo: 'atendido', rep: r,
      titulo: `Seu ${_ehCV() ? 'reembolso' : 'pedido'} de ${brl(r.valor)} (${r.tipo}) foi pago ✅`,
      sub: `${_ehCV() ? 'Reembolso' : 'Pedido'} de ${fmtDataBR(r.data)} · pago em ${fmtDataBR(String(r.atendido_em).slice(0, 10))}. O ${_ehCV() ? 'reembolso' : 'repasse'} recebido já foi registrado para você.`,
    }));
  return out;
}
function fmtDataBR(d) { const s = String(d || '').slice(0, 10); const [a, m, dd] = s.split('-'); return dd ? `${dd}/${m}/${a}` : s; }

async function atualizarNotificacoes() {
  if (_veEquipe() && !DEMO_MODE) { try { repassesEquipe = await DB.getRepassesTodos(); } catch (_) { repassesEquipe = []; } }
  const n = _notificacoes().length;
  const sino = $('hdr-sino'), num = $('hdr-sino-num');
  if (sino) { sino.style.display = user ? '' : 'none'; sino.classList.toggle('tem', n > 0); }
  if (num) { num.textContent = n > 99 ? '99+' : String(n); num.style.display = n ? '' : 'none'; }
  try {   // número no ícone do app (só com o app instalado)
    if (n > 0 && navigator.setAppBadge) await navigator.setAppBadge(n);
    else if (navigator.clearAppBadge) await navigator.clearAppBadge();
  } catch (_) {}
  return n;
}

function abrirNotificacoes() {
  const itens = _notificacoes();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay open';
  ov.id = 'notif-overlay';
  const html = itens.length ? itens.map(it => `
    <div class="notif-item ${it.tipo}">
      <div class="notif-ico">${it.tipo === 'pedido' ? '💸' : it.tipo === 'devedor' ? '⚠️' : it.tipo === 'novo' ? '🙋' : it.tipo === 'cartao' ? '💳' : '✅'}</div>
      <div class="notif-txt">
        <div class="notif-tit">${esc(it.titulo)}</div>
        <div class="notif-sub">${esc(it.sub)}</div>
        ${it.tipo === 'cartao' ? `<div class="notif-acoes">
          ${_veEquipe() ? `<button class="btn btn-sm btn-primary" onclick="document.getElementById('notif-overlay')?.remove(); switchView('equipe'); setTimeout(() => Gestor.abrir('${it.userId}'), 400)">👤 Ver colaborador</button>` : ''}
          <button class="btn btn-sm btn-outline" onclick="dispensarNotificacao('${it.id}', this)">OK, vi</button>
        </div>` : it.tipo === 'novo' ? `<div class="notif-acoes">
          <button class="btn btn-sm btn-primary" onclick="confirmarEntrada('${it.userId}', true, this)">✅ Confirmar entrada</button>
          <button class="btn btn-sm btn-danger-outline" onclick="confirmarEntrada('${it.userId}', false, this)">🚫 Recusar</button>
        </div>` : it.tipo === 'devedor' ? `<div class="notif-acoes">
          ${_veEquipe() ? `<button class="btn btn-sm btn-primary" onclick="document.getElementById('notif-overlay')?.remove(); switchView('equipe'); setTimeout(() => Gestor.abrir('${it.userId}'), 400)">👤 Ver colaborador</button>` : ''}
          <button class="btn btn-sm btn-outline" onclick="dispensarNotificacao('${it.id}', this)">OK, vi</button>
        </div>` : it.tipo === 'pedido' ? `<div class="notif-acoes">
          <button class="btn btn-sm btn-primary" onclick="marcarPedidoPago('${it.id}', this)">✅ Marcar como pago</button>
          ${_veEquipe() ? `<button class="btn btn-sm btn-outline" onclick="document.getElementById('notif-overlay')?.remove(); switchView('equipe'); setTimeout(() => Gestor.abrir('${it.rep.user_id}'), 400)">👤 Ver colaborador</button>` : ''}
        </div>` : `<div class="notif-acoes"><button class="btn btn-sm btn-outline" onclick="dispensarNotificacao('${it.id}', this)">OK, vi</button></div>`}
      </div>
    </div>`).join('') : '<div class="empty-state" style="padding:24px 8px">Nenhuma notificação. 🎉</div>';
  ov.innerHTML = `
    <div class="modal-card" onclick="event.stopPropagation()">
      <div class="modal-hd"><h3>🔔 Notificações${itens.length ? ` (${itens.length})` : ''}</h3><button class="btn-close-modal" onclick="this.closest('.modal-overlay').remove()">✕</button></div>
      <div class="modal-bd" style="max-height:65vh;overflow:auto">${html}</div>
      ${itens.some(i => i.tipo === 'atendido') ? `<div class="modal-ft"><button class="btn btn-outline" onclick="dispensarTodasNotificacoes()">Marcar todas como vistas</button></div>` : ''}
    </div>`;
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}
/* Gestor confirma (ou recusa) a entrada de um cadastro novo (22/09/2026).
   Recusar desativa a conta e derruba as sessões abertas no aparelho dela. */
async function confirmarEntrada(id, aceita, btn) {
  if (!sb || !navigator.onLine) { toast('Precisa de internet para confirmar', 'err'); return; }
  const quem = equipePorId[id]?.nome || 'o colaborador';
  if (!confirm(aceita
    ? `Liberar ${quem} para usar o app?`
    : `Recusar a entrada de ${quem}?\n\nA conta é desativada na hora. Dá para reativar depois na Equipe.`)) return;
  if (btn) btn.disabled = true;
  try {
    const c = await sb.colaboradores.confirmar(id, aceita);
    if (c?.id) equipePorId[c.id] = c;
    toast(aceita ? `${quem} liberado ✅` : `Entrada de ${quem} recusada`);
    document.getElementById('notif-overlay')?.remove();
    await atualizarNotificacoes();
    abrirNotificacoes();
    if (viewAtual === 'equipe') renderEquipe();
  } catch (e) { toast('Não deu: ' + (e.message || 'erro'), 'err'); if (btn) btn.disabled = false; }
}

/* ═══════════════════════════════════════════════════════════
   REPASSE DE OUTRO COLABORADOR (24/09/2026)
   Pedido do Cleiton: o gestor precisa corrigir e apagar repasse e reembolso
   da equipe. O registro é de outra pessoa, então NÃO passa pelo IndexedDB
   daqui — vai direto ao servidor, como o lançamento do gestor (34ba623) e a
   correção de categoria da nota.
═══════════════════════════════════════════════════════════ */
/* Mês e ano a partir da data digitada (24/09/2026). Antes cada tela tinha o
   seu jeito — o filtro do mês, a chave da nota — e bastava um deles estar
   desencontrado para o lançamento ficar guardado num período onde ninguém o
   procurava. */
/* Data no futuro não existe em prestação de contas: a nota é de um gasto que
   JÁ aconteceu (pedido do Cleiton em 24/09/2026, depois da nota que foi
   gravada em 2045). Devolve null quando está tudo bem, ou o texto do aviso. */
function _dataNoFuturo(data) {
  const d = new Date(String(data) + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  /* 24/09/2026: "hoje" vem do SERVIDOR quando ele já respondeu alguma coisa.
     Com o relógio do aparelho adiantado, o app achava que amanhã era hoje e
     deixava passar — e o lançamento nascia no futuro. */
  const hoje = new Date((sb?.hojeDoServidor?.() || new Date().toISOString().slice(0, 10)) + 'T00:00:00');
  hoje.setHours(23, 59, 59, 999);
  if (d <= hoje) return null;
  const dias = Math.round((d - hoje) / 86400000);
  return dias > 400
    ? 'A data está em ' + d.getFullYear() + ', muito à frente de hoje.'
    : 'A data é de ' + fmtDataBR(data) + ', ainda no futuro.';
}

function _mesAnoDaData(data) {
  const d = new Date(String(data) + 'T00:00:00');
  if (isNaN(d.getTime())) return [filMes, filAno];
  return [d.getMonth() + 1, d.getFullYear()];
}

function _repasseDaEquipe(id) {
  const fontes = [window._repassesDaFicha, repassesEquipe, window._equipeCache?.repasses, repasses];
  for (const lista of fontes) {
    const achou = (lista || []).find(r => r && r.id === id);
    if (achou) return achou;
  }

  return null;
}

async function editarRepasseDeOutro(id) {
  if (!_ehGestorOuAdmin()) { toast('Só gestor ou admin corrige o repasse de outra pessoa', 'err'); return; }
  if (!sb || !navigator.onLine) { toast('Precisa de internet para corrigir', 'err'); return; }
  const r = _repasseDaEquipe(id);
  if (!r) { toast('Repasse não encontrado', 'err'); return; }
  const quem = equipePorId[r.user_id]?.nome || 'o colaborador';

  const valor = prompt(`Valor do repasse de ${quem} (R$):`, String(Number(r.valor) || 0));
  if (valor === null) return;
  const v = parseFloat(String(valor).replace(',', '.'));
  if (!(v > 0)) { toast('Valor inválido', 'err'); return; }

  const data = prompt('Data (dd/mm/aaaa):', fmtDataBR(r.data));
  if (data === null) return;
  const m = String(data).match(new RegExp('(\\d{2})\\/(\\d{2})\\/(\\d{4})'));
  if (!m) { toast('Data inválida — use dd/mm/aaaa', 'err'); return; }
  const iso = m[3] + '-' + m[2] + '-' + m[1];

  const desc = prompt('Descrição:', r.descricao || '');
  if (desc === null) return;

  setLoading(true);
  try {
    await sb.repasses.upsert({
      ...r,
      valor: v,
      data: iso,
      mes: Number(m[2]),
      ano: Number(m[3]),
      descricao: String(desc).trim() || null,
    });
    toast('Repasse corrigido ✅');
    await _recarregarEquipe();
  } catch (e) {
    toast('Não deu: ' + (e.message || 'erro'), 'err');
  } finally { setLoading(false); }
}

async function excluirRepasseDeOutro(id) {
  if (!_ehGestorOuAdmin()) { toast('Só gestor ou admin exclui o repasse de outra pessoa', 'err'); return; }
  if (!sb || !navigator.onLine) { toast('Precisa de internet para excluir', 'err'); return; }
  const r = _repasseDaEquipe(id);
  if (!r) { toast('Repasse não encontrado', 'err'); return; }
  const quem = equipePorId[r.user_id]?.nome || 'o colaborador';
  const nl = String.fromCharCode(10);
  if (!confirm([
    'Excluir este repasse de ' + quem + '?',
    '',
    brl(r.valor) + ' · ' + fmtDataBR(r.data) + (r.descricao ? ' · ' + r.descricao : ''),
    '',
    'O valor sai do saldo dele e some das planilhas.',
  ].join(nl))) return;

  setLoading(true);
  try {
    await sb.repasses.upsert({ ...r, deleted: true });
    toast('Repasse excluído');
    await _recarregarEquipe();
  } catch (e) {
    toast('Não deu: ' + (e.message || 'erro'), 'err');
  } finally { setLoading(false); }
}

/* redesenha a ficha do colaborador com os dados novos do servidor */
async function _recarregarEquipe() {
  try {
    if (user) await DB.sync(sb, user.id).catch(() => {});
    await carregarDadosLocais();
  } catch (_) {}
  if (viewAtual === 'equipe') renderEquipe();
}

async function marcarPedidoPago(id, btn) {
  if (!sb || !navigator.onLine) { toast('Precisa de internet para marcar como pago', 'err'); return; }
  const r = repassesEquipe.find(x => x.id === id);
  const quem = equipePorId[r?.user_id]?.nome || 'o colaborador';
  if (!confirm(`Confirmar que o repasse de ${brl(r?.valor || 0)} para ${quem} foi PAGO?\n\nO repasse entra no saldo de ${quem} e o pedido sai das pendências.`)) return;
  if (btn) btn.disabled = true;
  try {
    await sb.repasses.atendido(id);
    toast(`Pago ✅ — repasse registrado no saldo de ${quem}`);
    if (sb && user) await DB.sync(sb, user.id).catch(() => {});
    await carregarDadosLocais();
    document.getElementById('notif-overlay')?.remove();
    abrirNotificacoes();
    if (viewAtual === 'equipe') renderEquipe();
  } catch (e) { toast('Não deu: ' + (e.message || 'erro'), 'err'); if (btn) btn.disabled = false; }
}
function dispensarNotificacao(id) { _notifMarcarVistos([id]); document.getElementById('notif-overlay')?.remove(); atualizarNotificacoes(); abrirNotificacoes(); }
function dispensarTodasNotificacoes() { _notifMarcarVistos(_notificacoes().filter(i => i.tipo === 'atendido').map(i => i.id)); document.getElementById('notif-overlay')?.remove(); atualizarNotificacoes(); }

/* ─── Voltar para a tela anterior (23/09/2026) ───────────────────
   O rodapé voltava sempre um nível fixo ("‹ Despesas"), então quem
   entrava no Painel vindo da Equipe era jogado para Despesas. Agora o
   app guarda por onde a pessoa passou e o botão volta para a tela de
   onde ela veio, com o nome dela. */
const NOME_VIEW = {
  inicio: 'Início', despesas: 'Despesas', home: 'Painel', notas: 'Minhas notas',
  lixeira: 'Apagados', saldo: 'RDM/RDA', equipe: 'Equipe', arquivos: 'Arquivos',
  perfil: 'Perfil', frota: 'Frota / KM', ponto: 'Ponto',
};
let _histViews = [];

function voltarView() {
  const anterior = _histViews.pop();
  switchView(anterior || 'inicio', true);
}

function switchView(v, voltando = false) {
  /* histórico: não empilha repetição nem o próprio destino (evita laço) */
  if (!voltando && viewAtual && viewAtual !== v) {
    _histViews = _histViews.filter(x => x !== v);
    _histViews.push(viewAtual);
    if (_histViews.length > 20) _histViews.shift();
  }
  if (v === "inicio") _histViews = [];   // Início é a raiz: zera o caminho
  _pintarBarraUsuario();
  _voltarRodape(null);   // cada tela declara o seu, se tiver
  viewAtual = v;
  /* página unificada: fora do Início, o cabeçalho mostra "‹ Início" */
  { const b = $('hdr-inicio'); if (b) b.style.display = v === 'inicio' ? 'none' : ''; }
  { const r = $('btn-inicio-rodape'); if (r) { r.style.display = v === 'inicio' ? 'none' : '';
      /* 21/09/2026: Painel, Notas, Saldo, Equipe e Arquivos vivem dentro de
         "Petermann – Despesas" — o rodapé volta um nível; o "‹ Início" do
         cabeçalho continua levando direto ao Início. */
      const anterior = _histViews[_histViews.length - 1];
      const rotulo = anterior ? '‹ ' + (NOME_VIEW[anterior] || 'Voltar') : '🏠 Início';
      r.textContent = rotulo;
      r.setAttribute('aria-label', anterior ? 'Voltar para ' + (NOME_VIEW[anterior] || 'a tela anterior') : 'Voltar ao Início');
      r.onclick = () => (anterior ? voltarView() : switchView('inicio', true));
    }
    $('app-content')?.classList.toggle('com-rodape', v !== 'inicio'); }
  if (v !== 'equipe') window.Gestor?.reset?.();   // sair da Equipe fecha o detalhe aberto
  if (v !== 'arquivos') window.Arquivos?.reset?.();
  document.querySelectorAll('.nav-btn[data-view]').forEach(b => {
    const ativo = b.dataset.view === v;
    if (ativo && !b.classList.contains('active')) {      // pulinho só ao ENTRAR na aba
      b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump');
      b.addEventListener('animationend', () => b.classList.remove('bump'), { once: true });
    }
    b.classList.toggle('active', ativo);
  });
  const el = $('app-content');
  el.scrollTop = 0;
  if (v==='home')    renderHome();
  else if (v==='inicio') renderInicio();
  else if (v==='despesas') { _pagamentoCV = null; _abaDespesa = null; renderDespesas(); }
  else if (v==='frota')  { if (MODULOS_EXTRAS && _ehGestorOuAdmin()) window.Frota?.render(); else switchView('inicio'); }
  else if (v==='ponto')  { if (MODULOS_EXTRAS && _ehGestorOuAdmin()) window.Ponto?.render(); else switchView('inicio'); }
  else if (v==='arquivos') window.Arquivos?.render();
  else if (v==='notas')  renderNotas();
  else if (v==='lixeira') renderNotasApagadas();
  else if (v==='saldo')  renderSaldo();
  else if (v==='equipe') renderEquipe();
  else if (v==='perfil') renderPerfil();
}

/* ═══════════════════════════════════════════════════════════
   VIEW: DESPESAS CORPORATIVAS PETERMANN (20/09/2026)
   Os três lançamentos (QR, sem QR, repasse) num só lugar, com os painéis
   grandes que estavam no Início. O Início ficou com um botão só.
═══════════════════════════════════════════════════════════ */
/* ─── Abas RDA e RDM do hub (22/09/2026) ─────────────────────────
   Pedido do Cleiton: duas abas grandes dentro de "Petermann – Despesas",
   e o lançamento (QR e sem QR) DENTRO de cada uma. A aba aberta fica
   guardada em _abaDespesa; quem já escolheu não precisa escolher de novo
   no modal — o tipo vai junto e o app pula direto para o comprovante. */
const ABAS_DESPESA = {
  RDA: { ico: '🍽️', nome: 'Alimentação',
         sub: 'Refeição, lanche, café e água — a nota do restaurante ou do mercado.' },
  RDM: { ico: '💼', nome: 'Despesas corporativas',
         sub: 'Abastecimento, hospedagem e outros gastos de serviço.' },
};
let _abaDespesa = null;          // 'RDA' | 'RDM' | chave de categoria (CV) | null
let _abaPreEscolhida = null;     // tipo já escolhido na aba, consumido pelo seletor
let _subtipoPreEscolhido = null; // categoria já escolhida junto (regime CV)
let _pagamentoCV = null;         // 'cv' | 'reembolso' — escolhido na página nova

/* 24/09/2026 — pedido do Cleiton: no regime de cartão, antes de escolher a
   categoria a pessoa diz COM QUE DINHEIRO pagou. Era um campo no meio do
   formulário, fácil de passar batido; virou a primeira tela do lançamento,
   e é ela que decide para qual aba da planilha a nota vai. */
const PAGAMENTOS_CV = [
  { chave: 'cv', ico: '💳', nome: 'Nota no cartão',
    sub: 'Pagou com o cartão corporativo. Vai para a aba CV ALELO.' },
  { chave: 'reembolso', ico: '👛', nome: 'Nota de reembolso',
    sub: 'Pagou do próprio bolso. Vai para a aba CV REEMBOLSO e a empresa devolve.' },
];

function _pagamentoCVInfo(chave) {
  return PAGAMENTOS_CV.find(p => p.chave === chave) || null;
}

function escolherPagamentoCV(chave) {
  _pagamentoCV = chave;
  _abaDespesa = null;
  renderDespesas();
}

function trocarPagamentoCV() {
  _pagamentoCV = null;
  _abaDespesa = null;
  renderDespesas();
}

/* 24/09/2026 — regime de cartão corporativo: não existe RDA x RDM. O gasto
   é dividido nas MESMAS quatro categorias da planilha (as quatro colunas de
   CV ALELO), todas juntas. O banco continua guardando tipo/subtipo, que é o
   que o relatório lê; para quem é CV o app só deixa de PERGUNTAR a aba. */
const CATEGORIAS_CV = [
  { chave: 'alimentacao',   ico: '🍽️', nome: 'Alimentação',   tipo: 'RDA', subtipo: null,
    sub: 'Refeição, lanche, café e água.' },
  { chave: 'abastecimento', ico: '⛽', nome: 'Abastecimento', tipo: 'RDM', subtipo: 'Abastecimento',
    sub: 'Combustível e o que sai no posto.' },
  { chave: 'hospedagem',    ico: '🏨', nome: 'Hospedagem',    tipo: 'RDM', subtipo: 'Hospedagem',
    sub: 'Pousada, hotel e diárias.' },
  { chave: 'outros',        ico: '📦', nome: 'Outros',        tipo: 'RDM', subtipo: 'Outros',
    sub: 'Borracharia, oficina, EPIs e demais gastos.' },
];

function _categoriaCV(chave) {
  return CATEGORIAS_CV.find(c => c.chave === chave) || null;
}

/* De uma nota para a categoria do CV (a mesma conta que o relatório faz). */
function _chaveCategoriaDaNota(n) {
  if (!n) return 'outros';
  if (n.tipo === 'RDA') return 'alimentacao';
  const s = String(n.subtipo || '').toLowerCase();
  if (s.startsWith('abast')) return 'abastecimento';
  if (s.startsWith('hosp')) return 'hospedagem';
  return 'outros';
}

/* ─── Resumo de gastos e saldo devedor (22/09/2026) ──────────────
   Pedido do Cleiton: dentro de Despesas, um resumo de RDA e RDM "para ter
   ideia do que tem para receber e ter um controle"; e, quando a empresa
   estiver devendo mais de R$ 1.500 a alguém, um alerta para o gestor.

   Saldo devedor = o que a EMPRESA deve ao colaborador, acumulado até o mês:
     • regime RDM/RDA → gastos − repasses recebidos;
     • regime CV      → reembolsos registrados − reembolsos recebidos
       (as notas do cartão não entram: quem pagou foi a empresa).
   Positivo = a empresa deve; negativo = o colaborador está com dinheiro
   da empresa para gastar. */
const LIMITE_DEVEDOR = 1500;

function _devedorDe(ns, rs, mes, ano, ehCv, tipo = null) {
  const k = ano * 12 + mes;
  const ate = o => !o.deleted && (Number(o.ano) * 12 + Number(o.mes)) <= k && (!tipo || o.tipo === tipo);
  if (ehCv) {
    /* 24/09/2026: no cartão corporativo a dívida NÃO vem de pedidos — vem
       das notas que a pessoa pagou do próprio bolso, que é o que a aba CV
       REEMBOLSO soma na planilha. Dela se abate o que a empresa já
       transferiu (coluna "REEMBOLSO DE:"). A recarga do cartão fica fora:
       aquele dinheiro foi para o cartão, não para a conta da pessoa.
       O filtro por categoria também não vale aqui: o reembolso é um valor
       só, sem separar RDA de RDM. */
    const ateData = o => !o.deleted && (Number(o.ano) * 12 + Number(o.mes)) <= k;
    const doBolso = _soma(ns.filter(n => ateData(n) && n.pagamento === 'reembolso'));
    const reembolsado = _soma(rs.filter(r => ateData(r) && _repasseEhRecebido(r) && _repasseEhReembolso(r)));

    return doBolso - reembolsado;
  }

  return _soma(ns.filter(ate)) - _soma(rs.filter(r => ate(r) && _repasseEhRecebido(r)));
}

/* Colaboradores da equipe acima do limite (gestor/admin; usa o que já está
   no aparelho — notasEquipe/repassesEquipe — sem pedir nada ao servidor). */
function _equipeDevedora(mes = filMes, ano = filAno) {
  if (!_ehGestorOuAdmin()) return [];
  const porUser = {};
  const junta = (arr, campo) => arr.forEach(o => {
    if (o.deleted || !o.user_id) return;
    (porUser[o.user_id] = porUser[o.user_id] || { ns: [], rs: [] })[campo].push(o);
  });
  junta(notasEquipe, 'ns'); junta(repassesEquipe, 'rs');
  if (user?.id) { porUser[user.id] = { ns: notas.filter(n => !n.deleted), rs: repasses.filter(r => !r.deleted) }; }
  return Object.entries(porUser)
    .map(([id, d]) => {
      const quem = id === user?.id ? user : equipePorId[id];
      return {
        id,
        nome: (id === user?.id ? user?.nome : equipePorId[id]?.nome) || 'Colaborador',
        valor: _devedorDe(d.ns, d.rs, mes, ano, _ehCV(quem), 'RDM'),   // só RDM (22/09/2026)
        total: _devedorDe(d.ns, d.rs, mes, ano, _ehCV(quem)),
      };
    })
    .filter(c => c.valor > LIMITE_DEVEDOR)
    .sort((a, b) => b.valor - a.valor);
}

/* Bloco "Resumo do mês" do hub: RDA, RDM e o que há para receber. */
function _resumoHub() {
  const doMes = t => notas.filter(n => !n.deleted && n.tipo === t && n.mes === filMes && n.ano === filAno);
  const rda = doMes('RDA'), rdm = doMes('RDM');
  const cv = _ehCV();
  const ns = notas.filter(n => !n.deleted), rs = repasses.filter(r => !r.deleted);
  const devedor = _devedorDe(ns, rs, filMes, filAno, cv);
  const devedorRdm = _devedorDe(ns, rs, filMes, filAno, cv, 'RDM');
  /* 22/09/2026: o aviso é SÓ pelo devedor de RDM e SÓ para gestor/admin —
     o colaborador vê os números, mas não é cobrado pelo app. */
  const acima = _ehGestorOuAdmin() && devedorRdm > LIMITE_DEVEDOR;
  const outros = _equipeDevedora().filter(c => c.id !== user?.id);

  const linha = (ico, sigla, arr) => `
    <div class="res-col">
      <span class="res-ico">${ico}</span>
      <span class="res-sigla">${sigla}</span>
      <span class="res-val">${brl(_soma(arr))}</span>
      <span class="res-sub">${arr.length} nota${arr.length === 1 ? '' : 's'}</span>
    </div>`;

  const rotulo = cv ? 'Reembolso a receber' : 'A receber da empresa';

  /* 22/09/2026: "especificar os gastos no resumo a receber e apontar os
     gastos RDM/RDA e os valores por mês" — o que forma o valor a receber,
     separado por aba e mês a mês. No regime CV, "gasto" aqui é o reembolso
     registrado (nota do cartão não é dívida da empresa com a pessoa). */
  const devedorRda = _devedorDe(ns, rs, filMes, filAno, cv, 'RDA');
  const gastoDe = (t, mes) => cv
    ? _soma(rs.filter(r => r.tipo === t && r.mes === mes && r.ano === filAno && _repasseEhPedido(r)))
    : _soma(ns.filter(n => n.tipo === t && n.mes === mes && n.ano === filAno));
  const recebidoDe = (t, mes) => _soma(rs.filter(r => r.tipo === t && r.mes === mes && r.ano === filAno && _repasseEhRecebido(r)));

  /* 23/09/2026: no regime de dinheiro em conta o RDA e o RDM são contas
     separadas — o valor a receber sai por aba, não somado. Cada caixa diz
     também o estado: a receber, adiantado (recebeu mais do que gastou) ou
     em dia. */
  const caixaRec = (ico, sigla, v) => {
    const estado = v > 0 ? 'receber' : v < 0 ? 'adiantado' : 'zerado';
    const legenda = v > 0 ? (cv ? 'a reembolsar' : 'a receber')
                  : v < 0 ? 'adiantado com você'
                  : 'em dia';
    return `
      <div class="res-rec ${estado}">
        <span class="res-rec-top">${ico} ${sigla}</span>
        <span class="res-rec-val">${brl(Math.abs(v))}</span>
        <span class="res-rec-sub">${legenda}</span>
      </div>`;
  };
  const tabelaAba = (ico, tipo) => {
    const linhas = [];
    for (let m = 12; m >= 1; m--) {
      const g = gastoDe(tipo, m), rec = recebidoDe(tipo, m);
      if (g || rec) linhas.push({ m, g, rec, falta: g - rec });
    }
    if (!linhas.length) return '';
    const mostra = linhas.slice(0, 6);
    return `
      <div class="res-tab-tit">${ico} ${tipo} — mês a mês</div>
      <table class="res-tab">
        <tr><th>Mês</th><th>${cv ? 'Reembolso' : 'Gasto'}</th><th>Recebido</th><th>A receber</th></tr>
        ${mostra.map(l => `
        <tr>
          <td>${MESES[l.m - 1]}</td>
          <td>${brl(l.g)}</td>
          <td>${brl(l.rec)}</td>
          <td class="${l.falta > 0 ? 'pos' : l.falta < 0 ? 'neg' : ''}">${brl(l.falta)}</td>
        </tr>`).join('')}
      </table>
      ${linhas.length > mostra.length ? `<div class="res-tab-mais">+ ${linhas.length - mostra.length} mês(es) em ${filAno} — veja tudo em RDM/RDA e Planilhas.</div>` : ''}`;
  };

  const detalhe = `
    <div class="res-rec-tit">${rotulo} — por aba</div>
    <div class="res-recs">
      ${caixaRec('🍽️', 'RDA', devedorRda)}
      ${caixaRec('💼', 'RDM', devedorRdm)}
    </div>
    ${tabelaAba('🍽️', 'RDA')}
    ${tabelaAba('💼', 'RDM')}`;

  return `
    <div class="ini-titulo">Resumo de ${MESES[filMes - 1]} ${filAno}</div>
    <div class="res-card ${acima ? 'alerta' : ''}" onclick="switchView('saldo')">
      <div class="res-linha">
        ${linha('🍽️', 'RDA', rda)}
        ${linha('💼', 'RDM', rdm)}
      </div>
      ${detalhe}
      ${acima ? `<div class="res-alerta">⚠️ <b>RDM ${brl(devedorRdm)}</b> — acima do limite de ${brl(LIMITE_DEVEDOR)}. Veja o detalhe em <b>RDM/RDA e Planilhas</b>.</div>` : ''}
    </div>
    ${outros.length ? `
    <div class="res-card alerta res-equipe" onclick="event.stopPropagation(); abrirNotificacoes()">
      <div class="res-alerta" style="margin:0">🔔 <b>${outros.length} ${outros.length === 1 ? 'colaborador' : 'colaboradores'}</b> com <b>RDM</b> a receber acima de ${brl(LIMITE_DEVEDOR)}:
        ${outros.slice(0, 3).map(c => `${esc(c.nome)} (${brl(c.valor)})`).join(' · ')}${outros.length > 3 ? ` e mais ${outros.length - 3}` : ''}. Toque para ver.</div>
    </div>` : ''}`;
}

/* Cartão de categoria no hub (CV) — mesma cara do cartão de aba, mas
   contando só as notas daquela categoria. */
function _catCardCV(chave) {
  const c = _categoriaCV(chave);
  if (!c) return '';
  const aberta = _abaDespesa === chave;
  const doMes = notas.filter(n => !n.deleted && n.mes === filMes && n.ano === filAno
    && _chaveCategoriaDaNota(n) === chave);
  const total = doMes.reduce((s, n) => s + _n(n.valor), 0);
  const mesTxt = doMes.length
    ? `${MESES[filMes - 1]}: ${brlCurto(total)} · ${doMes.length} nota${doMes.length === 1 ? '' : 's'}`
    : `${MESES[filMes - 1]}: nenhuma nota`;
  return `
    <div class="aba-hero aba-hero-${c.tipo.toLowerCase()} ${aberta ? 'aberta' : ''}" id="aba-${chave}">
      <span class="aba-hero-mes">${esc(mesTxt)}</span>
      <button class="aba-hero-cab" aria-expanded="${aberta}" onclick="abrirAbaDespesa('${chave}')">
        <span class="aba-hero-ico">${c.ico}</span>
        <span class="aba-hero-txt">
          <span class="aba-hero-sigla">${esc(c.nome)}</span>
          <span class="aba-hero-nome">${esc(c.sub)}</span>
          <span class="aba-hero-sub">${aberta ? 'Escolha como quer lançar 👇' : ''}</span>
        </span>
        <span class="aba-hero-seta">${aberta ? '▲' : '▼'}</span>
      </button>
      ${aberta ? `
      <div class="aba-hero-acoes">
        <button class="aba-acao aba-acao-destaque" onclick="lancarNaCategoriaCV('${chave}','qr')">
          <span class="aba-acao-ico">📷</span>
          <span class="aba-acao-txt">
            <span class="aba-acao-tit">Nota pelo QR Code</span>
            <span class="aba-acao-sub">Aponte a câmera: empresa, valor e data entram sozinhos.</span>
          </span>
        </button>
        <button class="aba-acao" onclick="lancarNaCategoriaCV('${chave}','manual')">
          <span class="aba-acao-ico">📝</span>
          <span class="aba-acao-txt">
            <span class="aba-acao-tit">Nota sem QR</span>
            <span class="aba-acao-sub">Recibo, DANFE ou NFS-e: foto ou arquivo.</span>
          </span>
        </button>
      </div>` : ''}
    </div>`;
}

function lancarNaCategoriaCV(chave, modo) {
  const c = _categoriaCV(chave);
  if (!c) return;
  _abaPreEscolhida = c.tipo;
  _subtipoPreEscolhido = c.subtipo;
  const pag = _pagamentoCV || 'cv';
  _pagamentoPreEscolhido = pag;
  if (modo === 'qr') iniciarQR();
  else abrirSeletorTipoLancamento({ _manual: true, tipo: c.tipo, subtipo: c.subtipo, pagamento: pag });
}

/* O QR abre a câmera e só depois monta os dados: a escolha fica guardada
   aqui até o formulário nascer. */
let _pagamentoPreEscolhido = null;

function _abaCard(tipo) {
  const a = ABAS_DESPESA[tipo];
  const aberta = _abaDespesa === tipo;
  const doMes = notas.filter(n => !n.deleted && n.tipo === tipo && n.mes === filMes && n.ano === filAno);
  const total = doMes.reduce((s, n) => s + _n(n.valor), 0);
  const mesTxt = doMes.length
    ? `${MESES[filMes - 1]}: ${brlCurto(total)} · ${doMes.length} nota${doMes.length === 1 ? '' : 's'}`
    : `${MESES[filMes - 1]}: nenhuma nota`;
  return `
    <div class="aba-hero aba-hero-${tipo.toLowerCase()} ${aberta ? 'aberta' : ''}" id="aba-${tipo}">
      <span class="aba-hero-mes">${esc(mesTxt)}</span>
      <button class="aba-hero-cab" aria-expanded="${aberta}" onclick="abrirAbaDespesa('${tipo}')">
        <span class="aba-hero-ico">${a.ico}</span>
        <span class="aba-hero-txt">
          <span class="aba-hero-sigla">${tipo}</span>
          <span class="aba-hero-nome">${esc(a.nome)}</span>
          <span class="aba-hero-sub">${aberta ? 'Escolha como quer lançar 👇' : esc(a.sub)}</span>
        </span>
        <span class="aba-hero-seta">${aberta ? '▲' : '▼'}</span>
      </button>
      ${aberta ? `
      <div class="aba-hero-acoes">
        <button class="aba-acao aba-acao-destaque" onclick="lancarNaAba('${tipo}','qr')">
          <span class="aba-acao-ico">📷</span>
          <span class="aba-acao-txt">
            <span class="aba-acao-tit">Nota pelo QR Code</span>
            <span class="aba-acao-sub">Aponte a câmera: empresa, valor e data entram sozinhos.</span>
          </span>
        </button>
        <button class="aba-acao" onclick="lancarNaAba('${tipo}','manual')">
          <span class="aba-acao-ico">📝</span>
          <span class="aba-acao-txt">
            <span class="aba-acao-tit">Nota sem QR</span>
            <span class="aba-acao-sub">Recibo, DANFE ou NFS-e: foto ou arquivo.</span>
          </span>
        </button>
      </div>` : ''}
    </div>`;
}

function abrirAbaDespesa(tipo) {
  _abaDespesa = _abaDespesa === tipo ? null : tipo;   // tocar de novo fecha
  renderDespesas();
  if (_abaDespesa) {
    const el = $('aba-' + _abaDespesa);
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 40);
  }
}

/* Lança já na aba escolhida: o modal não pergunta RDA/RDM de novo (o botão
   "Trocar" continua lá, para o caso de a pessoa ter aberto a aba errada). */
function lancarNaAba(tipo, modo) {
  _abaPreEscolhida = tipo;
  if (modo === 'qr') iniciarQR();
  else abrirSeletorTipoLancamento({ _manual: true, tipo });
}

function renderDespesas() {
  $('app-content').innerHTML = `
  <div class="db-container">
    <div class="ini-ola">
      <h2>🧾 Petermann – Despesas</h2>
      <span>${_ehCV() ? 'Notas do cartão, painel e saldo' : 'Notas RDA / RDM, painel e saldo'}</span>
    </div>

    ${_ehContabilidade() ? `
    <div class="ini-dica">👀 Perfil <b>Contabilidade</b>: consulta e relatórios. Lançamentos são feitos pelos colaboradores.</div>` : `
    ${_ehCV() && !_pagamentoCV ? `
    <div class="ini-titulo">Como esta nota foi paga?</div>
    ${PAGAMENTOS_CV.map(p => `
      <button class="pnl pnl-atalho pag-cv-card" style="margin-bottom:10px" onclick="escolherPagamentoCV('${p.chave}')">
        <span class="pnl-conteudo">
          <span class="pnl-ico">${p.ico}</span>
          <span class="pnl-tit">${esc(p.nome)}</span>
          <span class="pnl-sub">${esc(p.sub)}</span>
        </span>
      </button>`).join('')}
    ` : _ehCV() ? `
    <div class="pag-cv-escolhido">
      <span>${_pagamentoCVInfo(_pagamentoCV)?.ico || ''} <b>${esc(_pagamentoCVInfo(_pagamentoCV)?.nome || '')}</b></span>
      <button class="btn btn-sm btn-outline" onclick="trocarPagamentoCV()">Trocar</button>
    </div>
    <div class="ini-titulo">Escolha a categoria e lance a nota</div>
    ${CATEGORIAS_CV.map(c => _catCardCV(c.chave)).join('')}
    ` : `
    <div class="ini-titulo">Escolha a aba e lance a nota</div>
    ${_abaCard('RDA') + _abaCard('RDM')}`}
    ${_resumoHub()}`}

    <div class="ini-titulo">Ir para</div>
    <div class="ini-ir">
      ${_ehContabilidade() ? '' : `
      <button class="ini-ir-btn" onclick="irParaNotas()"><span class="ini-ir-ico">🧾</span><span class="ini-ir-lbl">Minhas notas</span><span class="ini-ir-sub">lista completa</span></button>
      <button class="ini-ir-btn" onclick="switchView('home')"><span class="ini-ir-ico">📊</span><span class="ini-ir-lbl">Painel</span><span class="ini-ir-sub">gráficos e pendências</span></button>
      <button class="ini-ir-btn" onclick="switchView('saldo')"><span class="ini-ir-ico">${_ehCV() ? '💳' : '💰'}</span><span class="ini-ir-lbl">${_ehCV() ? 'C.V. e Planilha' : 'RDM/RDA e Planilhas'}</span><span class="ini-ir-sub">${_ehCV() ? 'cartão, reembolsos e planilha' : 'saldo e relatórios'}</span></button>`}
      ${_veEquipe() ? `<button class="ini-ir-btn" onclick="switchView('equipe')"><span class="ini-ir-ico">👥</span><span class="ini-ir-lbl">Equipe</span><span class="ini-ir-sub">baixar relatórios</span></button>` : ''}
      ${_veEquipe() ? `<button class="ini-ir-btn" onclick="switchView('arquivos')"><span class="ini-ir-ico">📁</span><span class="ini-ir-lbl">Arquivos</span><span class="ini-ir-sub">pastas e ZIP do mês</span></button>` : ''}
    </div>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════
   VIEW: INÍCIO — tela de entrada (pedido em 16/09/2026)
   Quem entra no sistema quer LANÇAR. Três ações grandes, em linguagem
   de quem está no campo, um resumo do mês e atalhos para o resto.
   Nada aqui é novo: só chama o que já existe (QR, Manual, Repasse).
═══════════════════════════════════════════════════════════ */
function renderInicio() {
  const A = _agregaPeriodo(filMes, filAno, 'mensal');
  const hora = new Date().getHours();
  const saud = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
  const nome = (user?.nome || user?.email || '').split(' ')[0] || '';
  const hojeTxt = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });

  _recalcularDuplicatas(notas);
  const pend = notas.filter(n => !n.deleted && (n.sync_status === 'failed' || n.synced === false));
  const semAnexo = A.ns.filter(n => !n.foto_path && !n.foto_local);
  const semValor = A.ns.filter(n => !(Number(n.valor) > 0));
  /* 24/09/2026: a planilha da empresa tem uma coluna de CNPJ e outra de
     "Nº DA NOTA" em cada categoria. Nota sem esses dois campos vira célula
     vazia lá, e alguém preenche à mão depois — é onde nascem os erros. */
  const semDoc = A.ns.filter(_notaIncompletaParaPlanilha);
  /* 24/09/2026: lançamento com data no futuro é sempre erro — e é assim que
     a nota gravada em 2045 aparece, em vez de sumir das listas. Olha o ano
     inteiro, não só o mês filtrado. */
  const noFuturo = notas.filter(n => !n.deleted && _dataNoFuturo(n.data))
    .concat(repasses.filter(r => !r.deleted && _dataNoFuturo(r.data)));
  const dups = A.ns.filter(n => _dupMapa.has(n.id));
  const pendTotal = pend.length + semAnexo.length + semValor.length + dups.length + semDoc.length + noFuturo.length;
  const pendTxt = [
    pend.length ? `${pend.length} aguardando envio` : null,
    semAnexo.length ? `${semAnexo.length} sem anexo` : null,
    semValor.length ? `${semValor.length} sem valor` : null,
    semDoc.length ? `${semDoc.length} sem CNPJ ou nº da nota` : null,
    noFuturo.length ? `${noFuturo.length} com data no futuro` : null,
    dups.length ? `${dups.length} possível duplicata` : null,
  ].filter(Boolean).join(' · ');

  const ultimas = [...notas].filter(n => !n.deleted)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 3);

  /* 21/09/2026 (reunião): a saudação mostra a FOTO do colaborador e o PAPEL
     dele. O avatar usa a mesma classe da Equipe — o observador do gestor.js
     baixa a imagem sozinho quando vê .avatar[data-foto]. */
  const PAPEL = { colaborador: 'Colaborador', gestor: 'Gestor', admin: 'Administrador', contabilidade: 'Contabilidade' };
  const papel = user?.role || 'colaborador';
  $('app-content').innerHTML = `
  <div class="db-container">
    </div>

    <!-- 20/09/2026: QR + Nota sem QR + Repasse viraram UM painel que abre a
         tela com os três. 21/09/2026: virou "Petermann – Despesas" e passou a
         guardar também Painel, Minhas notas, Saldo, Equipe e Arquivos — o
         Início ficou só com os módulos (Despesas, Frota, Ponto) e o Perfil. -->
    <div class="ini-paineis">
      <button class="pnl pnl-grande" onclick="switchView('despesas')">
        <span class="pnl-conteudo">
          <span class="pnl-ico">🧾</span>
          <span class="pnl-tit">Petermann – Despesas</span>
          <span class="pnl-sub">${_ehContabilidade()
            ? "Equipe / Baixar relatórios · Arquivos."
            : `Lançar nota · Painel · Minhas notas · ${_ehCV() ? 'C.V e notas de reembolso' : 'RDM/RDA e Planilhas'}${_veEquipe() ? " · Equipe · Arquivos" : ""}.`}</span>
        </span>
      </button>
      ${_ehContabilidade() ? '' : _ehCV() ? `
      <button class="pnl pnl-grande" onclick="abrirFormRepasse(null, null, null, 'reembolso')">
        <span class="pnl-conteudo">
          <span class="pnl-ico">👛</span>
          <span class="pnl-tit">Reembolso</span>
          <span class="pnl-sub">o que você pagou do bolso · e o que já recebeu</span>
        </span>
      </button>
      <button class="pnl pnl-grande" onclick="abrirFormRepasse('requested', null, null, 'recarga')">
        <span class="pnl-conteudo">
          <span class="pnl-ico">💳</span>
          <span class="pnl-tit">Recarga do cartão</span>
          <span class="pnl-sub">${_saldoCartao() != null ? 'saldo hoje: ' + brl(_saldoCartao()) : 'pedir recarga ao gestor'}</span>
        </span>
      </button>` : `
      <button class="pnl pnl-grande" onclick="abrirFormRepasse()">
        <span class="pnl-conteudo">
          <span class="pnl-ico">💸</span>
          <span class="pnl-tit">Repasse</span>
          <span class="pnl-sub">recebido ou a pedir (PIX)</span>
        </span>
      </button>`}
    </div>
    ${!_ehContabilidade() && pendTotal ? `
    <div class="ini-dica" style="cursor:pointer" onclick="switchView('home')">⚠️ <b>${pendTotal} pendência${pendTotal === 1 ? '' : 's'}</b>: ${esc(pendTxt)} — toque para ver no Painel.</div>` : ''}

    <!-- 22/09/2026: o Início ficou com o painel de Despesas e os atalhos.
         Os cartões grandes de Frota/Ponto e os números do mês saíram daqui
         (pedido do Cleiton): Frota e Ponto viraram atalhos em "Ir para" e os
         números continuam no Painel e no Saldo, de onde nunca saíram. -->
    <div class="ini-titulo">Ir para</div>
    <div class="ini-ir">
      <button class="ini-ir-btn" onclick="switchView('perfil')"><span class="ini-ir-ico">👤</span><span class="ini-ir-lbl">Perfil</span><span class="ini-ir-sub">conta, backup, ajuda</span></button>
      ${MODULOS_EXTRAS && _ehGestorOuAdmin() ? `
      <button class="ini-ir-btn" onclick="switchView('frota')"><span class="ini-ir-ico">🚗</span><span class="ini-ir-lbl">Frota / KM</span><span class="ini-ir-sub">odômetro dos veículos</span></button>
      <button class="ini-ir-btn" onclick="switchView('ponto')"><span class="ini-ir-ico">⏱️</span><span class="ini-ir-lbl">Ponto</span><span class="ini-ir-sub">entrada, saída, extras</span></button>` : ''}
    </div>


    ${_ehContabilidade() ? '' : ultimas.length ? `
    <div class="ini-titulo">Últimos lançamentos</div>
    <div class="notas-list">${ultimas.map(n => cardNotaHTML(n, 'inithumb-')).join('')}</div>` : `
    <div class="ini-dica">👆 Ainda não há lançamentos. Toque em <b>Petermann – Despesas</b>, escolha a aba <b>RDA</b> ou <b>RDM</b> e lance pelo <b>QR Code</b> — é o jeito mais rápido.</div>`}
  </div>`;

  if (ultimas.length) _carregarMiniaturas(ultimas, 'inithumb-').catch(() => {});
}

/* ═══════════════════════════════════════════════════════════
   VIEW: HOME — dashboard interativo
   Estado da interação vive fora do render p/ sobreviver ao
   innerHTML (toque numa barra, série ligada/desligada, etc.)
═══════════════════════════════════════════════════════════ */
let dashSerie      = { RDM:true, RDA:true };  // séries visíveis no gráfico
let dashTendencia  = false;                   // linha do total sobre as barras
let dashBarraSel   = null;                    // índice da coluna tocada
let dashFatiaSel   = null;                    // chave da fatia do donut tocada
let _dashEvo       = [];                      // dados do gráfico (p/ o drill-down)

const _n     = v => Number(v) || 0;
const _soma  = arr => arr.reduce((a,x) => a + _n(x.valor), 0);
const _dataDe = o => String(o?.data || o?.created_at || '');   // nunca undefined

function _repasseEhPedido(rep) {
  const kind = String(rep?.kind || '').toLowerCase();
  return ['requested', 'request', 'pedido', 'solicitado'].includes(kind);
}

/* 23/09/2026: o repasse que o gestor registra JÁ VALE — entra em saldo,
   gráfico e planilha na hora. A confirmação do colaborador, que existiu por
   algumas horas hoje, saiu do fluxo: quem paga é quem registra. */
function _repasseEhRecebido(rep) {
  return !_repasseEhPedido(rep);
}

/* Rótulo curto p/ eixo: R$ 350 · R$ 1,2 mil · R$ 1,4 mi */
function brlCurto(v) {
  const a = Math.abs(v);
  if (a >= 1e6)  return 'R$ ' + (v/1e6).toFixed(1).replace('.',',') + ' mi';
  if (a >= 1000) return 'R$ ' + (v/1000).toFixed(a >= 10000 ? 0 : 1).replace('.',',') + ' mil';
  return 'R$ ' + Math.round(v);
}

/* Topo "redondo" da escala do gráfico (1, 2, 2,5 ou 5 × potência de 10) */
function _escalaTopo(pico) {
  if (!(pico > 0)) return 100;
  const mag = Math.pow(10, Math.floor(Math.log10(pico)));
  for (const m of [1, 2, 2.5, 5]) if (mag*m >= pico) return mag*m;
  return mag*10;
}

/* Agrega notas e repasses de um período (mês ou ano inteiro) */
function _agregaPeriodo(mes, ano, modo) {
  const doPeriodo = o => !o.deleted && o.ano === ano && (modo === 'anual' || o.mes === mes);
  const ns = notas.filter(doPeriodo);
  const rs = repasses.filter(doPeriodo).filter(_repasseEhRecebido);
  const porTipo = (arr,t) => _soma(arr.filter(x => x.tipo === t));
  const rdmG = porTipo(ns,'RDM'), rdaG = porTipo(ns,'RDA');
  const rdmR = porTipo(rs,'RDM'), rdaR = porTipo(rs,'RDA');
  return { ns, rs, rdmG, rdaG, rdmR, rdaR,
           gasto: rdmG + rdaG, recebido: rdmR + rdaR };
}

/* Resumo por trimestre do exercício, como o quadro da aba BANCO DE DADOS.
   Soma GASTOS (não repasses) — é o que as fórmulas M6/M8 da planilha apontam. */
function _resumoTrimestral(ano) {
  const porMes = Array.from({ length: 13 }, () => ({ rdm: 0, rda: 0 }));
  notas.forEach(n => {
    if (n.deleted || n.ano !== ano) return;
    const m = porMes[n.mes];
    if (!m) return;
    if (n.tipo === 'RDM') m.rdm += _n(n.valor);
    else if (n.tipo === 'RDA') m.rda += _n(n.valor);
  });
  const trims = TRIMESTRES.map(t => {
    const rdm = t.meses.reduce((a, m) => a + porMes[m].rdm, 0);
    const rda = t.meses.reduce((a, m) => a + porMes[m].rda, 0);
    return { ...t, rdm, rda, total: rdm + rda };
  });
  return {
    trims,
    totalRdm:  trims.reduce((a, t) => a + t.rdm, 0),
    totalRda:  trims.reduce((a, t) => a + t.rda, 0),
    totalGeral: trims.reduce((a, t) => a + t.total, 0),
  };
}

/* Saldo acumulado mês a mês para RDM/RDA (independentes).
   Pendência negativa de meses anteriores é abatida do repasse do mês atual.
   Ex.: Mês 1 Gasto 500 Repasse 300 → Pendência -200
        Mês 2 Gasto 100 Repasse 400 → Saldo Líquido = (400-100) + (-200) = 100 */
function _saldoAcumuladoAte(targetMes, targetAno, tipo) {
  const targetKey = targetAno * 12 + targetMes;
  const ePassado  = o => !o.deleted && (tipo ? o.tipo === tipo : true) && ((o.ano * 12 + o.mes) < targetKey);
  const eAtual    = o => !o.deleted && (tipo ? o.tipo === tipo : true) && ((o.ano * 12 + o.mes) === targetKey);
  const gastosPassados   = _soma(notas.filter(ePassado));
  const repassesPassados = _soma(repasses.filter(o => ePassado(o) && _repasseEhRecebido(o)));
  const pendenciaAnterior = repassesPassados - gastosPassados;
  const gastoMes   = _soma(notas.filter(eAtual));
  const repasseMes = _soma(repasses.filter(o => eAtual(o) && _repasseEhRecebido(o)));
  const saldoMes   = repasseMes - gastoMes;
  const saldoLiquido = pendenciaAnterior + saldoMes;
  return { pendenciaAnterior, gastoMes, repasseMes, saldoMes, saldoLiquido };
}

/* ── Nota com data implausível ───────────────────────────────
   O ano da nota sai dos dígitos 3-4 da chave de acesso, então um QR borrado
   ou um OCR que troca um dígito joga a nota para um mês qualquer do passado.
   Ela some de todas as telas — que são todas por mês — e mesmo assim entra
   na pendência anterior do saldo acumulado, contaminando todos os meses
   seguintes sem deixar rastro. Foi assim que apareceu -R$ 900,00 num mês
   sem nada lançado.

   Por isso esta checagem é feita sobre TODAS as notas, não só as do período
   em foco: uma nota fora da janela é, por definição, invisível no período. */
const JANELA_PASSADO_MESES = 24;
function _dataImplausivel(n) {
  const agora = new Date();
  const kAgora = agora.getFullYear() * 12 + (agora.getMonth() + 1);
  const k = Number(n.ano) * 12 + Number(n.mes);
  if (!Number.isFinite(k)) return true;                 // mes/ano ausente ou corrompido
  return k > kAgora || k < kAgora - JANELA_PASSADO_MESES;
}
const _notasDataSuspeita = () => notas.filter(n => !n.deleted && _dataImplausivel(n));

function _periodoAnterior(mes, ano, modo) {
  if (modo === 'anual') return { mes, ano: ano - 1 };
  return mes > 1 ? { mes: mes-1, ano } : { mes: 12, ano: ano-1 };
}

/* Chip de variação vs. período anterior. subirEhBom=false p/ gastos. */
function chipDelta(atual, anterior, subirEhBom = true) {
  if (!anterior) return atual ? '<span class="dl dl-new">novo</span>' : '';
  const pct = ((atual - anterior) / Math.abs(anterior)) * 100;
  if (Math.abs(pct) < 0.5) return '<span class="dl dl-flat">estável</span>';
  const subiu = pct > 0;
  const bom   = subirEhBom ? subiu : !subiu;
  return `<span class="dl ${bom ? 'dl-bom' : 'dl-ruim'}" title="vs. período anterior">${
    subiu ? '▲' : '▼'} ${Math.abs(pct) >= 999 ? '999+' : Math.abs(pct).toFixed(0)}%</span>`;
}

/* ── Interações ─────────────────────────────────────────── */
function alternarPeriodoDashboard(periodo) {
  filtroPeriodo = periodo;
  dashBarraSel = null;
  renderHome();
}

function alternarSerieDash(k) {
  // nunca deixa as duas séries apagadas — o gráfico ficaria vazio
  if (dashSerie[k] && !dashSerie[k === 'RDM' ? 'RDA' : 'RDM']) return;
  dashSerie[k] = !dashSerie[k];
  renderHome();
}

function alternarTendenciaDash() { dashTendencia = !dashTendencia; renderHome(); }

function selecionarBarraDash(i) {
  dashBarraSel = (dashBarraSel === i) ? null : i;
  renderHome();
}

function selecionarFatiaDash(chave) {
  dashFatiaSel = (dashFatiaSel === chave) ? null : chave;
  renderHome();
}

/* Toque numa coluna → "Abrir" pula o dashboard para aquele mês/ano */
function abrirBarraDash() {
  const d = _dashEvo[dashBarraSel];
  if (!d) return;
  filMes = d.mes; filAno = d.ano;
  dashBarraSel = null;
  renderHome();
  _garantirAnoEmFoco();
}

/* ── Gráfico de evolução (SVG, interativo) ──────────────── */
function gerarGraficoEvolucao(dados) {
  const W = 340, H = 172;
  const pl = 48, pr = 12, pt = 18, pb = 28;
  const gw = W - pl - pr, gh = H - pt - pb;
  const base = pt + gh;

  const totalDe = d => (dashSerie.RDM ? d.rdm : 0) + (dashSerie.RDA ? d.rda : 0);
  const visiveis = dados.flatMap(d => [
    dashSerie.RDM ? d.rdm : 0,
    dashSerie.RDA ? d.rda : 0,
    dashTendencia ? totalDe(d) : 0,
  ]);
  const topo = _escalaTopo(Math.max(...visiveis, 0));
  const cw   = gw / Math.max(1, dados.length);
  const y    = v => base - (Math.min(v, topo) / topo) * gh;

  /* grade: só 0 / metade / topo recebem rótulo — _escalaTopo garante
     que a metade também caia num número redondo. 1/4 e 3/4 ficam
     como linhas de apoio sem texto. */
  let svg = '';
  [0, .25, .5, .75, 1].forEach(f => {
    const yy = base - f*gh;
    const rotulado = f === 0 || f === .5 || f === 1;
    svg += `<line x1="${pl}" y1="${yy.toFixed(1)}" x2="${W-pr}" y2="${yy.toFixed(1)}"
             stroke="var(--border)" stroke-width="${f === 0 ? 1.2 : .8}"
             ${f === 0 ? '' : `stroke-dasharray="2 3" opacity="${rotulado ? .7 : .35}"`}/>`;
    if (rotulado)
      svg += `<text x="${pl-6}" y="${(yy+2.6).toFixed(1)}" text-anchor="end"
               style="font-size:9.5px;fill:var(--text2);font-weight:600">${brlCurto(topo*f)}</text>`;
  });

  /* barras agrupadas */
  const nSeries = (dashSerie.RDM ? 1 : 0) + (dashSerie.RDA ? 1 : 0);
  const bw = Math.max(4, Math.min(13, (cw - 8) / Math.max(1, nSeries)));
  dados.forEach((d, i) => {
    const cx  = pl + i*cw + cw/2;
    const sel = dashBarraSel === i;

    if (sel) svg += `<rect x="${(pl+i*cw).toFixed(1)}" y="${pt}" width="${cw.toFixed(1)}"
                      height="${gh}" fill="var(--primary)" opacity=".07" rx="4"/>`;

    let slot = 0;
    const barra = (val, cor) => {
      const x  = nSeries === 1 ? cx - bw/2 : cx - bw - 1.5 + slot*(bw + 3);
      slot++;
      if (!(val > 0)) return '';
      const h = Math.max(2, base - y(val));
      return `<rect x="${x.toFixed(1)}" y="${(base-h).toFixed(1)}" width="${bw.toFixed(1)}"
               height="${h.toFixed(1)}" rx="2.5" fill="${cor}"
               opacity="${dashBarraSel === null || sel ? 1 : .38}"/>`;
    };
    if (dashSerie.RDM) svg += barra(d.rdm, 'var(--accent)');
    if (dashSerie.RDA) svg += barra(d.rda, 'var(--primary)');

    svg += `<text x="${cx.toFixed(1)}" y="${H-8}" text-anchor="middle"
             style="font-size:10.5px;font-weight:${sel?800:500};
             fill:${sel?'var(--primary)':'var(--text2)'}">${d.label}</text>`;
  });

  /* linha de tendência do total */
  if (dashTendencia && dados.length > 1) {
    const pts = dados.map((d,i) =>
      `${(pl + i*cw + cw/2).toFixed(1)},${y(totalDe(d)).toFixed(1)}`).join(' ');
    svg += `<polyline points="${pts}" fill="none" stroke="#3b82f6" stroke-width="1.8"
             stroke-linejoin="round" stroke-linecap="round" opacity=".9"/>`;
    dados.forEach((d,i) => {
      svg += `<circle cx="${(pl + i*cw + cw/2).toFixed(1)}" cy="${y(totalDe(d)).toFixed(1)}"
               r="2.6" fill="#fff" stroke="#3b82f6" stroke-width="1.6"/>`;
    });
  }

  /* áreas de toque por coluna (sempre por último = ficam no topo) */
  dados.forEach((_, i) => {
    svg += `<rect x="${(pl+i*cw).toFixed(1)}" y="${pt}" width="${cw.toFixed(1)}" height="${gh+pb-8}"
             fill="transparent" style="cursor:pointer" onclick="selecionarBarraDash(${i})"/>`;
  });

  return `<svg class="db-chart" viewBox="0 0 ${W} ${H}" role="img"
            aria-label="Evolução de gastos por período">${svg}</svg>`;
}

/* ── Donut de composição (SVG, fatias tocáveis) ─────────── */
function gerarDonut(cats, total) {
  const CX = 66, CY = 66, R = 50, C = 2*Math.PI*R;
  if (!(total > 0)) {
    return `<svg viewBox="0 0 132 132" class="db-chart" style="height:132px">
      <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="var(--bg)" stroke-width="16"/>
      <text x="${CX}" y="${CY+4}" text-anchor="middle"
        style="font-size:13px;fill:var(--text2);font-weight:700">sem gastos</text></svg>`;
  }

  let acc = 0, segs = '';
  cats.forEach(c => {
    const len = (c.val/total) * C;
    const sel = dashFatiaSel === c.key;
    segs += `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${c.cor}"
              stroke-width="${sel ? 22 : 16}" stroke-dasharray="${len.toFixed(2)} ${(C-len).toFixed(2)}"
              stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${CX} ${CY})"
              opacity="${dashFatiaSel === null || sel ? 1 : .35}"
              style="cursor:pointer;transition:stroke-width .18s,opacity .18s"
              onclick="selecionarFatiaDash('${c.key}')"/>`;
    acc += len;
  });

  const foco = cats.find(c => c.key === dashFatiaSel);
  const centro = foco
    ? `<text x="${CX}" y="${CY-3}" text-anchor="middle"
         style="font-size:15.5px;font-weight:800;fill:var(--primary-d)">${
           Math.round(foco.val/total*100)}%</text>
       <text x="${CX}" y="${CY+11}" text-anchor="middle"
         style="font-size:10px;font-weight:700;fill:var(--text2)">${esc(foco.curto)}</text>`
    : `<text x="${CX}" y="${CY-2}" text-anchor="middle"
         style="font-size:15px;font-weight:800;fill:var(--primary-d)">${brlCurto(total)}</text>
       <text x="${CX}" y="${CY+11}" text-anchor="middle"
         style="font-size:10px;font-weight:700;fill:var(--text2)">TOTAL</text>`;

  return `<svg viewBox="0 0 132 132" class="db-chart" style="height:132px">${segs}${centro}</svg>`;
}

function renderHome() {
  const modo = filtroPeriodo;                        // 'mensal' | 'anual'
  const A    = _agregaPeriodo(filMes, filAno, modo); // período em foco
  const pAnt = _periodoAnterior(filMes, filAno, modo);
  const B    = _agregaPeriodo(pAnt.mes, pAnt.ano, modo);

  const rotulo = modo === 'mensal' ? `${MESES[filMes-1]} ${filAno}` : String(filAno);

  /* ── Primeiro acesso: convite em vez de painel vazio ────── */
  if (!notas.length && !repasses.some(r => _repasseEhRecebido(r))) {
    $('app-content').innerHTML = `
    <div class="db-container">
      <div class="db-card" style="align-items:center;text-align:center;gap:12px;padding:28px 20px">
        <div style="font-size:46px">📊</div>
        <div style="font-size:19px;font-weight:800;color:var(--primary-d)">Seu painel começa aqui</div>
        <p style="font-size:16px;color:var(--text2);line-height:1.5">
          Lance a primeira nota e o dashboard passa a mostrar saldo, evolução,
          composição dos gastos e pendências automaticamente.</p>
        <button class="btn btn-primary btn-full" onclick="abrirCaptura()">+ Lançar primeira nota</button>
        <button class="btn btn-outline btn-full" onclick="abrirAjuda()">Como usar o app</button>
      </div>
    </div>`;
    return;
  }

  /* ── Números do período ─────────────────────────────────── */
  const saldo      = A.recebido - A.gasto;
  const saldoAnt   = B.recebido - B.gasto;
  const totalNotas = A.ns.length;
  const mediaNota  = totalNotas   ? A.gasto / totalNotas   : 0;
  const mediaAnt   = B.ns.length  ? B.gasto / B.ns.length  : 0;
  const maior      = [...A.ns].sort((a,b) => _n(b.valor) - _n(a.valor))[0] || null;
  const consumoPct = A.recebido > 0 ? (A.gasto / A.recebido) * 100 : (A.gasto > 0 ? 100 : 0);

  /* Saldo acumulado (histórico) p/ KPIs — RDM e RDA separados */
  const rdmAcc = _saldoAcumuladoAte(filMes, filAno, 'RDM');
  const rdaAcc = _saldoAcumuladoAte(filMes, filAno, 'RDA');
  const totalAcumulado = rdmAcc.saldoLiquido + rdaAcc.saldoLiquido;

  /* ── Série do gráfico: 6 meses ou 5 anos ────────────────── */
  _dashEvo = [];
  if (modo === 'mensal') {
    for (let i = 5; i >= 0; i--) {
      let m = filMes - i, a = filAno;
      while (m < 1) { m += 12; a--; }
      const g = _agregaPeriodo(m, a, 'mensal');
      _dashEvo.push({ label: MESES[m-1], mes: m, ano: a, rdm: g.rdmG, rda: g.rdaG });
    }
  } else {
    for (let i = 4; i >= 0; i--) {
      const a = filAno - i;
      const g = _agregaPeriodo(filMes, a, 'anual');
      _dashEvo.push({ label: String(a), mes: filMes, ano: a, rdm: g.rdmG, rda: g.rdaG });
    }
  }
  if (dashBarraSel !== null && !_dashEvo[dashBarraSel]) dashBarraSel = null;

  /* ── Composição dos gastos (donut) ──────────────────────── */
  const SUBS_RDM = ['Abastecimento','Hospedagem','Outros'];
  const somaRDM  = f => _soma(A.ns.filter(n => n.tipo === 'RDM' && f(n)));
  /* nomes conforme a planilha padrao da empresa (abas R.D.M. / R.D.A);
     o subtipo gravado no banco continua 'Hospedagem'/'Outros' — só o rótulo muda */
  const cats = [
    { key:'abast',  name:'RDM · Abastecimento', curto:'Abastec.', cor:'var(--accent-d)',
      val: somaRDM(n => n.subtipo === 'Abastecimento') },
    { key:'hosp',   name:'RDM · Hospedagens',   curto:'Hosped.',  cor:'var(--accent)',
      val: somaRDM(n => n.subtipo === 'Hospedagem') },
    // "Outros" absorve também RDM sem categoria — o donut sempre fecha no gasto total
    { key:'outros', name:'RDM · Outros (Borracharia/Oficina/EPIs)', curto:'Outros', cor:'#94a3b8',
      val: somaRDM(n => !SUBS_RDM.includes(n.subtipo) || n.subtipo === 'Outros') },
    { key:'rda',    name:'RDA · Alimentação',   curto:'RDA',      cor:'var(--primary)',
      val: A.rdaG },
  ].filter(c => c.val > 0).sort((a,b) => b.val - a.val);
  if (dashFatiaSel && !cats.some(c => c.key === dashFatiaSel)) dashFatiaSel = null;

  /* ── Ranking de fornecedores ────────────────────────────── */
  const mapaForn = new Map();
  A.ns.forEach(n => {
    if (_n(n.valor) <= 0) return;
    const nome = String(n.razao_social || '').trim()
      || (n.cnpj ? (window.BrasilAPI?.formatar?.(n.cnpj) || n.cnpj) : 'Sem empresa');
    const cur = mapaForn.get(nome) || { val:0, qtd:0 };
    cur.val += _n(n.valor); cur.qtd++;
    mapaForn.set(nome, cur);
  });
  const forn = [...mapaForn.entries()]
    .map(([nome, v]) => ({ nome, ...v }))
    .sort((a,b) => b.val - a.val).slice(0, 5);
  const maxForn = forn.length ? forn[0].val : 1;

  /* ── Pendências (lista interativa com transferência) ───── */
  const escopo   = modo === 'anual';
  _recalcularDuplicatas(notas);   // sobre TODAS as notas: a repetida pode estar em outro mês
  const pendentes = A.ns.filter(n =>
    n.sync_status === 'failed' || n.synced === false || _n(n.valor) <= 0 || (!n.foto_path && !n.foto_local) || _dupMapa.has(n.id)
  ).sort((a,b) => _dataDe(b).localeCompare(_dataDe(a)));

  const resumoPend = [
    { ico:'⚠️', txt:'Sem valor',    n: pendentes.filter(n => _n(n.valor) <= 0).length, flag:'sem-valor' },
    { ico:'📎', txt:'Sem anexo',    n: pendentes.filter(n => !n.foto_path && !n.foto_local).length, flag:'sem-anexo' },
    { ico:'⏳', txt:'Aguardando envio', n: pendentes.filter(n => n.sync_status === 'failed' || n.synced === false).length, flag:'pendente' },
    { ico:'🔁', txt:'Possíveis duplicatas', n: pendentes.filter(n => _dupMapa.has(n.id)).length, flag:'duplicata' },
  ];

  const linhaResumo = r => r.n ? `
    <button class="db-pend-item" onclick="irParaNotas('${r.flag}',${escopo})">
      <span class="db-pend-ico">${r.ico}</span>
      <span class="db-pend-txt">${r.txt}</span>
      <span class="db-pend-n">${r.n}</span>
      <span class="db-pend-seta">›</span>
    </button>` : '';

  const motivosDe = n => {
    const m = [];
    if (_n(n.valor) <= 0) m.push('sem valor');
    if (!n.foto_path && !n.foto_local) m.push('sem anexo');
    if (n.sync_status === 'failed') m.push('falha na sincronização');
    else if (n.synced === false) m.push('não enviada');
    if (_dataImplausivel(n)) m.push('data fora do período');
    const d = _dupMapa.get(n.id);
    if (d) m.push(`possível duplicata (${_MOTIVO_DUP[d.motivo]})`);
    return m.join(' · ');
  };

  /* Data suspeita é a única pendência que NÃO respeita o período em foco:
     a nota está escondida justamente por estar fora dele. */
  const suspeitas = _notasDataSuspeita();
  const linhaSuspeita = suspeitas.length ? `
    <button class="db-pend-item alerta" onclick="irParaNotas('data-suspeita',false)">
      <span class="db-pend-ico">📅</span>
      <span class="db-pend-txt">Data suspeita <b>(fora do período)</b></span>
      <span class="db-pend-n">${suspeitas.length}</span>
      <span class="db-pend-seta">›</span>
    </button>` : '';

  const itensPend = pendentes.slice(0, 10).map(n => `
    <div class="db-pend-item" style="gap:10px">
      <span class="tipo-badge tipo-${n.tipo}" style="flex-shrink:0">${esc(n.tipo)}</span>
      <div style="flex:1;min-width:0">
        <div class="db-pend-txt" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${esc(n.razao_social || (n.cnpj ? (window.BrasilAPI?.formatar?.(n.cnpj) || n.cnpj) : 'Sem empresa'))}</div>
        <div style="font-size:13px;color:var(--text2);margin-top:1px">
          ${esc(fmtData(n.data))} · ${motivosDe(n)}</div>
      </div>
      <span class="db-pend-n" style="margin-right:4px">${_n(n.valor) > 0 ? brl(n.valor) : '⚠️'}</span>
      <button class="btn btn-sm btn-outline" onclick="abrirTransferirNota('${n.id}')" style="flex-shrink:0">Mover</button>
    </div>`).join('');

  const pendHtml = pendentes.length
    ? linhaSuspeita + resumoPend.map(linhaResumo).join('')
      + `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
           <div style="font-size:13px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">
             Notas pendentes</div>
           <div class="db-pend">${itensPend}</div>
           ${pendentes.length > 10
             ? `<button class="btn btn-sm btn-outline btn-full" style="margin-top:8px" onclick="irParaNotas(null,${escopo})">
                  Ver todas (${pendentes.length})</button>` : ''}
         </div>`
    : linhaSuspeita + `<div class="db-pend-item ok">
         <span class="db-pend-ico">✅</span>
         <span class="db-pend-txt">Nada pendente em ${esc(rotulo)}</span>
         <span class="db-pend-n">0</span>
       </div>`;

  const pendingHint = pendentes.length ? `<div class="db-pend-item alerta" style="margin-bottom:8px">
    <span class="db-pend-ico">📡</span>
    <span class="db-pend-txt">Itens ainda não sincronizados ficam salvos no aparelho e tentam de novo quando a rede voltar.</span>
  </div>` : '';

  /* ── Ritmo de gasto e projeção (só no modo mês) ──────────── */
  let ritmoHtml = '';
  if (modo === 'mensal') {
    const agora     = new Date();
    const ehAtual   = filMes === agora.getMonth()+1 && filAno === agora.getFullYear();
    const diasMes   = new Date(filAno, filMes, 0).getDate();
    const corridos  = ehAtual ? agora.getDate() : diasMes;
    const mediaDia  = corridos ? A.gasto / corridos : 0;
    const projecao  = mediaDia * diasMes;
    const diasComNota = new Set(A.ns.map(n => _dataDe(n).slice(0,10)).filter(Boolean)).size;
    ritmoHtml = `
    <div class="db-card">
      <div class="db-card-title">
        <span>Ritmo de gasto</span>
        <span style="font-size:12.5px;color:var(--text2);font-weight:600">
          ${ehAtual ? `dia ${corridos} de ${diasMes}` : `${diasMes} dias`}</span>
      </div>
      <div class="db-ritmo">
        <div class="db-ritmo-cel">
          <div class="db-ritmo-val">${brlCurto(mediaDia)}</div>
          <div class="db-ritmo-lbl">por dia</div>
        </div>
        <div class="db-ritmo-cel">
          <div class="db-ritmo-val">${brlCurto(ehAtual ? projecao : A.gasto)}</div>
          <div class="db-ritmo-lbl">${ehAtual ? 'projeção' : 'fechado'}</div>
        </div>
        <div class="db-ritmo-cel">
          <div class="db-ritmo-val">${diasComNota}</div>
          <div class="db-ritmo-lbl">dias c/ nota</div>
        </div>
      </div>
    </div>`;
  }

  /* ── Últimas notas ──────────────────────────────────────── */
  const recentes = [...A.ns]
    .sort((a,b) => _dataDe(b).localeCompare(_dataDe(a))
                || String(b.created_at||'').localeCompare(String(a.created_at||'')))
    .slice(0, 5);
  const recHtml = recentes.length ? recentes.map(n => `
    <div class="recent-item" onclick="editarNota('${n.id}')" style="cursor:pointer">
      ${n.foto_path || n.foto_local ? `
      <button class="recent-thumb" id="dbthumb-${n.id}" title="Ver anexo da nota"
              onclick="event.stopPropagation();verFoto('${n.id}')"><span class="nota-thumb-ph">📎</span></button>` : ''}
      <span class="tipo-badge tipo-${n.tipo}">${esc(n.tipo)}</span>
      <div class="recent-info">
        <div class="recent-tit">${esc(n.razao_social
          || (n.cnpj ? (window.BrasilAPI?.formatar?.(n.cnpj) || n.cnpj) : 'Sem empresa'))}</div>
        <div class="recent-sub">${esc(fmtData(n.data))}${n.subtipo ? ' · ' + esc(n.subtipo) : ''}</div>
      </div>
      <span class="recent-val ${String(n.tipo||'').toLowerCase()}">${
        _n(n.valor) > 0 ? brl(n.valor) : '⚠️'}</span>
    </div>`).join('') : '<p class="muted-p">Nenhuma nota lançada no período.</p>';

  /* ── Faixa de detalhe do gráfico (drill-down) ───────────── */
  const barra = dashBarraSel !== null ? _dashEvo[dashBarraSel] : null;
  const drillHtml = barra ? `
    <div class="db-drill">
      <span><b>${esc(barra.label)}</b></span>
      <span>RDM <b>${brl(barra.rdm)}</b></span>
      <span>RDA <b>${brl(barra.rda)}</b></span>
      <span>Total <b>${brl(barra.rdm + barra.rda)}</b></span>
      <span class="sp">
        ${(barra.mes !== filMes || barra.ano !== filAno)
          ? `<button class="btn btn-sm btn-primary" onclick="abrirBarraDash()">Abrir</button>` : ''}
        <button class="btn btn-sm btn-outline" onclick="selecionarBarraDash(${dashBarraSel})">Fechar</button>
      </span>
    </div>`
    : `<div class="db-hint">Toque numa coluna para ver os valores do período</div>`;

  /* ── Cabeçalho institucional (aba CABEÇALHO da planilha) ── */
  const cabecalhoHtml = `
    <div class="db-emp">
      <div class="db-emp-razao">${esc(EMPRESA.razao)}</div>
      <div class="db-emp-linha">CNPJ ${esc(EMPRESA.cnpj)}</div>
      <div class="db-emp-linha">${esc(EMPRESA.endereco)} CEP ${esc(EMPRESA.cep)} — ${esc(EMPRESA.cidade)}</div>
      <div class="db-emp-tit">${esc(EMPRESA.titulo)}</div>
      <div class="db-emp-sub">${esc(EMPRESA.subtitulo)}</div>
      <div class="db-emp-campos">
        <div class="db-emp-campo">
          <span class="db-emp-lbl">Funcionário</span>
          <span class="db-emp-val">${esc(user?.nome || user?.email || '—')}</span>
        </div>
        <div class="db-emp-campo">
          <span class="db-emp-lbl">Safra / Ano do Exercício</span>
          <span class="db-emp-val">${filAno}</span>
        </div>
      </div>
    </div>`;

  /* ── Quadro trimestral (aba BANCO DE DADOS) ─────────────── */
  const T = _resumoTrimestral(filAno);
  /* valor cheio (sem "R$", que vai no título) — o quadro é conferido contra a planilha */
  const numBR = v => v.toLocaleString('pt-BR', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const celTrim = (v, cls = '') =>
    `<td class="${cls}${v > 0 ? '' : ' zero'}">${v > 0 ? numBR(v) : '—'}</td>`;
  const trimestralHtml = `
    <div class="db-card">
      <div class="db-card-title">
        <span>Resumo trimestral · ${filAno}</span>
        <span style="font-size:12.5px;color:var(--text2);font-weight:600">gastos em R$</span>
      </div>
      <div class="db-trim-wrap">
        <table class="db-trim">
          <thead>
            <tr>
              <th></th>
              ${T.trims.map(t => `<th>${t.id}<span>${esc(t.rotulo)}</span></th>`).join('')}
              <th class="tot">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>RDM</th>
              ${T.trims.map(t => celTrim(t.rdm)).join('')}
              ${celTrim(T.totalRdm, 'tot')}
            </tr>
            <tr>
              <th>RDA</th>
              ${T.trims.map(t => celTrim(t.rda)).join('')}
              ${celTrim(T.totalRda, 'tot')}
            </tr>
            <tr class="soma">
              <th>Total/Trim</th>
              ${T.trims.map(t => celTrim(t.total)).join('')}
              ${celTrim(T.totalGeral, 'tot')}
            </tr>
          </tbody>
        </table>
      </div>
      <div class="db-trim-geral">
        <span>Total Geral do Exercício</span>
        <b>${brl(T.totalGeral)}</b>
      </div>
    </div>`;

  /* ── Montagem ───────────────────────────────────────────── */
  $('app-content').innerHTML = `
  <div class="db-container">

    <!-- 21/09/2026 (reunião): atalho direto do Painel para a Despesa Corporativa -->
    <button class="pnl pnl-mini pnl-atalho" onclick="switchView('despesas')">
      <span class="pnl-conteudo"><span class="pnl-ico">🧾</span><span class="pnl-tit">Petermann – Despesas</span><span class="pnl-sub">Lançar nota ou repasse agora.</span></span>
    </button>

    ${cabecalhoHtml}

    <div class="db-header">
      <div class="mes-nav">
        <button class="btn-mes-nav" onclick="mudarMes(-1)" aria-label="Período anterior">‹</button>
        <span class="mes-label">${esc(rotulo)}</span>
        <button class="btn-mes-nav" onclick="mudarMes(1)" aria-label="Próximo período">›</button>
      </div>
      <div class="seg">
        <button class="seg-btn ${modo === 'mensal' ? 'active' : ''}"
                onclick="alternarPeriodoDashboard('mensal')">Mês</button>
        <button class="seg-btn ${modo === 'anual' ? 'active' : ''}"
                onclick="alternarPeriodoDashboard('anual')">Ano</button>
      </div>
    </div>

    <div class="db-hero">
      <div class="db-hero-top">
        <div>
          <div class="db-hero-lbl">Saldo Acumulado · ${esc(rotulo)}</div>
          <div class="db-hero-val ${totalAcumulado < 0 ? 'neg' : ''}">${brl(totalAcumulado)}</div>
        </div>
      </div>
      <div class="db-hero-meta">
        <span>Recebido <b>${brl(A.recebido)}</b></span>
        <span>Gasto <b>${brl(A.gasto)}</b></span>
        <span>${rdmAcc.pendenciaAnterior !== 0 || rdaAcc.pendenciaAnterior !== 0
          ? `<span>Pend. anterior <b style="color:${(rdmAcc.pendenciaAnterior + rdaAcc.pendenciaAnterior) < 0 ? 'var(--danger)' : 'inherit'}">${brl(rdmAcc.pendenciaAnterior + rdaAcc.pendenciaAnterior)}</b></span>`
          : ''}</span>
      </div>
      <div class="db-consumo">
        <div class="db-consumo-fill ${consumoPct > 100 ? 'over' : ''}"
             style="width:${Math.min(100, Math.round(consumoPct))}%"></div>
      </div>
      <div class="db-consumo-txt">${
        A.recebido > 0
          ? `${Math.round(consumoPct)}% do repasse utilizado`
          : (A.gasto > 0 ? 'Gasto sem repasse lançado no período' : 'Nada lançado no período')
      }</div>
    </div>

    <div class="db-grid">
      <button class="db-kpi rdm" onclick="switchView('saldo')">
        <div class="db-kpi-top">
          <span class="db-kpi-title">Saldo de RDM Recebido</span>
          ${rdmAcc.pendenciaAnterior < 0
            ? `<span class="dl dl-ruim">Pend. ${brl(rdmAcc.pendenciaAnterior)}</span>`
            : (rdmAcc.pendenciaAnterior > 0
              ? `<span class="dl dl-bom">Créd. ${brl(rdmAcc.pendenciaAnterior)}</span>` : '')}
        </div>
        <span class="db-kpi-val ${rdmAcc.saldoLiquido < 0 ? 'neg' : ''}">${brl(rdmAcc.saldoLiquido)}</span>
        <span class="db-kpi-sub">Gasto ${brl(rdmAcc.gastoMes)} · Recebido ${brl(rdmAcc.repasseMes)}</span>
      </button>
      <button class="db-kpi rda" onclick="switchView('saldo')">
        <div class="db-kpi-top">
          <span class="db-kpi-title">Saldo de RDA Recebido</span>
          ${rdaAcc.pendenciaAnterior < 0
            ? `<span class="dl dl-ruim">Pend. ${brl(rdaAcc.pendenciaAnterior)}</span>`
            : (rdaAcc.pendenciaAnterior > 0
              ? `<span class="dl dl-bom">Créd. ${brl(rdaAcc.pendenciaAnterior)}</span>` : '')}
        </div>
        <span class="db-kpi-val ${rdaAcc.saldoLiquido < 0 ? 'neg' : ''}">${brl(rdaAcc.saldoLiquido)}</span>
        <span class="db-kpi-sub">Gasto ${brl(rdaAcc.gastoMes)} · Recebido ${brl(rdaAcc.repasseMes)}</span>
      </button>
      <button class="db-kpi media" onclick="irParaNotas(null,${escopo})">
        <div class="db-kpi-top">
          <span class="db-kpi-title">Média/Nota</span>
          ${chipDelta(mediaNota, mediaAnt, false)}
        </div>
        <span class="db-kpi-val">${brl(mediaNota)}</span>
        <span class="db-kpi-sub">${totalNotas} nota${totalNotas === 1 ? '' : 's'} no período</span>
      </button>
      <button class="db-kpi maior" onclick="${maior ? `editarNota('${maior.id}')` : 'abrirCaptura()'}">
        <div class="db-kpi-top"><span class="db-kpi-title">Maior nota</span></div>
        <span class="db-kpi-val">${maior ? brl(maior.valor) : brl(0)}</span>
        <span class="db-kpi-sub">${maior ? esc(maior.razao_social || 'Sem empresa') : 'Nenhuma nota'}</span>
      </button>
    </div>

    <div class="db-card">
      <div class="db-card-title">
        <span>Evolução ${modo === 'mensal' ? '· 6 meses' : '· 5 anos'}</span>
        <div class="db-legend">
          <button class="lg-btn rdm ${dashSerie.RDM ? 'on' : 'off'}"
                  onclick="alternarSerieDash('RDM')"><span class="lg-dot"></span>RDM</button>
          <button class="lg-btn rda ${dashSerie.RDA ? 'on' : 'off'}"
                  onclick="alternarSerieDash('RDA')"><span class="lg-dot"></span>RDA</button>
          <button class="lg-btn trend ${dashTendencia ? 'on' : 'off'}"
                  onclick="alternarTendenciaDash()"><span class="lg-dot"></span>Total</button>
        </div>
      </div>
      ${gerarGraficoEvolucao(_dashEvo)}
      ${drillHtml}
    </div>

    ${trimestralHtml}

    <div class="db-card">
      <div class="db-card-title">
        <span>Composição dos gastos</span>
        ${dashFatiaSel ? `<a class="link" onclick="selecionarFatiaDash('${dashFatiaSel}')">limpar</a>` : ''}
      </div>
      <div class="db-donut-wrap">
        <div class="db-donut">${gerarDonut(cats, A.gasto)}</div>
        <div class="db-donut-legend">
          ${cats.length ? cats.map(c => `
            <button class="db-dl-item ${dashFatiaSel && dashFatiaSel !== c.key ? 'dim' : ''}"
                    onclick="selecionarFatiaDash('${c.key}')">
              <span class="db-dl-dot" style="background:${c.cor}"></span>
              <span class="db-dl-name">${esc(c.name)}</span>
              <span class="db-dl-val">${brl(c.val)}</span>
            </button>`).join('')
          : '<p class="muted-p">Nenhuma despesa no período.</p>'}
        </div>
      </div>
    </div>

    <div class="db-card">
      <div class="db-card-title">
        <span>Onde mais se gasta</span>
        <span style="font-size:12.5px;color:var(--text2);font-weight:600">top ${forn.length}</span>
      </div>
      <div class="db-rank">
        ${forn.length ? forn.map((f, i) => `
          <div class="db-rank-item">
            <div class="db-rank-meta">
              <span class="db-rank-pos">${i+1}º</span>
              <span class="db-rank-name">${esc(f.nome)}</span>
              <span class="db-rank-val">${brl(f.val)}</span>
            </div>
            <div class="db-rank-track">
              <div class="db-rank-fill" style="width:${Math.max(4, Math.round(f.val/maxForn*100))}%"></div>
            </div>
            <div style="font-size:12.5px;color:var(--text2)">${f.qtd} nota${f.qtd === 1 ? '' : 's'}
              · ${brl(f.val/f.qtd)} em média</div>
          </div>`).join('')
        : '<p class="muted-p">Sem fornecedores identificados no período.</p>'}
      </div>
    </div>

    <div class="db-card">
      <div class="db-card-title">
        <span>Pendências</span>
        <a class="link" onclick="irParaNotas(null,${escopo})">Ver notas →</a>
      </div>
      <div class="db-pend">${pendingHint}${pendHtml}</div>
    </div>

    ${ritmoHtml}

    <div class="db-card">
      <div class="db-card-title">
        <span>Últimas notas</span>
        <a class="link" onclick="irParaNotas(null,${escopo})">Ver todas →</a>
      </div>
      <div style="display:flex;flex-direction:column;gap:2px">${recHtml}</div>
    </div>

  </div>`;

  _carregarMiniaturas(recentes, 'dbthumb-').catch(() => {});
}

/* ── VIEW: NOTAS ─────────────────────────────────────────── */
/* Filtro vindo do dashboard (toque numa pendência) */
let filtroNotasFlag = null;   // 'sem-valor' | 'sem-anexo' | 'pendente' | null
let filtroNotasAno  = false;  // true = ano inteiro em vez de um mês

const _ROTULO_FLAG = {
  'sem-valor'    : '⚠️ Só notas sem valor',
  'sem-anexo'    : '📎 Só notas sem anexo',
  'pendente'     : '⏳ Só notas aguardando envio',
  'data-suspeita': '📅 Notas com data fora do período',
  'duplicata'    : '🔁 Possíveis registros duplicados',
};

/* Este filtro ignora mês/ano: a nota está escondida por estar fora deles. */
const _FLAG_SEM_PERIODO = 'data-suspeita';

function irParaNotas(flag = null, anoInteiro = false) {
  filtroNotasFlag = flag;
  filtroNotasAno  = !!anoInteiro;
  switchView('notas');
}

function limparFiltroNotas() {
  filtroNotasFlag = null;
  filtroNotasAno  = false;
  renderNotas();
}

function _passaFiltroNota(n) {
  if (filtroNotasFlag === 'sem-valor')     return _n(n.valor) <= 0;
  if (filtroNotasFlag === 'sem-anexo')     return !n.foto_path && !n.foto_local;
  if (filtroNotasFlag === 'pendente')      return n.sync_status === 'failed' || n.synced === false;
  if (filtroNotasFlag === 'data-suspeita') return _dataImplausivel(n);
  if (filtroNotasFlag === 'duplicata')     return _dupMapa.has(n.id);
  return true;
}

function _statusNota(n) {
  if (n?.sync_status === 'failed') return '<span class="sync-pill failed" title="Falha na sincronização">⚠️ falhou</span>';
  if (n?.sync_status === 'pending' || n?.synced === false) return '<span class="sync-pill pending" title="Pendente de sincronização">⏳ pendente</span>';
  return '<span class="sync-pill synced" title="Sincronizado">✓ ok</span>';
}

/* Nota igual ATIVA do mesmo dono (para avisar antes de restaurar) */
function _dupNaLixeira(n) {
  for (const v of notas) {
    if (v.id === n.id || v.deleted || (n.user_id && v.user_id && v.user_id !== n.user_id)) continue;
    const m = _motivoDuplicata(n, v);
    if (m) return { nota: v, motivo: m };
  }
  return null;
}

async function restaurarNota(id) {
  const arq = (await DB.getDeletedNotasUser(user.id).catch(() => [])).find(x => x.id === id);
  const d = arq ? _dupNaLixeira(arq) : null;
  if (d && !confirm(`Já existe uma nota igual ativa:\n${_resumoNota(d.nota)}\n\nRestaurar mesmo assim? Vai ficar duplicada.`)) return;
  const n = await DB.restoreNota(id);
  if (!n) {
    toast('Lançamento não encontrado na lixeira', 'err');
    return;
  }
  await carregarDadosLocais();
  if (viewAtual === 'lixeira') renderNotasApagadas();
  else renderNotas();
  syncToDrive().catch(() => {});
  if (sb && navigator.onLine) DB.sync(sb, user.id).catch(() => {});
  toast('Lançamento restaurado');
}

/* Definitivo é definitivo: a linha sai do banco e o anexo sai do Storage,
   sem lixeira para voltar. Por isso só o DONO da nota e o admin — gestor
   corrige nota de colaborador, mas apagar sem volta é outro nível — e é a
   mesma regra das policies notas_del / fotos_del no Supabase. */
function _podeApagarDefinitivo(n) {
  if (!user || !n) return false;
  return (n.user_id && n.user_id === user.id) || user.role === 'admin';
}

async function apagarDefinitivo(id) {
  const n = (await DB.getDeletedNotasUser(user.id).catch(() => []))
    .find(x => x.id === id) || _notaPorId(id);
  if (!n) { toast('Lançamento não encontrado', 'err'); return; }
  if (!_podeApagarDefinitivo(n)) { toast('Só o dono da nota ou o admin pode apagar em definitivo', 'err'); return; }

  /* Sem internet não dá: apagaria só aqui, a linha continuaria no Supabase e
     a sincronização seguinte traria a nota de volta. */
  if (!sb || !navigator.onLine) {
    toast('Precisa de internet para apagar em definitivo', 'err');
    return;
  }

  const resumo = [n.tipo, n.razao_social || (n.cnpj ? BrasilAPI.formatar(n.cnpj) : null),
                  n.data ? fmtData(n.data) : null, brl(n.valor)].filter(Boolean).join(' · ');
  const resposta = window.prompt(
    'APAGAR EM DEFINITIVO\n\n' + resumo +
    '\n\nA nota e o anexo saem do sistema para sempre. Não vão para a lixeira e não há como restaurar.'
    + '\n\nDigite EXCLUIR para confirmar.', '');
  if (resposta === null) return;
  if (String(resposta).trim().toUpperCase() !== 'EXCLUIR') { toast('Exclusão cancelada', 'err'); return; }

  setLoading(true);
  try {
    // 1) linha + anexo no servidor (a API apaga o arquivo do disco junto) —
    //    se falhar, para tudo: apagar só aqui traria de volta
    await sb.notas.delete(id);
    // 2) só então some daqui
    await DB.purgeNotaLocal(id);

    await carregarDadosLocais();
    if (viewAtual === 'lixeira') renderNotasApagadas(); else renderNotas();
    toast('Lançamento apagado em definitivo');
  } catch (e) {
    if (e?.status === 404) {
      /* já não existe no servidor (apagada por outro aparelho): o que sobrou
         é a cópia local — some daqui e pronto */
      await DB.purgeNotaLocal(id);
      await carregarDadosLocais();
      if (viewAtual === 'lixeira') renderNotasApagadas(); else renderNotas();
      toast('Já não existia no servidor — removida deste aparelho');
      return;
    }
    toast('Não foi possível apagar: ' + (e.message || e), 'err');
  } finally { setLoading(false); }
}

/* Cópia órfã da lixeira (não existe no servidor): só limpa o aparelho. */
async function limparDaLixeira(id) {
  if (!confirm('Remover este item da lixeira deste aparelho? (ele já não existe no servidor)')) return;
  await DB.limparDaLixeira(id, true);
  await carregarDadosLocais();
  renderNotasApagadas();
  toast('Removido da lixeira');
}

async function renderNotasApagadas() {
  const el = $('app-content');
  if (!user) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">🗑️</div><p>Faça login para ver os lançamentos apagados.</p></div>';
    return;
  }
  let items = await DB.getDeletedNotasUser(user.id).catch(() => []);

  /* 20/09/2026: a lixeira guardava cópias que já não existem no servidor
     (apagadas em definitivo por outro aparelho, ou da época do Supabase) —
     "Apagar definitivo" falhava com 404 e "Restaurar" criava uma nota
     repetida. Com internet, pergunta ao servidor o que ainda existe:
       • não existe lá → "só neste aparelho": só dá para limpar daqui;
       • existe e NÃO está apagada → foi restaurada em outro lugar: sai da
         lixeira sozinha (o sync já trouxe a viva). */
  const noServidor = new Map();
  if (sb && navigator.onLine && items.length) {
    try {
      (await sb.notas.existem(items.map(n => n.id))).forEach(x => noServidor.set(x.id, x.deleted));
      const limpar = items.filter(n => noServidor.has(n.id) && noServidor.get(n.id) === false);
      for (const n of limpar) await DB.limparDaLixeira(n.id, false).catch(() => {});
      if (limpar.length) items = items.filter(n => !limpar.includes(n));
      items.forEach(n => { n._orfa = !noServidor.has(n.id); });
    } catch (_) { /* offline ou erro: mostra como sempre */ }
  }
  const ns = (items || []).sort((a, b) => String(b.deleted_at || '').localeCompare(String(a.deleted_at || '')));
  const fmtHora = d => {
    try { return new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (_) { return '—'; }
  };

  let html = `
  <div class="page-hd">
    <div class="mes-nav">
      <button class="btn-mes-nav" onclick="switchView('notas')">‹</button>
      <span class="mes-label">Lançamentos apagados</span>
      <button class="btn btn-sm btn-outline" onclick="switchView('notas')">Voltar</button>
    </div>
  </div>`;

  if (!ns.length) {
    html += `<div class="empty-state">
      <div class="empty-icon">🗑️</div>
      <p>Nenhum lançamento apagado por aqui.</p>
      <button class="btn btn-primary" onclick="switchView('notas')">Voltar para as notas</button>
    </div>`;
  } else {
    html += `<div class="notas-list" id="notas-list">`;
    ns.forEach(n => {
      html += `
      <div class="nota-card" data-tipo="${n.tipo}">
        <div class="nota-head">
          <span class="tipo-badge tipo-${n.tipo}">${n.tipo}</span>
          ${n.subtipo ? `<span class="subtipo-tag">${n.subtipo}</span>` : ''}
          <span class="nota-data">${fmtHora(n.deleted_at || n.updated_at || n.created_at)}</span>
        </div>
        <div class="nota-body">
          <div class="nota-empresa">${esc(n.razao_social || (n.cnpj ? BrasilAPI.formatar(n.cnpj) : 'Sem empresa'))}</div>
          ${n.observacao ? `<div class="nota-obs">${esc(n.observacao)}</div>` : ''}
        </div>
        ${(() => {
          const d = _dupNaLixeira(n);
          const avisos = [];
          if (d) avisos.push(`⚠️ <b>Já existe uma nota igual ativa</b> (${esc(_resumoNota(d.nota))}). Restaurar vai duplicar.`);
          if (n._orfa) avisos.push('📱 <b>Só neste aparelho</b> — não existe mais no servidor. Pode limpar daqui.');
          return avisos.length ? `<div class="nota-obs" style="color:#b45309;background:#fff7e6;border-radius:8px;padding:6px 8px;margin:6px 0 2px">${avisos.join('<br>')}</div>` : '';
        })()}
        <div class="nota-foot">
          <span class="nota-valor">${Number(n.valor) > 0 ? brl(n.valor) : '<span style="color:var(--danger)">⚠️ sem valor</span>'}</span>
          <div class="nota-actions">
            ${n._orfa
              ? `<button class="btn btn-sm btn-danger-outline" onclick="limparDaLixeira('${n.id}')">Limpar daqui</button>`
              : `<button class="btn btn-sm ${_dupNaLixeira(n) ? 'btn-outline' : 'btn-primary'}" onclick="restaurarNota('${n.id}')">Restaurar</button>
            ${_podeApagarDefinitivo(n) ? `<button class="btn btn-sm btn-danger-outline"
              onclick="apagarDefinitivo('${n.id}')" title="Apagar em definitivo">Apagar definitivo</button>` : ''}`}
          </div>
        </div>
      </div>`;
    });
    html += `</div>`;
  }

  el.innerHTML = html;
}

function renderNotas() {
  _recalcularDuplicatas(notas);
  const el = $('app-content');
  const semPeriodo = filtroNotasFlag === _FLAG_SEM_PERIODO;
  const noPeriodo  = n => semPeriodo || (n.ano === filAno && (filtroNotasAno || n.mes === filMes));
  const ns = notas
    .filter(n => !n.deleted && noPeriodo(n) && _passaFiltroNota(n))
    .sort((a,b) => _dataDe(b).localeCompare(_dataDe(a)));

  const periodo = semPeriodo ? 'Todos os períodos'
                : filtroNotasAno ? String(filAno) : `${MESES[filMes-1]} ${filAno}`;

  let html = `
  <div class="page-hd">
    <div class="mes-nav">
      <button class="btn-mes-nav" onclick="mudarMes(-1)">‹</button>
      <span class="mes-label">${periodo}</span>
      <button class="btn-mes-nav" onclick="mudarMes(1)">›</button>
    </div>
    <div class="fil-tipo">
      <button class="chip active" data-fil="all"  onclick="filtrarTipo(this)">Todas</button>
      <button class="chip"        data-fil="RDA"  onclick="filtrarTipo(this)">RDA</button>
      <button class="chip"        data-fil="RDM"  onclick="filtrarTipo(this)">RDM</button>
      <button class="chip" onclick="switchView('lixeira')">🗑 Apagados</button>
    </div>
  </div>`;

  if (filtroNotasFlag || filtroNotasAno) {
    html += `<div class="fil-ativo">
      <span>${_ROTULO_FLAG[filtroNotasFlag] || '📅 Ano inteiro'}${
        filtroNotasFlag && filtroNotasAno ? ' · ano inteiro' : ''} — ${ns.length} nota${
        ns.length === 1 ? '' : 's'}</span>
      <button onclick="limparFiltroNotas()" title="Limpar filtro">✕</button>
    </div>`;
  }

  if (!ns.length) {
    html += `<div class="empty-state">
      <div class="empty-icon">📋</div>
      <p>${filtroNotasFlag ? 'Nenhuma nota com esse filtro em' : 'Nenhuma nota em'} ${periodo}</p>
      ${!filtroNotasFlag && !filtroNotasAno ? '<p style="font-size:14px;color:var(--text2);margin-top:6px">Se ficou offline, as notas novas ficam salvas no aparelho e sincronizam depois.</p>' : ''}
      <button class="btn btn-primary" onclick="${filtroNotasFlag || filtroNotasAno
        ? 'limparFiltroNotas()' : 'abrirCaptura()'}">${filtroNotasFlag || filtroNotasAno
        ? 'Limpar filtro' : '+ Lançar'}</button>
    </div>`;
  } else {
    html += `<div class="notas-list" id="notas-list">`;
    ns.forEach(n => { html += cardNotaHTML(n); });
    html += `</div>`;
  }
  el.innerHTML = html;
  _carregarMiniaturas(ns).catch(() => {});
}

/* Cartão de uma nota na lista — o mesmo em "Notas" e no detalhe do
   colaborador da aba Equipe (gestor.js chama daqui). Os botões procuram a
   nota pelo id na lista global `notas`; para gestor/admin ela já inclui as
   notas da equipe, e o detalhe garante isso antes de desenhar. */
/* Falta algo que a planilha da empresa pede? Ela tem, em cada categoria,
   DATA · CNPJ DA NOTA · Nº DA NOTA · R$. Sem CNPJ o servidor escreve a razão
   social no lugar, e sem número a célula fica vazia (24/09/2026). */
function _notaIncompletaParaPlanilha(n) {
  if (!n || n.deleted) return false;
  const digitos = String(n.cnpj || '').replace(new RegExp("\\D", 'g'), '');
  const temCnpj = digitos.length === 14;
  const temNumero = String(n.numero || '').trim() !== '';
  return !temCnpj || !temNumero;
}

function cardNotaHTML(n, pref = 'thumb-', opts = {}) {
  _notasDesenhadas.set(n.id, n);
  const pendSync = _statusNota(n);
  return `
      <div class="nota-card ${n.foto_path||n.foto_local ? 'com-thumb' : ''}" data-tipo="${n.tipo}">
        ${n.foto_path||n.foto_local ? `
        <button class="nota-thumb" id="${pref}${n.id}" onclick="verFoto('${n.id}')"
                title="Ver anexo da nota"><span class="nota-thumb-ph">📎</span></button>` : ''}
        <div class="nota-head">
          <span class="tipo-badge tipo-${n.tipo}">${n.tipo}</span>
          ${docBadgeHTML(n)}
          ${_dupMapa.has(n.id) ? `<span class="doc-tag dup" title="Possível duplicata: ${_MOTIVO_DUP[_dupMapa.get(n.id).motivo]} — ${esc(_resumoNota(_dupMapa.get(n.id).nota))}">🔁 duplicada?</span>` : ''}
          ${n.subtipo ? `<span class="subtipo-tag">${n.subtipo}</span>` : ''}
          ${!opts.semDono && _ehGestorOuAdmin() && _ehNotaDeOutroUsuario(n)
            ? `<span class="subtipo-tag" title="Nota de outro colaborador">👤 ${esc(_rotuloProprietario(n))}</span>`
            : ''}
          <span class="nota-data">${fmtData(n.data)}</span>
          ${pendSync}
        </div>
        <div class="nota-body">
          <div class="nota-empresa">${esc(n.razao_social || (n.cnpj ? BrasilAPI.formatar(n.cnpj) : 'Sem empresa'))}</div>
          ${n.cnpj&&!n.razao_social ? `<div class="nota-cnpj">${BrasilAPI.formatar(n.cnpj)}</div>` : ''}
          ${_numeroSerieHTML(n)}
          ${n.observacao ? `<div class="nota-obs">${esc(n.observacao)}</div>` : ''}
        </div>
        <div class="nota-foot">
          <span class="nota-valor">${Number(n.valor) > 0 ? brl(n.valor) : '<span style="color:var(--danger)">⚠️ sem valor</span>'}</span>
          <div class="nota-actions">
            ${n.chave_nfce || /^https?:/i.test(n.qr_url || '') ? `<button class="btn-icon-sm" onclick="consultarNota('${n.id}')" title="Consultar a nota no portal">🔗</button>` : ''}
            ${_corrigeNotaDeOutro() && _ehNotaDeOutroUsuario(n)
              ? `<button class="btn-icon-sm" onclick="corrigirGrupoNota('${n.id}')" title="Corrigir a categoria">🔀</button>` : ''}
            <button class="btn-icon-sm" onclick="editarNota('${n.id}')" title="Editar">✏️</button>
            <button class="btn-icon-sm danger" onclick="excluirNota('${n.id}')" title="Excluir">🗑</button>
          </div>
        </div>
      </div>`;
}

/* ── Miniaturas do anexo na lista de notas ───────────────── */
/* URLs de objeto criadas aqui; revogadas antes de cada novo render */
let _thumbURLs = [];
function _limparMiniaturas() {
  _thumbURLs.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
  _thumbURLs = [];
}

/* Preenche as miniaturas depois que a lista já está na tela, na mesma ordem
   de fallback do verFoto: blob local (offline) → Drive → Supabase.
   As notas que só existem no Supabase saem numa única chamada assinada. */
async function _carregarMiniaturas(ns, pref = 'thumb-') {
  _limparMiniaturas();
  const comAnexo = (ns || []).filter(n => n.foto_path || n.foto_local);
  if (!comAnexo.length) return;

  const pendentes = [];
  for (const n of comAnexo) {
    const slot = $(pref + n.id);
    if (!slot) continue;

    const local = await DB.getFotoLocal(n.id).catch(() => null);
    if (local?.blob) {
      const ext = local.ext || _extDoArquivo(local.blob);
      /* só imagem vira object URL; PDF/XML mostram ícone e não precisam de blob */
      const url = _ehImagemExt(ext) ? URL.createObjectURL(local.blob) : 'icone';
      if (url !== 'icone') _thumbURLs.push(url);
      _pintarMiniatura(slot, url, ext);
      continue;
    }
    /* Supabase ANTES do Drive. A URL do Drive leva o token na query
       (?alt=media&access_token=…), formato que a API do Google não aceita
       mais para autorizar: o <img> falha calado, cai no onerror e a nota
       fica sem imagem — mesmo com o arquivo íntegro no Supabase. Como o
       Drive vinha primeiro, o caminho que funciona nunca era tentado. */
    if (n.foto_path) { pendentes.push(n); continue; }

    const driveUrl = GDrive.getFotoUrl?.(n.id);
    if (driveUrl) {
      _pintarMiniatura(slot, driveUrl, GDrive.getFotoExt?.(n.id) || _extDeUrl(n.foto_path || ''));
    }
  }
  if (!pendentes.length) return;

  /* offline ou sem sessão: fica o 📎, que ainda abre o visualizador */
  if (!sb || !navigator.onLine) return;

  const urls = await sb.fotos.urls(pendentes.map(n => n.foto_path)).catch(() => ({}));
  pendentes.forEach(n => {
    const url = urls[n.foto_path];
    if (url) _pintarMiniatura($(pref + n.id), url, _extDeUrl(n.foto_path));
  });
}

/* PDF/XML não têm o que renderizar: mostra o ícone do tipo em vez da imagem */
function _pintarMiniatura(slot, url, ext) {
  if (!slot || !url) return;
  if (!_ehImagemExt(ext || 'jpg')) {
    slot.innerHTML = `<span class="nota-thumb-ph">${ext === 'pdf' ? '📄' : '🧾'}</span>`;
    return;
  }
  const img = new Image();
  img.alt = 'Anexo da nota';
  img.onload  = () => { slot.innerHTML = ''; slot.appendChild(img); };
  img.onerror = () => {};   // mantém o 📎 do placeholder
  img.src = url;
}

function mudarMes(delta) {
  // no modo anual (dashboard ou lista filtrada por ano) as setas andam de ano
  const porAno = (viewAtual === 'home'  && filtroPeriodo === 'anual')
              || (viewAtual === 'notas' && filtroNotasAno);
  if (porAno) {
    filAno += delta;
  } else {
    filMes += delta;
    if (filMes > 12) { filMes = 1;  filAno++; }
    if (filMes < 1)  { filMes = 12; filAno--; }
  }
  dashBarraSel = null;
  if (viewAtual==='home')  renderHome();
  if (viewAtual==='notas') renderNotas();
  if (viewAtual==='saldo') renderSaldo();
  _garantirAnoEmFoco();
}

function filtrarTipo(btn) {
  document.querySelectorAll('.fil-tipo .chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const f = btn.dataset.fil;
  document.querySelectorAll('.nota-card').forEach(c =>
    c.style.display = (f==='all' || c.dataset.tipo===f) ? '' : 'none'
  );
}

/* ── VIEW: SALDO ─────────────────────────────────────────── */
function renderSaldo() {
  const rdm = _saldoAcumuladoAte(filMes, filAno, 'RDM');
  const rda = _saldoAcumuladoAte(filMes, filAno, 'RDA');

  const ns = notas.filter(n => n.mes===filMes && n.ano===filAno);
  const rs = repasses.filter(r => !r.deleted && r.mes===filMes && r.ano===filAno);

  // breakdown RDM por subtipo — rotulo conforme a planilha padrao, chave inalterada
  const subs = [
    { key:'Abastecimento', lbl:'Abastecimento' },
    { key:'Hospedagem',    lbl:'Hospedagens' },
    { key:'Outros',        lbl:'Outros (Borracharia/Oficina/EPIs)' },
  ];
  const subHtml = subs.map(s => {
    const v = ns.filter(n=>n.tipo==='RDM'&&n.subtipo===s.key).reduce((a,n)=>a+Number(n.valor||0),0);
    return v>0 ? `<div class="sub-row"><span>${s.lbl}</span><span>${brl(v)}</span></div>` : '';
  }).join('');

  const repHtml = rs.length ? rs.map(r => {
    const pedido = _repasseEhPedido(r);
    const cvR = _ehCV();
    const label = pedido ? (cvR ? 'Reembolso registrado' : 'Pedido') : (cvR ? 'Reembolso recebido' : 'Recebido');
    const desc = esc(r.descricao || (pedido ? (cvR ? 'Reembolso a receber' : 'Pedido de repasse') : (cvR ? 'Reembolso recebido' : 'Repasse recebido')));
    const detail = pedido
      ? (r.atendido_em ? `Pago pelo gestor em ${fmtDataBR(String(r.atendido_em).slice(0, 10))} ✅` : (cvR ? 'Aguardando o gestor pagar' : 'Solicitação pendente para o gestor'))
      : (cvR ? 'Abate dos reembolsos registrados' : 'Registrado como repasse recebido');
    return `
      <div class="rep-item">
        <span class="tipo-badge tipo-${r.tipo}">${r.tipo}</span>
        <div style="flex:1;min-width:0">
          <div class="rep-desc">${desc}</div>
          <div style="font-size:13px;color:var(--text2);margin-top:2px">${label} · ${detail}</div>
        </div>
        <span class="rep-val">${brl(r.valor)}</span>
        <button class="btn-icon-sm danger" onclick="excluirRepasse('${r.id}')">🗑</button>
      </div>`;
  }).join('') : '<p class="muted-p">Nenhum repasse registrado.</p>';

  /* card independente do tipo */
  const cardTipo = (lbl, d) => {
    const quitado = d.pendenciaAnterior < 0 && d.saldoLiquido >= 0;
    const statusTag = quitado
      ? '<span class="dl dl-bom" style="margin-left:6px">Quitado</span>'
      : (d.saldoLiquido < 0
          ? '<span class="dl dl-ruim" style="margin-left:6px">Pendência</span>' : '');
    return `
    <div class="saldo-card ${d.saldoLiquido<0?'neg':''}">
      <div class="saldo-label">${lbl} ${statusTag}</div>
      <div class="saldo-val">${brl(d.saldoLiquido)}</div>
      <div class="saldo-detail">
        ${d.pendenciaAnterior !== 0
          ? `<span>Pend. anterior <b style="color:${d.pendenciaAnterior<0?'var(--danger)':'inherit'}">${brl(d.pendenciaAnterior)}</b></span>` : ''}
        <span>Gasto <b>${brl(d.gastoMes)}</b></span>
        <span>Recebido <b>${brl(d.repasseMes)}</b></span>
      </div>
      ${lbl==='RDM' && subHtml ? `<div class="sub-breakdown">${subHtml}</div>` : ''}
    </div>`;
  };

  /* 21/09/2026 (reunião): a aba "Saldo" virou "RDM/RDA e Planilhas", com a
     seção "Baixar relatório" em destaque. Na fase 3 (enquadramento CV) os
     botões passam a depender do regime do colaborador. */
  /* Fase 3 (21/09/2026) — regime CV: o cartão corporativo paga; o que circula
     é reembolso. Cards: gasto no cartão (mês), do bolso, reembolsos. Só a
     Planilha CV para baixar. RDM/RDA: os cards de sempre e só o Excel/CSV. */
  const cv = _ehCV();
  let cardsCV = '';
  if (cv) {
    const nsAno = notas.filter(n => !n.deleted && n.ano === filAno);
    const soma = arr => arr.reduce((a, x) => a + Number(x.valor || 0), 0);
    const semReemb = n => _notaDoCartao(n);
    const cartaoMes = soma(ns.filter(semReemb));
    const bolsoMes = soma(ns.filter(n => n.pagamento === 'reembolso'));
    const cartaoAno = soma(nsAno.filter(semReemb));
    const rsAno = repasses.filter(r => !r.deleted && r.ano === filAno);
    /* 24/09/2026: recarga do cartão não é reembolso — sem separar, o quadro
       de reembolsos dizia que a pessoa já tinha recebido o que na verdade
       foi para o cartão. */
    const soReemb = _repasseEhReembolso;
    const recAno = soma(rsAno.filter(r => _repasseEhRecebido(r) && soReemb(r)));
    /* O que a empresa deve é o que saiu do bolso menos o que ela já pagou —
       a mesma conta da planilha (CV REEMBOLSO menos "REEMBOLSO DE:"). */
    const bolsoAno = soma(nsAno.filter(n => n.pagamento === 'reembolso'));
    const saldoCartao = _saldoCartao();
    const aReceber = bolsoAno - recAno;
    const cat = f => soma(ns.filter(n => semReemb(n) && f(n)));
    cardsCV = `
  <div class="saldo-grid">
    <div class="saldo-card ${saldoCartao != null && saldoCartao < CARTAO_SALDO_MINIMO ? 'neg' : ''}">
      <div class="saldo-label">💳 Saldo do cartão ${saldoCartao != null && saldoCartao < CARTAO_SALDO_MINIMO ? '<span class="dl dl-ruim" style="margin-left:6px">Acabando</span>' : ''}</div>
      <div class="saldo-val">${brl(saldoCartao || 0)}</div>
      <div class="saldo-detail"><span>Recargas no ano <b>${brl(soma(rsAno.filter(r => r.destino === 'recarga' && _repasseEhRecebido(r))))}</b></span><span>Gasto no cartão <b>${brl(cartaoAno)}</b></span></div>
      ${saldoCartao != null && saldoCartao < CARTAO_SALDO_MINIMO ? `<div class="sub-breakdown"><div class="sub-row"><span>Peça a recarga pelo Início → 💳 Recarga do cartão</span><span></span></div></div>` : ''}
    </div>
    <div class="saldo-card">
      <div class="saldo-label">💳 Gasto no cartão · ${MESES[filMes-1]}</div>
      <div class="saldo-val">${brl(cartaoMes)}</div>
      <div class="saldo-detail"><span>No ano <b>${brl(cartaoAno)}</b></span><span>Do bolso no mês <b>${brl(bolsoMes)}</b></span></div>
      <div class="sub-breakdown">
        <div class="sub-row"><span>Alimentação (RDA)</span><span>${brl(cat(n => n.tipo === 'RDA'))}</span></div>
        <div class="sub-row"><span>Abastecimento</span><span>${brl(cat(n => n.subtipo === 'Abastecimento'))}</span></div>
        <div class="sub-row"><span>Hospedagens</span><span>${brl(cat(n => n.subtipo === 'Hospedagem'))}</span></div>
        <div class="sub-row"><span>Outros</span><span>${brl(cat(n => n.tipo === 'RDM' && n.subtipo === 'Outros'))}</span></div>
      </div>
    </div>
    <div class="saldo-card ${aReceber > 0 ? 'neg' : ''}">
      <div class="saldo-label">👛 Reembolsos · ${filAno} ${aReceber > 0 ? '<span class="dl dl-ruim" style="margin-left:6px">A receber</span>' : '<span class="dl dl-bom" style="margin-left:6px">Em dia</span>'}</div>
      <div class="saldo-val">${brl(aReceber)}</div>
      <div class="saldo-detail"><span>Notas do bolso <b>${brl(bolsoAno)}</b></span><span>Já reembolsado <b>${brl(recAno)}</b></span></div>
      <div class="sub-breakdown"><div class="sub-row"><span>Pedidos registrados no ano</span><span>${brl(soma(rsAno.filter(r => _repasseEhPedido(r) && soReemb(r))))}</span></div></div>
    </div>
  </div>`;
  }
  $('app-content').innerHTML = `
  <div class="ini-ola" style="padding:4px 2px 6px"><h2>${cv ? '💳 C.V. e Planilha' : '📊 RDM/RDA e Planilhas'}</h2><span>${cv ? 'cartão corporativo e reembolsos' : 'gasto, repasse e saldo por aba'}</span></div>
  <div class="page-hd">
    <div class="mes-nav">
      <button class="btn-mes-nav" onclick="mudarMes(-1)">‹</button>
      <span class="mes-label">${MESES[filMes-1]} ${filAno}</span>
      <button class="btn-mes-nav" onclick="mudarMes(1)">›</button>
    </div>
  </div>
  <div class="db-card" style="gap:8px;padding:12px 14px">
    <div class="dash-card-title" style="margin:0">⬇️ Baixar relatório</div>
    ${cv ? `<div class="export-btns">
      <span style="font-size:15px;font-weight:700;color:var(--text2);align-self:center">Planilha de C.V. (modelo da empresa) · ${filAno}:</span>
      <button class="btn btn-sm btn-primary" onclick="baixarRelatorioCv('xlsx')">📗 Excel</button>
      <button class="btn btn-sm btn-outline" onclick="baixarRelatorioCv('pdf')">📕 PDF</button>
      <button class="btn btn-sm btn-outline" onclick="exportCSV()">CSV ${MESES[filMes-1]}</button>
    </div>` : `<div class="export-btns">
      <span style="font-size:15px;font-weight:700;color:var(--text2);align-self:center">Planilha de RDM e RDA (modelo da empresa) · ${filAno}:</span>
      <button class="btn btn-sm btn-primary" onclick="baixarRelatorioRdmRda()">📗 Excel</button>
      <button class="btn btn-sm btn-outline" onclick="baixarRelatorioRdmRda(null, null, 'pdf')">📕 PDF</button>
    </div>
    <div class="export-btns">
      <span style="font-size:15px;font-weight:700;color:var(--text2);align-self:center">Resumo do app:</span>
      <button class="btn btn-sm btn-outline" onclick="exportExcel()">Excel anual</button>
      <button class="btn btn-sm btn-outline" onclick="exportCSV()">CSV ${MESES[filMes-1]}</button>
    </div>`}
  </div>

  ${cv ? cardsCV : `<div class="saldo-grid">
    ${cardTipo('RDM', rdm)}
    ${cardTipo('RDA', rda)}
  </div>`}

  <div class="section-hd">
    <span>${cv ? 'Reembolsos' : 'Repasses'}</span>
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
      <button class="btn btn-sm btn-outline" onclick="abrirFormRepasse('received')">${cv ? '+ Reembolso recebido' : '+ Registrar recebido'}</button>
      <button class="btn btn-sm btn-primary" onclick="abrirFormRepasse('requested')">${cv ? 'Registrar reembolso' : 'Solicitar repasse'}</button>
    </div>
  </div>
  <div class="rep-list">${repHtml}</div>`;
}

/* ── VIEW: EQUIPE ────────────────────────────────────────── */
async function renderEquipe() {
  if (!sb||DEMO_MODE) {
    $('app-content').innerHTML = '<div class="empty-state">Equipe disponível com o servidor configurado.</div>';
    return;
  }
  const el = $('app-content');
  await Gestor.renderDashboard(el, sb, user, () => renderEquipe(), { mes: filMes, ano: filAno });
}

/* O detalhe do colaborador (gestor.js) desenha notas que vieram direto do
   servidor; os botões do cartão procuram pelo id em `notas`. */
function garantirNotasNaLista(lista) {
  const ids = new Set([...notas.map(n => n.id), ...notasEquipe.map(n => n.id)]);
  (lista || []).forEach(n => {
    if (ids.has(n.id)) return;
    notasEquipe.push({ ...n, user_nome: equipePorId[n.user_id]?.nome || null });
  });
}

function mudarMesEquipe(delta) {
  filMes += delta;
  if (filMes > 12) { filMes = 1;  filAno++; }
  if (filMes < 1)  { filMes = 12; filAno--; }
  renderEquipe();
  _garantirAnoEmFoco();
}

/* Janela por ano (20/09/2026): o aparelho só guarda os anos que já pediu.
   Ao navegar para um ano ainda não baixado, busca no servidor e redesenha. */
let _garantindoAno = null;
async function _garantirAnoEmFoco() {
  if (!sb || !user || DEMO_MODE || !navigator.onLine) return;
  const ano = filAno;
  if (_garantindoAno === ano) return;
  _garantindoAno = ano;
  try {
    const n = await DB.garantirAno(sb, user.id, ano);
    if (n && filAno === ano) {
      await carregarDadosLocais();
      toast(`${n} lançamento${n > 1 ? 's' : ''} de ${ano} baixado${n > 1 ? 's' : ''}`);
      switchView(viewAtual);
    }
  } catch (_) {}
  finally { if (_garantindoAno === ano) _garantindoAno = null; }
}

function exportExcelEquipe(ids = []) {   // ids = marcados no seletor da Equipe (21/09/2026)
  Gestor.exportEquipeExcel(sb, user, filMes, filAno, ids);
}

/* Planilha do Google da equipe (consolidada, mês atual) */
async function exportSheetsEquipe() {
  if (!(await _garantirDrive())) return;
  const aba = window.open('', '_blank');   // abre no clique p/ não cair em bloqueio de popup
  setLoading(true);
  try {
    const { collabs, notas, repasses, mes, ano } = await Gestor.renderForExcel(sb, user, filMes, filAno);
    const url = await GSheets.exportarEquipe(notas, repasses, collabs, mes, ano, user.nome);
    if (aba) aba.location = url; else window.open(url, '_blank');
    toast('Planilha da equipe atualizada! 📊');
  } catch (e) {
    if (aba) aba.close();
    toast('Sheets equipe: ' + e.message, 'err');
  } finally { setLoading(false); }
}

/* Diagnóstico de anexos — percorre a MESMA cascata que a miniatura e o
   verFoto usam (blob local → Drive → Supabase) e reporta o erro exato de
   cada etapa. Existe porque "a foto não aparece" tem pelo menos quatro
   causas com conserto oposto: arquivo nunca subiu, referência perdida,
   permissão de leitura negada, ou falha só na exibição. Sem isso, achar
   qual delas é depende de rodar SQL no Supabase. */
/* Uma URL só serve se o <img> conseguir carregá-la. Erro de autorização
   não vira exceção: vem como onerror mudo. */
const _urlCarrega = url => new Promise(res => {
  const i = new Image();
  const t = setTimeout(() => { i.onload = i.onerror = null; res(false); }, 6000);
  i.onload  = () => { clearTimeout(t); res(true);  };
  i.onerror = () => { clearTimeout(t); res(false); };
  i.src = url;
});

async function diagnosticoFotos() {
  if (!sb || DEMO_MODE) { alert('Disponível apenas com o servidor configurado.'); return; }
  const ov = $('ocr-overlay');
  ov.style.display = 'flex';
  $('ocr-progress').textContent = 'Verificando anexos…';
  try {
    const minhas   = notas.filter(n => !n.deleted && n.user_id === user.id);
    const comPath  = minhas.filter(n => n.foto_path);
    const semPath  = minhas.filter(n => !n.foto_path);

    // amostra: até 5 das mais recentes que deveriam ter arquivo no servidor
    const amostra = [...comPath].sort((a,b) =>
      String(b.created_at||'').localeCompare(String(a.created_at||''))).slice(0, 5);

    const linhas = [];
    for (const n of amostra) {
      const passos = [];
      const local = await DB.getFotoLocal(n.id).catch(() => null);
      passos.push(local?.blob ? 'local:ok' : 'local:não');

      /* Testa se a URL do Drive CARREGA, não só se foi montada. Marcar
         "drive:ok" só por existir foi o que escondeu a causa real: a URL
         existia, era escolhida na frente do Supabase, e não renderizava. */
      const driveUrl = GDrive.getFotoUrl?.(n.id);
      passos.push(!driveUrl ? 'drive:não'
                : (await _urlCarrega(driveUrl)) ? 'drive:carrega'
                : 'drive:NÃO CARREGA');
      try {
        const b = await sb.fotos.download(n.foto_path);
        passos.push(b ? `servidor:ok ${Math.round(b.size/1024)}kB` : 'servidor:vazio');
      } catch (e) { passos.push('servidor:ERRO ' + e.message); }
      linhas.push(`${fmtData(n.data)} ${n.tipo} ${brl(n.valor)}\n  ${n.foto_path}\n  ${passos.join(' | ')}`);
    }

    // blobs locais ainda não enviados
    let pendentesLocais = 0;
    for (const n of semPath) if ((await DB.getFotoLocal(n.id).catch(()=>null))?.blob) pendentesLocais++;

    ov.style.display = 'none';
    alert(
      `DIAGNÓSTICO DE ANEXOS\n\n` +
      `Minhas notas: ${minhas.length}\n` +
      `Com foto_path (deveriam ter arquivo no servidor): ${comPath.length}\n` +
      `Sem foto_path: ${semPath.length}\n` +
      `  destas, com arquivo ainda só no aparelho: ${pendentesLocais}\n\n` +
      (amostra.length
        ? `AMOSTRA (${amostra.length} mais recentes):\n\n` + linhas.join('\n\n')
        : 'Nenhuma nota com foto_path para testar.') +
      `\n\nComo ler:\n` +
      `• servidor:ok → arquivo existe e você consegue baixar\n` +
      `• servidor:ERRO → arquivo não está lá OU a leitura foi negada\n` +
      `• local:não e servidor:ERRO → é este caso que deixa a nota sem imagem`
    );
  } catch (e) {
    ov.style.display = 'none';
    alert('Diagnóstico falhou: ' + e.message);
  }
}

/* Gestor: envia ao Drive as fotos de TODOS os colaboradores (todos os
   meses), organizadas em Colaborador/Mês-Ano/Tipo. Baixa cada foto do
   Supabase Storage e reúsa o upload que já cria as subpastas. Se a foto
   já estiver no Drive, só atualiza (não duplica).
   Mostra um resumo FIXO (popup) com o diagnóstico de cada etapa. */
async function enviarFotosEquipeDrive() {
  if (!sb || DEMO_MODE) { alert('Disponível apenas com o servidor configurado.'); return; }
  if (!(await _garantirDrive())) return;
  if (!confirm('Enviar ao Drive as fotos de TODOS os colaboradores (todos os meses)?\nPode levar um tempo conforme a quantidade.')) return;

  const ov = $('ocr-overlay');
  const setProg = txt => { if (ov) ov.style.display = 'flex'; const p = $('ocr-progress'); if (p) p.textContent = txt; };
  setProg('Preparando envio…');

  try {
    // 1) mapa user_id -> {nome,email} p/ nomear a pasta do colaborador
    let collabs;
    try { collabs = await sb.colaboradores.list(); }
    catch (e) { throw new Error('colaboradores: ' + e.message, { cause: e }); }
    const mapa = {};
    (collabs || []).forEach(c => { mapa[c.id] = c; });

    // 2) TODAS as notas com foto (todos os meses / todos os colaboradores)
    let notas;
    try { notas = await sb.notas.list({ fields: 'id,user_id,tipo,subtipo,valor,mes,ano,data,foto_path,deleted' }); }
    catch (e) { throw new Error('notas: ' + e.message, { cause: e }); }
    const totalNotas = (notas || []).length;
    const comFoto = (notas || []).filter(n => n.foto_path && !n.deleted);

    if (!comFoto.length) {
      if (ov) ov.style.display = 'none';
      alert(`Nenhuma foto para enviar.\n\nNotas que este perfil consegue ler: ${totalNotas}\nCom foto no servidor: 0\n\n`
        + `Se você sabe que há fotos: ou elas ainda não foram sincronizadas ao servidor, `
        + `ou as permissões não deixam este perfil ver as notas dos outros colaboradores.`);
      return;
    }

    // 3) atualiza índice do Drive p/ NÃO duplicar o que já está lá
    setProg('Lendo o que já existe no Drive…');
    let idxAviso = '';
    try { await GDrive.atualizarIndice(); }
    catch (e) { idxAviso = `Aviso: não li o Drive antes (${e.message}).\n\n`; }

    // 4) baixa do servidor e sobe pro Drive, contando cada etapa
    let ok = 0, falhaBaixar = 0, falhaSubir = 0, erroBaixar = '', erroSubir = '', i = 0;
    /* Rede de campo cai no meio (Wi-Fi com portal, troca para 4G): numa
       rodada de 31 fotos, 20 downloads falharam em sequência e um upload
       recebeu uma página HTML no lugar do JSON. Cada etapa tenta duas
       vezes, com pausa, antes de contar como falha — e a lista de quem
       ficou de fora vai para o relatório, para rodar de novo depois. */
    const pausa = ms => new Promise(r => setTimeout(r, ms));
    const comRetentativa = async fn => {
      try { return await fn(); }
      catch (e1) { await pausa(1500); return fn(); }
    };
    const baixar = async path => {
      const b = await sb.fotos.download(path);
      if (!b) throw new Error('sem dados');
      return b;
    };
    const ficaram = [];

    for (const n of comFoto) {
      i++;
      setProg(`Enviando fotos ${i}/${comFoto.length}…`);
      let blob = null;
      try {
        blob = await comRetentativa(() => baixar(n.foto_path));
      } catch (e) {
        falhaBaixar++; ficaram.push(n);
        if (!erroBaixar) erroBaixar = `${e.message} (${n.foto_path})`;
        continue;
      }

      try {
        const ext = (String(n.foto_path).split('.').pop() || 'jpg').toLowerCase();
        const c   = mapa[n.user_id] || {};
        await comRetentativa(() => GDrive.uploadFotoComDados(blob, {
          /* subtipo e data PRECISAM vir: sem subtipo toda nota RDM cai na
             pasta OUTROS, mesmo sendo Abastecimento — e o appProperties
             gravado errado ainda contamina a migração, que confia nele. */
          id: n.id, tipo: n.tipo, subtipo: n.subtipo, mes: n.mes, ano: n.ano, data: n.data,
          user_id: n.user_id, user_email: c.email, user_nome: c.nome,
        }, ext));
        ok++;
      } catch (e) { falhaSubir++; ficaram.push(n); if (!erroSubir) erroSubir = e.message; }
    }

    if (ov) ov.style.display = 'none';
    alert(idxAviso
      + `Consolidação concluída.\n\n`
      + `Notas com foto: ${comFoto.length}\n`
      + `✅ Enviadas ao Drive: ${ok}\n`
      + `⬇️ Falha ao BAIXAR do servidor: ${falhaBaixar}\n`
      + `☁️ Falha ao SUBIR no Drive: ${falhaSubir}\n`
      + (erroBaixar ? `\nErro ao baixar: ${erroBaixar}` : '')
      + (erroSubir  ? `\nErro ao subir: ${erroSubir}` : '')
      + (ficaram.length
          ? `\n\nFicaram de fora (rode de novo com sinal melhor):\n`
            + ficaram.slice(0, 8).map(n => `• ${fmtData(n.data)} ${n.tipo} ${brl(n.valor)} — ${mapa[n.user_id]?.nome || '?'}`).join('\n')
            + (ficaram.length > 8 ? `\n… e mais ${ficaram.length - 8}` : '')
          : ''));
  } catch (e) {
    if (ov) ov.style.display = 'none';
    alert('Envio ao Drive falhou: ' + e.message);
  }
}

/* ── Consolidação AUTOMÁTICA (silenciosa) ────────────────────
   Roda sozinha quando o GESTOR/ADMIN abre o app com Drive conectado.
   Sobe ao Drive só as fotos da equipe que AINDA NÃO estão lá (barato:
   pula download+upload do que já existe). Sem popups; toast só se fez algo. */
let _autoConsolidaFeito = false, _autoConsolidaRodando = false;

function _maybeAutoConsolidarFotos() {
  if (_autoConsolidaFeito || _autoConsolidaRodando) return;
  if (!sb || DEMO_MODE || !user) return;
  if (user.role !== 'gestor' && user.role !== 'admin') return;
  if (!navigator.onLine || !GDrive.isConnected()) return;
  _autoConsolidaRodando = true;
  _autoConsolidarFotosDrive()
    .then(() => { _autoConsolidaFeito = true; })
    .catch(() => {})
    .finally(() => { _autoConsolidaRodando = false; });
}

async function _autoConsolidarFotosDrive() {
  // 1) atualiza índice p/ saber o que já está no Drive
  await GDrive.atualizarIndice();

  // 2) mapa de colaboradores + todas as notas com foto
  const [collabs, notas] = await Promise.all([
    sb.colaboradores.list(),
    sb.notas.list({ fields: 'id,user_id,tipo,subtipo,mes,ano,data,foto_path,deleted' }),
  ]);
  const mapa = {};
  (collabs || []).forEach(c => { mapa[c.id] = c; });

  // 3) só as que têm foto, não deletadas, e que AINDA NÃO estão no Drive
  const pendentes = (notas || []).filter(n =>
    n.foto_path && !n.deleted && !GDrive.getFotoExt(n.id)
  );
  if (!pendentes.length) return;

  // 4) baixa do servidor e sobe pro Drive (para suave se a conexão cair)
  let ok = 0;
  for (const n of pendentes) {
    if (!navigator.onLine || !GDrive.isConnected()) break;
    try {
      let blob = null;
      try { blob = await sb.fotos.download(n.foto_path); } catch (_) { blob = null; }
      if (!blob) continue;
      const ext = (String(n.foto_path).split('.').pop() || 'jpg').toLowerCase();
      const c   = mapa[n.user_id] || {};
      await GDrive.uploadFotoComDados(blob, {
        // subtipo/data obrigatórios — ver o comentário no envio da equipe
        id: n.id, tipo: n.tipo, subtipo: n.subtipo, mes: n.mes, ano: n.ano, data: n.data,
        user_id: n.user_id, user_email: c.email, user_nome: c.nome,
      }, ext);
      ok++;
    } catch (_) { /* segue p/ a próxima */ }
  }
  if (ok) toast(`Drive atualizado: ${ok} foto(s) da equipe organizada(s) ☁️`);
}

/* Foto do perfil (19/09/2026): arquivo em <user_id>/perfil.jpg no servidor,
   caminho em colaboradores.foto_path. Reduzida no aparelho antes de subir. */
async function _mostrarAvatar() {
  const el = $('perfil-avatar');
  if (!el || !user?.foto_path || !sb) return;
  try {
    const url = await sb.fotos.url(user.foto_path);
    if (url && $('perfil-avatar')) { el.innerHTML = `<img src="${url}" alt="">`; el.classList.add('com-foto'); }
  } catch (_) {}
}
async function enviarFotoPerfil(e) {
  let file = e.target.files?.[0];
  if (!file) return;
  if (!navigator.onLine) { toast('Precisa de internet para enviar a foto', 'err'); return; }
  try { file = await _normalizarOrientacao(file); } catch (_) {}   // 23/09/2026: rosto em pé
  /* enquadramento (19/09/2026): a mesma tela de recorte das notas, agora
     para o rosto — quem tirar a foto escolhe o pedaço que vira o avatar */
  let escolhida = file;
  if (window.Recorte) {
    const tit = $('crop-overlay')?.querySelector('.crop-tit');
    if (tit) tit.textContent = 'Enquadre o rosto';
    try { escolhida = (await Recorte.abrir(file)) || file; } catch (_) { escolhida = file; }
    if (tit) tit.textContent = 'Enquadre a nota';
  }
  setLoading(true);
  try {
    let blob = escolhida, ext = 'jpg';
    try { ({ blob, ext } = await _comprimirImagem(escolhida, 'jpg')); } catch (_) {}
    user = await sb.auth.fotoPerfil(blob, ext);
    toast('Foto do perfil salva ✅');
    renderPerfil();
  } catch (err) { toast('Foto: ' + (err.message || 'não subiu'), 'err'); }
  finally { setLoading(false); e.target.value = ''; }
}
async function removerFotoPerfil() {
  if (!confirm('Remover a foto do perfil?')) return;
  setLoading(true);
  try { user = await sb.auth.removerFotoPerfil(); renderPerfil(); }
  catch (err) { toast(err.message, 'err'); } finally { setLoading(false); }
}

/* ── VIEW: PERFIL ────────────────────────────────────────── */
/* Cartão "Notificações neste aparelho" (24/09/2026). O estado é do APARELHO,
   não da conta: cada celular autoriza o seu. */
/* CPF do perfil (24/09/2026). Grava ao sair do campo; vazio limpa. */
async function salvarCpfDoPerfil(campo) {
  const digitos = _soDigitos(campo.value);
  if (digitos && digitos.length !== 11) { toast('CPF precisa ter 11 dígitos', 'err'); return; }
  if (digitos === _soDigitos(user?.cpf)) return;             // não mudou
  if (!sb || !navigator.onLine) { toast('Precisa de internet para salvar o CPF', 'err'); return; }
  try {
    const atualizado = await sb.colaboradores.update(user.id, { cpf: digitos || null });
    user.cpf = atualizado?.cpf ?? (digitos || null);
    campo.value = _formatarDoc(user.cpf || '');
    toast(user.cpf ? 'CPF salvo ✅' : 'CPF removido');
  } catch (e) {
    toast('Não deu para salvar: ' + (e.message || 'erro'), 'err');
  }
}

async function _pintarCartaoPush() {
  const el = $('perfil-push');
  if (!el) return;
  if (!_pushDisponivel()) {
    el.innerHTML = '<p style="font-size:14px;color:var(--text2)">Este navegador não trabalha com notificação.</p>';
    return;
  }
  const inscrito = !!(await _inscricaoAtual());
  const bloqueado = Notification.permission === 'denied';
  if (inscrito) {
    el.innerHTML = `
      <div style="background:rgba(185,226,74,.14);border:1px solid rgba(185,226,74,.45);border-radius:10px;padding:10px 12px">
        <b>🔔 Notificações ligadas neste aparelho</b>
        <p style="margin-top:4px;line-height:1.5;font-size:14.5px">Pedido de repasse, repasse pago, cadastro novo e cartão acabando chegam aqui — e o número aparece no ícone do app.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <button class="btn btn-sm btn-outline" onclick="sb?.push.testar().then(()=>toast('Aviso de teste enviado')).catch(()=>toast('Não deu','err'))">Enviar um teste</button>
          <button class="btn btn-sm btn-danger-outline" onclick="desligarNotificacoes(this)">Desligar aqui</button>
        </div>
      </div>`;
    return;
  }
  el.innerHTML = `
    <div style="background:#FFF7ED;border:1.5px solid #FDBA74;border-radius:10px;padding:10px 12px;color:#7C2D12">
      <b style="color:#9A3412">🔕 Notificações desligadas neste aparelho</b>
      <p style="margin-top:4px;line-height:1.5;color:inherit;font-size:14.5px">${bloqueado
        ? 'Você bloqueou as notificações para este site. Libere nas configurações do navegador e volte aqui.'
        : 'Ligue para receber no celular o pedido de repasse, o repasse pago, o cadastro novo e o aviso de cartão acabando. É o que faz o número aparecer no ícone do app.'}</p>
      ${bloqueado ? '' : '<button class="btn btn-primary btn-full" style="margin-top:8px" onclick="ativarNotificacoes(this)">🔔 Ligar notificações neste aparelho</button>'}
    </div>`;
}

function renderPerfil() {
  $('app-content').innerHTML = `
  <div class="page-hd"><h2>Perfil</h2></div>
  <div class="perfil-card">
    <div class="perfil-avatar" id="perfil-avatar">${esc((user?.nome||'?')[0].toUpperCase())}</div>
    <input type="file" id="p-foto" accept="image/*" capture="user" style="display:none" onchange="enviarFotoPerfil(event)">
    <input type="file" id="p-foto-galeria" accept="image/*" style="display:none" onchange="enviarFotoPerfil(event)">
    <div style="display:flex;gap:8px;justify-content:center;margin:-4px 0 10px;flex-wrap:wrap">
      <button class="btn btn-sm btn-primary" onclick="$('p-foto').click()">📷 Tirar foto</button>
      <button class="btn btn-sm btn-outline" onclick="$('p-foto-galeria').click()">🖼️ Da galeria</button>
      ${user?.foto_path ? `<button class="btn btn-sm btn-outline" onclick="removerFotoPerfil()">Remover</button>` : ''}
    </div>
    <p style="font-size:15px;color:var(--text2);text-align:center;margin:-4px 0 8px">Depois da foto, enquadre o rosto e toque em <b>Usar recorte</b>.</p>
    <div class="perfil-nome">${esc(user?.nome||user?.email||'')}</div>
    <div class="perfil-email">${esc(user?.email||'')}</div>
    <div class="perfil-meta">
      <span class="role-pill role-${esc(user?.role||'colaborador')}">${esc(user?.role||'colaborador')}</span>
    </div>
  </div>

  <div class="perfil-form">
    <label class="lbl">Nome</label>
    <input class="inp" id="p-nome"   value="${esc(user?.nome||'')}" autocomplete="name" autocapitalize="words">
    <button class="btn btn-primary" onclick="salvarPerfil()">Salvar perfil</button>
  </div>

  <div class="perfil-actions">
    <div class="install-slot"></div>
    <button class="btn btn-outline" onclick="abrirAjuda()">❓ Como usar o app</button>
    ${_ehGestorOuAdmin() && window.GDrive?.isConfigured() ? `
    <div style="border-top:1px solid var(--border);padding-top:16px;margin-top:4px">
      <p class="lbl" style="margin-bottom:12px">☁️ Google Drive</p>
      ${driveOk && GDrive.isConnected() ? `
        <div style="background:#F0FBF4;border:1.5px solid #74C69D;border-radius:10px;padding:12px 14px;margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="width:9px;height:9px;border-radius:50%;background:#40916C;flex-shrink:0;display:inline-block"></span>
            <span style="font-size:15.5px;font-weight:700;color:#1B4332">Conectado</span>
            <span style="margin-left:auto;font-size:13px;color:#5A6E60">Expira em ${GDrive.minutosRestantes()} min</span>
          </div>
          <p style="font-size:14px;color:#5A6E60">Notas e fotos sincronizando automaticamente</p>
        </div>
        <button class="btn btn-outline btn-full" style="margin-bottom:8px" onclick="testarDrive()">🔍 Testar acesso à pasta</button>
        <button class="btn btn-outline btn-full" onclick="migrarPastasDrive()">🗂️ Reorganizar pastas no padrão</button>
      ` : `
        <div style="background:#F8FAF9;border:1.5px dashed var(--border);border-radius:10px;padding:14px;text-align:center">
          <div style="font-size:29px;margin-bottom:8px">☁️</div>
          <p style="font-size:15.5px;color:var(--text2);line-height:1.6">
            O Drive conecta sozinho quando você abre o app.<br>
            Se não conectou, use o botão abaixo.
          </p>
        </div>
        <button class="btn btn-primary btn-full" style="margin-top:10px" onclick="conectarDriveAgora()">🔗 Conectar Drive agora</button>
        <button class="btn btn-outline btn-full" style="margin-top:8px" onclick="reconectarDrivePeloGoogle()">🔁 Entrar de novo pelo Google (com Drive)</button>
        <details style="margin-top:10px;font-size:13.5px;color:var(--text2)">
          <summary style="cursor:pointer">🩺 Diagnóstico do Drive</summary>
          <pre style="white-space:pre-wrap;font-size:13px;line-height:1.5;margin-top:6px">${esc(_driveDiagTexto())}</pre>
        </details>
      `}
    </div>
    ` : ''}
    ${_ehGestorOuAdmin() && sb && !DEMO_MODE ? `
    <div style="border-top:1px solid var(--border);padding-top:16px;margin-top:4px">
      <p class="lbl" style="margin-bottom:8px">💾 Armazenamento do servidor</p>
      <div id="armazenamento-card" style="font-size:15px;color:var(--text2)">Medindo o espaço em disco…</div>
    </div>
    <div style="border-top:1px solid var(--border);padding-top:16px;margin-top:4px">
      <p class="lbl" style="margin-bottom:8px">🗄️ Backup</p>
      <p style="font-size:14px;color:var(--text2);line-height:1.6;margin-bottom:10px">
        Banco + todas as fotos num ZIP. O servidor gera um sozinho toda semana (lista abaixo);
        baixe uma cópia de vez em quando e guarde fora da Locaweb.
      </p>
      <button class="btn btn-primary btn-full" id="btn-backup-completo" onclick="baixarBackupCompleto()">⬇️ Baixar backup completo (banco + fotos)</button>
      <div id="backups-auto" style="margin-top:10px;font-size:15px;color:var(--text2)">Carregando backups automáticos…</div>
      <div class="field" style="margin-top:12px">
        <label class="lbl">Seu CPF <span style="font-weight:400;color:var(--text2)">— opcional</span></label>
        <input class="inp" id="p-cpf" inputmode="numeric" placeholder="000.000.000-00" value="${esc(_formatarDoc(user?.cpf || ''))}"
               onblur="salvarCpfDoPerfil(this)">
        <p style="font-size:13.5px;color:var(--text2);line-height:1.45;margin-top:4px">
          Serve para uma exceção: nota que sai no <b>seu</b> CPF — recarga de celular na sua linha, por exemplo — deixa de ser barrada. Sem ele, só passa nota sem consumidor ou no CNPJ da empresa.</p>
      </div>
      <div id="perfil-push" style="margin-top:12px"></div>
      <div id="backup-drive" style="margin-top:12px;font-size:15px;color:var(--text2)">Conferindo a cópia no Google Drive…</div>
      <button class="btn btn-outline btn-full" id="btn-backup" style="margin-top:8px" onclick="baixarBackupBanco()">⬇️ Só o banco (.sqlite)</button>
      <button class="btn btn-outline btn-full" id="btn-migrar" style="margin-top:8px" onclick="atualizarBanco()">🛠️ Atualizar estrutura do banco</button>
      <p style="font-size:13px;color:var(--text2);margin-top:6px">
        Use "Atualizar" só quando uma nova versão da API pedir (ele aplica as migrações pendentes no servidor).
      </p>
    </div>
    ` : ''}
  </div>`;
  _pintarBotaoInstalar();
  _mostrarAvatar();
  _listarBackupsAuto();
  _mostrarArmazenamento();
  _mostrarBackupDrive();
}

/* Cópia do backup no Google Drive (21/09/2026). Gestor ou admin autoriza uma vez
   (só "arquivos criados por este app"); depois o cron semanal sobe o zip
   sozinho para a pasta "Backups Petermann App" e mantém lá a mesma rotação.
   Se a Locaweb perder o disco, o backup mais novo está no Drive. */
async function _mostrarBackupDrive() {
  const el0 = $('backup-drive');
  if (!el0 || !_ehGestorOuAdmin() || !sb || !navigator.onLine) { if (el0) el0.textContent = ''; return; }
  try {
    const s = await sb.backup.drive();
    _pintarCartaoPush().catch(() => {});
    const el = $('backup-drive');
    if (!el) return;
    const q = d => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    if (!s.conectado) {
      el.innerHTML = `
        <div style="background:#FFF7ED;border:1.5px solid #FDBA74;border-radius:10px;padding:10px 12px;color:#7C2D12">
          <b style="color:#9A3412">☁️ Cópia fora da Locaweb: desligada</b>
          <p style="margin-top:4px;line-height:1.5;color:inherit">Conecte o Google Drive para o backup semanal subir sozinho para a pasta <b>${esc(s.pasta)}</b> do seu Drive. O app só ganha acesso aos arquivos que ele mesmo criar.</p>
          <button class="btn btn-primary btn-full" style="margin-top:8px" onclick="conectarDriveBackup()">🔗 Conectar Google Drive ao backup</button>
        </div>`;
      return;
    }
    const dias = s.ultimo_envio ? Math.floor((Date.now() - new Date(s.ultimo_envio).getTime()) / 86_400_000) : null;
    const atraso = dias === null ? '<span style="color:#b45309;font-weight:700">ainda nenhum envio — toque em "Enviar agora" para testar</span>'
                 : dias > 8 ? `<span style="color:#b45309;font-weight:700">há ${dias} dias — confira o Crontab</span>` : `há ${dias} dia${dias === 1 ? '' : 's'}`;
    el.innerHTML = `
      <div style="background:#F0FBF4;border:1.5px solid #74C69D;border-radius:10px;padding:10px 12px;color:#1B4332">
        <b style="color:#1B4332">☁️ Cópia no Google Drive: ligada</b>
        <div style="margin-top:4px;line-height:1.6;color:inherit">
          Conta: <b>${esc(s.email || '')}</b> · pasta <b>${esc(s.pasta)}</b><br>
          Último envio: ${atraso}${s.ultimo_arquivo ? ` <span style="opacity:.75">(${esc(s.ultimo_arquivo)})</span>` : ''}
          ${s.ultimo_erro ? `<br><span style="color:#b91c1c">⚠️ Último erro: ${esc(s.ultimo_erro)}</span>` : ''}
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
          <button class="btn btn-sm btn-outline" id="btn-drive-enviar" onclick="enviarBackupDriveAgora()">⬆️ Enviar agora</button>
          <button class="btn btn-sm btn-outline" onclick="desconectarDriveBackup()">Desconectar</button>
        </div>
      </div>`;
  } catch (e) { const el = $('backup-drive'); if (el) el.textContent = 'Não consegui conferir o Drive do backup: ' + (e.message || 'erro'); }
}
async function conectarDriveBackup() {
  if (!navigator.onLine) { toast('Sem conexão', 'err'); return; }
  try {
    const { url } = await sb.backup.driveUrl();
    location.href = url;   // Google → callback da API → volta ao app com #drive_backup=ok
  } catch (e) { toast(e.message || 'Não consegui abrir a autorização do Google', 'err'); }
}
async function enviarBackupDriveAgora() {
  if (!navigator.onLine) { toast('Sem conexão', 'err'); return; }
  const b = $('btn-drive-enviar'); if (b) { b.disabled = true; b.textContent = 'Enviando…'; }
  setLoading(true, 'Enviando o backup mais novo ao Drive… (pode levar 1 min)');
  try {
    const r = await sb.backup.driveEnviar();
    toast(`Enviado ao Drive: ${r.nome} ✅`);
  } catch (e) { toast(e.message || 'Falha ao enviar ao Drive', 'err'); }
  finally { setLoading(false); _mostrarBackupDrive(); }
}
async function desconectarDriveBackup() {
  if (!confirm('Desligar a cópia do backup no Google Drive? Os arquivos já enviados continuam lá.')) return;
  try { await sb.backup.driveDesconectar(); toast('Drive desconectado do backup'); }
  catch (e) { toast(e.message || 'erro', 'err'); }
  _mostrarBackupDrive();
}

/* Armazenamento do servidor (21/09/2026): quanto o app ocupa na Locaweb
   (banco, fotos, backups, logs), % do plano, tendência e último backup.
   O mesmo número que o cron `armazenamento:verificar` usa para avisar
   por e-mail — aqui é a versão "olhar quando quiser". Gestor e admin (22/09/2026). */
async function _mostrarArmazenamento() {
  const el0 = $('armazenamento-card');
  if (!el0 || !_ehGestorOuAdmin() || !sb || !navigator.onLine) { if (el0) el0.textContent = 'Sem conexão — abra de novo quando estiver online.'; return; }
  try {
    const m = await sb.admin.armazenamento();
    const el = $('armazenamento-card');
    if (!el) return;
    const MB = b => (b / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' MB';
    const cor = { ok: '#2D6A4F', aviso: '#b45309', critico: '#b91c1c' }[m.nivel] || 'var(--text2)';
    const rotulo = { ok: '✅ Tudo bem', aviso: '⚠️ Atenção', critico: '🔴 Crítico' }[m.nivel] || '';
    const p = m.partes;
    const partes = [
      ['📷 Fotos', p.fotos.bytes, `${p.fotos.n} arquivo${p.fotos.n === 1 ? '' : 's'}`],
      ['🗄️ Backups', p.backups.bytes, `${p.backups.n} cópia${p.backups.n === 1 ? '' : 's'}`],
      ['🧮 Banco de dados', p.banco.bytes, `${p.banco.n} lançamentos`],
      ['🖼️ Miniaturas', p.miniaturas.bytes, 'regeradas sozinhas'],
      ['📜 Logs', p.logs.bytes, ''],
    ];
    const total = Math.max(1, m.total);
    const barras = partes.map(([nome, bytes, extra]) => `
      <div style="display:flex;justify-content:space-between;gap:8px;margin-top:6px">
        <span>${nome}${extra ? ` <span style="opacity:.7">· ${esc(extra)}</span>` : ''}</span><b>${MB(bytes)}</b>
      </div>
      <div style="height:6px;border-radius:4px;background:var(--border);overflow:hidden">
        <div style="height:100%;width:${Math.max(1, Math.round(bytes / total * 100))}%;background:var(--primary,#2D6A4F)"></div>
      </div>`).join('');

    let plano;
    if (m.pct !== null && m.limite_mb) {
      const corBarra = m.nivel === 'critico' ? '#b91c1c' : m.nivel === 'aviso' && m.pct >= (m.limites?.aviso_pct ?? 80) ? '#b45309' : '#2D6A4F';
      plano = `
        <div style="display:flex;justify-content:space-between;margin-top:8px"><span>Uso do teto de alerta</span><b>${m.pct.toLocaleString('pt-BR')} % de ${(m.limite_mb / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB</b></div>
        <div style="height:10px;border-radius:5px;background:var(--border);overflow:hidden;margin-top:4px">
          <div style="height:100%;width:${Math.min(100, m.pct)}%;background:${corBarra}"></div>
        </div>`;
    } else {
      plano = `<p style="margin-top:8px;opacity:.8">Teto de alerta não definido — grave <code>ARMAZENAMENTO_LIMITE_MB</code> no servidor para ver a porcentagem e receber aviso por e-mail.</p>`;
    }

    const t = m.tendencia || {};
    let tend = '';
    if (t.por_mes !== null && t.por_mes !== undefined && t.amostras >= 2) {
      tend = `📈 Crescimento: <b>${t.por_mes >= 0 ? '+' : '−'}${MB(Math.abs(t.por_mes))}/mês</b>`
        + (t.dias_ate_limite !== null && t.dias_ate_limite !== undefined ? ` · no ritmo atual o espaço acaba em <b>~${t.dias_ate_limite} dias</b>` : '')
        + ` <span style="opacity:.7">(${t.amostras} medições)</span>`;
    } else {
      tend = '📈 Tendência: aparece depois de alguns dias de medição.';
    }

    const ub = m.ultimo_backup;
    const backup = ub
      ? `🗄️ Último backup automático: <b>há ${ub.dias} dia${ub.dias === 1 ? '' : 's'}</b> (${MB(ub.bytes)})${ub.dias > 8 ? ' <span style="color:#b45309;font-weight:700">— atrasado, confira o Crontab</span>' : ''}`
      : '<span style="color:#b45309;font-weight:700">🗄️ Nenhum backup automático ainda.</span>';

    const vol = m.volume ? `<p style="margin-top:8px;opacity:.7;font-size:13.5px">Disco da Locaweb (compartilhado com outros clientes): ${m.volume.pct_usado.toLocaleString('pt-BR')} % usado, ${(m.volume.livre / 1073741824).toFixed(0)} GB livres.</p>` : '';

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span>Total usado pelo app</span>
        <b style="font-size:18px;color:${cor}">${MB(m.total)}</b>
      </div>
      <div style="color:${cor};font-weight:700;margin-top:2px">${rotulo}</div>
      ${plano}
      ${barras}
      <p style="margin-top:10px">${tend}</p>
      <p style="margin-top:4px">${backup}</p>
      ${vol}
      <p style="margin-top:6px;opacity:.7;font-size:13.5px">Medido agora (${new Date(m.em).toLocaleString('pt-BR')}). O servidor mede sozinho todo dia às 04:10 e avisa por e-mail se passar de ${m.limites?.aviso_pct ?? 80} % ou o backup atrasar.</p>`;
  } catch (e) {
    const el = $('armazenamento-card');
    if (el) el.textContent = 'Não consegui medir o armazenamento: ' + (e.message || 'erro');
  }
}

/* Backups automáticos (artisan backup:gerar no agendador da Locaweb):
   lista com link para baixar cada um. Gestor e admin (22/09/2026). */
async function _listarBackupsAuto() {
  const el0 = $('backups-auto');
  if (!el0 || !_ehGestorOuAdmin() || !sb || !navigator.onLine) { if (el0) el0.textContent = ''; return; }
  try {
    const { backups = [] } = await sb.backup.lista();
    const el = $('backups-auto');            // o Perfil pode ter sido redesenhado enquanto esperava
    if (!el) return;
    if (!backups.length) {
      el.innerHTML = '⚠️ Nenhum backup automático ainda. Cadastre no painel da Locaweb (Agendador de tarefas) o comando <code>backup:gerar</code> — está no guia.';
      return;
    }
    /* crontab parado é silencioso: se o mais novo tem mais de 8 dias, avisa */
    const dias = Math.floor((Date.now() - new Date(backups[0].em).getTime()) / 86_400_000);
    const alerta = dias > 8 ? `<div style="color:#b45309;font-weight:700;margin-bottom:4px">⚠️ Último backup automático há ${dias} dias — confira o Crontab no painel da Locaweb.</div>` : '';
    el.innerHTML = alerta + '<b>Automáticos no servidor:</b><br>' + backups.slice(0, 8).map(b =>
      `<a class="link" onclick="baixarBackupAuto('${esc(b.nome)}')">${esc(b.nome)}</a> · ${(b.bytes / 1048576).toFixed(1)} MB`).join('<br>');
  } catch (e) { const el = $('backups-auto'); if (el) el.textContent = 'Não consegui listar os backups: ' + (e.message || 'erro'); }
}
async function _baixarBlob(promessa, nomeArquivo, msg) {
  if (!navigator.onLine) { toast('Sem conexão', 'err'); return; }
  setLoading(true, msg || 'Gerando…');
  try {
    const blob = await promessa;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nomeArquivo;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast(`Baixado (${(blob.size / 1048576).toFixed(1)} MB) ✅`);
  } catch (e) { toast('Não foi possível baixar: ' + (e.message || 'erro'), 'err'); }
  finally { setLoading(false); }
}
function baixarBackupCompleto() { return _baixarBlob(sb.backup.completo(), `petermann-completo-${hoje()}.zip`, 'Montando o backup (banco + fotos)… pode levar 1 min'); }
function baixarBackupAuto(nome) { return _baixarBlob(sb.backup.arquivo(nome), nome, 'Baixando ' + nome + '…'); }

/* Planilha de C.V. no modelo oficial (PLANILHA DE CV), preenchida pelo
   servidor com as notas/repasses do ano — sem depender do Drive. Gestor e
   admin passam o user_id do colaborador; o colaborador baixa a própria. */
async function baixarRelatorioCv(formato = 'xlsx', userId = null, nome = null) {
  if (!sb || !navigator.onLine) { toast('Precisa de internet para gerar a planilha', 'err'); return; }
  setLoading(true, formato === 'pdf' ? 'Gerando o PDF… (até 1 min)' : 'Gerando a planilha…');
  try {
    const blob = await sb.relatorio.cv(filAno, userId, formato);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `Planilha_CV_${(nome || user?.nome || 'colaborador').replace(/\s+/g, '_')}_${filAno}.${formato}`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast(`${formato === 'pdf' ? 'PDF' : 'Planilha'} gerado ✅`);
  } catch (e) {
    toast('Não foi possível gerar: ' + (e.message || 'erro'), 'err');
  } finally { setLoading(false); }
}

/* Planilha de RDM e RDA no modelo oficial (21/09/2026), para quem está no
   regime RDM/RDA. xlsx = o modelo preenchido pelo servidor (limpa o exemplo
   antes); pdf = montado dos dados no padrão do modelo. */
function baixarRelatorioRdmRda(userId = null, nome = null, formato = 'xlsx') {
  if (!sb || !navigator.onLine) { toast('Precisa de internet para gerar a planilha', 'err'); return; }
  const arq = `Planilha_RDM_RDA_${(nome || user?.nome || 'colaborador').replace(/\s+/g, '_')}_${filAno}.${formato}`;
  return _baixarBlob(sb.relatorio.rdmrda(filAno, userId, formato), arq, formato === 'pdf' ? 'Gerando o PDF de RDM e RDA…' : 'Gerando a Planilha de RDM e RDA (modelo da empresa)… uns 20 s');
}

/* Relatório da equipe do mês em PDF (20/09/2026): resumo, quadro por
   colaborador e as notas/repasses de cada um. Gestor/admin. */
function baixarRelatorioEquipe(ids = []) {   // ids = marcados no seletor da Equipe (21/09/2026)
  if (!sb || !navigator.onLine) { toast('Precisa de internet para gerar o relatório', 'err'); return; }
  return _baixarBlob(sb.relatorio.equipe(filAno, filMes, ids), `Relatorio_Equipe_${filAno}-${String(filMes).padStart(2, '0')}.pdf`, 'Gerando o PDF da equipe…');
}

/* Planilha de C.V. de vários colaboradores (21/09/2026), escolhidos no modal
   da Equipe (Gestor.abrirCvEquipe). modo 'unico' = um Excel com as abas de
   cada um; 'zip' = um arquivo completo por pessoa. */
function baixarCvEquipe(ids = [], modo = 'unico') {
  if (!sb || !navigator.onLine) { toast('Precisa de internet para gerar as planilhas', 'err'); return; }
  const n = ids.length || 'todos os';
  const nome = modo === 'zip' ? `Planilhas_Equipe_${filAno}.zip` : `Planilhas_Equipe_${filAno}.xlsx`;
  return _baixarBlob(sb.relatorio.cvEquipe(filAno, ids, modo), nome, `Gerando as planilhas de ${n} colaborador(es) · ${filAno}… CV uns 5 s, RDM/RDA uns 20 s por pessoa`);
}

/* Cópia íntegra do SQLite de produção (GET /backup/banco, só admin). O
   arquivo desce pelo navegador como petermann-AAAA-MM-DD.sqlite. */
async function baixarBackupBanco() {
  if (!navigator.onLine) { toast('Sem conexão', 'err'); return; }
  const btn = $('btn-backup');
  if (btn) btn.disabled = true;
  setLoading(true, 'Gerando backup…');
  try {
    const blob = await sb.backup.banco();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `petermann-${hoje()}.sqlite`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast(`Backup baixado (${Math.round(blob.size / 1024)} kB)`);
  } catch (e) {
    toast('Não foi possível gerar o backup: ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
    setLoading(false);
  }
}

async function salvarPerfil() {
  const nome = $('p-nome').value.trim();
  if (!nome) { toast('Informe seu nome','err'); return; }
  user.nome = nome;
  if (sb && !DEMO_MODE) {
    try { await sb.auth.updateMe(nome); }
    catch (e) { toast('Não salvou no servidor: ' + e.message, 'err'); return; }
  }
  toast('Perfil salvo!');
  renderPerfil();
}

/* Roda as migrações pendentes NO SERVIDOR (POST /admin/migrar, só admin).
   É o "php artisan migrate" de quem não tem terminal na hospedagem. */
async function atualizarBanco() {
  if (!navigator.onLine) { toast('Sem conexão', 'err'); return; }
  const btn = $('btn-migrar');
  if (btn) btn.disabled = true;
  setLoading(true, 'Conferindo o banco…');
  try {
    const st = await sb.admin.status();
    const pend = st?.migracoes_pendentes || [];
    if (!pend.length) { toast('Banco já está atualizado'); return; }
    if (!confirm(`${pend.length} atualização(ões) pendente(s):\n\n${pend.join('\n')}\n\nAplicar agora? Baixe um backup antes, se ainda não baixou.`)) return;
    setLoading(true, 'Atualizando…');
    const r = await sb.admin.migrar();
    if (!r?.ok) throw new Error(r?.saida || 'falha');
    toast('Banco atualizado');
    console.info('[migrar]', r.saida);
  } catch (e) {
    toast('Não foi possível atualizar: ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
    setLoading(false);
  }
}

/* ── CAPTURA: sheet seleção ──────────────────────────────── */
/* Sem o botão + (16/09/2026): "lançar" de qualquer tela leva ao Início,
   onde estão as três ações. A folha antiga fica só como reserva. */
function abrirCaptura() {
  switchView('inicio');
}
function fecharCaptura() {
  $('capture-sheet').classList.remove('open');
}

/* ── QR Code ─────────────────────────────────────────────── */
async function iniciarQR() {
  fecharCaptura();
  setLoading(true);
  try { await _ensureJsQR(); } catch (e) { setLoading(false); toast(e.message, 'err'); return; }
  setLoading(false);
  const ov = $('qr-overlay');
  ov.style.display = 'flex';
  const _h = $('qr-hint'); if (_h) _h.textContent = 'Aponte para o QR Code da NFCe  ·  ' + APP_VERSION;
  const _s = $('qr-status-txt'); if (_s) _s.textContent = '';
  _qrSeen = 0;
  const video  = $('qr-video');
  const canvas = $('qr-canvas');
  const ctx    = canvas.getContext('2d', { willReadFrequently: true });

  // ── Banner de diagnóstico GRANDE no topo (impossível não ver) ──
  let diag = document.getElementById('qr-diag');
  if (!diag) {
    diag = document.createElement('div');
    diag.id = 'qr-diag';
    diag.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:5;'
      + 'background:rgba(0,0,0,.78);color:#7CFC00;font-size:15.5px;font-weight:700;'
      + 'padding:10px 12px;text-align:center;font-family:monospace;line-height:1.45;'
      + 'padding-top:calc(10px + env(safe-area-inset-top,0px));';
    $('qr-overlay').appendChild(diag);
  }
  const setDiag = t => { diag.textContent = `[${APP_VERSION}·${APP_BUILD}] ` + t; };
  setDiag('Abrindo câmera…');

  // checa suporte do navegador
  if (!navigator.mediaDevices?.getUserMedia) {
    setDiag('SEM SUPORTE a câmera neste navegador. Use "Chave" ou "Foto OCR".');
    return;
  }

  const onStream = stream => {
    qrStream = stream;
    // atributos ANTES do srcObject (exigência do iOS p/ não ficar preto)
    video.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');
    video.setAttribute('muted', '');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    // tenta dar play; em alguns celulares o autoplay é bloqueado
    const tentarPlay = () => video.play().catch(() => {});
    tentarPlay();

    // foco contínuo quando o aparelho suporta
    try {
      const track = stream.getVideoTracks()[0];
      const caps  = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      }
      /* zoom da câmera (19/09/2026): QR pequeno lê melhor aproximando pela
         lente do que chegando o celular — o foco não perde. Slider só aparece
         onde a câmera tem zoom (Android Chrome). */
      const zoomEl = $('qr-zoom');
      if (zoomEl && caps.zoom && caps.zoom.max > caps.zoom.min) {
        zoomEl.min = caps.zoom.min; zoomEl.max = Math.min(caps.zoom.max, 5); zoomEl.step = caps.zoom.step || 0.1;
        zoomEl.value = Math.min(zoomEl.max, Math.max(caps.zoom.min, 1.5));
        track.applyConstraints({ advanced: [{ zoom: Number(zoomEl.value) }] }).catch(() => {});
        zoomEl.oninput = () => track.applyConstraints({ advanced: [{ zoom: Number(zoomEl.value) }] }).catch(() => {});
        zoomEl.parentElement.style.display = 'flex';
      } else if (zoomEl) { zoomEl.parentElement.style.display = 'none'; }
      _detectorNativo().then(d => { const st = $('qr-motor'); if (st) st.textContent = d ? 'Leitor nativo do Android ativo' : 'Leitor: jsQR'; });
    } catch (_) {}

    const start = () => {
      canvas.width  = video.videoWidth  || 1280;
      canvas.height = video.videoHeight || 720;
      loopQR(ctx, video, canvas);
    };
    if (video.readyState >= 2) { tentarPlay(); start(); }
    else video.addEventListener('loadedmetadata', () => { tentarPlay(); start(); }, { once: true });

    // toque na tela sempre re-tenta o play (contorna bloqueio de autoplay)
    const ov2 = $('qr-overlay');
    const onTap = () => tentarPlay();
    ov2.addEventListener('click', onTap);

    // MEDIDOR AO VIVO (diagnóstico) — mostra o estado real do vídeo/câmera
    clearInterval(window._qrDiag);
    window._qrDiag = setInterval(() => {
      if (!qrStream) { clearInterval(window._qrDiag); return; }
      const tr = stream.getVideoTracks()[0] || {};
      const preto = !video.videoWidth;
      setDiag(`${video.videoWidth||0}x${video.videoHeight||0} · play=${!video.paused} · rs=${video.readyState} · cam=${tr.readyState||'?'}/${tr.enabled?'on':'off'}${tr.muted?'/MUTED':''}`
        + (preto ? '  ⟵ sem imagem (toque na tela)' : ''));
    }, 400);
  };

  const onErro = e => {
    const nome = e?.name || e?.message || 'erro';
    setDiag('ERRO ao abrir câmera: ' + nome + '. Toque no X e use "Chave" ou "Foto OCR".');
  };

  // 1ª tentativa: câmera traseira em HD. Se falhar (constraint), cai p/ câmera simples.
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
  })
    .then(onStream)
    .catch(err => {
      if (err?.name === 'OverconstrainedError' || err?.name === 'NotReadableError' || err?.name === 'TypeError') {
        // fallback: qualquer câmera, sem exigências
        navigator.mediaDevices.getUserMedia({ video: true }).then(onStream).catch(onErro);
      } else {
        onErro(err);
      }
    });
}

let _qrSkip = 0;
let _qrSeen = 0;
async function loopQR(ctx, video, canvas) {
  if (!qrStream) return;
  /* Qualquer erro aqui dentro (biblioteca que não carregou, frame
     inválido…) matava o laço em silêncio: a câmera ficava aberta e nada
     era lido, sem nenhuma pista. Agora o erro vai para o banner e o laço
     continua tentando. */
  try {
    await _lerFrameQR(ctx, video, canvas);
  } catch (e) {
    const d = document.getElementById('qr-diag');
    if (d) d.textContent = `[${APP_VERSION}·${APP_BUILD}] ERRO na leitura: ${e?.message || e}`;
    console.error('loopQR:', e);
  }
  if (qrStream) qrFrame = requestAnimationFrame(() => loopQR(ctx, video, canvas));
}

/* Leitor nativo do Android/Chrome (BarcodeDetector = o mesmo motor do leitor
   de QR do sistema/Google Lens). Pedido em 19/09/2026: lê muito melhor que o
   jsQR em cupom amassado/desbotado. Onde não existe (iPhone antigo, PC),
   fica o jsQR. */
let _qrNativo = null, _qrNativoTentado = false;
async function _detectorNativo() {
  if (_qrNativoTentado) return _qrNativo;
  _qrNativoTentado = true;
  try {
    if ('BarcodeDetector' in window) {
      let fmts = [];
      try { fmts = await window.BarcodeDetector.getSupportedFormats(); } catch (_) {}
      if (!fmts.length || fmts.includes('qr_code')) _qrNativo = new window.BarcodeDetector({ formats: ['qr_code'] });
    }
  } catch (_) { _qrNativo = null; }
  return _qrNativo;
}

async function _lerFrameQR(ctx, video, canvas) {
  // decodifica a cada 2 frames — equilíbrio entre CPU e velocidade de leitura
  _qrSkip = (_qrSkip + 1) % 2;
  if (_qrSkip === 0 && video.videoWidth) {
    if (canvas.width !== video.videoWidth)  canvas.width  = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    let code = null;
    const det = await _detectorNativo();
    if (det) {
      try {
        const codes = await det.detect(video);        // direto no vídeo, sem copiar pixels
        if (codes?.length && codes[0].rawValue) code = { data: codes[0].rawValue };
      } catch (_) { /* frame ruim: cai no jsQR abaixo */ }
    }
    if (!code) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // attemptBoth = lê QR normal E invertido (cupons desbotados/claros)
      code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    }
    if (code?.data) {
      // aceita pela chave/cnpj OU por qualquer sequência de 44 dígitos no conteúdo
      let parsed = NFCE.fromScan(code.data);
      if (!(parsed?.chave || parsed?.cnpj)) {
        const m = code.data.replace(/\D/g, '').match(/\d{44}/);
        if (m) parsed = NFCE.parseChave44(m[0]);
      }
      if (parsed?.chave || parsed?.cnpj) {
        // captura ESTE frame (que tem o QR) antes de fechar — servirá p/ OCR e foto
        let frameBlob = null;
        try { frameBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92)); } catch (_) {}
        if (parsed.chave) {
          _salvarUrlQR(parsed.chave, code.data);   // guarda o link real da consulta
          navigator.clipboard?.writeText(parsed.chave).catch(() => {});
          if (/^https?:\/\//i.test(code.data)) parsed.qr_url = code.data;
        }
        fecharQR();
        await _finalizarCapturaQR(parsed, frameBlob);
        return;
      }
      // QR de NFS-e (nota de serviço): não tem chave de 44, mas o link abre a nota
      if (_ehUrlNfse(code.data)) {
        let frameBlob = null;
        try { frameBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92)); } catch (_) {}
        fecharQR();
        await _finalizarCapturaQR({ qr_url: code.data, documento: 'nfse' }, frameBlob);
        return;
      }
      // QR foi lido mas não parece ser de NFC-e — avisa em vez de ficar mudo
      _qrSeen++;
      if (_qrSeen >= 3) {
        const st = $('qr-status-txt');
        if (st) st.textContent = 'QR lido, mas não é de NFC-e. Use a foto (OCR) ou a chave de 44 dígitos.';
      }
    }
  }
}

function fecharQR() {
  cancelAnimationFrame(qrFrame);
  clearInterval(window._qrDiag);
  document.getElementById('qr-diag')?.remove();
  qrStream?.getTracks().forEach(t => t.stop());
  qrStream = null;
  $('qr-overlay').style.display = 'none';
}

/* Depois de ler o QR (chave), abre a nota com a chave preenchida e
   PEDE a foto da nota inteira (conferência + OCR do valor). */
async function _finalizarCapturaQR(parsed, frameBlob) {
  const dados = { ...parsed, metodo_captura: 'qrcode' };
  if (!dados.data) dados.data = hoje();

  // TRAVA na leitura: se a chave já foi registrada, avisa e abre a nota existente
  const dup = _notaDuplicadaChave(parsed.chave, null);
  if (dup) {
    toast('⚠️ Nota já registrada — abrindo a existente.', 'err');
    editarNota(dup.id);
    return;
  }

  /* Pedido em 16/09/2026: depois da chave, a FOTO vem antes do formulário.
     A câmera só abre em gesto do usuário, então passa pelo seletor RDA/RDM
     e pela tela "Comprovante da nota" (um toque = abre a câmera); o
     formulário só aparece quando o OCR terminar, já com o máximo preenchido. */
  if (dados.qr_url && dados.chave) _sefazPorQr(dados.qr_url, dados.chave);   // valor oficial, em paralelo
  const aba = _abaPreEscolhida;                    // veio de uma aba do hub (22/09/2026)
  abrirSeletorTipoLancamento({ ...dados, _manual: true });
  const lido = dados.documento === 'nfse' ? 'QR da NFS-e lido! 🧰' : 'Chave lida! 🔑';
  toast(aba ? `${lido} Agora fotografe a nota (aba ${aba}).` : `${lido} Escolha a aba e fotografe a nota.`);
}

/* Passo 2 do fluxo "QR → foto": destaca o botão de foto como chamada de ação.
   A câmera abre no TOQUE do usuário (gesto real) — não depende de auto-abrir,
   que o celular bloqueia. O destaque some quando a foto é anexada. */
function _pedirFotoPasso2() {
  const wrap = document.querySelector('.foto-btn-wrap');
  const lbl  = $('btn-foto-label');
  if (lbl)  lbl.textContent = '📷 PASSO 2 — Toque para fotografar a nota';
  if (wrap) {
    wrap.classList.add('pedir-foto');
    try { wrap.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
  }
}
function _limparPedirFoto() {
  document.querySelector('.foto-btn-wrap')?.classList.remove('pedir-foto');
}

/* Destaca a área de anexo quando tentam salvar sem ele (mesmo destaque
   visual do Passo 2, mas sem trocar o texto do botão). */
function _pedirAnexoObrigatorio() {
  const wrap = document.querySelector('.foto-btn-wrap');
  if (!wrap) return;
  wrap.classList.add('pedir-foto');
  try { wrap.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
}

/* ── Código de Barras (Quagga2) ───────────────────────── */
let _barcodeRunning = false;
let _quaggaLoaded    = false;

async function _ensureQuagga() {
  if (typeof Quagga !== 'undefined') { _quaggaLoaded = true; return; }
  if (_quaggaLoaded) return;
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.8.2/dist/quagga.min.js';
    s.onload  = () => { _quaggaLoaded = true; res(); };
    s.onerror = () => rej(new Error('Falha ao carregar Quagga2'));
    document.head.appendChild(s);
  });
}

async function iniciarBarcode() {
  fecharCaptura();
  setLoading(true);
  try {
    await _ensureQuagga();
    setLoading(false);
    iniciarBarcodeScanner();
  } catch (e) {
    setLoading(false);
    toast('Erro ao carregar scanner: ' + e.message, 'err');
  }
}

function iniciarBarcodeScanner() {
  const ov = $('qr-overlay');
  ov.style.display = 'flex';
  { const h=$('qr-hint'); if(h) h.textContent='Aponte para o código de barras'; }
  { const s=$('qr-status-txt'); if(s) s.textContent=''; }

  navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment', width:{ideal:1280} } })
    .then(stream => {
      qrStream = stream;
      const video = $('qr-video');
      video.srcObject = stream;
      video.play();
      video.addEventListener('loadedmetadata', () => {
        Quagga.init({
          inputStream: {
            name: 'Live',
            type: 'LiveStream',
            target: video,
            constraints: { facingMode:'environment' },
          },
          decoder: {
            readers: ['code_128_reader', 'ean_reader', 'ean_8_reader',
                       'code_39_reader', 'code_39_vin_reader',
                       'i2of5_reader'],
          },
          locate: true,
        }, (err) => {
          if (err) {
            fecharBarcode();
            toast('Erro no scanner: ' + err, 'err');
            return;
          }
          _barcodeRunning = true;
          Quagga.start();
        });

        Quagga.onDetected(result => {
          if (!_barcodeRunning) return;
          const code = result?.codeResult?.code;
          if (code) {
            fecharBarcode();
            const parsed = NFCE.fromScan(code);
            if (parsed?.chave || parsed?.cnpj || parsed?.valor) {
              const isNFe = parsed.modelo === '55';
              if (parsed.chave) {
                _salvarUrlQR(parsed.chave, code);   // só salva se for URL (QR); barcode = chave pura
                navigator.clipboard?.writeText(parsed.chave).catch(() => {});
                toast(isNFe ? 'Chave NF-e lida!' : 'Chave NFC-e lida!');
              }
              abrirFormNota({ ...parsed, metodo_captura:'barcode' });
            } else {
              toast('Código de barras não reconhecido (use a chave de 44 dígitos da NF-e/NFC-e)', 'err');
            }
          }
        });
      });
    })
    .catch(e => {
      fecharBarcode();
      toast('Câmera indisponível: ' + e.message, 'err');
    });
}

function fecharBarcode() {
  _barcodeRunning = false;
  try { Quagga?.stop(); } catch (_) {}
  qrStream?.getTracks().forEach(t => t.stop());
  qrStream = null;
  $('qr-overlay').style.display = 'none';
  { const h=$('qr-hint'); if(h) h.textContent='Aponte para o QR Code da NFCe'; }
}

/* ── Chave NFCe (digitar 44 dígitos) ──────────────────── */
function iniciarChaveNFCe() {
  const chave = prompt('Cole a chave de acesso de 44 dígitos (NF-e ou NFC-e):');
  if (!chave || !chave.trim()) return;
  onChaveNFCe(chave.trim());
}

async function onChaveNFCe(raw) {
  setLoading(true);
  try {
    const result = await SEFAZ.consultarChave(raw);
    const isNFe = result.modelo === '55';
    // igual ao QR lido: aba → comprovante (foto/arquivo) → OCR → formulário
    abrirSeletorTipoLancamento({
      cnpj           : result.cnpj || '',
      valor          : result.valor || '',
      data           : result.data || hoje(),
      razao_social   : result.razao_social || '',
      chave          : result.chave || '',
      uf             : result.uf || '',
      modelo         : result.modelo,
      metodo_captura : isNFe ? `nfe_${result.fonte}` : `chave_nfce_${result.fonte}`,
      mes            : result.mes,
      ano            : result.ano,
      _manual        : true,
    });
    toast(isNFe ? 'NF-e identificada pela chave — agora a foto' : 'NFC-e identificada pela chave — agora a foto');
  } catch (e) {
    toast(e.message, 'err');
  } finally { setLoading(false); }
}

/* ── FOTO DA NOTA — lê QR Code E texto da MESMA imagem ───────
   Uma foto só: tenta achar o QR (chave) com jsQR e, em paralelo,
   roda OCR p/ valor/data/CNPJ/razão. Junta tudo num formulário. */
function lerFotoNota() {
  fecharCaptura();
  $('f-foto-ocr').click();
}

/* carrega um blob como <img> */
function _blobToImg(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload  = () => { URL.revokeObjectURL(url); res(im); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('img')); };
    im.src = url;
  });
}

/* ── Compressão do anexo antes de guardar/enviar ──────────────
   A foto crua do celular tem 3 a 5 MB e o armazenamento do Supabase é
   limitado; com o lado maior em 1800 px o cupom continua legível e o
   arquivo cai para algo entre 200 e 500 KB.
   Roda no momento de SALVAR, depois de o OCR já ter lido a imagem
   original — reduzir aqui não piora a leitura do valor.
   PDF e XML passam intactos. Qualquer falha (HEIC do iPhone, que o
   canvas não decodifica) devolve o original: comprimir é otimização,
   nunca motivo para perder o anexo. */
/* 20/09/2026: 1800 px/q0,75 dava ~1 MB por nota; 1400 px/q0,72 fica em
   ~400 KB e o cupom continua legível (QR e OCR rodam antes, no original). */
const _FOTO_LADO_MAX   = 1400;
const _FOTO_QUALIDADE  = 0.72;
const _FOTO_MIN_COMPRIMIR = 400 * 1024;   // abaixo disso não vale o esforço

/* Orientação gravada no EXIF (1 = já está em pé). Lê só o começo do arquivo:
   o bloco EXIF vem nos primeiros KB de um JPEG. */
async function _exifOrientacao(blob) {
  try {
    if (!/^image\/jpe?g$/i.test(blob?.type || '')) return 1;
    const buf = await blob.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return 1;      // não é JPEG
    let i = 2;
    while (i + 4 < v.byteLength) {
      if (v.getUint8(i) !== 0xFF) { i++; continue; }                  // resincroniza
      const marca = v.getUint8(i + 1), tam = v.getUint16(i + 2);
      if (marca === 0xE1) {                                          // APP1 = EXIF
        const base = i + 10;
        if (v.getUint32(i + 4) !== 0x45786966) { i += 2 + tam; continue; }
        const little = v.getUint16(base) === 0x4949;
        const ifd = base + v.getUint32(base + 4, little);
        const n = v.getUint16(ifd, little);
        for (let t = 0; t < n; t++) {
          const e = ifd + 2 + t * 12;
          if (v.getUint16(e, little) === 0x0112) return v.getUint16(e + 8, little) || 1;
        }
        return 1;
      }
      if (marca === 0xDA || marca === 0xD9) return 1;                 // começou a imagem
      i += 2 + tam;
    }
  } catch (_) {}
  return 1;
}

/* Devolve a foto JÁ EM PÉ e sem EXIF de rotação. Só reencoda quando precisa
   — foto que já está certa passa direto, sem perder qualidade. */
async function _normalizarOrientacao(blob) {
  try {
    if (await _exifOrientacao(blob) <= 1) return blob;
    let fonte = null, bmp = null;
    if (window.createImageBitmap) {
      try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); fonte = bmp; } catch (_) {}
    }
    if (!fonte) fonte = await _blobToImg(blob);                       // <img> já vem girado nos navegadores atuais
    const w = fonte.width || fonte.naturalWidth, h = fonte.height || fonte.naturalHeight;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(fonte, 0, 0, w, h);
    try { bmp?.close?.(); } catch (_) {}
    const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
    return out && out.size ? out : blob;
  } catch (_) { return blob; }
}

async function _comprimirImagem(blob, ext) {
  /* endireita antes de qualquer coisa: o recorte, o OCR e o arquivo salvo
     passam a ver a foto na posição certa */
  try { blob = await _normalizarOrientacao(blob); } catch (_) {}
  if (!blob || !_ehImagemExt(ext || 'jpg')) return { blob, ext };
  if (blob.size <= _FOTO_MIN_COMPRIMIR)    return { blob, ext };
  try {
    const img = await _blobToImg(blob);
    const escala = Math.min(1, _FOTO_LADO_MAX / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width  = Math.max(1, Math.round(img.width  * escala));
    c.height = Math.max(1, Math.round(img.height * escala));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const menor = await new Promise(r => c.toBlob(r, 'image/jpeg', _FOTO_QUALIDADE));
    if (!menor || menor.size >= blob.size) return { blob, ext };   // nunca piora
    return { blob: menor, ext: 'jpg' };                            // reencodado
  } catch (_) { return { blob, ext }; }
}

/* LEITOR DE QR ROBUSTO — extrai o texto do QR de uma imagem.
   Estratégia que resolve "QR pequeno na foto da nota inteira":
   1) BarcodeDetector nativo (Android Chrome) — muito superior p/ QR denso
   2) jsQR como reserva
   3) TILING: divide a foto em pedaços com sobreposição e AMPLIA cada um,
      procurando o QR em cada parte — um QR minúsculo vira grande o bastante. */
async function _qrStringFromBlob(blob) {
  // prepara o detector nativo (se houver)
  let detector = null;
  try {
    if ('BarcodeDetector' in window) {
      let fmts = [];
      try { fmts = await window.BarcodeDetector.getSupportedFormats(); } catch (_) {}
      if (!fmts.length || fmts.includes('qr_code')) {
        detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      }
    }
  } catch (_) {}

  let img = null;
  try { await _ensureJsQR(); } catch (_) {}
  try { img = await _blobToImg(blob); } catch (_) {}
  if (!img) {
    // sem <img> não dá p/ recortar; tenta o detector direto no blob
    if (detector) {
      try {
        const bmp = await createImageBitmap(blob);
        const codes = await detector.detect(bmp);
        bmp.close && bmp.close();
        if (codes && codes.length && codes[0].rawValue) return codes[0].rawValue;
      } catch (_) {}
    }
    return null;
  }

  const c  = document.createElement('canvas');
  const cx = c.getContext('2d', { willReadFrequently: true });

  // roda os dois leitores no que estiver desenhado no canvas
  const lerCanvas = async (binarizar) => {
    if (detector) {
      try { const codes = await detector.detect(c); if (codes && codes.length && codes[0].rawValue) return codes[0].rawValue; } catch (_) {}
    }
    if (typeof jsQR !== 'undefined') {
      try {
        const d = cx.getImageData(0, 0, c.width, c.height);
        if (binarizar) {
          const a = d.data;
          for (let i = 0; i < a.length; i += 4) {
            const g = a[i]*0.299 + a[i+1]*0.587 + a[i+2]*0.114;
            const v = g > 128 ? 255 : 0; a[i]=a[i+1]=a[i+2]=v;
          }
          cx.putImageData(d, 0, 0);
        }
        const code = jsQR(d.data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
        if (code?.data) return code.data;
      } catch (_) {}
    }
    return null;
  };

  // desenha um recorte (sx,sy,sw,sh) ampliado p/ ~maxLado no maior lado
  const desenhar = (sx, sy, sw, sh, maxLado) => {
    const scale = Math.min(maxLado / Math.max(sw, sh), 5);   // amplia até 5x
    const dw = Math.max(1, Math.round(sw*scale)), dh = Math.max(1, Math.round(sh*scale));
    c.width = dw; c.height = dh;
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
  };

  // 1) imagem inteira, algumas resoluções (+ uma binarizada)
  for (const m of [Math.min(Math.max(img.width, img.height), 3000), 2000, 1400]) {
    desenhar(0, 0, img.width, img.height, m);
    const r = await lerCanvas(false); if (r) return r;
  }
  desenhar(0, 0, img.width, img.height, 2000);
  { const r = await lerCanvas(true); if (r) return r; }

  // 2) TILING — grades 2x2, 3x3 e 4x4 com 25% de sobreposição
  for (const n of [2, 3, 4]) {
    const tw = img.width / n, th = img.height / n, ov = 0.25;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const sx = Math.max(0, (col - ov) * tw);
        const sy = Math.max(0, (row - ov) * th);
        const sw = Math.min(img.width  - sx, tw * (1 + 2*ov));
        const sh = Math.min(img.height - sy, th * (1 + 2*ov));
        desenhar(sx, sy, sw, sh, 1300);
        const r = await lerCanvas(false); if (r) return r;
      }
    }
  }
  return null;
}

/* compat: devolve o texto do QR de uma imagem (usa o leitor robusto) */
function _lerQRDeImagem(blob) {
  return _qrStringFromBlob(blob);
}

async function onFotoNota(e) {
  const file = e.target.files[0];
  if (!file) return;

  const ov = $('ocr-overlay');
  ov.style.display = 'flex';
  $('ocr-progress').textContent = 'Lendo a nota…';

  const dados = { metodo_captura: 'foto' };

  // 1) tenta ler o QR Code da própria foto (chave NFC-e)
  try {
    await _ensureJsQR().catch(() => {});
    const qrTxt = await _lerQRDeImagem(file);
    if (qrTxt) {
      let parsed = NFCE.fromScan(qrTxt);
      if (!(parsed?.chave)) {
        const m = qrTxt.replace(/\D/g, '').match(/\d{44}/);
        if (m) parsed = NFCE.parseChave44(m[0]);
      }
      if (parsed?.chave) {
        Object.assign(dados, parsed);
        _salvarUrlQR(parsed.chave, qrTxt);
      }
    }
  } catch (_) {}

  // 2) OCR do texto p/ preencher o que o QR não traz (valor, data, CNPJ, razão)
  try {
    $('ocr-progress').textContent = 'Lendo o texto da nota…';
    const r = await OCR.processar(file);
    dados.cnpj         = dados.cnpj         || r.cnpj         || '';
    dados.valor        = dados.valor        || r.valor        || '';
    dados.data         = dados.data         || r.data         || hoje();
    dados.razao_social = dados.razao_social || r.razao_social || '';
    dados.chave        = dados.chave        || r.chave        || '';
    dados.uf           = dados.uf           || r.uf           || '';
  } catch (_) {}

  ov.style.display = 'none';
  e.target.value = '';

  if (!dados.chave && !dados.cnpj && !dados.valor) {
    toast('Não consegui ler a nota. Tente uma foto mais nítida ou use "Manual".', 'err');
  }

  // abre o formulário e ANEXA a foto (abrirFormNota zera fotoBlob, então setamos depois)
  await abrirFormNota(dados);
  fotoBlob = file;
  fotoExt  = _extDoArquivo(file);
  fotoURL  = URL.createObjectURL(file);
  atualizarPreviewFoto(fotoURL);
}

/* ── Form Nota ───────────────────────────────────────────── */
let _dadosLancamentoPendentes = null;

function abrirSeletorTipoLancamento(dados = {}) {
  /* Veio de uma aba do hub (22/09/2026): o tipo já está escolhido, então o
     passo 1 é pulado. O aviso de sugestão passa a aparecer no passo 2. */
  if (!dados.tipo && _abaPreEscolhida) dados = { ...dados, tipo: _abaPreEscolhida };
  /* 24/09/2026: no CV a categoria e a forma de pagamento já foram escolhidas
     nas telas anteriores — pelo caminho do QR elas chegam por aqui. */
  if (!dados.subtipo && _subtipoPreEscolhido) dados = { ...dados, subtipo: _subtipoPreEscolhido };
  if (!dados.pagamento && _pagamentoPreEscolhido) dados = { ...dados, pagamento: _pagamentoPreEscolhido };
  _abaPreEscolhida = null;
  _subtipoPreEscolhido = null;
  _pagamentoPreEscolhido = null;
  _dadosLancamentoPendentes = dados || {};
  const ov = $('tipo-lancamento-overlay');
  if (ov) ov.style.display = 'flex';
  _montarGradeDoSeletor();
  const dica2 = $('tipo-lancamento-dica2'); if (dica2) dica2.textContent = '';
  /* Fornecedor conhecido (chave/CNPJ/nome): até 20/09 o app escolhia a aba
     sozinho e pulava o passo 1. Reunião de 21/09/2026: a escolha é SEMPRE
     manual — a sugestão vira só um aviso embaixo do título, e a pessoa toca
     em RDA ou RDM. (Na fase 3 entra o CV, conforme o regime do colaborador.) */
  const d = _dadosLancamentoPendentes;
  const dica = $('tipo-lancamento-dica'); if (dica) dica.textContent = '';
  if (d.cnpj || d.chave || d.razao_social) {
    sugerirAba(d).then(s => {
      if (!s || _dadosLancamentoPendentes !== d) return;                // já escolheu/fechou
      d._sugestao = s;
      /* aba já escolhida: só aproveita a categoria se a sugestão for da MESMA
         aba — senão um "Abastecimento" (RDM) entraria numa nota de RDA */
      if (!d.tipo || s.tipo === d.tipo) d.subtipo = s.subtipo || d.subtipo;
      const txt = `Sugestão para este fornecedor: ${s.tipo}${s.tipo === 'RDM' && s.subtipo ? ' · ' + s.subtipo : ''} (${s.rotulo}). Você decide.`;
      if (dica) dica.textContent = txt;
      /* aba já escolhida e a sugestão aponta para a outra: avisa no passo 2 */
      const dv = $('tipo-lancamento-dica2');
      if (dv && d.tipo) dv.textContent = s.tipo === d.tipo ? '' : `⚠️ ${txt} Toque em "Trocar" se for o caso.`;
      /* sugestão da MESMA aba: completa a pílula (a categoria chegou depois) */
      const pill = $('tipo-lancamento-passo2-aba');
      if (pill && d.tipo && s.tipo === d.tipo) {
        pill.textContent = `${d.tipo} · ${s.subtipo && d.tipo === 'RDM' ? s.subtipo + ' · ' : ''}sugerido: ${s.rotulo}`;
      }
    }).catch(() => {});
  }
  if (d.tipo) selecionarTipoLancamento(d.tipo);   // pula o passo 1
}

function fecharSeletorTipoLancamento() {
  const ov = $('tipo-lancamento-overlay');
  if (ov) ov.style.display = 'none';
  const p1 = $('tipo-lancamento-passo1'), p2 = $('tipo-lancamento-passo2');
  if (p1) p1.style.display = '';
  if (p2) p2.style.display = 'none';
  const t = $('tipo-lancamento-titulo'); if (t) t.textContent = 'Selecione a aba para iniciar o lançamento';
  _dadosLancamentoPendentes = null;
}

/* Grade do passo 1: quatro categorias no regime de cartão, as duas abas nos
   demais (24/09/2026). */
function _montarGradeDoSeletor() {
  const cv = $('tipo-lancamento-grid-cv'), abas = $('tipo-lancamento-grid-abas');
  if (!cv || !abas) return;
  const ehCv = _ehCV();
  cv.style.display = ehCv ? '' : 'none';
  abas.style.display = ehCv ? 'none' : '';
  const titulo = $('tipo-lancamento-passo1')?.querySelector('p');
  if (titulo) {
    titulo.textContent = ehCv
      ? 'Escolha a categoria da despesa. É por ela que a nota entra na planilha.'
      : 'Escolha com atenção a aba correta antes de preencher a nota. Isso evita lançar a despesa na aba errada.';
  }
  if (!ehCv || cv.dataset.pronto === '1') return;
  cv.innerHTML = CATEGORIAS_CV.map(c => `
    <button class="tipo-lancamento-card tipo-lancamento-card-${c.tipo.toLowerCase()}"
            onclick="selecionarTipoLancamento('${c.tipo}', ${c.subtipo ? "'" + c.subtipo + "'" : 'null'})">
      <div class="tipo-lancamento-icon">${c.ico}</div>
      <div class="tipo-lancamento-title">${esc(c.nome)}</div>
      <div class="tipo-lancamento-subtitle">${esc(c.sub)}</div>
    </button>`).join('');
  cv.dataset.pronto = '1';
}

function selecionarTipoLancamento(tipo, subtipo = null) {
  /* MESMO objeto de _dadosLancamentoPendentes (22/09/2026): a consulta de
     sugestão do fornecedor compara por identidade para saber se ainda vale.
     Com a aba já escolhida na tela de Despesas, a escolha acontece no mesmo
     instante da abertura — uma cópia aqui descartaria a sugestão que ainda
     está a caminho, e o aviso "a sugestão é a outra aba" nunca apareceria. */
  const dados = Object.assign(_dadosLancamentoPendentes || {}, { tipo, _tipoSelecionado: true });
  if (subtipo) dados.subtipo = subtipo;   // regime CV: a categoria vem junto (24/09/2026)
  /* Lançamento MANUAL: em vez de abrir o formulário vazio, pergunta já o
     comprovante (pedido em 16/09/2026). O anexo é obrigatório de qualquer
     jeito, e a câmera só abre em gesto do usuário — por isso um toque a mais
     aqui, e não um "abrir sozinho" que o celular bloquearia. */
  if (dados._manual) {
    _dadosLancamentoPendentes = dados;
    const pill = $('tipo-lancamento-passo2-aba');
    const s = dados._sugestao;
    if (pill) {
      pill.textContent = tipo + (s && s.tipo === tipo ? ` · ${s.subtipo && tipo === 'RDM' ? s.subtipo + ' · ' : ''}sugerido: ${s.rotulo}` : '');
      pill.className = `nota-aba-pill ${tipo === 'RDA' ? 'rda' : 'rdm'}`;
    }
    const trocar = $('tipo-lancamento-trocar'); if (trocar) trocar.style.display = '';
    $('tipo-lancamento-passo1').style.display = 'none';
    $('tipo-lancamento-passo2').style.display = '';
    const t = $('tipo-lancamento-titulo'); if (t) t.textContent = 'Comprovante da nota';
    return;
  }
  fecharSeletorTipoLancamento();
  abrirFormNota(dados);
}

/* Passo 2 do manual: abre o formulário e, no MESMO gesto, a câmera ou o
   seletor de arquivo. abrirFormNota preenche os campos de forma síncrona
   antes de qualquer await, então o input já está dentro do formulário certo
   quando o onchange chegar. */
let _formEsperandoLeitura = false;   // formulário montado mas escondido até o OCR acabar
function voltarEscolhaAba() {
  const d2 = $('tipo-lancamento-dica2'); if (d2) d2.textContent = '';
  $('tipo-lancamento-passo2').style.display = 'none';
  $('tipo-lancamento-passo1').style.display = '';
  const t = $('tipo-lancamento-titulo'); if (t) t.textContent = 'Selecione a aba para iniciar o lançamento';
  if (_dadosLancamentoPendentes) { delete _dadosLancamentoPendentes._sugestao; delete _dadosLancamentoPendentes.subtipo; }
}
function lancarManualComAnexo(modo) {
  const dados = { ...(_dadosLancamentoPendentes || {}) };
  delete dados._manual; delete dados._sugestao;
  fecharSeletorTipoLancamento();
  abrirFormNota(dados);                // parte síncrona: campos preenchidos e overlay aberto
  if (modo === 'foto' || modo === 'arquivo') {
    /* Foto ANTES do formulário: a pessoa só vê a tela depois que QR/OCR
       leram o que dava (valor, CNPJ, número…) — menos digitação. Se cancelar
       a câmera, o formulário aparece do mesmo jeito (evento cancel). */
    _formEsperandoLeitura = true;
    $('nota-form-overlay').style.display = 'none';
    const inp = $(modo === 'foto' ? 'f-foto-nota' : 'f-arq-nota');
    inp?.addEventListener('cancel', _mostrarFormAposLeitura, { once: true });
    inp?.click();
  } else {
    _pedirFotoPasso2();
  }
}
function _mostrarFormAposLeitura() {
  if (!_formEsperandoLeitura) return;
  _formEsperandoLeitura = false;
  const ov = $('nota-form-overlay');
  if (ov) ov.style.display = 'flex';
  if (!fotoBlob) _pedirFotoPasso2();   // cancelou a câmera: continua pedindo o anexo
}

async function abrirFormNota(dados = {}) {
  if (!dados.id && !dados._tipoSelecionado && !dados._skipTipoSelector) {
    abrirSeletorTipoLancamento(dados);
    return;
  }
  fotoBlob = null; fotoOriginal = null; fotoURL = null; fotoExt = null; _setFotoRender(null);
  _limparPedirFoto();                 // reseta destaque do Passo 2 a cada abertura
  const ov = $('nota-form-overlay');
  ov.style.display = 'flex';

  $('nf-id').value       = dados.id       || '';
  $('nf-owner-id').value = dados.user_id || user?.id || '';
  $('nf-metodo').value   = dados.metodo_captura || 'manual';
  $('nf-chave').value    = dados.chave    || dados.chave_nfce || '';
  $('nf-qr-url').value   = dados.qr_url   || '';
  $('nf-consumidor').value = (dados.consumidor || '').replace(new RegExp(String.fromCharCode(92) + 'D', 'g'), '');
  _docEscolhidoManual = false;
  $('nf-documento').value = (dados.documento && DOC_LABEL[dados.documento]) ? dados.documento : '';
  $('nf-numero').value   = dados.numero   || '';
  $('nf-serie').value    = dados.serie    || '';
  $('nf-uf').value       = dados.uf       || '';
  $('nf-tipo').value     = dados.tipo     || 'RDA';
  $('nf-subtipo').value  = dados.subtipo  || 'Abastecimento';
  /* Pagamento: só para colaborador CV (dono da nota); RDM/RDA não vê o campo */
  { const donoId = dados.user_id || user?.id; const donoCV = donoId === user?.id ? _ehCV() : _ehCV(equipePorId[donoId]);
    const g = $('nf-pagamento-group'); if (g) g.style.display = donoCV ? '' : 'none';
  _ajustarCamposDeCategoria();
    const p = $('nf-pagamento'); if (p) p.value = dados.pagamento || 'cv'; }
  _valorEditadoManual = false; _sugestaoPendente = null;
  { const box = $('nota-aba-sugestao'); if (box) box.style.display = 'none'; }
  /* nota já com URL do QR e sem valor (ex.: importada antes do 141): busca o oficial */
  if (dados.qr_url && dados.chave_nfce && !(Number(dados.valor) > 0)) _sefazPorQr(dados.qr_url, dados.chave_nfce);
  $('nf-data').value     = dados.data     || hoje();
  $('nf-valor').value    = dados.valor    || '';
  $('nf-cnpj').value     = dados.cnpj ? BrasilAPI.formatar(dados.cnpj) : '';
  $('nf-razao').value    = dados.razao_social || '';
  $('nf-obs').value      = dados.observacao   || '';

  // mês/ano vêm dos dados ou do filtro atual
  $('nf-mes').value = dados.mes || filMes;
  $('nf-ano').value = dados.ano || filAno;

  // badge de captura
  const badges = { foto:'📷 Foto da nota', qrcode:'📷 QR Code', ocr:'🔍 OCR', manual:'✏️ Manual', barcode:'📊 Cód. Barras', chave_nfce_chave:'🔑 Chave', chave_nfce_sefaz_json:'🌐 SEFAZ', chave_nfce_sefaz_proxy:'🌐 SEFAZ', chave_nfce_sefaz_html:'🌐 SEFAZ' };
  const _modelo = dados.modelo || (_digitos(dados.chave).length === 44 ? _digitos(dados.chave).slice(20,22) : '');
  $('captura-badge').textContent = _modelo === '55'
    ? '🧾 NF-e (chave)'
    : (badges[dados.metodo_captura||'manual'] || '✏️ Manual');

  toggleSubtipo();

  // foto: prioriza local → Drive → Supabase
  if (dados.id) {
    const local = await DB.getFotoLocal(dados.id);
    if (local?.blob) {
      fotoBlob = local.blob;
      fotoExt  = local.ext || _extDoArquivo(local.blob);
      fotoURL  = URL.createObjectURL(local.blob);
      atualizarPreviewFoto(fotoURL);
      if (fotoExt === 'pdf') _renderizarPreviewPdfAsync(local.blob);  // puxa a imagem em background
    } else {
      fotoExt = _extDeUrl(dados.foto_path || '') || GDrive.getFotoExt?.(dados.id) || null;
      const driveUrl = GDrive.getFotoUrl?.(dados.id);
      atualizarPreviewFoto(driveUrl || (dados.foto_path ? `supabase:${dados.foto_path}` : null));
    }
  } else {
    atualizarPreviewFoto(null);
  }

  // se vier com CNPJ, busca razão social automaticamente
  if (dados.cnpj && !dados.razao_social) buscarRazaoSocial(dados.cnpj);

  // enriquecimento automático via SEFAZ (sempre que tiver chave NFCe)
  if (dados.chave && dados.chave.length === 44 && !dados.id) {
    enriquecerViaSefaz(dados.chave);
  }

  // link de consulta no SEFAZ (quando há chave de 44 dígitos)
  _atualizarLinkConsulta();

  // título e banner de correção por gestor/admin
  const isGestorEdit = _ehGestorOuAdmin() && !!dados.id && _ehNotaDeOutroUsuario(dados);
  const banner = $('gestor-edit-banner');
  const bannerTitle = $('gestor-edit-title');
  const bannerText = $('gestor-edit-text');
  if (banner) banner.style.display = isGestorEdit ? 'flex' : 'none';
  if (bannerTitle) bannerTitle.textContent = 'Correção de gestor';
  if (bannerText) bannerText.textContent = `Você está corrigindo a nota de ${_rotuloProprietario(dados)}. A alteração preserva o lançamento original do colaborador.`;
  $('nf-titulo').textContent = dados.id ? (isGestorEdit ? `Editar nota · ${_rotuloProprietario(dados)}` : 'Editar Nota') : 'Nova Nota';
}

/* edição de nota com PDF salvo: renderiza a 1ª página em background p/ preview */
async function _renderizarPreviewPdfAsync(blob) {
  try {
    const { blob: img } = await _renderPdfPagina1(blob);
    if (fotoBlob !== blob) return;   // usuário trocou o anexo enquanto renderizava
    _setFotoRender(img);
    atualizarPreviewFoto(fotoURL);
  } catch (_) {}
}

/* mostra/esconde o link "Consultar no SEFAZ" conforme a chave do formulário */
function _atualizarLinkConsulta() {
  const cl = $('nf-consulta');
  _mostrarChaveNota();   // mostra/esconde a chave abaixo da foto
  if (!cl) return;
  const qrUrl = $('nf-qr-url')?.value || '';
  if (_digitos($('nf-chave').value).length === 44 || /^https?:\/\//i.test(qrUrl)) {
    cl.style.display = 'inline-block';
    cl.textContent = /^https?:\/\//i.test(qrUrl) && _digitos($('nf-chave').value).length !== 44 ? '🔗 Abrir a NFS-e no portal' : '🔗 Consultar nota no SEFAZ';
    cl.onclick = () => abrirConsultaChave($('nf-chave').value, qrUrl || null);
  } else {
    cl.style.display = 'none';
    cl.onclick = null;
  }
}

/* enriquece formulário com dados do SEFAZ em background */
async function enriquecerViaSefaz(chave) {
  try {
    $('captura-badge').textContent = '🌐 Buscando dados oficiais…';
    const result = await SEFAZ.consultarChave(chave);
    let enriquecido = false;
    if (result.razao_social) {
      $('nf-razao').value = result.razao_social;
      enriquecido = true;
    }
    if (result.valor) {
      $('nf-valor').value = result.valor;
      enriquecido = true;
    }
    if (result.data) {
      $('nf-data').value = result.data;
      $('nf-mes').value = result.mes;
      $('nf-ano').value = result.ano;
      enriquecido = true;
    }
    if (result.cnpj && !$('nf-cnpj').value) {
      $('nf-cnpj').value = BrasilAPI.formatar(result.cnpj);
      enriquecido = true;
    }
    if (enriquecido) {
      $('captura-badge').textContent = '🌐 Dados oficiais SEFAZ';
      if (result.fonte && result.fonte !== 'chave') toast('Dados enriquecidos via SEFAZ');
    } else {
      $('captura-badge').textContent = '📷 QR Code';
    }
  } catch (_) {
    $('captura-badge').textContent = '📷 QR Code';
  }
}

function fecharFormNota() {
  _formEsperandoLeitura = false;
  $('nota-form-overlay').style.display = 'none';
}

function atualizarBannerTipoLancamento(tipo = $('nf-tipo')?.value || 'RDA') {
  const pill = $('nota-aba-pill');
  const btn = $('nota-aba-switch');
  if (!pill || !btn) return;
  const isRda = tipo === 'RDA';
  pill.className = `nota-aba-pill ${isRda ? 'rda' : 'rdm'}`;
  pill.textContent = `Aba selecionada: ${isRda ? 'RDA' : 'RDM'}`;
  btn.textContent = isRda ? 'Trocar para RDM' : 'Trocar para RDA';
}

function alternarTipoLancamentoFormulario() {
  const tipo = $('nf-tipo').value === 'RDA' ? 'RDM' : 'RDA';
  $('nf-tipo').value = tipo;
  toggleSubtipo();
}

/* Regime CV (24/09/2026): a pessoa escolhe UMA categoria; o app traduz para
   o par tipo/subtipo que o banco e a planilha usam. */
function aplicarCategoriaCV() {
  const c = _categoriaCV($('nf-cat-cv').value);
  if (!c) return;
  $('nf-tipo').value = c.tipo;
  $('nf-subtipo').value = c.subtipo || 'Abastecimento';
  atualizarBannerTipoLancamento(c.tipo);
}

/* Mostra a escolha certa para o regime e deixa a categoria no valor da nota. */
function _ajustarCamposDeCategoria() {
  const grupo = $('nf-cat-cv-group'), linha = $('nf-aba-row');
  if (!grupo || !linha) return;
  const ehCv = _ehCV();
  grupo.style.display = ehCv ? '' : 'none';
  linha.style.display = ehCv ? 'none' : '';
  if (!ehCv) return;
  const sel = $('nf-cat-cv');
  sel.value = _chaveCategoriaDaNota({ tipo: $('nf-tipo').value, subtipo: $('nf-subtipo').value });
  aplicarCategoriaCV();
}

function toggleSubtipo() {
  const tipo = $('nf-tipo').value || 'RDA';
  $('nf-subtipo-group').style.display = tipo === 'RDM' ? '' : 'none';
  if (tipo === 'RDM') {
    if (!$('nf-subtipo').value) $('nf-subtipo').value = 'Abastecimento';
  } else {
    $('nf-subtipo').value = 'Abastecimento';
  }
  atualizarBannerTipoLancamento(tipo);
}

let _cnpjTimer;
function onCNPJChange() {
  clearTimeout(_cnpjTimer);
  _cnpjTimer = setTimeout(() => buscarRazaoSocial($('nf-cnpj').value), 800);
}

async function buscarRazaoSocial(raw) {
  const cnpj = BrasilAPI.limpar(raw);
  if (cnpj.length !== 14) return;
  $('cnpj-spin').style.display = 'inline-block';
  const r = await BrasilAPI.consultar(cnpj, sb);
  $('cnpj-spin').style.display = 'none';
  if (r?.razao_social) $('nf-razao').value = r.razao_social;
}

async function onFotoNotaChange(e) {
  let file = e.target.files[0];
  if (!file) return;
  /* 23/09/2026: endireita ANTES de tudo — recorte, OCR, anexo e miniatura
     passam a trabalhar com a foto na posição certa. */
  try { file = await _normalizarOrientacao(file); } catch (_) {}
  _limparPedirFoto();               // foto anexada → tira o destaque do Passo 2
  fotoBlob = file;
  fotoOriginal = file;
  fotoExt  = 'jpg';                 // câmera sempre devolve imagem
  fotoURL  = URL.createObjectURL(file);
  atualizarPreviewFoto(fotoURL);
  // lê a própria foto anexada (OCR) e preenche os campos vazios
  try { await extrairDadosDaFoto(file); }
  finally { _mostrarFormAposLeitura(); }
}

/* Anexar arquivo já existente no aparelho: imagem, PDF ou XML da NF-e.
   - imagem  → OCR (lê valor/empresa) como na foto
   - XML     → faz o parse e preenche tudo (autoritativo)
   - PDF     → só anexa (sem leitura automática) */
async function onArquivoNotaChange(e) {
  let file = e.target.files[0];
  if (!file) return;
  try { file = await _normalizarOrientacao(file); } catch (_) {}   // 23/09/2026
  _limparPedirFoto();               // arquivo anexado → tira o destaque do Passo 2
  fotoBlob = file;
  fotoOriginal = file;
  fotoExt  = _extDoArquivo(file);
  fotoURL  = URL.createObjectURL(file);
  atualizarPreviewFoto(fotoURL);
  try {
    if (_ehImagemExt(fotoExt))      await extrairDadosDaFoto(file);
    else if (fotoExt === 'xml')     await extrairDadosDoXML(file);
    else /* pdf */                  await extrairDadosDoPDF(file);
  } finally { _mostrarFormAposLeitura(); }
}

/* PDF anexado → renderiza a 1ª página como imagem (vira o preview)
   e lê os dados: texto embutido do PDF (DANFE digital) ou QR/OCR da imagem. */
async function extrairDadosDoPDF(file) {
  const ov = $('ocr-overlay');
  ov.style.display = 'flex';
  $('ocr-progress').textContent = 'Lendo o PDF…';
  try {
    const { blob, texto } = await _renderPdfPagina1(file);
    _setFotoRender(blob);
    atualizarPreviewFoto(fotoURL);   // agora mostra a imagem da 1ª página
    // PDF digital (DANFE) traz o texto embutido — mais confiável que OCR
    const temTexto  = texto.replace(/\s/g, '').length >= 40;
    const ocrPronto = temTexto ? OCR.parseFiscalText(texto) : null;
    await extrairDadosDaFoto(blob, ocrPronto);  // QR da imagem + preenche campos
  } catch (err) {
    ov.style.display = 'none';
    toast('Não consegui ler este PDF — anexado mesmo assim.', 'err');
  }
}

/* Lê o XML da NF-e/NFC-e e preenche os campos (a chave é autoritativa). */
async function extrairDadosDoXML(file) {
  const ov = $('ocr-overlay');
  if (ov) { ov.style.display = 'flex'; $('ocr-progress').textContent = 'Lendo o XML da nota…'; }
  try {
    const txt = await file.text();
    const doc = new DOMParser().parseFromString(txt, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('XML inválido');
    const T = sel => doc.querySelector(sel)?.textContent?.trim() || '';

    const preencheu = [];

    // chave: do atributo Id (infNFe Id="NFe<44 dígitos>") ou de <chNFe>
    let chave = _digitos(doc.querySelector('infNFe')?.getAttribute('Id') || '');
    if (chave.length !== 44) chave = _digitos(T('chNFe'));
    const daChave = (chave.length === 44) ? NFCE.parseChave44(chave) : null;
    if (chave.length === 44) {
      $('nf-chave').value = chave;
      if ($('nf-uf'))  $('nf-uf').value  = daChave?.uf  || $('nf-uf').value;
      if ($('nf-mes')) $('nf-mes').value = daChave?.mes || $('nf-mes').value;
      if ($('nf-ano')) $('nf-ano').value = daChave?.ano || $('nf-ano').value;
      _atualizarLinkConsulta();
    }

    // número e série (<ide><nNF>, <ide><serie>)
    if (T('ide nNF')) { _preencherNumeroSerie(T('ide nNF').replace(/^0+/, ''), T('ide serie').replace(/^0+/, '') || '0', true); preencheu.push('número'); }

    /* consumidor da nota (24/09/2026): no XML ele vem em <dest>, e é o que
       a regra da empresa olha — sem consumidor ou no CNPJ dela. */
    const dest = _digitos(T('dest CNPJ')) || _digitos(T('dest CPF'));
    if (dest.length === 11 || dest.length === 14) $('nf-consumidor').value = dest;

    // CNPJ + razão social do emitente
    const cnpj = _digitos(T('emit CNPJ'));
    if (cnpj.length === 14) {
      $('nf-cnpj').value = BrasilAPI.formatar(cnpj); preencheu.push('CNPJ');
      const xNome = T('emit xNome');
      if (xNome) $('nf-razao').value = xNome; else buscarRazaoSocial(cnpj);
    }

    // data de emissão (dhEmi = ISO; dEmi = AAAA-MM-DD)
    const dh = T('ide dhEmi') || T('ide dEmi');
    if (dh) {
      const d = dh.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        $('nf-data').value = d; preencheu.push('data');
        if (chave.length !== 44) {   // sem chave autoritativa → mês/ano vêm da data
          $('nf-mes').value = parseInt(d.slice(5, 7), 10);
          $('nf-ano').value = parseInt(d.slice(0, 4), 10);
        }
      }
    }

    // valor total da nota
    const vNF = parseFloat(T('ICMSTot vNF') || T('vNF'));
    if (!isNaN(vNF) && vNF > 0) { $('nf-valor').value = vNF.toFixed(2); preencheu.push('valor'); }

    if (ov) ov.style.display = 'none';
    toast(preencheu.length ? `XML lido: ${preencheu.join(', ')}.` : 'XML anexado. Confira os campos.',
          preencheu.length ? 'ok' : 'err');
  } catch (err) {
    if (ov) ov.style.display = 'none';
    toast('Não consegui ler este XML: ' + err.message + ' — anexado mesmo assim.', 'err');
  }
}

/* Lê um QR Code dentro de uma imagem (foto do cupom) usando o leitor robusto
   (BarcodeDetector nativo → jsQR). Devolve os campos da chave NFC-e. */
async function _lerQRdaImagem(file) {
  const data = await _qrStringFromBlob(file);
  if (!data) return null;
  let p = NFCE.fromScan(data);
  if (!(p?.chave)) {
    const m = String(data).replace(/\D/g, '').match(/\d{44}/);
    if (m) p = NFCE.parseChave44(m[0]);
  }
  if (p?.chave) {
    _salvarUrlQR(p.chave, data);   // guarda o link real da consulta
    if (/^https?:\/\//i.test(data)) p.qr_url = data;
  }
  if (!(p?.chave) && _ehUrlNfse(data)) return { qr_url: data, documento: 'nfse' };
  return p;
}

/* Botão "Ler QR da foto e inserir a chave" — usa a foto anexada
   (ou a imagem renderizada da 1ª página, no caso de PDF) */
async function lerChaveDaFotoAnexada() {
  // foto inteira (antes do recorte) quando houver: o QR pode ter ficado fora do enquadramento
  const alvo = _ehImagemExt(fotoExt || 'jpg') ? (fotoOriginal || fotoBlob) : fotoRender;
  if (!alvo) { toast('Anexe uma foto da nota primeiro', 'err'); return; }
  const ov = $('ocr-overlay');
  if (ov) { ov.style.display = 'flex'; $('ocr-progress').textContent = 'Procurando QR Code na foto…'; }
  const qr = await _lerQRdaImagem(alvo);
  if (ov) ov.style.display = 'none';
  if (qr?.chave && qr.chave.length === 44) {
    $('nf-chave').value = qr.chave;
    if (qr.uf && !$('nf-uf').value) $('nf-uf').value = qr.uf;
    if (qr.cnpj && !$('nf-cnpj').value) $('nf-cnpj').value = BrasilAPI.formatar(qr.cnpj);
    _atualizarLinkConsulta();
    _mostrarChaveNota();
    toast('Chave inserida pelo QR! 🔑');
  } else if (qr?.documento === 'nfse') {
    $('nf-qr-url').value = qr.qr_url;
    _docEscolhidoManual = false;
    _atualizarDocumentoAuto();
    _atualizarLinkConsulta();
    toast('QR de NFS-e lido — link da nota guardado 🧰');
  } else {
    toast('Não achei QR nesta foto. Use uma foto mais nítida do QR Code.', 'err');
  }
}

/* mostra a chave de acesso (quando preenchida) abaixo da foto */
function _mostrarChaveNota() {
  const el = $('nf-chave-show');
  if (el) {
    const c = _digitos($('nf-chave').value);
    if (c.length === 44) { el.style.display = 'block'; el.textContent = '🔑 Chave: ' + c; }
    else { el.style.display = 'none'; el.textContent = ''; }
  }
  _atualizarBotaoLerChave();   // chave mudou → reavalia se mostra o botão de reserva
  _atualizarDocumentoAuto();   // chave/anexo mudou → reclassifica o documento
  _atualizarNumeroSerieAuto(); // número/série saem da chave
}

/* Foto anexada → múltiplos buscadores (QR + OCR + CNPJ + SEFAZ).
   Combina os resultados e preenche só os campos vazios.
   ocrPronto: resultado de parse já extraído (ex.: texto embutido de PDF) — pula o OCR. */
async function extrairDadosDaFoto(file, ocrPronto = null) {
  const ov = $('ocr-overlay');
  ov.style.display = 'flex';
  $('ocr-progress').textContent = 'Procurando QR Code…';
  try {
    // Busca 1: QR Code na foto INTEIRA — o QR pode cair fora do recorte
    const qr = await _lerQRdaImagem(file);

    // OCR do texto impresso — usado principalmente para o VALOR
    let ocr = ocrPronto || {};
    if (!ocrPronto) {
      /* Recorte antes do OCR: lendo a foto toda, mesa, mão e a nota do lado
         entram no texto e viram valor/CNPJ errado.
         O enquadramento confirmado vira o ANEXO, em resolução original —
         no fluxo do QR também (build 118). Entre 112 e 117 o fluxo com
         chave guardava a foto inteira, e como toda NFC-e passa por ali o
         recorte nunca era salvo. O que permite cortar sem medo é a garantia
         do Recorte de conter o papel inteiro. "Foto inteira" mantém o
         original; `fotoOriginal` segue guardado para o "Ler QR da foto". */
      let alvo = file;
      if (window.Recorte) {
        ov.style.display = 'none';                 // o recorte assume a tela
        try { alvo = (await Recorte.abrir(file)) || file; } catch (_) { alvo = file; }
        ov.style.display = 'flex';
        if (alvo !== file) {
          fotoBlob = alvo;
          fotoExt  = 'jpg';
          if (fotoURL) { try { URL.revokeObjectURL(fotoURL); } catch (_) {} }
          fotoURL  = URL.createObjectURL(alvo);
          atualizarPreviewFoto(fotoURL);
        }
      }
      $('ocr-progress').textContent = 'Lendo o texto…';
      try { ocr = await OCR.processar(alvo); } catch (_) {}
    }

    if (qr?.documento === 'nfse' && !$('nf-qr-url').value) { $('nf-qr-url').value = qr.qr_url; _atualizarDocumentoAuto(); }
    // chave: QR desta foto → formulário (veio do "Escanear QR") → texto lido
    let chave = (qr?.chave && qr.chave.length === 44) ? qr.chave : _digitos($('nf-chave').value);
    if (chave.length !== 44 && _digitos(ocr.chave).length === 44) chave = _digitos(ocr.chave);
    if (chave.length !== 44) chave = '';
    const daChave = chave ? NFCE.parseChave44(chave) : null;

    const preencheu = [];

    if (daChave) {
      // ✅ A CHAVE É AUTORITATIVA: CNPJ, empresa, UF, mês/ano e data vêm dela
      if (_digitos($('nf-chave').value).length !== 44) $('nf-chave').value = chave;
      $('nf-cnpj').value = BrasilAPI.formatar(daChave.cnpj);     // sobrescreve qualquer OCR errado
      if ($('nf-uf'))  $('nf-uf').value  = daChave.uf || $('nf-uf').value;
      if ($('nf-mes')) $('nf-mes').value = daChave.mes;
      if ($('nf-ano')) $('nf-ano').value = daChave.ano;
      _atualizarLinkConsulta();
      buscarRazaoSocial(daChave.cnpj);                            // razão social confiável (BrasilAPI)
      preencheu.push('CNPJ/empresa');

      // data: dia exato do OCR só se cair no MESMO mês/ano da chave; senão, dia 01
      let dataFinal = `${daChave.ano}-${String(daChave.mes).padStart(2,'0')}-01`;
      if (ocr.data && ocr.data.slice(0,7) === dataFinal.slice(0,7)) dataFinal = ocr.data;
      $('nf-data').value = dataFinal; preencheu.push('data');
    } else {
      // sem chave: tudo vem do OCR (menos confiável) — só preenche campos vazios
      if (ocr.cnpj && !$('nf-cnpj').value) {
        $('nf-cnpj').value = BrasilAPI.formatar(ocr.cnpj); preencheu.push('CNPJ'); buscarRazaoSocial(ocr.cnpj);
      }
      if (ocr.chave && ocr.chave.length === 44 && !$('nf-chave').value) {
        $('nf-chave').value = ocr.chave; _atualizarLinkConsulta();
      }
      if (ocr.razao_social && !$('nf-razao').value) { $('nf-razao').value = ocr.razao_social; }
      if (ocr.numero && !$('nf-numero').value) { _preencherNumeroSerie(ocr.numero, ocr.serie); preencheu.push('número'); }
      if (ocr.data && (!$('nf-data').value || $('nf-data').value === hoje())) {
        $('nf-data').value = ocr.data; preencheu.push('data');
      }
    }

    // VALOR: do OCR (ou do pipe do QR) — só se ainda estiver vazio
    const valor = (qr?.valor) || ocr.valor || null;
    if (valor && !$('nf-valor').value) { $('nf-valor').value = valor; preencheu.push('valor'); }

    ov.style.display = 'none';

    // SEFAZ em background p/ tentar o valor, se ainda faltar
    if (daChave && !$('nf-valor').value) enriquecerViaSefaz(chave);

    toast(preencheu.length
      ? `Preenchido: ${preencheu.join(', ')}. Confira o valor e o tipo.`
      : 'Confira os campos manualmente', preencheu.length ? 'ok' : 'err');

    // valor oficial (se a consulta do QR já respondeu, aplica por cima do OCR)
    const _k = _digitos($('nf-chave').value);
    if (_k && _sefazQrCache.has(_k)) { const r = _sefazQrCache.get(_k); if (r && typeof r.then !== 'function') _aplicarSefazNoForm(r, _k); }
    else if (_k && $('nf-qr-url').value) _sefazPorQr($('nf-qr-url').value, _k);
    // aba/categoria pelo fornecedor (só sugere; a pessoa já escolheu)
    _sugerirAbaNoFormulario().catch(() => {});

    // já lançada? avisa agora, com o que o OCR leu (número, fornecedor, valor, dia)
    _avisarDuplicataAposLeitura();
  } catch (err) {
    ov.style.display = 'none';
    toast('Erro ao ler a foto: ' + err.message, 'err');
  }
}

function atualizarPreviewFoto(url) {
  const prev = $('foto-preview');
  if (!url) {
    prev.innerHTML = '';
    $('btn-foto-label').textContent = '📷 Tirar foto';
    _atualizarBotaoLerChave();
    return;
  }
  // tipo: pela extensão do anexo atual, senão pela URL/path
  let kind = _kindDoExt(fotoExt);
  if (!kind) {
    const e = url.startsWith('supabase:') ? _extDeUrl(url.slice(9)) : _extDeUrl(url);
    kind = _kindDoExt(e) || 'image';
  }
  if (kind === 'image') {
    const src = url.startsWith('supabase:') ? '#' : url; // URL real viria de signed URL
    prev.innerHTML = `<img src="${src}" alt="Anexo" class="foto-thumb"
      onerror="this.parentElement.innerHTML='<span class=muted-p>📎 anexo da nota</span>'">`;
  } else if (kind === 'pdf' && fotoRenderURL) {
    // imagem da 1ª página puxada do PDF
    prev.innerHTML = `<img src="${fotoRenderURL}" alt="PDF (1ª página)" class="foto-thumb">
      <span class="muted-p" style="display:block;font-size:13px">📄 PDF — imagem da 1ª página</span>`;
  } else {
    const icon = kind === 'pdf' ? '📄' : '🧾';
    prev.innerHTML = `<span class="muted-p">${icon} ${kind.toUpperCase()} anexado — use “Ver anexo” na lista</span>`;
  }
  $('btn-foto-label').textContent = '📷 Trocar foto';
  _atualizarBotaoLerChave();
  _atualizarDocumentoAuto();   // anexo XML/PDF x foto decide NF-e x DANFE
}

/* Botão manual de ler QR só aparece como RESERVA:
   há algo legível (imagem, ou PDF já renderizado) E a leitura
   automática NÃO pegou a chave. (XML não tem QR para ler.) */
function _atualizarBotaoLerChave() {
  const btn = $('btn-ler-chave'); if (!btn) return;
  const legivel  = (!!fotoBlob && (!fotoExt || _ehImagemExt(fotoExt))) || !!fotoRender;
  const temChave = _digitos($('nf-chave').value).length === 44;
  btn.style.display = (legivel && !temChave) ? 'block' : 'none';
  // sem chave ainda: sempre dá para digitar (a opção da folha "Lançar" saiu em 16/09/2026)
  const dig = $('btn-digitar-chave'); if (dig) dig.style.display = temChave ? 'none' : 'block';
}

/* Chave digitada DENTRO do formulário aberto: preenche o que a chave carrega
   (CNPJ, UF, mês/ano, documento, número/série) sem abrir outra nota. */
function digitarChaveNoFormulario() {
  const raw = prompt('Digite ou cole a chave de acesso de 44 dígitos (NF-e ou NFC-e):');
  if (!raw || !raw.trim()) return;
  const c = _digitos(raw);
  if (c.length !== 44) { toast(`Chave com ${c.length} dígitos — precisa ter 44`, 'err'); return; }
  if (window.SEFAZ?.dvValido && !SEFAZ.dvValido(c)) { toast('Chave inválida (dígito verificador não confere) — confira os números', 'err'); return; }
  if (_notaDuplicadaChave(c, $('nf-id').value || null)) { toast('⚠️ Esta chave já está registrada em outra nota', 'err'); return; }
  const p = NFCE.parseChave44(c);
  $('nf-chave').value = c;
  if (p?.uf)  $('nf-uf').value  = p.uf;
  if (p?.mes) $('nf-mes').value = p.mes;
  if (p?.ano) $('nf-ano').value = p.ano;
  if (p?.cnpj) { $('nf-cnpj').value = BrasilAPI.formatar(p.cnpj); if (!$('nf-razao').value) buscarRazaoSocial(p.cnpj); }
  _atualizarLinkConsulta();   // mostra a chave, classifica o documento, número/série
  toast('Chave inserida 🔑 — confira o valor e a data');
}

/* nota (não deletada) do usuário com a MESMA chave NFC-e já registrada;
   ignora a que está sendo editada. Devolve a nota existente ou null. */
function _notaDuplicadaChave(chave, ignoreId) {
  const c = _digitos(chave);
  if (c.length !== 44) return null;
  return notas.find(n => n.id !== ignoreId && !n.deleted && _digitos(n.chave_nfce) === c) || null;
}

/* Duplicata SEM chave NFC-e. As travas acima dependem da chave de 44
   dígitos, e cupom de restaurante, hospedagem e boa parte dos RDA não têm
   chave nenhuma — essas notas podiam ser lançadas duas vezes sem nenhum
   aviso, e era daí que vinha a maior parte dos lançamentos repetidos.
   Compara o que identifica a nota na prática: tipo, dia, valor e fornecedor
   (CNPJ quando existe, senão a razão social). */
function _notaSemelhante({ tipo, cnpj, razao, valor, data, ignoreId }) {
  return _acharDuplicata({ tipo, cnpj, razao_social: razao, valor, data }, ignoreId)?.nota || null;
}

/* ── Registros duplicados (detectar e avisar; NUNCA apagar sozinho) ──────
   Três sinais, do mais forte ao mais fraco:
   1. mesma chave de 44 dígitos;
   2. mesmo número da nota + mesmo fornecedor (CNPJ ou razão social) — vale
      para recibo, DANFE e NFS-e lidos por OCR, que não têm chave;
   3. mesmo tipo + mesmo dia + mesmo valor + mesmo fornecedor.
   Pedido em 16/09/2026 ("reconhecer recibos duplicados pelo OCR"). */
/* Mesmo fornecedor: CNPJ igual quando os dois têm; senão razão social igual
   (um recibo lido por OCR pode ter só o nome, e a nota antiga só o CNPJ). */
function _mesmoFornecedor(a, b) {
  // BrasilAPI.limpar('') devolve 14 zeros: zero não é CNPJ
  const cnpjDe = x => { const c = _digitos(x?.cnpj || ''); return (c.length === 14 && !/^0+$/.test(c)) ? c : ''; };
  const ca = cnpjDe(a), cb = cnpjDe(b);
  if (ca && cb) return ca === cb;
  const norm = x => String(x || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const ra = norm(a?.razao_social), rb = norm(b?.razao_social);
  return !!ra && ra === rb;
}
function _motivoDuplicata(a, b) {
  const ka = _digitos(a.chave_nfce || ''), kb = _digitos(b.chave_nfce || '');
  if (ka.length === 44 && ka === kb) return 'chave';
  if (!_mesmoFornecedor(a, b)) return null;
  const na = String(a.numero || '').replace(/^0+/, ''), nb = String(b.numero || '').replace(/^0+/, '');
  if (na && na === nb && (!a.serie || !b.serie || String(a.serie) === String(b.serie))) return 'numero';
  const va = Math.round(Number(a.valor) * 100), vb = Math.round(Number(b.valor) * 100);
  if (va > 0 && va === vb && a.data && a.data === b.data && a.tipo === b.tipo) return 'igual';
  return null;
}
const _MOTIVO_DUP = { chave: 'mesma chave de acesso', numero: 'mesmo número de nota e fornecedor', igual: 'mesmo fornecedor, dia e valor' };
function _acharDuplicata(candidata, ignoreId = null) {
  for (const n of notas) {
    if (n.id === ignoreId || n.deleted) continue;
    const m = _motivoDuplicata(candidata, n);
    if (m) return { nota: n, motivo: m };
  }
  return null;
}
/* Mapa id → {nota, motivo} para as listas (Home/Notas). Recalculado a cada
   render; para o volume de um ano isso é instantâneo. */
let _dupMapa = new Map();
function _recalcularDuplicatas(lista) {
  /* 20/09/2026: era par a par (n²) — com 20 mil notas no aparelho do gestor
     eram 200 milhões de comparações a cada render. Agora agrupa em baldes
     (mesma chave; mesmo fornecedor+número; mesmo fornecedor+dia+valor+tipo)
     e só compara dentro do balde: linear. As regras são as de
     _motivoDuplicata, que continua valendo para o aviso na hora do lançamento. */
  _dupMapa = new Map();
  const vivas = (lista || notas).filter(n => !n.deleted);
  const marcar = (a, b, m) => {
    if (!_dupMapa.has(a.id)) _dupMapa.set(a.id, { nota: b, motivo: m });
    if (!_dupMapa.has(b.id)) _dupMapa.set(b.id, { nota: a, motivo: m });
  };
  const fornDe = n => {
    const c = _digitos(n.cnpj || '');
    if (c.length === 14 && !/^0+$/.test(c)) return 'c' + c;
    const r = String(n.razao_social || '').trim().toUpperCase().replace(/\s+/g, ' ');
    return r ? 'r' + r : null;
  };
  const baldes = new Map();
  const por = (chave, n) => { if (!chave) return; const b = baldes.get(chave); if (b) b.push(n); else baldes.set(chave, [n]); };
  for (const n of vivas) {
    const k = _digitos(n.chave_nfce || '');
    if (k.length === 44) por('K' + k, n);
    const f = fornDe(n);
    if (!f) continue;
    const num = String(n.numero || '').replace(/^0+/, '');
    if (num) por('N' + f + '|' + num, n);
    const v = Math.round(Number(n.valor) * 100);
    if (v > 0 && n.data) por('I' + f + '|' + n.data + '|' + v + '|' + (n.tipo || ''), n);
  }
  for (const [chave, grupo] of baldes) {
    if (grupo.length < 2) continue;
    const motivo = chave[0] === 'K' ? 'chave' : chave[0] === 'N' ? 'numero' : 'igual';
    for (let i = 0; i < grupo.length; i++) {
      for (let j = i + 1; j < grupo.length; j++) {
        let m = motivo;
        if (motivo === 'numero') { m = _motivoDuplicata(grupo[i], grupo[j]); if (!m) continue; }   // confere a série
        marcar(grupo[i], grupo[j], m);
      }
    }
  }
  return _dupMapa;
}
function _resumoNota(n) {
  return [n.tipo, n.razao_social || (n.cnpj ? BrasilAPI.formatar(n.cnpj) : null),
          n.numero ? `nº ${n.numero}` : null, n.data ? fmtData(n.data) : null, brl(n.valor)]
    .filter(Boolean).join(' · ');
}
/* Depois da leitura (OCR/QR da foto) avisa na hora, antes de a pessoa
   preencher o resto — e oferece abrir a que já existe. */
function _avisarDuplicataAposLeitura() {
  const cand = {
    tipo: $('nf-tipo').value, data: $('nf-data').value, valor: parseFloat($('nf-valor').value),
    cnpj: _digitos($('nf-cnpj').value), razao_social: $('nf-razao').value,
    chave_nfce: $('nf-chave').value, numero: $('nf-numero').value, serie: $('nf-serie').value,
  };
  const d = _acharDuplicata(cand, $('nf-id').value || null);
  if (!d) return false;
  const abrir = confirm(`⚠️ Parece registro duplicado (${_MOTIVO_DUP[d.motivo]}):\n\n${_resumoNota(d.nota)}\n\nAbrir a nota que já existe? (Cancelar = continuar este lançamento)`);
  if (abrir) { fecharFormNota(); editarNota(d.nota.id); }
  return true;
}

/* Trava de reentrância do Salvar.
   Sem ela, um segundo toque durante os awaits (checagem online da chave,
   compressão do anexo, gravação) reentrava em salvarNota() com nf-id ainda
   vazio, e DB.saveNota gerava OUTRO uuid — duas notas iguais no banco.
   Aparecia mais em RDA porque a trava anti-duplicata existente depende da
   chave NFC-e, e cupom de restaurante costuma não ter chave. */
let _salvandoNota = false;
async function salvarNota() {
  if (_salvandoNota) return;
  _salvandoNota = true;
  const btn = $('nf-btn-salvar');
  if (btn) btn.disabled = true;
  try {
    await _salvarNotaInterno();
  } finally {
    _salvandoNota = false;
    if (btn) btn.disabled = false;
  }
}

async function _salvarNotaInterno() {
  const tipo  = $('nf-tipo').value;
  let   valor = parseFloat($('nf-valor').value);
  const data  = $('nf-data').value;
  // sem valor ainda grava como "pendente" (0), mas sem anexo não grava
  if (!tipo || !data) { toast('Tipo e data são obrigatórios','err'); return; }

  const futuro = _dataNoFuturo(data);
  if (futuro) {
    const nl = String.fromCharCode(10);
    alert([
      futuro,
      '',
      'A nota registra um gasto que já aconteceu — não dá para lançar com data adiante de hoje.',
      '',
      'Confira a data no comprovante e corrija.',
    ].join(nl));
    toast('Data no futuro — corrija antes de salvar', 'err');
    return;
  }

  const donoDaNota = { user_id: $('nf-owner-id')?.value || _notaAtual?.user_id || user?.id };
  const proibido = _consumidorProibido($('nf-consumidor').value, donoDaNota);
  if (proibido) {
    setLoading(false);
    const nl = String.fromCharCode(10);
    const ehCpf = _soDigitos(proibido).length === 11;
    const semCpfNoPerfil = ehCpf && !_cpfDoDono(donoDaNota);
    alert([
      'Esta nota está no CPF/CNPJ ' + _formatarDoc(proibido) + ', que não é o da empresa.',
      '',
      'A nota precisa sair SEM consumidor identificado ou no CNPJ ' + _formatarDoc(CNPJ_EMPRESA) + '.',
      '',
      semCpfNoPerfil
        ? 'Se este CPF é o SEU — recarga de celular na sua linha, por exemplo —, cadastre-o no Perfil e o app deixa de barrar.'
        : 'Peça outra no caixa: esta não serve para a prestação de contas.',
    ].join(nl));
    toast('Nota no CPF/CNPJ de outra pessoa — não dá para lançar', 'err');
    return;
  }


  /* ANEXO OBRIGATÓRIO — nota de prestação de contas sem comprovante não vale.
     Ao EDITAR, o anexo que a nota já tem no servidor conta: depois que a foto
     sobe, o blob local é apagado e `fotoBlob` fica null. Sem essa ressalva,
     nenhuma nota já sincronizada poderia mais ser corrigida. */
  const _idEdicao  = $('nf-id').value || null;
  const _notaAtual = _notaPorId(_idEdicao);
  const _temAnexoSalvo = !!(_notaAtual && (_notaAtual.foto_path || _notaAtual.foto_local));
  if (!fotoBlob && !_temAnexoSalvo) {
    toast('Anexe a foto ou o arquivo da nota antes de salvar', 'err');
    _pedirAnexoObrigatorio();
    return;
  }

  // TRAVA anti-duplicata (local): mesma chave já registrada por MIM bloqueia
  if (_notaDuplicadaChave($('nf-chave').value, $('nf-id').value || null)) {
    toast('⚠️ Esta nota já foi registrada (chave NFC-e duplicada).', 'err');
    return;
  }
  // TRAVA de EQUIPE (online): a mesma chave já existe em QUALQUER colaborador?
  // POST /notas/chave-existe — só devolve sim/não, não expõe dados de outros.
  const _chaveDig = _digitos($('nf-chave').value);
  if (_chaveDig.length === 44 && sb && navigator.onLine) {
    try {
      const existe = await sb.notas.chaveExiste(_chaveDig, $('nf-id').value || null);
      if (existe) {
        toast('⚠️ Esta nota já foi registrada por outro colaborador da equipe.', 'err');
        return;
      }
    } catch (_) { /* falha na checagem online não bloqueia (a trava local já valeu) */ }
  }
  const semValor = isNaN(valor) || valor <= 0;
  if (semValor) valor = 0;

  const cnpjRaw = BrasilAPI.limpar($('nf-cnpj').value);
  /* 24/09/2026: mês e ano SAEM DA DATA, sempre. Vinham dos campos escondidos
     nf-mes/nf-ano, que o filtro da tela ou a chave lida preenchiam — foi
     assim que uma nota de 22/09/2026 foi parar em 2045 e sumiu das listas. */
  const [mes, ano] = _mesAnoDaData(data);

  /* Só para nota sem chave: com chave, as travas acima já resolveram.
     Repetida encontrada: grava a nova e manda a anterior para a lixeira,
     sem perguntar. A exclusão é reversível (a nota fica na lixeira), o que
     torna o automatismo aceitável.
     Só remove automaticamente quando a anterior é do MESMO dono: um gestor
     enxerga as notas de toda a equipe, e apagar sozinho o lançamento de um
     colaborador por semelhança seria longe demais. */
  let _repetidaAnterior = null;
  if (_digitos($('nf-chave').value).length !== 44) {
    const dup = _acharDuplicata({
      tipo, cnpj: cnpjRaw, razao_social: $('nf-razao').value, valor, data,
      numero: $('nf-numero').value, serie: $('nf-serie').value,
    }, $('nf-id').value || null);
    const igual = dup?.nota || null;
    /* DESLIGADO: a remocao automatica estava mandando notas para a lixeira em
       lote, em intervalos curtos demais para serem manuais. Volta o aviso com
       confirmacao ate a causa estar entendida — nada e apagado sem que a
       pessoa mande. */
    if (igual) {
      const resumo = [
        igual.tipo,
        igual.razao_social || (igual.cnpj ? BrasilAPI.formatar(igual.cnpj) : null),
        igual.data ? fmtData(igual.data) : null,
        brl(igual.valor),
      ].filter(Boolean).join(' · ');
      const seguir = confirm(
        `Esta nota parece já ter sido lançada (${_MOTIVO_DUP[dup.motivo]}):\n\n` + resumo +
        '\n\nLançar assim mesmo? (nada será apagado)'
      );
      if (!seguir) { toast('Lançamento cancelado — a nota já existe', 'err'); return; }
    }
  }

  const ownerId = $('nf-owner-id').value || _notaAtual?.user_id || user?.id || null;
  const createdBy = _notaAtual?.created_by || _notaAtual?.user_id || user?.id || null;
  /* 24/09/2026 — regra da empresa: a nota pode sair sem consumidor ou no
     CNPJ da Petermann & Morais. No CPF/CNPJ de terceiro ela não presta
     contas, e o lançamento para aqui. */
  const payload = {
    id             : $('nf-id').value || undefined,
    tipo, valor, data, mes, ano,
    subtipo        : tipo==='RDM' ? $('nf-subtipo').value : null,
    pagamento      : $('nf-pagamento-group')?.style.display !== 'none' ? ($('nf-pagamento')?.value || 'cv') : (_notaAtual?.pagamento || null),
    cnpj           : cnpjRaw || null,
    razao_social   : $('nf-razao').value.trim() || null,
    observacao     : $('nf-obs').value.trim()   || null,
    chave_nfce     : $('nf-chave').value        || null,
    /* mes/ano vêm da data, sempre — ver _mesAnoDaData (24/09/2026) */
    documento      : $('nf-documento').value    || null,
    numero         : ($('nf-numero').value || '').trim() || null,
    serie          : ($('nf-serie').value  || '').trim() || null,
    qr_url         : $('nf-qr-url').value       || null,
    consumidor     : $('nf-consumidor').value   || null,
    uf             : $('nf-uf').value           || null,
    metodo_captura : $('nf-metodo').value       || 'manual',
    user_id        : ownerId,
    created_by     : createdBy,
    updated_by     : user?.id || ownerId || null,
    foto_local     : null,
  };

  /* Ao editar, mantém o vínculo com o anexo que já está no servidor. O payload
     é montado só com os campos do formulário, e sem isto o save gravava o
     registro sem foto_path: a foto continuava no Supabase, mas a nota perdia a
     referência — sumia o 📎 e ela voltava a contar como "sem anexo".
     Se um anexo novo for enviado, o pushPending sobrescreve com o caminho certo. */
  if (_notaAtual?.foto_path) payload.foto_path = _notaAtual.foto_path;
  if (_notaAtual?.qr_url && !payload.qr_url) payload.qr_url = _notaAtual.qr_url;

  setLoading(true);
  try {
    /* URL real do QR: até aqui ela só existe em meta, indexada pela chave,
       porque no momento da leitura a nota ainda não tinha id. A partir do
       save ela viaja no próprio registro e sobe junto no sync — sem isso o
       link só funcionava no aparelho que escaneou. */
    if (!payload.qr_url && payload.chave_nfce) {
      const c = _digitos(payload.chave_nfce);
      if (c.length === 44) {
        try { payload.qr_url = (await DB.getMeta('qr_' + c)) || null; } catch (_) {}
      }
    }

    // anexo (foto / PDF / XML) — imagem é reduzida antes de guardar
    let anexoBlob = fotoBlob;
    let anexoExt  = fotoExt || (fotoBlob ? _extDoArquivo(fotoBlob) : null);
    if (anexoBlob) {
      ({ blob: anexoBlob, ext: anexoExt } = await _comprimirImagem(anexoBlob, anexoExt));
      // marcador, não o blob: a cópia real fica na store 'fotos' e é apagada
      // quando sobe. Guardar o blob aqui enchia o aparelho para sempre.
      payload.foto_local = anexoExt || 'jpg';
    }
    /* documento: o que a pessoa escolheu; senão o que a chave/anexo dizem.
       Fica null só quando não há como saber — o cartão mostra "documento?". */
    if (!payload.documento) {
      const extRef = anexoExt || (_notaAtual?.foto_path ? String(_notaAtual.foto_path).split('.').pop() : '');
      payload.documento = _docPelaChave(payload.chave_nfce, extRef) || (_ehUrlNfse(payload.qr_url) ? 'nfse' : null);
    }

    const saved = await DB.saveNota(payload, user.id);

    const _removeuRepetida = false;   // remocao automatica desligada

    if (anexoBlob) await DB.saveFotoLocal(saved.id, anexoBlob, anexoExt);
    if (anexoBlob && window.GDrive?.isConnected?.()) {
      const ownerId = saved.user_id || user.id;
      const ownerMeta = (ownerId && equipePorId[ownerId]) || { email: user.email, nome: user.nome };
      // upload do anexo com todos os dados da nota como metadados no Drive
      GDrive.uploadFotoComDados(anexoBlob, {
        ...saved,
        user_id: ownerId,
        user_email: ownerMeta.email || user.email,
        user_nome: ownerMeta.nome || user.nome,
      }, anexoExt)
        .then(() => toast('Anexo salvo no Drive ☁️'))
        .catch(e => toast('Drive anexo: ' + e.message, 'err'));
    }
    await syncBadge(false);
    fecharFormNota();
    await carregarDadosLocais();
    renderNotas();
    toast(
      semValor ? '⚠️ Nota salva SEM valor — edite para completar'
      : _removeuRepetida ? 'Nota salva — a repetida anterior foi para a lixeira'
      : 'Nota salva!',
      semValor ? 'err' : 'ok');
    syncToDrive().catch(() => {});
    if (sb && navigator.onLine) DB.sync(sb, user.id).then(()=>{}).catch(()=>{});
    /* CV pagou do bolso (21/09/2026): oferece registrar o reembolso na hora,
       já com valor e justificativa — é o "pedido de repasse" da versão CV. */
    if (payload.pagamento === 'reembolso' && !_idEdicao && ownerId === user?.id && valor > 0) {
      setTimeout(() => {
        if (confirm(`Você pagou ${brl(valor)} do próprio bolso.

Registrar o REEMBOLSO agora (data, valor e justificativa já preenchidos)? O gestor recebe a notificação.`)) {
          abrirFormRepasse('requested', { tipo, valor, data, descricao: 'Reembolso: ' + (payload.razao_social || (tipo === 'RDM' ? payload.subtipo : 'alimentação') || 'despesa') + (payload.numero ? ' · nº ' + payload.numero : '') });
        }
      }, 400);
    }
  } finally { setLoading(false); }
}

async function editarNota(id) {
  const n = _notaPorId(id);
  if (!n) return;
  abrirFormNota(n);
}

/* Correção de grupo pelo gestor (23/09/2026): o colaborador lançou em RDA o
   que era RDM (ou o contrário) e só o gestor conserta, sem abrir o formulário
   inteiro nem mexer no anexo. Vai direto ao servidor — a nota é de outra
   pessoa e não pode entrar no IndexedDB de quem corrige. */
const _GRUPOS = [
  { tipo: 'RDA', subtipo: null, rotulo: 'RDA', nota: 'alimentação' },
  { tipo: 'RDM', subtipo: 'Abastecimento', rotulo: 'RDM · Abastecimento', nota: 'combustível' },
  { tipo: 'RDM', subtipo: 'Hospedagem', rotulo: 'RDM · Hospedagem', nota: 'pousada, hotel' },
  { tipo: 'RDM', subtipo: 'Outros', rotulo: 'RDM · Outros', nota: 'demais gastos' },
];

function corrigirGrupoNota(id) {
  const n = _notaPorId(id);
  if (!n) { toast('Nota não encontrada', 'err'); return; }
  const atual = g => g.tipo === n.tipo && (g.tipo === 'RDA' || String(g.subtipo || '') === String(n.subtipo || 'Outros'));
  const ov = document.createElement('div');
  ov.className = 'modal-overlay open';
  ov.id = 'grupo-overlay';
  ov.innerHTML = `
    <div class="modal-card" style="max-width:420px">
      <div class="modal-hd"><h3>🔀 Corrigir grupo</h3>
        <button class="btn-icon-sm" onclick="document.getElementById('grupo-overlay')?.remove()">✕</button></div>
      <div class="modal-bd">
        <p style="margin:0 0 4px;opacity:.75;font-size:14.5px">${esc(n.razao_social || 'Sem empresa')} · ${brl(Number(n.valor) || 0)} · ${fmtData(n.data)}<br>
        Lançado por <b>${esc(_rotuloProprietario(n))}</b> em <b>${esc(n.tipo)}${n.subtipo ? ' · ' + esc(n.subtipo) : ''}</b>.</p>
        <div class="grupo-opcoes">
          ${_GRUPOS.map(g => `
            <button class="btn btn-full ${atual(g) ? 'btn-primary' : 'btn-outline'}" style="justify-content:flex-start;margin-bottom:8px"
                    ${atual(g) ? 'disabled' : ''}
                    onclick="_aplicarGrupoNota('${n.id}', '${g.tipo}', ${g.subtipo ? "'" + g.subtipo + "'" : 'null'}, this)">
              ${atual(g) ? '✅ ' : ''}${g.rotulo} <span style="margin-left:6px;opacity:.7;font-size:13px;font-weight:600">${g.nota}</span>
            </button>`).join('')}
        </div>
        <p style="opacity:.75;font-size:13px;margin-bottom:0">Muda só o grupo — valor, anexo e empresa ficam como estão. O anexo já enviado ao Drive só troca de pasta quando alguém usar <b>🗂️ Reorganizar pastas no padrão</b>.</p>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
}

async function _aplicarGrupoNota(id, tipo, subtipo, btn) {
  if (!sb || !navigator.onLine) { toast('Precisa de internet para corrigir', 'err'); return; }
  const n = _notaPorId(id);
  if (btn) btn.disabled = true;
  try {
    const r = await sb.notas.corrigirTipo(id, tipo, subtipo);
    const nova = r?.nota || {};
    if (n) { n.tipo = nova.tipo || tipo; n.subtipo = ('subtipo' in nova) ? nova.subtipo : subtipo; }
    document.getElementById('grupo-overlay')?.remove();
    toast(r?.mudou === false ? 'Já estava nesse grupo' : `Corrigido para ${tipo}${subtipo ? ' · ' + subtipo : ''} ✅`);
    if (viewAtual === 'equipe' && n?.user_id && window.Gestor?.abrir) Gestor.abrir(n.user_id);
    else if (viewAtual === 'equipe') switchView('equipe');
  } catch (e) {
    toast('Não deu: ' + (e.message || 'erro'), 'err');
    if (btn) btn.disabled = false;
  }
}

function confirmarExclusaoNota(id) {
  const n = _notaPorId(id);
  if (!n) {
    toast('Nota não encontrada', 'err');
    return false;
  }
  const detalhes = [
    n.tipo,
    n.subtipo,
    n.data ? fmtData(n.data) : null,
    Number.isFinite(Number(n.valor)) ? brl(Number(n.valor)) : null,
  ].filter(Boolean).join(' · ');
  const confirmacao = window.confirm(
    'Deseja realmente excluir esta nota do aplicativo e do backup remoto?'
    + (detalhes ? `\n\n${detalhes}` : '')
  );
  if (!confirmacao) {
    toast('Exclusão cancelada', 'err');
    return false;
  }
  const mensagem = 'Esta ação remove a nota do aplicativo e do backup remoto.\n\n'
    + (detalhes ? `${detalhes}\n\n` : '')
    + 'Digite EXCLUIR para confirmar.';
  const resposta = window.prompt(mensagem, '');
  if (resposta === null) return false;
  if (String(resposta).trim().toUpperCase() !== 'EXCLUIR') {
    toast('Exclusão cancelada', 'err');
    return false;
  }
  return true;
}

async function excluirNota(id) {
  if (!confirmarExclusaoNota(id)) return;
  await DB.softDeleteNota(id);
  await syncBadge(false);
  await carregarDadosLocais();
  if (viewAtual === 'lixeira') renderNotasApagadas();
  else renderNotas();
  syncToDrive().catch(() => {});
  if (sb && navigator.onLine) DB.sync(sb, user.id).catch(()=>{});
  toast('Nota enviada para a lixeira');
}

async function verFoto(id) {
  const n = _notaPorId(id);
  if (!n) return;

  let url = null, ext = null;

  // 1. anexo local (IndexedDB)
  const local = await DB.getFotoLocal(id);
  if (local?.blob) { url = URL.createObjectURL(local.blob); ext = local.ext || _extDoArquivo(local.blob); }

  /* 2. Servidor (URL assinada) — ANTES do Drive. A URL do Drive leva o
     token na query (?alt=media&access_token=…), formato que a API do Google
     não aceita mais para autorizar: a imagem não carrega e o visualizador
     abria vazio, mesmo com o arquivo íntegro no servidor. */
  if (!url && n.foto_path && sb) {
    const assinada = await sb.fotos.url(n.foto_path).catch(() => null);
    if (assinada) { url = assinada; ext = _extDeUrl(n.foto_path); }
  }

  // 3. Google Drive — último recurso (nota que só existe no Drive)
  if (!url) {
    const driveUrl = GDrive.getFotoUrl?.(id);
    if (driveUrl) { url = driveUrl; ext = GDrive.getFotoExt?.(id) || _extDeUrl(n.foto_path || ''); }
  }

  if (!url) { toast('Anexo não encontrado', 'err'); return; }

  // PDF/XML → abre em nova aba (o navegador renderiza/baixa)
  if (_kindDoExt(ext) && !_ehImagemExt(ext)) { window.open(url, '_blank'); return; }

  // imagem (ou tipo desconhecido) → visualizador
  $('foto-viewer-img').src = url;
  $('foto-viewer-info').textContent =
    `${n.tipo}${n.subtipo ? ' · ' + n.subtipo : ''} · ${fmtData(n.data)} · ${brl(n.valor)}`;
  $('foto-viewer-overlay').style.display = 'flex';
}

function fecharFotoViewer() {
  const ov = $('foto-viewer-overlay');
  ov.style.display = 'none';
  $('foto-viewer-img').src = '';
}

/* ── Ajuda / Como usar ───────────────────────────────────── */
function abrirAjuda()  { document.querySelectorAll('.ajuda-gestor').forEach(e => { e.style.display = _veEquipe() ? '' : 'none'; }); $('ajuda-overlay').style.display = 'flex'; $('ajuda-overlay').querySelector('.form-body').scrollTop = 0; }
function fecharAjuda() { $('ajuda-overlay').style.display = 'none'; }

/* ── Form Repasse ────────────────────────────────────────── */
let _repasseModo = 'received';

function _repasseTitulo(modo) {
  /* 24/09/2026: no CV há dois caminhos — a recarga do cartão pré-pago e o
     reembolso do que saiu do bolso. Chamar tudo de reembolso fazia o pedido
     de recarga abrir com o título errado. */
  if (_repasseDestino === 'recarga') return modo === 'requested' ? 'Pedir recarga do cartão' : 'Registrar recarga do cartão';
  /* colaborador CV (21/09/2026): o dinheiro que circula é REEMBOLSO do que saiu do bolso */
  if (_ehCV()) return modo === 'requested' ? 'Registrar reembolso (a receber)' : 'Registrar reembolso recebido';
  return modo === 'requested' ? 'Solicitar repasse' : 'Registrar repasse recebido';
}

/* Título do cabeçalho conforme o passo (23/09/2026): no passo 1 a pessoa
   ainda vai ESCOLHER entre registrar e solicitar — dizer só "Registrar
   repasse recebido" ali escondia metade da tela. */
function _repasseTituloCabecalho() {
  if (_repasseAlvo) return 'Lançar repasse para o colaborador';
  if (_repassePasso === 1) return _ehCV() ? 'Registrar ou solicitar reembolso' : 'Registrar ou solicitar repasse';
  return _repasseTitulo(_repasseModo);
}

function _repassePlaceholder(modo) {
  if (_repasseDestino === 'recarga') return modo === 'requested' ? 'Ex: cartão sem saldo para abastecer amanhã' : 'Ex: recarga feita pelo gestor';
  if (_ehCV()) return modo === 'requested' ? 'Ex: almoço pago do bolso — cartão não passou' : 'Ex: reembolso recebido do gestor';
  return modo === 'requested'
    ? 'Ex: combustível, hospedagem ou custo do mês'
    : 'Ex: repasse recebido do gestor';
}

function _repasseHelpText(modo) {
  if (_repasseDestino === 'recarga') return modo === 'requested'
    ? 'O gestor recebe o pedido e faz a transferência para o cartão. O valor entra no saldo do cartão quando ele marcar como pago.'
    : 'Registra uma recarga que já entrou no cartão; soma ao saldo do cartão.';
  if (_ehCV()) return modo === 'requested'
    ? 'O gestor recebe a notificação (e o e-mail). Quando marcar como pago, o reembolso recebido é registrado para você e abate deste valor.'
    : 'Registra um reembolso que já caiu na sua conta; abate dos reembolsos registrados.';
  return modo === 'requested'
    ? 'Este pedido envia um e-mail ao gestor automaticamente e fica marcado como solicitação pendente.'
    : 'Este registro entra no saldo como repasse recebido e não gera e-mail.';
}

function _atualizarUiRepasse() {
  const title = $('rep-title');
  const btnSalvar = $('rep-btn-salvar');
  const btnReceived = $('rep-mode-received');
  const btnRequest = $('rep-mode-request');
  const labelDesc = $('rep-desc-label');
  const descInput = $('rep-desc');
  const helpText = $('rep-help');

  if (title) title.textContent = _repasseTitulo(_repasseModo);
  if (btnSalvar) btnSalvar.textContent = _repasseModo === 'requested' ? 'Salvar e enviar' : 'Salvar';
  /* 24/09/2026: os botões do passo 1 têm ícone e legenda em <span>; escrever
     no textContent do botão apagaria os dois. */
  /* o ✓ do passo 1 só aparece depois do toque: _repasseModo tem um valor
     desde a abertura (o título e os textos dependem dele), mas marcar uma
     opção que ninguém escolheu é o mesmo engano que tiramos das sub-abas. */
  if (btnReceived) btnReceived.setAttribute('aria-pressed', String(_modoEscolhido && _repasseModo === 'received'));
  if (btnRequest) btnRequest.setAttribute('aria-pressed', String(_modoEscolhido && _repasseModo === 'requested'));
  const txt = (id, valor) => { const e = $(id); if (e) e.textContent = valor; };
  txt('rep-mode-received-tit', _ehCV() ? 'Reembolso recebido' : 'Registrar recebido');
  txt('rep-mode-received-sub', _ehCV() ? 'você já foi reembolsado' : 'o dinheiro já caiu');
  txt('rep-mode-request-tit', _ehCV() ? 'Registrar reembolso' : 'Solicitar repasse');
  txt('rep-mode-request-sub', _ehCV() ? 'pagou do próprio bolso' : 'pedir ao gestor');
  if (labelDesc) labelDesc.textContent = _repasseModo === 'requested' ? 'Custo / justificativa *' : 'Descrição';
  if (descInput) descInput.placeholder = _repassePlaceholder(_repasseModo);
  if (helpText) helpText.textContent = _repasseHelpText(_repasseModo);
}

/* ── Os três passos do repasse (24/09/2026) ──────────────────
   1) o que fazer · 2) RDA ou RDM · 3) os campos. Cada passo é uma página:
   o Voltar anda para trás e, no primeiro passo mostrado, fecha o form. */
let _repassePasso = 1;
let _repassePassoMin = 1;
let _modoEscolhido = false;

function irParaPassoRepasse(n) {
  _repassePasso = n;
  { const t = $('rep-title'); if (t) t.textContent = _repasseTituloCabecalho(); }
  const p1 = $('rep-passo-1'), p2 = $('rep-passo-2'), p3 = $('rep-dados');
  if (p1) p1.hidden = n !== 1;
  if (p2) p2.hidden = n !== 2 || _repasseSemCategoria();
  if (p3) p3.hidden = n !== 3;
  const salvar = $('rep-btn-salvar');
  if (salvar) salvar.style.display = n === 3 ? '' : 'none';
  const voltar = $('rep-btn-voltar');
  if (voltar) voltar.textContent = n > _repassePassoMin ? '‹ Voltar um passo' : '‹ Voltar';
  /* no passo 3, lembrar o que foi escolhido nos dois primeiros */
  const resumo = $('rep-resumo-escolha');
  if (resumo) {
    const tipo = $('rep-tipo')?.value || '';
    resumo.textContent = n === 3 && tipo
      ? '· ' + (_repasseModo === 'requested' ? (_ehCV() ? 'reembolso' : 'pedido') : 'recebido') + ' · ' + tipo
      : '';
  }
}

function escolherModoRepasse(modo) {
  _modoEscolhido = true;
  setRepasseModo(modo);
  /* no regime de cartão não há passo de aba: do "o que fazer" vai direto
     para os campos (24/09/2026) */
  irParaPassoRepasse(_repasseSemCategoria() ? 3 : 2);
}

function escolherTipoRepasse(tipo) {
  setRepasseTipo(tipo);
  irParaPassoRepasse(3);
}

function voltarPassoRepasse() {
  if (_repassePasso > _repassePassoMin) {
    /* voltando do 3 para o 2, a sub-aba é desmarcada: quem volta está
       trocando de aba, e deixar a antiga marcada convida ao engano. */
    if (_repassePasso === 3 && !_repasseSemCategoria()) {
      setRepasseTipo('');
      irParaPassoRepasse(2);
      return;
    }
    /* sem passo de aba (CV), o 3 volta direto para o "o que fazer" */
    irParaPassoRepasse(_repassePasso === 3 && _repasseSemCategoria() ? 1 : _repassePasso - 1);
    return;
  }
  fecharFormRepasse();
}

function setRepasseModo(modo) {
  _repasseModo = modo === 'requested' ? 'requested' : 'received';
  _atualizarUiRepasse();
}

/* Quando o gestor lança para outra pessoa: { id, nome }. Null = para si. */
let _repasseAlvo = null;

/* Regime CV (24/09/2026): o dinheiro anda por dois caminhos e a planilha da
   empresa os guarda em colunas diferentes —
     recarga   → cartão pré-pago Alelo, de onde saem os gastos do cartão;
     reembolso → conta do colaborador, pelo que ele pagou do bolso.
   Para quem é RDM/RDA fica null: lá a distinção não existe. */
let _repasseDestino = null;

/* Repasse que a empresa transferiu para a CONTA da pessoa como reembolso —
   não é recarga do cartão (24/09/2026). Lançamento antigo de CV, sem destino
   gravado, conta como reembolso: era assim que o relatório o tratava antes
   da separação. */
function _repasseEhReembolso(r) {
  return r && r.destino !== 'recarga';
}

/* Nenhum dinheiro do regime de cartão é lançado por aba (24/09/2026): as
   colunas do BANCO DE DADOS — recarga e reembolso — trazem só DATA e R$. E
   no CV não existe RDA x RDM: o gasto é dividido nas quatro categorias,
   todas juntas. _repasseDestino só é preenchido para quem é CV, então ele
   próprio responde a pergunta. */
function _repasseSemCategoria() {
  return _repasseDestino !== null;
}
const CARTAO_SALDO_MINIMO = 300;   // abaixo disso o gestor é avisado

/* Regra da empresa para o consumidor da nota (24/09/2026): pode sair SEM
   consumidor identificado, ou no CNPJ da Petermann & Morais. No CPF (ou
   CNPJ) de terceiro não presta contas — o lançamento é barrado. */
const CNPJ_EMPRESA = '17117768000142';

function _soDigitos(v) {
  return String(v || '').replace(new RegExp(String.fromCharCode(92) + 'D', 'g'), '');
}

/* Dono da nota: quem gastou, não quem está com o app aberto (o gestor pode
   estar corrigindo a nota de outra pessoa). */
function _cpfDoDono(n) {
  const id = n?.user_id || user?.id;
  const dono = id === user?.id ? user : equipePorId[id];

  return _soDigitos(dono?.cpf);
}

/* 24/09/2026 — exceção pedida pelo Cleiton: "recarga de celular, às vezes a
   linha está atrelada ao CPF do colaborador, não bloquear". A nota que sai
   no CPF de QUEM GASTOU passa; no de terceiro, continua barrada. */
function _consumidorProibido(doc, nota) {
  const d = _soDigitos(doc);
  if (!d) return null;                       // sem consumidor: permitido
  if (d === CNPJ_EMPRESA) return null;       // no CNPJ da empresa: permitido
  const cpfDono = _cpfDoDono(nota);
  if (cpfDono && d === cpfDono) return null; // no CPF de quem gastou: permitido
  return d;                                  // de terceiro: devolve para o aviso
}

function _formatarDoc(d) {
  const s = String(d || '').replace(new RegExp(String.fromCharCode(92) + 'D', 'g'), '');
  if (s.length === 11) return s.slice(0, 3) + '.' + s.slice(3, 6) + '.' + s.slice(6, 9) + '-' + s.slice(9);
  if (s.length === 14) return s.slice(0, 2) + '.' + s.slice(2, 5) + '.' + s.slice(5, 8) + '/' + s.slice(8, 12) + '-' + s.slice(12);
  return s;
}

/* Saldo do cartão pré-pago: recargas confirmadas menos as notas pagas nele.
   Vale só para quem é CV; para os demais devolve null (24/09/2026). */
/* Nota paga no cartão: tudo que não saiu do bolso. A nota antiga, gravada
   antes de existir a coluna pagamento, conta como cartão. */
function _notaDoCartao(n) {
  return n.pagamento !== 'reembolso';
}

function _saldoCartaoDe(ns, rs, ehCv) {
  if (!ehCv) return null;
  const soma = arr => arr.reduce((a, x) => a + (Number(x.valor) || 0), 0);
  const recargas = rs.filter(r => !r.deleted && r.destino === 'recarga' && _repasseEhRecebido(r));
  const noCartao = ns.filter(n => !n.deleted && _notaDoCartao(n));
  return soma(recargas) - soma(noCartao);
}


function _saldoCartao() {
  if (!_ehCV()) return null;
  return _saldoCartaoDe(notas, repasses, true);
}

/* Colaboradores CV com o cartão acabando — é o gestor quem faz a recarga. */
function _equipeCartaoBaixo() {
  if (!_ehGestorOuAdmin()) return [];
  const porUser = {};
  const junta = (arr, campo) => arr.forEach(o => {
    if (!o || o.deleted || !o.user_id) return;
    (porUser[o.user_id] = porUser[o.user_id] || { ns: [], rs: [] })[campo].push(o);
  });
  junta(notasEquipe, 'ns'); junta(repassesEquipe, 'rs');
  if (user?.id) porUser[user.id] = { ns: notas.filter(n => !n.deleted), rs: repasses.filter(r => !r.deleted) };
  return Object.entries(porUser)
    .map(([id, d]) => {
      const quem = id === user?.id ? user : equipePorId[id];
      if (!quem || !_ehCV(quem)) return null;
      const saldo = _saldoCartaoDe(d.ns, d.rs, true);
      return { id, nome: (quem?.nome || quem?.email || 'Colaborador'), saldo };
    })
    .filter(c => c && c.saldo < CARTAO_SALDO_MINIMO)
    .sort((a, b) => a.saldo - b.saldo);
}

/* Sub-abas RDA/RDM do repasse (23/09/2026, pedido do Cleiton: "para não
   esquecer de selecionar a aba correta"). O valor mora no input escondido
   #rep-tipo, que é o que salvarRepasse lê — vazio significa "ainda não
   escolheu", e o Salvar avisa. */
function setRepasseTipo(tipo) {
  const campo = $('rep-tipo');
  if (campo) campo.value = tipo || '';
  ['RDA', 'RDM'].forEach(t => {
    const b = $('rep-tipo-' + t);
    if (b) b.setAttribute('aria-pressed', String(t === tipo));
  });
}

function abrirFormRepasse(modo = null, pre = null, alvo = null, destino = null) {   // pre = { tipo, valor, data, descricao } (reembolso a partir da nota, 21/09/2026)
  /* 23/09/2026: lançamento do gestor para o colaborador — só "recebido",
     e entra direto no saldo dele (não passa pela confirmação). */
  _repasseAlvo = alvo && alvo.id ? alvo : null;
  _repasseDestino = _ehCV(_repasseAlvo ? equipePorId[_repasseAlvo.id] : undefined) ? (destino || 'reembolso') : null;
  if (_repasseAlvo) modo = 'received';
  setRepasseModo(modo || 'received');
  /* Começa no passo 1 quando nada foi decidido ainda (painel do Início). Quem
     já chega com o modo (botões do saldo, lançamento do gestor) entra no 2, e
     o reembolso vindo de uma nota, que já traz modo e aba, entra no 3. */
  /* A recarga do cartão não tem categoria na planilha (a coluna do extrato
     tem só DATA e R$), então o passo das abas não faz sentido para ela. */
  if (_repasseSemCategoria()) setRepasseTipo('RDM');
  _repassePassoMin = pre?.tipo ? 3
    : (modo || _repasseAlvo) ? (_repasseSemCategoria() ? 3 : 2)
    : 1;
  _modoEscolhido = _repassePassoMin > 1;
  _atualizarUiRepasse();
  /* Sem este reset o <select> guardava o tipo do repasse anterior: quem
     lançava um RDM e depois um RDA reabria o form já em RDM e o RDA entrava
     como RDM em silêncio — o saldo de um tipo inflava e o do outro zerava. */
  if (!_repasseSemCategoria()) setRepasseTipo(pre?.tipo || '');   // sem pré-escolha: a pessoa marca a aba
  /* CV pedindo reembolso: o valor não é chute — é o que a empresa deve pelas
     notas pagas do bolso, menos o que já transferiu (24/09/2026). */
  if (!pre && !_repasseAlvo && _repasseDestino === 'reembolso') {
    const deve = _devedorDe(notas, repasses, filMes, filAno, true);
    if (deve > 0) $('rep-valor').value = deve.toFixed(2);
  }
  irParaPassoRepasse(_repassePassoMin);
  $('rep-data').value  = pre?.data || hoje();
  $('rep-valor').value = pre?.valor != null ? String(pre.valor) : '';
  $('rep-desc').value  = pre?.descricao || '';
  $('rep-mes').value   = pre?.data ? Number(pre.data.slice(5, 7)) : filMes;
  $('rep-ano').value   = pre?.data ? Number(pre.data.slice(0, 4)) : filAno;
  {
    const t = $('rep-title'), aviso = $('rep-alvo');
    if (t) t.textContent = _repasseTituloCabecalho();
    if (aviso) {
      aviso.style.display = _repasseAlvo ? '' : 'none';
      aviso.innerHTML = _repasseAlvo
        ? `💰 Lançando para <b>${esc(_repasseAlvo.nome || 'colaborador')}</b> — entra no saldo dele na hora, sem precisar de confirmação.`
        : '';
    }
    /* para outro só existe "recebido": o passo 1 nem entra no caminho
       (o form abre direto no passo 2 — ver _repassePassoMin). */
  }
  $('rep-overlay').style.display = 'flex';
}
function fecharFormRepasse() { $('rep-overlay').style.display = 'none'; _repasseAlvo = null; }

/* Mesma trava do salvarNota (v65, quando RDA duplicava): o repasse ficou de
   fora e o defeito reapareceu aqui — dois toques no Salvar gravavam dois
   repasses, e o extrato do RDM na planilha mostrava o dobro do recebido.
   Repasse não tem chave para deduplicar depois (nota tem a chave da NFC-e),
   então a única defesa é não deixar entrar duas vezes. */
let _salvandoRepasse = false;
async function salvarRepasse() {
  if (_salvandoRepasse) return;
  _salvandoRepasse = true;
  const btn = $('rep-btn-salvar');
  if (btn) btn.disabled = true;
  try {
    await _salvarRepasseInterno();
  } finally {
    _salvandoRepasse = false;
    if (btn) btn.disabled = false;
  }
}

async function _salvarRepasseInterno() {
  const tipo  = $('rep-tipo').value;
  const valor = parseFloat($('rep-valor').value);
  const data  = $('rep-data').value;
  const _futuroRep = _dataNoFuturo(data);
  if (_futuroRep) { toast(_futuroRep + ' Corrija antes de salvar.', 'err'); return; }
  if (!tipo) { toast('Escolha a aba: RDA ou RDM', 'err'); return; }
  if (!valor||!data) { toast('Preencha os campos','err'); return; }
  /* mesma regra da nota: a data manda, não o mês que estava na tela */
  const [mes, ano] = _mesAnoDaData(data);
  const kind = _repasseModo === 'requested' ? 'requested' : 'received';
  /* email_sent sempre false daqui: quem envia é o SERVIDOR (gatilho
     trg_repasses_email no Supabase, via Resend) quando a solicitação chega
     lá — inclusive se o celular estava offline e sincronizou depois. O
     próprio gatilho marca true ao enviar, e não deixa o app rebaixar. */
  const payload = {
    tipo,
    valor,
    data,
    mes,
    ano,
    descricao: $('rep-desc').value.trim() || null,
    kind,
    destino: _repasseDestino,
    email_sent: false,
  };
  /* 23/09/2026: repasse do gestor PARA OUTRO vai direto ao servidor — no
     aparelho do gestor ele não existe, e no do colaborador aparece já
     confirmado na próxima sincronização. */
  if (_repasseAlvo) {
    if (!sb || !navigator.onLine) { toast('Precisa de internet para lançar para outro colaborador', 'err'); return; }
    const quem = _repasseAlvo.nome || 'colaborador';
    try {
      await sb.repasses.upsert({
        id: crypto.randomUUID(),
        user_id: _repasseAlvo.id,
        ...payload,
        descricao: payload.descricao || `Repasse lançado por ${user?.nome || 'gestor'}`,
      });
    } catch (e) { toast('Não deu: ' + (e.message || 'erro'), 'err'); return; }
    fecharFormRepasse();
    toast(`Repasse ${tipo} de ${brl(valor)} lançado para ${quem} ✅`);
    _repasseAlvo = null;
    if (viewAtual === 'equipe') renderEquipe();
    return;
  }

  await DB.saveRepasse(payload, user.id);
  await syncBadge(false);
  fecharFormRepasse();
  await carregarDadosLocais();
  if (viewAtual === 'home') renderHome();
  if (viewAtual === 'inicio') renderInicio();
  else renderSaldo();
  if (kind === 'requested') {
    toast(_ehCV() ? `Reembolso ${tipo} de ${brl(valor)} registrado — o gestor foi notificado.` : `Pedido de repasse ${tipo} de ${brl(valor)} registrado — o e-mail ao gestor sai automaticamente.`);
  } else {
    toast(_ehCV() ? `Reembolso recebido ${tipo} de ${brl(valor)} registrado.` : `Repasse recebido ${tipo} de ${brl(valor)} registrado.`);
  }
  syncToDrive().catch(() => {});
  if (sb && navigator.onLine) DB.sync(sb, user.id).catch(()=>{});
}

async function excluirRepasse(id) {
  if (!confirm('Excluir este repasse?')) return;
  await DB.softDeleteRepasse(id);
  await syncBadge(false);
  await carregarDadosLocais();
  if (viewAtual === 'home') renderHome();
  else renderSaldo();
  syncToDrive().catch(() => {});
  toast('Repasse excluído');
}

/* ── Exportações ─────────────────────────────────────────── */
/* A lib SheetJS é baixada pelo próprio Excel.carregar() na 1ª exportação. */
async function exportCSV() {
  setLoading(true);
  try { await Excel.exportarCSV(filMes, filAno, notas, repasses, user); }
  catch (e) { toast(e.message, 'err'); } finally { setLoading(false); }
}
async function exportExcel() {
  setLoading(true, 'Gerando a planilha…');
  try { await Excel.exportarAnual(filAno, notas, repasses, user); }
  catch (e) { toast(e.message, 'err'); } finally { setLoading(false); }
}

/* Planilha do Google "ao vivo" — cria/atualiza na pasta do Drive e abre o link */
async function exportSheets() {
  if (!(await _garantirDrive())) return;
  // abre a aba JÁ no clique (evita bloqueio de popup); navega quando a planilha estiver pronta
  const aba = window.open('', '_blank');
  setLoading(true);
  try {
    const url = await GSheets.exportarAnual(filAno, notas, repasses, user);
    if (aba) aba.location = url; else window.open(url, '_blank');
    toast('Planilha do Google atualizada! 📊');
  } catch (e) {
    if (aba) aba.close();
    toast('Sheets: ' + e.message, 'err');
  } finally { setLoading(false); }
}

/* ── Boot ────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════
   NOTIFICAÇÃO NO CELULAR (Web Push, 24/09/2026)
   Pedido do Cleiton: o número no ícone do app, como o do PicPay. No Android
   o app não desenha esse número — o sistema o põe sozinho quando há
   notificação não lida. Então o que ligamos aqui é a notificação de verdade,
   e o contador vem junto. Precisa da autorização da pessoa, uma vez por
   aparelho, e só funciona em https (ou no localhost).
═══════════════════════════════════════════════════════════ */
function _pushDisponivel() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function _b64ParaBytes(base64) {
  const pad = '='.repeat((4 - base64.length % 4) % 4);
  const limpo = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(limpo);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function _nomeDoAparelho() {
  const ua = navigator.userAgent || '';
  const s = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iPhone/iPad'
    : /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'Mac' : 'Aparelho';
  const nav = /Edg/i.test(ua) ? 'Edge' : /Chrome/i.test(ua) ? 'Chrome' : /Firefox/i.test(ua) ? 'Firefox'
    : /Safari/i.test(ua) ? 'Safari' : 'navegador';
  return s + ' · ' + nav;
}

/* Já está inscrito NESTE aparelho? */
async function _inscricaoAtual() {
  if (!_pushDisponivel()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch (_) { return null; }
}

async function ativarNotificacoes(btn) {
  if (!_pushDisponivel()) {
    toast('Este navegador não trabalha com notificação', 'err');
    return;
  }
  if (!sb || !user) { toast('Entre na sua conta primeiro', 'err'); return; }
  if (btn) btn.disabled = true;
  try {
    const { chave, ativo } = await sb.push.chave();
    if (!ativo || !chave) {
      toast('O servidor ainda não está configurado para notificações', 'err');
      return;
    }
    const permissao = await Notification.requestPermission();
    if (permissao !== 'granted') {
      toast(permissao === 'denied'
        ? 'Você bloqueou as notificações — libere nas configurações do navegador'
        : 'Autorização não concedida', 'err');
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    let inscricao = await reg.pushManager.getSubscription();
    if (!inscricao) {
      inscricao = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _b64ParaBytes(chave),
      });
    }
    const j = inscricao.toJSON();
    await sb.push.inscrever({
      endpoint: inscricao.endpoint,
      p256dh: j.keys?.p256dh,
      auth: j.keys?.auth,
      aparelho: _nomeDoAparelho(),
    });
    toast('Notificações ligadas neste aparelho ✅');
    await sb.push.testar().catch(() => {});
    if (viewAtual === 'perfil') switchView('perfil');
  } catch (e) {
    toast('Não deu para ligar: ' + (e.message || 'erro'), 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function desligarNotificacoes(btn) {
  if (btn) btn.disabled = true;
  try {
    const inscricao = await _inscricaoAtual();
    if (inscricao) {
      await sb?.push.desinscrever(inscricao.endpoint).catch(() => {});
      await inscricao.unsubscribe().catch(() => {});
    }
    toast('Notificações desligadas neste aparelho');
    if (viewAtual === 'perfil') switchView('perfil');
  } catch (e) {
    toast('Não deu: ' + (e.message || 'erro'), 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ═══════════════════════════════════════════════════════════
   VIGIA DE VERSÃO (24/09/2026)
   Até aqui a atualização dependia de a pessoa puxar a tela para baixo. Se
   ela deixasse o app aberto, podia passar o dia numa versão antiga — e no
   dia 23/09 foram dez builds. Agora o app pergunta ao servidor, de tempos
   em tempos, qual é o build publicado; achando um mais novo, limpa o cache
   e recarrega sozinho. Se houver formulário aberto, não interrompe: mostra
   um aviso com o botão Atualizar e espera.
═══════════════════════════════════════════════════════════ */
const VERSAO_INTERVALO_MS = 20 * 60 * 1000;

/* O build publicado vem do próprio sw.js (petermann-vNNN), que muda a cada
   versão — assim não há um quarto marcador de build para esquecer. */
async function _buildPublicado() {
  const r = await fetch('sw.js?nc=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) return null;
  const m = (await r.text()).match(new RegExp("petermann-v(" + "\\d" + "+)"));
  return m ? Number(m[1]) : null;
}

/* Recarregar no meio de um lançamento apagaria o que a pessoa digitou. */
function _momentoBomParaRecarregar() {
  if (_salvandoRepasse || window._salvandoNota) return false;
  const abertos = [...document.querySelectorAll('.full-overlay, .modal-overlay')]
    .filter(e => getComputedStyle(e).display !== 'none' && !e.classList.contains('fechado'));
  return abertos.length === 0;
}

async function _aplicarAtualizacao() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg) await reg.update();
    if (window.caches) {
      const chaves = await caches.keys();
      await Promise.all(chaves.map(k => caches.delete(k)));
    }
  } catch (_) {}
  location.reload();
}

function _avisarVersaoNova(build) {
  if ($('aviso-versao')) return;
  const d = document.createElement('div');
  d.id = 'aviso-versao';
  d.className = 'aviso-versao';
  d.innerHTML = `<span>✨ Versão nova do app (${build}) disponível.</span>
    <button class="btn btn-sm btn-primary" onclick="_aplicarAtualizacao()">Atualizar agora</button>`;
  document.body.appendChild(d);
}

async function verificarVersao() {
  if (!navigator.onLine) return;
  let publicado = null;
  try { publicado = await _buildPublicado(); } catch (_) { return; }
  if (!publicado || publicado <= APP_BUILD) return;
  /* Uma tentativa automática por versão: se depois de recarregar o build
     continuar velho (cache travado, arquivo pela metade), não entra em
     laço — passa a pedir o toque da pessoa. */
  let tentado = 0;
  try { tentado = Number(sessionStorage.getItem('build-tentado') || 0); } catch (_) {}
  if (tentado === publicado || !_momentoBomParaRecarregar()) { _avisarVersaoNova(publicado); return; }
  try { sessionStorage.setItem('build-tentado', String(publicado)); } catch (_) {}
  await _aplicarAtualizacao();
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  setTimeout(verificarVersao, 4000);
  setInterval(verificarVersao, VERSAO_INTERVALO_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) verificarVersao(); });
  renderAuth('login');
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') fecharFotoViewer();
  });
});
