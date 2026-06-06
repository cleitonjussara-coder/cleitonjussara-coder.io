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

/* câmera */
let qrStream  = null;
let qrFrame   = null;

/* foto selecionada na edição */
let fotoBlob  = null;
let fotoURL   = null;

const MESES   = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const NUCLEOS = ['Cristalina','Formosa','Paracatu','Uberlândia','Outro'];
const APP_VERSION = 'v40';

/* ── Helpers ─────────────────────────────────────────────── */
const brl  = v => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v||0);
const hoje = () => new Date().toISOString().split('T')[0];
const esc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const $    = id => document.getElementById(id);
const fmtData = d => { try { return new Date(d+'T00:00:00').toLocaleDateString('pt-BR'); } catch(_){return d;} };
const _digitos = s => String(s||'').replace(/\D/g,'');

/* ── Link de consulta da nota (SEFAZ) ─────────────────────── */
async function resolverLinkConsulta(chaveRaw) {
  const chave = _digitos(chaveRaw);
  if (chave.length !== 44) return null;
  let raw = null;
  try { raw = await DB.getMeta('qr_' + chave); } catch (_) {}   // URL real do QR, se houver
  return raw || (window.SEFAZ?.linkConsulta ? SEFAZ.linkConsulta(chave) : null);
}

function abrirConsultaChave(chaveRaw) {
  if (_digitos(chaveRaw).length !== 44) { toast('Esta nota não tem chave NFC-e para consulta', 'err'); return; }
  const w = window.open('', '_blank');           // abre já, evita bloqueio de popup
  resolverLinkConsulta(chaveRaw).then(url => {
    if (url) { if (w) w.location.href = url; else window.open(url, '_blank'); }
    else { if (w) w.close(); toast('Não foi possível montar o link de consulta', 'err'); }
  });
}

function consultarNota(id) {
  const n = notas.find(x => x.id === id);
  abrirConsultaChave(n?.chave_nfce || '');
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

function setLoading(on) {
  const el = $('loading-overlay');
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
      if (!session) { showTela('auth'); renderAuth(); }
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
    const {ok,pulled} = e.detail||{};
    if ((ok||0)+(pulled||0) > 0) toast(`Sincronizado: ${ok||0} enviados, ${pulled||0} recebidos`);
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
        }).catch(() => {});
    }

    // sync de dados em background
    DB.sync(sb, user.id).catch(() => {});
    if (driveOk) pullFromDrive().catch(() => {});
  } catch (_) { setLoading(false); }
}

async function carregarDadosLocais() {
  if (!user) return;
  notas    = await DB.getNotasUser(user.id);
  repasses = await DB.getRepassesUser(user.id);
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

/* ── Auth ────────────────────────────────────────────────── */
let authMode = 'login';
function renderAuth(mode='login') {
  authMode = mode;
  $('auth-body').innerHTML = mode==='login' ? `
    <h2 class="auth-title">Entrar</h2>
    <input class="inp" id="a-email" type="email" placeholder="E-mail" autocomplete="email">
    <input class="inp" id="a-pass"  type="password" placeholder="Senha" autocomplete="current-password">
    <button class="btn btn-primary btn-full" onclick="login()">Entrar</button>
    <p class="auth-switch">Não tem conta? <a onclick="renderAuth('reg')">Cadastrar</a></p>
    <div style="margin-top:8px;text-align:center">
      <hr style="border-color:rgba(255,255,255,.2);margin:12px 0">
      <button class="btn btn-outline btn-full" style="border-color:rgba(255,255,255,.4);color:rgba(255,255,255,.8)"
              onclick="usarSemConta()">Usar sem conta (modo local)</button>
      <p style="color:rgba(255,255,255,.45);font-size:11px;margin-top:14px">Versão ${APP_VERSION}</p>
    </div>
  ` : `
    <h2 class="auth-title">Criar conta</h2>
    <input class="inp" id="a-nome"  type="text"     placeholder="Seu nome">
    <input class="inp" id="a-email" type="email"    placeholder="E-mail" autocomplete="email">
    <input class="inp" id="a-pass"  type="password" placeholder="Senha (min. 6 caracteres)" autocomplete="new-password">
    <button class="btn btn-primary btn-full" onclick="register()">Criar conta</button>
    <p class="auth-switch">Já tem conta? <a onclick="renderAuth('login')">Entrar</a></p>
    <div style="margin-top:8px;text-align:center">
      <hr style="border-color:rgba(255,255,255,.2);margin:12px 0">
      <button class="btn btn-outline btn-full" style="border-color:rgba(255,255,255,.4);color:rgba(255,255,255,.8)"
              onclick="usarSemConta()">Usar sem conta (modo local)</button>
    </div>
  `;
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

/* ── VIEW: HOME ──────────────────────────────────────────── */
function renderHome() {
  const ns = notas.filter(n => n.mes===filMes && n.ano===filAno);
  const rs = repasses.filter(r => r.mes===filMes && r.ano===filAno);

  const rdmG = ns.filter(n=>n.tipo==='RDM').reduce((a,n)=>a+Number(n.valor||0),0);
  const rdmR = rs.filter(r=>r.tipo==='RDM').reduce((a,r)=>a+Number(r.valor||0),0);
  const rdaG = ns.filter(n=>n.tipo==='RDA').reduce((a,n)=>a+Number(n.valor||0),0);
  const rdaR = rs.filter(r=>r.tipo==='RDA').reduce((a,r)=>a+Number(r.valor||0),0);

  const pendentes = ns.filter(n => n.synced===false).length;
  const totalNotas = ns.length;

  // barras RDM por categoria
  const subs = ['Abastecimento','Hospedagem','Outros'];
  const subVals = subs.map(s => ns.filter(n=>n.tipo==='RDM'&&n.subtipo===s).reduce((a,n)=>a+Number(n.valor||0),0));
  const subMax  = Math.max(...subVals, 1);
  const cores   = ['r1','r2','r3'];

  let barHtml = '';
  subs.forEach((s, i) => {
    if (rdmG === 0 && subVals[i] === 0) return;
    const pct = Math.round((subVals[i] / subMax) * 100);
    barHtml += `
    <div class="bar-item">
      <span class="bar-label">${s}</span>
      <div class="bar-track"><div class="bar-fill ${cores[i]}" style="width:${pct}%"></div></div>
      <span class="bar-val">${brl(subVals[i])}</span>
    </div>`;
  });

  // evolucao ultimos 3 meses
  let evoHtml = '';
  for (let i = 2; i >= 0; i--) {
    let m = filMes - i;
    let a = filAno;
    if (m < 1) { m += 12; a--; }
    const mNs = notas.filter(n=>n.mes===m&&n.ano===a);
    const valRDM = mNs.filter(n=>n.tipo==='RDM').reduce((s,n)=>s+Number(n.valor||0),0);
    const valRDA = mNs.filter(n=>n.tipo==='RDA').reduce((s,n)=>s+Number(n.valor||0),0);
    evoHtml += `
    <div class="evo-card">
      <div class="evo-mes">${MESES[m-1]}</div>
      <div class="evo-rdm">${brl(valRDM)}</div>
      <div class="evo-rda">${brl(valRDA)}</div>
    </div>`;
  }

  // ultimas 5 notas
  const recentes = [...ns].sort((a,b) => b.data.localeCompare(a.data) || (b.created_at||'').localeCompare(a.created_at||'')).slice(0, 5);
  let recHtml = recentes.length ? recentes.map(n => `
    <div class="recent-item" onclick="editarNota('${n.id}')">
      <span class="tipo-badge tipo-${n.tipo}">${n.tipo}</span>
      <div class="recent-info">
        <div class="recent-tit">${esc(n.razao_social || (n.cnpj?BrasilAPI.formatar(n.cnpj):'Sem empresa'))}</div>
        <div class="recent-sub">${fmtData(n.data)}${n.subtipo?' · '+n.subtipo:''}</div>
      </div>
      <span class="recent-val ${n.tipo.toLowerCase()}">${brl(n.valor)}</span>
    </div>`).join('') : '<p class="muted-p">Nenhuma nota lançada este mes.</p>';

  $('app-content').innerHTML = `
  <div class="page-hd">
    <div class="mes-nav">
      <button class="btn-mes-nav" onclick="mudarMes(-1)">‹</button>
      <span class="mes-label">${MESES[filMes-1]} ${filAno}</span>
      <button class="btn-mes-nav" onclick="mudarMes(1)">›</button>
    </div>
  </div>

  <div class="home-grid">
    <div class="home-card">
      <div class="home-card-icon">⛽</div>
      <div class="home-card-val${rdmR-rdmG<0?' neg':''}">${brl(rdmR-rdmG)}</div>
      <div class="home-card-label">RDM</div>
      <div class="home-card-sub">${brl(rdmG)} gasto · ${brl(rdmR)} recebido</div>
    </div>
    <div class="home-card">
      <div class="home-card-icon">📋</div>
      <div class="home-card-val${rdaR-rdaG<0?' neg':''}">${brl(rdaR-rdaG)}</div>
      <div class="home-card-label">RDA</div>
      <div class="home-card-sub">${brl(rdaG)} gasto · ${brl(rdaR)} recebido</div>
    </div>
    <div class="home-card">
      <div class="home-card-icon">📄</div>
      <div class="home-card-val">${totalNotas}</div>
      <div class="home-card-label">Notas</div>
      <div class="home-card-sub">lançadas este mês</div>
    </div>
    <div class="home-card">
      <div class="home-card-icon">${pendentes?'⏳':'✅'}</div>
      <div class="home-card-val">${pendentes||'0'}</div>
      <div class="home-card-label">Pendentes</div>
      <div class="home-card-sub">${pendentes?'aguardando sync':'tudo sincronizado'}</div>
    </div>
  </div>

  ${rdmG > 0 ? `
  <div class="bar-section">
    <div class="bar-hd">Gastos RDM por Categoria</div>
    ${barHtml}
  </div>` : ''}

  <div class="evo-section">
    <div class="bar-hd">Evolução</div>
    <div class="evo-row">${evoHtml}</div>
  </div>

  <div class="recent-section">
    <div class="recent-hd">
      <span>Últimos Lançamentos</span>
      <a onclick="switchView('notas')">Ver todas →</a>
    </div>
    ${recHtml}
  </div>`;
}

/* ── VIEW: NOTAS ─────────────────────────────────────────── */
function renderNotas() {
  const el = $('app-content');
  const ns = notas.filter(n => n.mes===filMes && n.ano===filAno)
    .sort((a,b) => b.data.localeCompare(a.data));

  let html = `
  <div class="page-hd">
    <div class="mes-nav">
      <button class="btn-mes-nav" onclick="mudarMes(-1)">‹</button>
      <span class="mes-label">${MESES[filMes-1]} ${filAno}</span>
      <button class="btn-mes-nav" onclick="mudarMes(1)">›</button>
    </div>
    <div class="fil-tipo">
      <button class="chip active" data-fil="all"  onclick="filtrarTipo(this)">Todas</button>
      <button class="chip"        data-fil="RDA"  onclick="filtrarTipo(this)">RDA</button>
      <button class="chip"        data-fil="RDM"  onclick="filtrarTipo(this)">RDM</button>
    </div>
  </div>`;

  if (!ns.length) {
    html += `<div class="empty-state">
      <div class="empty-icon">📋</div>
      <p>Nenhuma nota em ${MESES[filMes-1]}/${filAno}</p>
      <button class="btn btn-primary" onclick="abrirCaptura()">+ Lançar</button>
    </div>`;
  } else {
    html += `<div class="notas-list" id="notas-list">`;
    ns.forEach(n => {
      const pendSync = n.synced===false ? '<span class="sync-pending" title="Pendente sync">⏳</span>' : '';
      html += `
      <div class="nota-card" data-tipo="${n.tipo}">
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
            ${n.foto_path||n.foto_local ? `<button class="btn-icon-sm" onclick="verFoto('${n.id}')" title="Ver foto">🖼</button>` : ''}
            <button class="btn-icon-sm" onclick="editarNota('${n.id}')" title="Editar">✏️</button>
            <button class="btn-icon-sm danger" onclick="excluirNota('${n.id}')" title="Excluir">🗑</button>
          </div>
        </div>
      </div>`;
    });
    html += `</div>`;
  }
  el.innerHTML = html;
}

function mudarMes(delta) {
  filMes += delta;
  if (filMes > 12) { filMes = 1;  filAno++; }
  if (filMes < 1)  { filMes = 12; filAno--; }
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
  const ns = notas.filter(n => n.mes===filMes && n.ano===filAno);
  const rs = repasses.filter(r => r.mes===filMes && r.ano===filAno);

  const rdmG = ns.filter(n=>n.tipo==='RDM').reduce((a,n)=>a+Number(n.valor||0),0);
  const rdmR = rs.filter(r=>r.tipo==='RDM').reduce((a,r)=>a+Number(r.valor||0),0);
  const rdaG = ns.filter(n=>n.tipo==='RDA').reduce((a,n)=>a+Number(n.valor||0),0);
  const rdaR = rs.filter(r=>r.tipo==='RDA').reduce((a,r)=>a+Number(r.valor||0),0);

  // breakdown RDM por subtipo
  const subs = ['Abastecimento','Hospedagem','Outros'];
  const subHtml = subs.map(s => {
    const v = ns.filter(n=>n.tipo==='RDM'&&n.subtipo===s).reduce((a,n)=>a+Number(n.valor||0),0);
    return v>0 ? `<div class="sub-row"><span>${s}</span><span>${brl(v)}</span></div>` : '';
  }).join('');

  // repasses do mês
  const repHtml = rs.length ? rs.map(r => `
    <div class="rep-item">
      <span class="tipo-badge tipo-${r.tipo}">${r.tipo}</span>
      <span class="rep-desc">${esc(r.descricao||'Repasse')}</span>
      <span class="rep-val">${brl(r.valor)}</span>
      <button class="btn-icon-sm danger" onclick="excluirRepasse('${r.id}')">🗑</button>
    </div>`).join('') : '<p class="muted-p">Nenhum repasse lançado.</p>';

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
    </div>
  </div>

  <div class="saldo-grid">
    <div class="saldo-card ${rdmR-rdmG<0?'neg':''}">
      <div class="saldo-label">RDM</div>
      <div class="saldo-val">${brl(rdmR-rdmG)}</div>
      <div class="saldo-detail">
        <span>Gasto <b>${brl(rdmG)}</b></span>
        <span>Recebido <b>${brl(rdmR)}</b></span>
      </div>
      ${subHtml ? `<div class="sub-breakdown">${subHtml}</div>` : ''}
    </div>
    <div class="saldo-card ${rdaR-rdaG<0?'neg':''}">
      <div class="saldo-label">RDA</div>
      <div class="saldo-val">${brl(rdaR-rdaG)}</div>
      <div class="saldo-detail">
        <span>Gasto <b>${brl(rdaG)}</b></span>
        <span>Recebido <b>${brl(rdaR)}</b></span>
      </div>
    </div>
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

/* ── VIEW: PERFIL ────────────────────────────────────────── */
function renderPerfil() {
  $('app-content').innerHTML = `
  <div class="page-hd"><h2>Perfil</h2></div>
  <div class="perfil-card">
    <div class="perfil-avatar">${(user?.nome||'?')[0].toUpperCase()}</div>
    <div class="perfil-nome">${esc(user?.nome||user?.email||'')}</div>
    <div class="perfil-email">${esc(user?.email||'')}</div>
    <div class="perfil-meta">
      <span class="role-pill role-${user?.role}">${user?.role||'colaborador'}</span>
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
    <button class="btn btn-outline" onclick="abrirAjuda()">❓ Como usar o app</button>
    <button class="btn btn-outline" onclick="exportExcel()">📊 Excel Anual ${filAno}</button>
    <button class="btn btn-outline" onclick="exportCSV()">📄 CSV ${MESES[filMes-1]}/${filAno}</button>
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

  await abrirFormNota(dados);   // chave/CNPJ/UF já entram; fotoBlob fica null

  // destaca o botão de foto como chamada p/ ação
  const lbl = $('btn-foto-label');
  if (lbl) lbl.textContent = '📷 Fotografar a nota inteira (conferência)';

  toast('Chave lida! 🔑 Agora fotografe a nota inteira para conferência.');

  // tenta abrir a câmera da nota automaticamente (se o navegador permitir;
  // caso bloqueie por falta de gesto, o usuário toca em "Anexar foto").
  setTimeout(() => { try { $('f-foto-nota').click(); } catch (_) {} }, 400);
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
  fotoURL  = URL.createObjectURL(file);
  atualizarPreviewFoto(fotoURL);
}

/* ── Form Nota ───────────────────────────────────────────── */
async function abrirFormNota(dados = {}) {
  fotoBlob = null; fotoURL = null;
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
      fotoURL  = URL.createObjectURL(local.blob);
      atualizarPreviewFoto(fotoURL);
    } else {
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
  fotoBlob = file;
  fotoURL  = URL.createObjectURL(file);
  atualizarPreviewFoto(fotoURL);
  // lê a própria foto anexada (OCR) e preenche os campos vazios
  await extrairDadosDaFoto(file);
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

/* Botão "Ler QR da foto e inserir a chave" — usa a foto já anexada */
async function lerChaveDaFotoAnexada() {
  if (!fotoBlob) { toast('Anexe uma foto da nota primeiro', 'err'); return; }
  const ov = $('ocr-overlay');
  if (ov) { ov.style.display = 'flex'; $('ocr-progress').textContent = 'Procurando QR Code na foto…'; }
  const qr = await _lerQRdaImagem(fotoBlob);
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
   Combina os resultados e preenche só os campos vazios. */
async function extrairDadosDaFoto(file) {
  const ov = $('ocr-overlay');
  ov.style.display = 'flex';
  $('ocr-progress').textContent = 'Procurando QR Code…';
  try {
    // Busca 1: QR Code dentro da imagem
    const qr = await _lerQRdaImagem(file);

    // chave: a do QR desta foto OU a que já está no formulário (veio do "Escanear QR")
    let chave = (qr?.chave && qr.chave.length === 44) ? qr.chave : _digitos($('nf-chave').value);
    if (chave.length !== 44) chave = '';
    const daChave = chave ? NFCE.parseChave44(chave) : null;

    // OCR do texto impresso — usado principalmente para o VALOR
    $('ocr-progress').textContent = 'Lendo o texto…';
    let ocr = {};
    try { ocr = await OCR.processar(file); } catch (_) {}

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
  if (url) {
    const src = url.startsWith('supabase:') ? '#' : url; // URL real viria de signed URL
    prev.innerHTML = `<img src="${src}" alt="Foto" class="foto-thumb"
      onerror="this.parentElement.innerHTML='<span class=muted-p>📎 foto anexada</span>'">`;
    $('btn-foto-label').textContent = '📷 Trocar foto';
  } else {
    prev.innerHTML = '';
    $('btn-foto-label').textContent = '📷 Anexar foto';
  }
  _atualizarBotaoLerChave();
}

/* Botão manual de ler QR só aparece como RESERVA:
   há foto anexada E a leitura automática NÃO pegou a chave. */
function _atualizarBotaoLerChave() {
  const btn = $('btn-ler-chave'); if (!btn) return;
  const temFoto  = !!fotoBlob;
  const temChave = _digitos($('nf-chave').value).length === 44;
  btn.style.display = (temFoto && !temChave) ? 'block' : 'none';
}

async function salvarNota() {
  const tipo  = $('nf-tipo').value;
  let   valor = parseFloat($('nf-valor').value);
  const data  = $('nf-data').value;
  // só tipo e data são obrigatórios — sem valor, grava como "pendente" (0)
  if (!tipo || !data) { toast('Tipo e data são obrigatórios','err'); return; }
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

  // foto
  if (fotoBlob) {
    payload.foto_local = fotoBlob;
    await DB.saveFotoLocal(payload.id || 'tmp', fotoBlob);
  }

  setLoading(true);
  try {
    const saved = await DB.saveNota(payload, user.id);
    if (fotoBlob) {
      await DB.saveFotoLocal(saved.id, fotoBlob);
      // upload da foto com todos os dados da nota como metadados no Drive
      GDrive.uploadFotoComDados(fotoBlob, { ...saved, user_id: user.id })
        .then(() => toast('Foto salva no Drive ☁️'))
        .catch(e => toast('Drive foto: ' + e.message, 'err'));
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

  let url = null;

  // 1. foto local (IndexedDB)
  const local = await DB.getFotoLocal(id);
  if (local?.blob) url = URL.createObjectURL(local.blob);

  // 2. Google Drive
  if (!url) {
    const driveUrl = GDrive.getFotoUrl?.(id);
    if (driveUrl) url = driveUrl;
  }

  // 3. Supabase Storage
  if (!url && n.foto_path && sb) {
    const { data } = await sb.storage.from('notas-fotos').createSignedUrl(n.foto_path, 300);
    if (data?.signedUrl) url = data.signedUrl;
  }

  if (!url) { toast('Foto não encontrada', 'err'); return; }

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
  $('rep-data').value  = hoje();
  $('rep-valor').value = '';
  $('rep-desc').value  = '';
  $('rep-mes').value   = filMes;
  $('rep-ano').value   = filAno;
  $('rep-overlay').style.display = 'flex';
}
function fecharFormRepasse() { $('rep-overlay').style.display = 'none'; }

async function salvarRepasse() {
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
  toast('Repasse lançado!');
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

/* ── Boot ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  init();
  renderAuth('login');
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') fecharFotoViewer();
  });
});
