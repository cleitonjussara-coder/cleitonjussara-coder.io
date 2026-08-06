'use strict';
/* ─────────────────────────────────────────────────────────────
   app.js — Core Petermann PWA
   Troque as duas linhas abaixo com suas credenciais Supabase.
───────────────────────────────────────────────────────────── */
const SUPABASE_URL      = 'https://alkndoafntxzkpcgscvz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFsa25kb2FmbnR4emtwY2dzY3Z6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzNjcwMDMsImV4cCI6MjA5NDk0MzAwM30.sjKOuNiGYbcHbJwPQuhO65c9apYbgA-xtOqYTfCo7UY';
const DEMO_MODE = SUPABASE_URL.includes('COLE_SUA');

/* ── Estado global ───────────────────────────────────────── */
let sb        = null;
let user      = null;   // { id, email, nome, role, nucleo }
let notas     = [];
let repasses  = [];
let driveOk   = false;
let viewAtual = 'home';
let filMes    = new Date().getMonth() + 1;
let filAno    = new Date().getFullYear();
let _drivePullInterval = null;
let filtroPeriodo = 'mensal';

/* câmera */
let qrStream  = null;
let qrFrame   = null;

/* arquivo (foto / PDF / XML) selecionado na edição */
let fotoBlob  = null;
let fotoURL   = null;
let fotoExt   = null;   // 'jpg' | 'png' | 'pdf' | 'xml' | …
let fotoRender    = null;   // imagem renderizada da 1ª página do PDF (preview + QR/OCR)
let fotoRenderURL = null;

const MESES   = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const NUCLEOS = ['Cristalina','Formosa','Paracatu','Uberlândia','Outro'];
const APP_VERSION = 'v82';

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
async function resolverLinkConsulta(chaveRaw, qrUrlDaNota) {
  const chave = _digitos(chaveRaw);
  if (chave.length !== 44) return null;

  if (/^https?:\/\//i.test(qrUrlDaNota || '')) return { url: qrUrlDaNota, exato: true };

  // notas escaneadas antes da v59 têm a URL só em meta, neste aparelho
  let raw = null;
  try { raw = await DB.getMeta('qr_' + chave); } catch (_) {}
  if (raw) return { url: raw, exato: true };

  const fallback = window.SEFAZ?.linkConsulta ? SEFAZ.linkConsulta(chave) : null;
  return fallback ? { url: fallback, exato: false } : null;
}

function abrirConsultaChave(chaveRaw, qrUrlDaNota) {
  if (_digitos(chaveRaw).length !== 44) { toast('Esta nota não tem chave NFC-e para consulta', 'err'); return; }
  const w = window.open('', '_blank');           // abre já, evita bloqueio de popup
  resolverLinkConsulta(chaveRaw, qrUrlDaNota).then(r => {
    if (!r) { if (w) w.close(); toast('Não foi possível montar o link de consulta', 'err'); return; }
    if (w) w.location.href = r.url; else window.open(r.url, '_blank');
    if (!r.exato) toast('Nota não foi lida por QR — abrindo o portal nacional com a chave (pede captcha)');
  });
}

function consultarNota(id) {
  const n = notas.find(x => x.id === id);
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

function syncBadge(syncing) {
  const dot = $('sync-dot');
  const txt = $('sync-txt');
  if (syncing) { dot.className='sync-dot syncing'; txt.textContent='sincronizando'; return; }
  if (!navigator.onLine) { dot.className='sync-dot offline'; txt.textContent='offline'; return; }
  dot.className='sync-dot online'; txt.textContent='online';
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

/* Cliente Supabase singleton — UMA promessa, UM client, UM listener.
   Evita corrida (2 cliques rápidos) que criava clients duplicados. */
let _sbPromise = null;
function _ensureSb() {
  if (_sbPromise) return _sbPromise;
  _sbPromise = (async () => {
    if (typeof supabase === 'undefined') {
      await _loadScript(
        'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
        'Falha ao carregar autenticação');
    }
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    sb.auth.onAuthStateChange(async (_ev, session) => {
      /* PASSWORD_RECOVERY também chega por aqui; a sessão que vem com ele é
         só para trocar a senha, não para entrar no app. */
      if (_ev === 'PASSWORD_RECOVERY') _recuperandoSenha = true;
      if (_recuperandoSenha) { showTela('auth'); renderAuth('nova-senha'); return; }
      if (session?.user) {
        if (user && _telaAtual === 'app') return;
        await onLogin(session.user);
      } else {
        user = null;
        _telaAtual = 'auth';
        showTela('auth');
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

/* ── Inicialização ───────────────────────────────────────── */
async function init() {
  if (!DEMO_MODE) {
    try {
      await _ensureSb();
      const { data:{ session } } = await sb.auth.getSession();
      /* veio do link do e-mail: pede a nova senha antes de qualquer coisa */
      if (_recuperandoSenha) { showTela('auth'); renderAuth('nova-senha'); }
      else if (!session) { showTela('auth'); renderAuth(); }
    } catch (_) {
      // sem rede no boot — mostra login mesmo assim; o botao recarrega o Supabase
      showTela('auth'); renderAuth();
    }
  } else {
    // modo demo sem Supabase
    $('demo-banner').style.display = 'flex';
    await DB.open();
    user = { id:'demo-user', email:'demo@petermann.app', nome:'Demo', role:'admin', nucleo:'Cristalina' };
    await carregarDadosLocais();
    showTela('app');
    switchView('home');
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
  window.addEventListener('db-synced', async e => {
    syncBadge(false);
    if (driveOk) await pullFromDrive().catch(() => {});
    await carregarDadosLocais();
    if (viewAtual==='home')   renderHome();
    if (viewAtual==='notas') renderNotas();
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
  setLoading(true);
  try {
    await DB.open();
    // perfil em cache → app abre na hora; sem cache, usa padrão
    let perfil = null;
    try { perfil = JSON.parse(localStorage.getItem('perfil_' + authUser.id) || 'null'); } catch (_) {}
    user = perfil || { id:authUser.id, email:authUser.email, nome:'', role:'colaborador', nucleo:'Cristalina' };
    DB.setupAutoSync(sb, () => user?.id);
    await carregarDadosLocais();
    showTela('app');
    switchView('home');
    setLoading(false);

    // perfil oficial em background (não bloqueia a tela)
    if (!DEMO_MODE && sb) {
      sb.from('colaboradores').select('*').eq('id', authUser.id).maybeSingle()
        .then(({ data }) => {
          if (!data) return;
          const mudou = JSON.stringify(data) !== JSON.stringify(perfil);
          user = data;
          try { localStorage.setItem('perfil_' + authUser.id, JSON.stringify(data)); } catch (_) {}
          if (mudou) {
            showTela('app');                       // atualiza menu Equipe conforme o cargo
            if (viewAtual === 'perfil') renderPerfil();
          }
          _maybeAutoConsolidarFotos();             // papel de gestor confirmado → tenta organizar (se Drive já conectado)
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

let _reparoAnexosFeito = false;
async function carregarDadosLocais() {
  if (!user) return;
  notas    = await DB.getNotasUser(user.id);
  repasses = await DB.getRepassesUser(user.id);
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
  if (appEl)  appEl.style.display  = t === 'app'  ? 'flex' : 'none';
  if (t==='app') {
    const navEq = $('nav-equipe');
    if (navEq) navEq.style.display = (user?.role==='gestor'||user?.role==='admin') ? 'flex' : 'none';
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
  L.push(`Versão do app: ${APP_VERSION}`);
  L.push(`Navegador: ${navigator.userAgent.slice(0, 110)}`);

  alert(L.join('\n'));
}

/* ── Auth ────────────────────────────────────────────────── */

/* RECUPERAÇÃO DE SENHA — a trava mais importante deste bloco.
   O link do e-mail volta para o app com um token que o Supabase troca por
   uma SESSÃO VÁLIDA. Como o onAuthStateChange manda para dentro do app
   sempre que há sessão, sem isto a pessoa entraria direto e a tela de nova
   senha nunca apareceria — o link viraria um "login mágico".
   A leitura acontece na carga do script, ANTES de createClient(), porque o
   cliente consome e limpa o hash da URL ao iniciar. */
let _recuperandoSenha = /type=recovery/.test(location.hash + location.search);
function _limparUrlRecuperacao() {
  _recuperandoSenha = false;
  try { history.replaceState(null, '', location.pathname + location.search.replace(/[?&]type=recovery[^&]*/, '')); }
  catch (_) {}
}

let authMode = 'login';
function renderAuth(mode='login') {
  authMode = mode;
  const rodape = `
    <div style="margin-top:8px;text-align:center">
      <hr style="border-color:rgba(255,255,255,.2);margin:12px 0">
      <div class="install-slot"></div>
      <button class="btn btn-outline btn-full" style="border-color:rgba(255,255,255,.4);color:rgba(255,255,255,.8)"
              onclick="usarSemConta()">Usar sem conta (modo local)</button>
      <p style="color:rgba(255,255,255,.45);font-size:11px;margin-top:14px">Versão ${APP_VERSION}</p>
    </div>`;

  if (mode === 'reset') {
    $('auth-body').innerHTML = `
      <h2 class="auth-title">Recuperar senha</h2>
      <p style="color:rgba(255,255,255,.75);font-size:13px;line-height:1.6;margin-bottom:14px">
        Informe o e-mail da sua conta. Você receberá um link para definir uma senha nova.
      </p>
      <input class="inp" id="a-email" type="email" placeholder="E-mail" autocomplete="email">
      <button class="btn btn-primary btn-full" id="a-btn-reset" onclick="pedirRecuperacao()">Enviar link</button>
      <p class="auth-switch"><a onclick="renderAuth('login')">Voltar para o login</a></p>
      ${rodape}`;
    _pintarBotaoInstalar();
    return;
  }

  if (mode === 'nova-senha') {
    $('auth-body').innerHTML = `
      <h2 class="auth-title">Nova senha</h2>
      <p style="color:rgba(255,255,255,.75);font-size:13px;line-height:1.6;margin-bottom:14px">
        Escolha a senha que você vai usar a partir de agora.
      </p>
      <input class="inp" id="a-pass"  type="password" placeholder="Nova senha (min. 6 caracteres)" autocomplete="new-password">
      <input class="inp" id="a-pass2" type="password" placeholder="Repita a nova senha" autocomplete="new-password">
      <button class="btn btn-primary btn-full" id="a-btn-nova" onclick="definirNovaSenha()">Salvar senha</button>
      <p class="auth-switch"><a onclick="cancelarRecuperacao()">Cancelar</a></p>`;
    return;
  }

  $('auth-body').innerHTML = mode==='login' ? `
    <h2 class="auth-title">Entrar</h2>
    <input class="inp" id="a-email" type="email" placeholder="E-mail" autocomplete="email">
    <input class="inp" id="a-pass"  type="password" placeholder="Senha" autocomplete="current-password">
    <button class="btn btn-primary btn-full" onclick="login()">Entrar</button>
    <p class="auth-switch"><a onclick="renderAuth('reset')">Esqueci minha senha</a></p>
    <p class="auth-switch">Não tem conta? <a onclick="renderAuth('reg')">Cadastrar</a></p>
    ${rodape}
  ` : `
    <h2 class="auth-title">Criar conta</h2>
    <input class="inp" id="a-nome"  type="text"     placeholder="Seu nome">
    <input class="inp" id="a-email" type="email"    placeholder="E-mail" autocomplete="email">
    <input class="inp" id="a-pass"  type="password" placeholder="Senha (min. 6 caracteres)" autocomplete="new-password">
    <button class="btn btn-primary btn-full" onclick="register()">Criar conta</button>
    <p class="auth-switch">Já tem conta? <a onclick="renderAuth('login')">Entrar</a></p>
    <div style="margin-top:8px;text-align:center">
      <hr style="border-color:rgba(255,255,255,.2);margin:12px 0">
      <div class="install-slot"></div>
      <button class="btn btn-outline btn-full" style="border-color:rgba(255,255,255,.4);color:rgba(255,255,255,.8)"
              onclick="usarSemConta()">Usar sem conta (modo local)</button>
    </div>
  `;
  _pintarBotaoInstalar();
}

/* Modo local sem autenticação — acessa QR/OCR sem depender do Supabase */
async function usarSemConta() {
  $('demo-banner').style.display = 'flex';
  await DB.open();
  user = { id:'local-user', email:'local@petermann.app', nome:'Usuário Local', role:'admin', nucleo:'Cristalina' };
  await carregarDadosLocais();
  showTela('app');
  switchView('home');
}

/* Dispara o e-mail de redefinição. O redirectTo aponta para o próprio app
   (origem + caminho, sem hash) e PRECISA estar na lista de Redirect URLs do
   Supabase — fora dela o link do e-mail cai numa página de erro. */
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
    const destino = location.origin + location.pathname;
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: destino });
    if (error) throw error;
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

/* Grava a senha nova usando a sessão temporária criada pelo link. */
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
    const { error } = await sb.auth.updateUser({ password: nova });
    if (error) throw error;
    /* Sai da sessão do link antes de mandar para o login: assim a pessoa
       estreia a senha nova, em vez de entrar de carona no token do e-mail. */
    _limparUrlRecuperacao();
    await sb.auth.signOut();
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
  try { await sb?.auth?.signOut(); } catch (_) {}
  showTela('auth');
  renderAuth('login');
}

async function login() {
  const email = $('a-email').value.trim();
  const pass  = $('a-pass').value;
  if (!email||!pass) { toast('Preencha e-mail e senha','err'); return; }
  setLoading(true);
  try { await _ensureSb(); } catch (_) { setLoading(false); toast('Sem conexão para entrar','err'); return; }
  const { data, error } = await sb.auth.signInWithPassword({ email, password:pass });
  if (error) { setLoading(false); toast(error.message,'err'); return; }
  // fallback: garante a entrada mesmo se o onAuthStateChange não disparar
  if (data?.user && _telaAtual !== 'app') await onLogin(data.user);
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
  const { error } = await sb.auth.signUp({ email, password:pass, options:{ data:{ nome } } });
  setLoading(false);
  if (error) { toast(error.message,'err'); return; }
  toast('Verifique seu e-mail para confirmar o cadastro.');
  renderAuth('login');
}

async function logout() {
  try {
    if (sb) await sb.auth.signOut().catch(() => {});
  } catch (_) {}
  user = null; notas = []; repasses = [];
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
    updateDriveBadge();
    if (driveOk && user) {
      await pullFromDrive();
      _maybeAutoConsolidarFotos();          // gestor abriu o app com Drive → organiza fotos da equipe
    } else if (!driveOk && GDrive.isConfigured()) {
      // Drive configurado mas não conectado — mostra banner sutil
      _mostrarBannerDrive();
    }
  } catch (e) { console.warn('Drive init:', e.message); }
}

function _mostrarBannerDrive() {
  // banner descartável no topo do conteúdo
  const existing = $('drive-invite-banner');
  if (existing) return;
  const b = document.createElement('div');
  b.id = 'drive-invite-banner';
  b.style.cssText = 'background:#1B4332;color:#fff;font-size:13px;padding:10px 16px;'
    + 'display:flex;align-items:center;gap:10px;flex-shrink:0;';
  b.innerHTML = `
    <span style="flex:1">☁️ Conecte o Google Drive para salvar seus dados na nuvem</span>
    <button onclick="connectDrive()" style="background:var(--accent);color:var(--primary-d);border:none;
      border-radius:8px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0">
      Conectar
    </button>
    <button onclick="this.parentElement.remove()" style="background:none;border:none;color:rgba(255,255,255,.6);
      font-size:18px;cursor:pointer;line-height:1;padding:0 4px">×</button>`;
  const content = $('app-content');
  if (content) content.parentElement.insertBefore(b, content);
}

async function connectDrive() {
  // remove banner se existir
  $('drive-invite-banner')?.remove();
  setLoading(true);
  try {
    await GDrive.requestAccess();
    driveOk = true;
    updateDriveBadge();
    await pullFromDrive();
    toast('✅ Google Drive conectado!');
    if (viewAtual === 'perfil') renderPerfil();
    _maybeAutoConsolidarFotos();            // conectou agora → se for gestor, organiza fotos da equipe
  } catch (e) {
    const msg = e.message || 'Erro desconhecido';
    if (msg.includes('negado') || msg.includes('denied')) {
      toast('Acesso negado — autorize o app no Google', 'err');
    } else {
      toast('Drive: ' + msg, 'err');
    }
  } finally { setLoading(false); }
}

function disconnectDrive() {
  GDrive.disconnect();
  driveOk = false;
  updateDriveBadge();
  toast('Drive desconectado');
  renderPerfil();
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
  if (!GDrive.isConnected()) { toast('Conecte o Drive primeiro', 'err'); return; }
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
      const { data: collabs } = await sb.from('colaboradores').select('id,nome');
      (collabs || []).forEach(c => { if (c.nome) nomePorUserId[c.id] = c.nome; });
    }
    if (user.nome) nomePorUserId[user.id] = user.nome;   // o próprio perfil manda

    /* As notas de verdade: a migração usa elas em vez do appProperties, que
       pode ter sido gravado incompleto por um envio antigo. Locais primeiro,
       servidor por cima (o gestor enxerga a equipe toda). */
    const notaPorId = {};
    notas.forEach(n => { notaPorId[n.id] = n; });
    if (sb && !DEMO_MODE) {
      const { data } = await sb.from('notas').select('id,user_id,tipo,subtipo,mes,ano,data');
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
  try {
    const remote = await GDrive.loadNotas(user.id);
    if (!remote) return;
    await DB.upsertFromDrive('notas',    remote.notas);
    await DB.upsertFromDrive('repasses', remote.repasses);
    await carregarDadosLocais();
    if (viewAtual === 'home')  renderHome();
    if (viewAtual === 'notas') renderNotas();
    if (viewAtual === 'saldo') renderSaldo();
  } catch (e) { console.warn('Drive pull:', e.message); }
}

async function syncToDrive() {
  if (!driveOk || !user || !GDrive.isConnected()) return;
  syncBadge(true);
  try {
    await GDrive.syncNotas(user.id, notas, repasses);
  } catch (e) {
    console.error('Drive sync:', e.message);
    toast('Drive: ' + e.message, 'err');
    if (!GDrive.isConnected()) { driveOk = false; updateDriveBadge(); }
  } finally { syncBadge(false); }
}

function updateDriveBadge() {
  const badge = $('drive-badge');
  if (!badge) return;
  if (!window.GDrive?.isConfigured()) { badge.style.display = 'none'; return; }
  badge.style.display = 'flex';
  const ok  = driveOk && GDrive.isConnected();
  const min = ok ? GDrive.minutosRestantes() : 0;
  $('drive-dot').style.background = ok ? '#74C69D' : '#94A3B8';
  $('drive-txt').textContent       = ok ? `Drive (${min}min)` : 'Drive';
  badge.title = ok ? `Drive conectado — sessão expira em ${min} min` : 'Drive desconectado — clique para conectar';
}

/* ── Navegação ───────────────────────────────────────────── */
function switchView(v) {
  viewAtual = v;
  document.querySelectorAll('.nav-btn[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view===v)
  );
  const el = $('app-content');
  el.scrollTop = 0;
  if (v==='home')    renderHome();
  else if (v==='notas')  renderNotas();
  else if (v==='saldo')  renderSaldo();
  else if (v==='equipe') renderEquipe();
  else if (v==='perfil') renderPerfil();
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
  const rs = repasses.filter(doPeriodo);
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
  const repassesPassados = _soma(repasses.filter(ePassado));
  const pendenciaAnterior = repassesPassados - gastosPassados;
  const gastoMes   = _soma(notas.filter(eAtual));
  const repasseMes = _soma(repasses.filter(eAtual));
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
               style="font-size:7.5px;fill:var(--text2);font-weight:600">${brlCurto(topo*f)}</text>`;
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
             style="font-size:8.5px;font-weight:${sel?800:500};
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
        style="font-size:11px;fill:var(--text2);font-weight:700">sem gastos</text></svg>`;
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
         style="font-size:14px;font-weight:800;fill:var(--primary-d)">${
           Math.round(foco.val/total*100)}%</text>
       <text x="${CX}" y="${CY+11}" text-anchor="middle"
         style="font-size:8px;font-weight:700;fill:var(--text2)">${esc(foco.curto)}</text>`
    : `<text x="${CX}" y="${CY-2}" text-anchor="middle"
         style="font-size:12.5px;font-weight:800;fill:var(--primary-d)">${brlCurto(total)}</text>
       <text x="${CX}" y="${CY+11}" text-anchor="middle"
         style="font-size:8px;font-weight:700;fill:var(--text2)">TOTAL</text>`;

  return `<svg viewBox="0 0 132 132" class="db-chart" style="height:132px">${segs}${centro}</svg>`;
}

function renderHome() {
  const modo = filtroPeriodo;                        // 'mensal' | 'anual'
  const A    = _agregaPeriodo(filMes, filAno, modo); // período em foco
  const pAnt = _periodoAnterior(filMes, filAno, modo);
  const B    = _agregaPeriodo(pAnt.mes, pAnt.ano, modo);

  const rotulo = modo === 'mensal' ? `${MESES[filMes-1]} ${filAno}` : String(filAno);

  /* ── Primeiro acesso: convite em vez de painel vazio ────── */
  if (!notas.length && !repasses.length) {
    $('app-content').innerHTML = `
    <div class="db-container">
      <div class="db-card" style="align-items:center;text-align:center;gap:12px;padding:28px 20px">
        <div style="font-size:44px">📊</div>
        <div style="font-size:17px;font-weight:800;color:var(--primary-d)">Seu painel começa aqui</div>
        <p style="font-size:13.5px;color:var(--text2);line-height:1.5">
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
  const pendentes = A.ns.filter(n =>
    n.synced === false || _n(n.valor) <= 0 || (!n.foto_path && !n.foto_local)
  ).sort((a,b) => _dataDe(b).localeCompare(_dataDe(a)));

  const resumoPend = [
    { ico:'⚠️', txt:'Sem valor',    n: pendentes.filter(n => _n(n.valor) <= 0).length, flag:'sem-valor' },
    { ico:'📎', txt:'Sem anexo',    n: pendentes.filter(n => !n.foto_path && !n.foto_local).length, flag:'sem-anexo' },
    { ico:'⏳', txt:'Aguardando envio', n: pendentes.filter(n => n.synced === false).length, flag:'pendente' },
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
    if (n.synced === false) m.push('não enviada');
    if (_dataImplausivel(n)) m.push('data fora do período');
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
        <div style="font-size:10.5px;color:var(--text2);margin-top:1px">
          ${esc(fmtData(n.data))} · ${motivosDe(n)}</div>
      </div>
      <span class="db-pend-n" style="margin-right:4px">${_n(n.valor) > 0 ? brl(n.valor) : '⚠️'}</span>
      <button class="btn btn-sm btn-outline" onclick="abrirTransferirNota('${n.id}')" style="flex-shrink:0">Mover</button>
    </div>`).join('');

  const pendHtml = pendentes.length
    ? linhaSuspeita + resumoPend.map(linhaResumo).join('')
      + `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
           <div style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">
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
        <span style="font-size:10px;color:var(--text2);font-weight:600">
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
        <span style="font-size:10px;color:var(--text2);font-weight:600">gastos em R$</span>
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
        <span style="font-size:10px;color:var(--text2);font-weight:600">top ${forn.length}</span>
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
            <div style="font-size:10px;color:var(--text2)">${f.qtd} nota${f.qtd === 1 ? '' : 's'}
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
      <div class="db-pend">${pendHtml}</div>
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
  if (filtroNotasFlag === 'pendente')      return n.synced === false;
  if (filtroNotasFlag === 'data-suspeita') return _dataImplausivel(n);
  return true;
}

function renderNotas() {
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
      <button class="btn btn-primary" onclick="${filtroNotasFlag || filtroNotasAno
        ? 'limparFiltroNotas()' : 'abrirCaptura()'}">${filtroNotasFlag || filtroNotasAno
        ? 'Limpar filtro' : '+ Lançar'}</button>
    </div>`;
  } else {
    html += `<div class="notas-list" id="notas-list">`;
    ns.forEach(n => {
      const pendSync = n.synced===false ? '<span class="sync-pending" title="Pendente sync">⏳</span>' : '';
      html += `
      <div class="nota-card ${n.foto_path||n.foto_local ? 'com-thumb' : ''}" data-tipo="${n.tipo}">
        ${n.foto_path||n.foto_local ? `
        <button class="nota-thumb" id="thumb-${n.id}" onclick="verFoto('${n.id}')"
                title="Ver anexo da nota"><span class="nota-thumb-ph">📎</span></button>` : ''}
        <div class="nota-head">
          <span class="tipo-badge tipo-${n.tipo}">${n.tipo}</span>
          ${n.subtipo ? `<span class="subtipo-tag">${n.subtipo}</span>` : ''}
          <span class="nota-data">${fmtData(n.data)}</span>
          ${pendSync}
        </div>
        <div class="nota-body">
          <div class="nota-empresa">${esc(n.razao_social || (n.cnpj ? BrasilAPI.formatar(n.cnpj) : 'Sem empresa'))}</div>
          ${n.cnpj&&!n.razao_social ? `<div class="nota-cnpj">${BrasilAPI.formatar(n.cnpj)}</div>` : ''}
          ${n.observacao ? `<div class="nota-obs">${esc(n.observacao)}</div>` : ''}
        </div>
        <div class="nota-foot">
          <span class="nota-valor">${Number(n.valor) > 0 ? brl(n.valor) : '<span style="color:var(--danger)">⚠️ sem valor</span>'}</span>
          <div class="nota-actions">
            ${n.chave_nfce ? `<button class="btn-icon-sm" onclick="consultarNota('${n.id}')" title="Consultar no SEFAZ">🔗</button>` : ''}
            <button class="btn-icon-sm" onclick="editarNota('${n.id}')" title="Editar">✏️</button>
            <button class="btn-icon-sm danger" onclick="excluirNota('${n.id}')" title="Excluir">🗑</button>
          </div>
        </div>
      </div>`;
    });
    html += `</div>`;
  }
  el.innerHTML = html;
  _carregarMiniaturas(ns).catch(() => {});
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

  const { data } = await sb.storage.from('notas-fotos')
    .createSignedUrls(pendentes.map(n => n.foto_path), 300);
  (data || []).forEach((r, i) => {
    const n = pendentes[i];
    if (r?.signedUrl) _pintarMiniatura($(pref + n.id), r.signedUrl, _extDeUrl(n.foto_path));
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
  const rs = repasses.filter(r => r.mes===filMes && r.ano===filAno);

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

  // repasses do mês
  const repHtml = rs.length ? rs.map(r => `
    <div class="rep-item">
      <span class="tipo-badge tipo-${r.tipo}">${r.tipo}</span>
      <span class="rep-desc">${esc(r.descricao||'Repasse')}</span>
      <span class="rep-val">${brl(r.valor)}</span>
      <button class="btn-icon-sm danger" onclick="excluirRepasse('${r.id}')">🗑</button>
    </div>`).join('') : '<p class="muted-p">Nenhum repasse lançado.</p>';

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

  $('app-content').innerHTML = `
  <div class="page-hd">
    <div class="mes-nav">
      <button class="btn-mes-nav" onclick="mudarMes(-1)">‹</button>
      <span class="mes-label">${MESES[filMes-1]} ${filAno}</span>
      <button class="btn-mes-nav" onclick="mudarMes(1)">›</button>
    </div>
    <div class="export-btns">
      <button class="btn btn-sm btn-outline" onclick="exportCSV()">CSV</button>
      <button class="btn btn-sm btn-outline" onclick="exportExcel()">Excel Anual</button>
      <button class="btn btn-sm btn-primary" onclick="exportSheets()">📊 Google Sheets</button>
    </div>
  </div>

  <div class="saldo-grid">
    ${cardTipo('RDM', rdm)}
    ${cardTipo('RDA', rda)}
  </div>

  <div class="section-hd">
    <span>Repasses</span>
    <button class="btn btn-sm btn-primary" onclick="abrirFormRepasse()">+ Repasse</button>
  </div>
  <div class="rep-list">${repHtml}</div>`;
}

/* ── VIEW: EQUIPE ────────────────────────────────────────── */
async function renderEquipe() {
  if (!sb||DEMO_MODE) {
    $('app-content').innerHTML = '<div class="empty-state">Equipe disponível com Supabase configurado.</div>';
    return;
  }
  const el = $('app-content');
  await Gestor.renderDashboard(el, sb, user, () => renderEquipe(), { mes: filMes, ano: filAno });
}

function mudarMesEquipe(delta) {
  filMes += delta;
  if (filMes > 12) { filMes = 1;  filAno++; }
  if (filMes < 1)  { filMes = 12; filAno--; }
  renderEquipe();
}

function exportExcelEquipe() {
  Gestor.exportEquipeExcel(sb, user, filMes, filAno);
}

/* Planilha do Google da equipe (consolidada, mês atual) */
async function exportSheetsEquipe() {
  if (!GDrive.isConnected()) {
    toast('Conecte o Google Drive no Perfil primeiro', 'err');
    switchView('perfil');
    return;
  }
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
  if (!sb || DEMO_MODE) { alert('Disponível apenas com Supabase configurado.'); return; }
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
        const r = await sb.storage.from('notas-fotos').download(n.foto_path);
        passos.push(r.error ? `supabase:ERRO ${r.error.message}`
                  : r.data  ? `supabase:ok ${Math.round(r.data.size/1024)}kB`
                            : 'supabase:vazio');
      } catch (e) { passos.push('supabase:EXCEÇÃO ' + e.message); }
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
      `• supabase:ok → arquivo existe e você consegue baixar\n` +
      `• supabase:ERRO Object not found → arquivo não está lá OU a leitura foi negada\n` +
      `• local:não e supabase:ERRO → é este caso que deixa a nota sem imagem`
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
  if (!sb || DEMO_MODE) { alert('Disponível apenas com Supabase configurado.'); return; }
  if (!GDrive.isConnected()) {
    alert('Conecte o Google Drive no Perfil primeiro.');
    switchView('perfil');
    return;
  }
  if (!confirm('Enviar ao Drive as fotos de TODOS os colaboradores (todos os meses)?\nPode levar um tempo conforme a quantidade.')) return;

  const ov = $('ocr-overlay');
  const setProg = txt => { if (ov) ov.style.display = 'flex'; const p = $('ocr-progress'); if (p) p.textContent = txt; };
  setProg('Preparando envio…');

  try {
    // 1) mapa user_id -> {nome,email} p/ nomear a pasta do colaborador
    const { data: collabs, error: ce } = await sb.from('colaboradores').select('id,nome,email');
    if (ce) throw new Error('colaboradores: ' + ce.message);
    const mapa = {};
    (collabs || []).forEach(c => { mapa[c.id] = c; });

    // 2) TODAS as notas com foto (todos os meses / todos os colaboradores)
    const { data: notas, error } = await sb.from('notas')
      .select('id,user_id,tipo,subtipo,mes,ano,data,foto_path,deleted');
    if (error) throw new Error('notas: ' + error.message);
    const totalNotas = (notas || []).length;
    const comFoto = (notas || []).filter(n => n.foto_path && !n.deleted);

    if (!comFoto.length) {
      if (ov) ov.style.display = 'none';
      alert(`Nenhuma foto para enviar.\n\nNotas que este perfil consegue ler: ${totalNotas}\nCom foto no Supabase: 0\n\n`
        + `Se você sabe que há fotos: ou elas ainda não foram sincronizadas ao Supabase, `
        + `ou as permissões não deixam este perfil ver as notas dos outros colaboradores.`);
      return;
    }

    // 3) atualiza índice do Drive p/ NÃO duplicar o que já está lá
    setProg('Lendo o que já existe no Drive…');
    let idxAviso = '';
    try { await GDrive.atualizarIndice(); }
    catch (e) { idxAviso = `Aviso: não li o Drive antes (${e.message}).\n\n`; }

    // 4) baixa do Supabase e sobe pro Drive, contando cada etapa
    let ok = 0, falhaBaixar = 0, falhaSubir = 0, primeiroErro = '', i = 0;
    for (const n of comFoto) {
      i++;
      setProg(`Enviando fotos ${i}/${comFoto.length}…`);
      let blob = null;
      try {
        const r = await sb.storage.from('notas-fotos').download(n.foto_path);
        if (r.error || !r.data) {
          falhaBaixar++;
          if (!primeiroErro) primeiroErro = `baixar: ${r.error?.message || 'sem dados'} (${n.foto_path})`;
          continue;
        }
        blob = r.data;
      } catch (e) { falhaBaixar++; if (!primeiroErro) primeiroErro = 'baixar: ' + e.message; continue; }

      try {
        const ext = (String(n.foto_path).split('.').pop() || 'jpg').toLowerCase();
        const c   = mapa[n.user_id] || {};
        await GDrive.uploadFotoComDados(blob, {
          /* subtipo e data PRECISAM vir: sem subtipo toda nota RDM cai na
             pasta OUTROS, mesmo sendo Abastecimento — e o appProperties
             gravado errado ainda contamina a migração, que confia nele. */
          id: n.id, tipo: n.tipo, subtipo: n.subtipo, mes: n.mes, ano: n.ano, data: n.data,
          user_id: n.user_id, user_email: c.email, user_nome: c.nome,
        }, ext);
        ok++;
      } catch (e) { falhaSubir++; if (!primeiroErro) primeiroErro = 'subir: ' + e.message; }
    }

    if (ov) ov.style.display = 'none';
    alert(idxAviso
      + `Consolidação concluída.\n\n`
      + `Notas com foto: ${comFoto.length}\n`
      + `✅ Enviadas ao Drive: ${ok}\n`
      + `⬇️ Falha ao BAIXAR do Supabase: ${falhaBaixar}\n`
      + `☁️ Falha ao SUBIR no Drive: ${falhaSubir}\n`
      + (primeiroErro ? `\nPrimeiro erro: ${primeiroErro}` : ''));
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
  const [{ data: collabs }, { data: notas }] = await Promise.all([
    sb.from('colaboradores').select('id,nome,email'),
    sb.from('notas').select('id,user_id,tipo,subtipo,mes,ano,data,foto_path,deleted'),
  ]);
  const mapa = {};
  (collabs || []).forEach(c => { mapa[c.id] = c; });

  // 3) só as que têm foto, não deletadas, e que AINDA NÃO estão no Drive
  const pendentes = (notas || []).filter(n =>
    n.foto_path && !n.deleted && !GDrive.getFotoExt(n.id)
  );
  if (!pendentes.length) return;

  // 4) baixa do Supabase e sobe pro Drive (para suave se a conexão cair)
  let ok = 0;
  for (const n of pendentes) {
    if (!navigator.onLine || !GDrive.isConnected()) break;
    try {
      const r = await sb.storage.from('notas-fotos').download(n.foto_path);
      if (r.error || !r.data) continue;
      const ext = (String(n.foto_path).split('.').pop() || 'jpg').toLowerCase();
      const c   = mapa[n.user_id] || {};
      await GDrive.uploadFotoComDados(r.data, {
        // subtipo/data obrigatórios — ver o comentário no envio da equipe
        id: n.id, tipo: n.tipo, subtipo: n.subtipo, mes: n.mes, ano: n.ano, data: n.data,
        user_id: n.user_id, user_email: c.email, user_nome: c.nome,
      }, ext);
      ok++;
    } catch (_) { /* segue p/ a próxima */ }
  }
  if (ok) toast(`Drive atualizado: ${ok} foto(s) da equipe organizada(s) ☁️`);
}

/* ── VIEW: PERFIL ────────────────────────────────────────── */
function renderPerfil() {
  $('app-content').innerHTML = `
  <div class="page-hd"><h2>Perfil</h2></div>
  <div class="perfil-card">
    <div class="perfil-avatar">${esc((user?.nome||'?')[0].toUpperCase())}</div>
    <div class="perfil-nome">${esc(user?.nome||user?.email||'')}</div>
    <div class="perfil-email">${esc(user?.email||'')}</div>
    <div class="perfil-meta">
      <span class="role-pill role-${esc(user?.role||'colaborador')}">${esc(user?.role||'colaborador')}</span>
      <span class="nucleo-pill">${esc(user?.nucleo||'')}</span>
    </div>
  </div>

  <div class="perfil-form">
    <label class="lbl">Nome</label>
    <input class="inp" id="p-nome"   value="${esc(user?.nome||'')}">
    <label class="lbl">Núcleo</label>
    <select class="inp" id="p-nucleo">
      ${NUCLEOS.map(n=>`<option value="${n}"${n===user?.nucleo?' selected':''}>${n}</option>`).join('')}
    </select>
    <button class="btn btn-primary" onclick="salvarPerfil()">Salvar perfil</button>
  </div>

  <div class="perfil-actions">
    <div class="install-slot"></div>
    <button class="btn btn-outline" onclick="abrirAjuda()">❓ Como usar o app</button>
    <button class="btn btn-outline" onclick="exportExcel()">📊 Excel Anual ${filAno}</button>
    <button class="btn btn-outline" onclick="exportCSV()">📄 CSV ${MESES[filMes-1]}/${filAno}</button>
    <button class="btn btn-outline" onclick="diagnosticoFotos()">🔎 Diagnóstico de anexos</button>
    <button class="btn btn-outline" onclick="diagnosticoInstalacao()">🔎 Diagnóstico de instalação</button>
    <div style="border-top:1px solid var(--border);padding-top:16px;margin-top:4px">
      <p class="lbl" style="margin-bottom:12px">☁️ Google Drive</p>
      ${driveOk && GDrive.isConnected() ? `
        <div style="background:#F0FBF4;border:1.5px solid #74C69D;border-radius:10px;padding:12px 14px;margin-bottom:12px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="width:9px;height:9px;border-radius:50%;background:#40916C;flex-shrink:0;display:inline-block"></span>
            <span style="font-size:13px;font-weight:700;color:#1B4332">Conectado</span>
            <span style="margin-left:auto;font-size:11px;color:#5A6E60">Expira em ${GDrive.minutosRestantes()} min</span>
          </div>
          <p style="font-size:12px;color:#5A6E60">Notas e fotos sincronizando automaticamente</p>
        </div>
        <button class="btn btn-outline btn-full" style="margin-bottom:8px" onclick="testarDrive()">🔍 Testar acesso à pasta</button>
        <button class="btn btn-outline btn-full" style="margin-bottom:8px" onclick="migrarPastasDrive()">🗂️ Reorganizar pastas no padrão</button>
        <button class="btn btn-danger-outline btn-full" onclick="disconnectDrive()">Desconectar Drive</button>
      ` : `
        <div style="background:#F8FAF9;border:1.5px dashed var(--border);border-radius:10px;padding:14px;margin-bottom:12px;text-align:center">
          <div style="font-size:28px;margin-bottom:8px">☁️</div>
          <p style="font-size:13px;color:var(--text2);line-height:1.6">
            Salve notas, repasses e fotos automaticamente no Google Drive compartilhado.
          </p>
        </div>
        <button class="btn btn-primary btn-full" onclick="connectDrive()">
          Entrar com Google Drive
        </button>
      `}
    </div>
    <button class="btn btn-danger-outline" onclick="logout()">Sair</button>
  </div>`;
  _pintarBotaoInstalar();
}

async function salvarPerfil() {
  const nome   = $('p-nome').value.trim();
  const nucleo = $('p-nucleo').value;
  if (!nome) { toast('Informe seu nome','err'); return; }
  user.nome   = nome;
  user.nucleo = nucleo;
  if (sb && !DEMO_MODE) {
    await sb.from('colaboradores').update({ nome, nucleo }).eq('id', user.id);
  }
  toast('Perfil salvo!');
  renderPerfil();
}

/* ── CAPTURA: sheet seleção ──────────────────────────────── */
function abrirCaptura() {
  $('capture-sheet').classList.add('open');
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
      + 'background:rgba(0,0,0,.78);color:#7CFC00;font-size:13px;font-weight:700;'
      + 'padding:10px 12px;text-align:center;font-family:monospace;line-height:1.45;'
      + 'padding-top:calc(10px + env(safe-area-inset-top,0px));';
    $('qr-overlay').appendChild(diag);
  }
  const setDiag = t => { diag.textContent = `[${APP_VERSION}] ` + t; };
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
  // decodifica a cada 2 frames — equilíbrio entre CPU e velocidade de leitura
  _qrSkip = (_qrSkip + 1) % 2;
  if (_qrSkip === 0 && video.videoWidth) {
    if (canvas.width !== video.videoWidth)  canvas.width  = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // attemptBoth = lê QR normal E invertido (cupons desbotados/claros)
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
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
        }
        fecharQR();
        await _finalizarCapturaQR(parsed, frameBlob);
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
  qrFrame = requestAnimationFrame(() => loopQR(ctx, video, canvas));
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

  await abrirFormNota(dados);   // chave/CNPJ/UF já entram; fotoBlob fica null
  _pedirFotoPasso2();           // Passo 2: destaca e pede a foto (abre no TOQUE)
  toast('Chave lida! 🔑 Passo 2: toque no botão destacado para fotografar a nota.');
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
    abrirFormNota({
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
    });
    toast(isNFe ? 'NF-e identificada pela chave' : 'NFC-e identificada pela chave');
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
const _FOTO_LADO_MAX   = 1800;
const _FOTO_QUALIDADE  = 0.75;
const _FOTO_MIN_COMPRIMIR = 400 * 1024;   // abaixo disso não vale o esforço

async function _comprimirImagem(blob, ext) {
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
async function abrirFormNota(dados = {}) {
  fotoBlob = null; fotoURL = null; fotoExt = null; _setFotoRender(null);
  _limparPedirFoto();                 // reseta destaque do Passo 2 a cada abertura
  const ov = $('nota-form-overlay');
  ov.style.display = 'flex';

  $('nf-id').value       = dados.id       || '';
  $('nf-metodo').value   = dados.metodo_captura || 'manual';
  $('nf-chave').value    = dados.chave    || '';
  $('nf-uf').value       = dados.uf       || '';
  $('nf-tipo').value     = dados.tipo     || 'RDA';
  $('nf-subtipo').value  = dados.subtipo  || 'Abastecimento';
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

  // título
  $('nf-titulo').textContent = dados.id ? 'Editar Nota' : 'Nova Nota';
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
  if (_digitos($('nf-chave').value).length === 44) {
    cl.style.display = 'inline-block';
    cl.onclick = () => abrirConsultaChave($('nf-chave').value);
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
  $('nota-form-overlay').style.display = 'none';
}

function toggleSubtipo() {
  $('nf-subtipo-group').style.display = $('nf-tipo').value==='RDM' ? '' : 'none';
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
  const file = e.target.files[0];
  if (!file) return;
  _limparPedirFoto();               // foto anexada → tira o destaque do Passo 2
  fotoBlob = file;
  fotoExt  = 'jpg';                 // câmera sempre devolve imagem
  fotoURL  = URL.createObjectURL(file);
  atualizarPreviewFoto(fotoURL);
  // lê a própria foto anexada (OCR) e preenche os campos vazios
  await extrairDadosDaFoto(file);
}

/* Anexar arquivo já existente no aparelho: imagem, PDF ou XML da NF-e.
   - imagem  → OCR (lê valor/empresa) como na foto
   - XML     → faz o parse e preenche tudo (autoritativo)
   - PDF     → só anexa (sem leitura automática) */
async function onArquivoNotaChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  _limparPedirFoto();               // arquivo anexado → tira o destaque do Passo 2
  fotoBlob = file;
  fotoExt  = _extDoArquivo(file);
  fotoURL  = URL.createObjectURL(file);
  atualizarPreviewFoto(fotoURL);
  if (_ehImagemExt(fotoExt))      await extrairDadosDaFoto(file);
  else if (fotoExt === 'xml')     await extrairDadosDoXML(file);
  else /* pdf */                  await extrairDadosDoPDF(file);
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
  if (p?.chave) _salvarUrlQR(p.chave, data);   // guarda o link real da consulta
  return p;
}

/* Botão "Ler QR da foto e inserir a chave" — usa a foto anexada
   (ou a imagem renderizada da 1ª página, no caso de PDF) */
async function lerChaveDaFotoAnexada() {
  const alvo = _ehImagemExt(fotoExt || 'jpg') ? fotoBlob : fotoRender;
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
         entram no texto e viram valor/CNPJ errado. Alimenta só a leitura —
         o anexo salvo continua sendo a foto original (evidência fiscal). */
      let alvo = file;
      if (window.Recorte) {
        ov.style.display = 'none';                 // o recorte assume a tela
        try { alvo = (await Recorte.abrir(file)) || file; } catch (_) { alvo = file; }
        ov.style.display = 'flex';
      }
      $('ocr-progress').textContent = 'Lendo o texto…';
      try { ocr = await OCR.processar(alvo); } catch (_) {}
    }

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
      <span class="muted-p" style="display:block;font-size:11px">📄 PDF — imagem da 1ª página</span>`;
  } else {
    const icon = kind === 'pdf' ? '📄' : '🧾';
    prev.innerHTML = `<span class="muted-p">${icon} ${kind.toUpperCase()} anexado — use “Ver anexo” na lista</span>`;
  }
  $('btn-foto-label').textContent = '📷 Trocar foto';
  _atualizarBotaoLerChave();
}

/* Botão manual de ler QR só aparece como RESERVA:
   há algo legível (imagem, ou PDF já renderizado) E a leitura
   automática NÃO pegou a chave. (XML não tem QR para ler.) */
function _atualizarBotaoLerChave() {
  const btn = $('btn-ler-chave'); if (!btn) return;
  const legivel  = (!!fotoBlob && (!fotoExt || _ehImagemExt(fotoExt))) || !!fotoRender;
  const temChave = _digitos($('nf-chave').value).length === 44;
  btn.style.display = (legivel && !temChave) ? 'block' : 'none';
}

/* nota (não deletada) do usuário com a MESMA chave NFC-e já registrada;
   ignora a que está sendo editada. Devolve a nota existente ou null. */
function _notaDuplicadaChave(chave, ignoreId) {
  const c = _digitos(chave);
  if (c.length !== 44) return null;
  return notas.find(n => n.id !== ignoreId && !n.deleted && _digitos(n.chave_nfce) === c) || null;
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

  /* ANEXO OBRIGATÓRIO — nota de prestação de contas sem comprovante não vale.
     Ao EDITAR, o anexo que a nota já tem no servidor conta: depois que a foto
     sobe, o blob local é apagado e `fotoBlob` fica null. Sem essa ressalva,
     nenhuma nota já sincronizada poderia mais ser corrigida. */
  const _idEdicao  = $('nf-id').value || null;
  const _notaAtual = _idEdicao ? notas.find(n => n.id === _idEdicao) : null;
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
  // usa a função chave_nfce_existe (SECURITY DEFINER) — só devolve sim/não.
  const _chaveDig = _digitos($('nf-chave').value);
  if (_chaveDig.length === 44 && sb && navigator.onLine) {
    try {
      const { data: existe, error } = await sb.rpc('chave_nfce_existe', {
        p_chave: _chaveDig, p_ignore_id: $('nf-id').value || null,
      });
      if (!error && existe) {
        toast('⚠️ Esta nota já foi registrada por outro colaborador da equipe.', 'err');
        return;
      }
    } catch (_) { /* falha na checagem online não bloqueia (a trava local já valeu) */ }
  }
  const semValor = isNaN(valor) || valor <= 0;
  if (semValor) valor = 0;

  const cnpjRaw = BrasilAPI.limpar($('nf-cnpj').value);
  const mes  = parseInt($('nf-mes').value, 10) || new Date(data+'T00:00:00').getMonth()+1;
  const ano  = parseInt($('nf-ano').value, 10) || new Date(data+'T00:00:00').getFullYear();

  const payload = {
    id             : $('nf-id').value || undefined,
    tipo, valor, data, mes, ano,
    subtipo        : tipo==='RDM' ? $('nf-subtipo').value : null,
    cnpj           : cnpjRaw || null,
    razao_social   : $('nf-razao').value.trim() || null,
    observacao     : $('nf-obs').value.trim()   || null,
    chave_nfce     : $('nf-chave').value        || null,
    uf             : $('nf-uf').value           || null,
    metodo_captura : $('nf-metodo').value       || 'manual',
    foto_local     : null,
  };

  /* Ao editar, mantém o vínculo com o anexo que já está no servidor. O payload
     é montado só com os campos do formulário, e sem isto o save gravava o
     registro sem foto_path: a foto continuava no Supabase, mas a nota perdia a
     referência — sumia o 📎 e ela voltava a contar como "sem anexo".
     Se um anexo novo for enviado, o pushPending sobrescreve com o caminho certo. */
  if (_notaAtual?.foto_path) payload.foto_path = _notaAtual.foto_path;
  if (_notaAtual?.qr_url)    payload.qr_url    = _notaAtual.qr_url;

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

    const saved = await DB.saveNota(payload, user.id);
    if (anexoBlob) {
      await DB.saveFotoLocal(saved.id, anexoBlob, anexoExt);
      // upload do anexo com todos os dados da nota como metadados no Drive
      GDrive.uploadFotoComDados(anexoBlob, { ...saved, user_id: user.id, user_email: user.email, user_nome: user.nome }, anexoExt)
        .then(() => toast('Anexo salvo no Drive ☁️'))
        .catch(e => toast('Drive anexo: ' + e.message, 'err'));
    }
    fecharFormNota();
    await carregarDadosLocais();
    renderNotas();
    toast(semValor ? '⚠️ Nota salva SEM valor — edite para completar' : 'Nota salva!', semValor ? 'err' : 'ok');
    syncToDrive().catch(() => {});
    if (sb && navigator.onLine) DB.sync(sb, user.id).then(()=>{}).catch(()=>{});
  } finally { setLoading(false); }
}

async function editarNota(id) {
  const n = notas.find(x=>x.id===id);
  if (!n) return;
  abrirFormNota(n);
}

async function excluirNota(id) {
  if (!confirm('Excluir esta nota?')) return;
  await DB.softDeleteNota(id);
  await carregarDadosLocais();
  renderNotas();
  syncToDrive().catch(() => {});
  if (sb && navigator.onLine) DB.sync(sb, user.id).catch(()=>{});
  toast('Nota excluída');
}

async function verFoto(id) {
  const n = notas.find(x=>x.id===id);
  if (!n) return;

  let url = null, ext = null;

  // 1. anexo local (IndexedDB)
  const local = await DB.getFotoLocal(id);
  if (local?.blob) { url = URL.createObjectURL(local.blob); ext = local.ext || _extDoArquivo(local.blob); }

  /* 2. Supabase Storage — ANTES do Drive. A URL do Drive leva o token na
     query (?alt=media&access_token=…), formato que a API do Google não
     aceita mais para autorizar: a imagem não carrega e o visualizador
     abria vazio, mesmo com o arquivo íntegro no Supabase. */
  if (!url && n.foto_path && sb) {
    const { data } = await sb.storage.from('notas-fotos').createSignedUrl(n.foto_path, 300);
    if (data?.signedUrl) { url = data.signedUrl; ext = _extDeUrl(n.foto_path); }
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
function abrirAjuda()  { $('ajuda-overlay').style.display = 'flex'; $('ajuda-overlay').querySelector('.form-body').scrollTop = 0; }
function fecharAjuda() { $('ajuda-overlay').style.display = 'none'; }

/* ── Form Repasse ────────────────────────────────────────── */
function abrirFormRepasse() {
  /* Sem este reset o <select> guardava o tipo do repasse anterior: quem
     lançava um RDM e depois um RDA reabria o form já em RDM e o RDA entrava
     como RDM em silêncio — o saldo de um tipo inflava e o do outro zerava. */
  $('rep-tipo').value  = 'RDA';
  $('rep-data').value  = hoje();
  $('rep-valor').value = '';
  $('rep-desc').value  = '';
  $('rep-mes').value   = filMes;
  $('rep-ano').value   = filAno;
  $('rep-overlay').style.display = 'flex';
}
function fecharFormRepasse() { $('rep-overlay').style.display = 'none'; }

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
  if (!tipo||!valor||!data) { toast('Preencha os campos','err'); return; }
  const mes = parseInt($('rep-mes').value,10) || filMes;
  const ano = parseInt($('rep-ano').value,10) || filAno;
  await DB.saveRepasse({ tipo, valor, data, mes, ano, descricao: $('rep-desc').value.trim() || null }, user.id);
  fecharFormRepasse();
  await carregarDadosLocais();
  renderSaldo();
  // o tipo vai no aviso: erro de tipo é invisível no valor e só aparece no saldo
  toast(`Repasse ${tipo} de ${brl(valor)} lançado!`);
  syncToDrive().catch(() => {});
  if (sb && navigator.onLine) DB.sync(sb, user.id).catch(()=>{});
}

async function excluirRepasse(id) {
  if (!confirm('Excluir este repasse?')) return;
  await DB.softDeleteRepasse(id);
  await carregarDadosLocais();
  renderSaldo();
  syncToDrive().catch(() => {});
  toast('Repasse excluído');
}

/* ── Exportações ─────────────────────────────────────────── */
let _xlsxLoaded = false;
async function _ensureXLSX() {
  if (typeof XLSX !== 'undefined') { _xlsxLoaded = true; return; }
  if (_xlsxLoaded) return;
  setLoading(true);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js';
    s.onload  = () => { _xlsxLoaded = true; setLoading(false); res(); };
    s.onerror = () => { setLoading(false); rej(new Error('Falha ao carregar exportação')); };
    document.head.appendChild(s);
  });
}
async function exportCSV()   { await _ensureXLSX(); Excel.exportarCSV(filMes, filAno, notas, repasses, user); }
async function exportExcel() { await _ensureXLSX(); Excel.exportarAnual(filAno, notas, repasses, user); }

/* Planilha do Google "ao vivo" — cria/atualiza na pasta do Drive e abre o link */
async function exportSheets() {
  if (!GDrive.isConnected()) {
    toast('Conecte o Google Drive no Perfil primeiro', 'err');
    switchView('perfil');
    return;
  }
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
document.addEventListener('DOMContentLoaded', () => {
  init();
  renderAuth('login');
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') fecharFotoViewer();
  });
});
