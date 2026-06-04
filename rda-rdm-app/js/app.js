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

/* ── Helpers ─────────────────────────────────────────────── */
const brl  = v => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v||0);
const hoje = () => new Date().toISOString().split('T')[0];
const esc  = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const $    = id => document.getElementById(id);
const fmtData = d => { try { return new Date(d+'T00:00:00').toLocaleDateString('pt-BR'); } catch(_){return d;} };

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
  if (viewAtual==='home')  renderHome();
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
  ` : `
    <h2 class="auth-title">Criar conta</h2>
    <input class="inp" id="a-nome"  type="text"     placeholder="Seu nome">
    <input class="inp" id="a-email" type="email"    placeholder="E-mail" autocomplete="email">
    <input class="inp" id="a-pass"  type="password" placeholder="Senha (min. 6 caracteres)" autocomplete="new-password">
    <button class="btn btn-primary btn-full" onclick="register()">Criar conta</button>
    <p class="auth-switch">Já tem conta? <a onclick="renderAuth('login')">Entrar</a></p>
  `;
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
          <span class="nota-valor">${brl(n.valor)}</span>
          <div class="nota-actions">
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
  const video  = $('qr-video');
  const canvas = $('qr-canvas');
  const ctx    = canvas.getContext('2d');

  navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment', width:{ideal:1280} } })
    .then(stream => {
      qrStream = stream;
      video.srcObject = stream;
      video.play();
      video.addEventListener('loadedmetadata', () => {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        loopQR(ctx, video, canvas);
      });
    })
    .catch(e => {
      fecharQR();
      toast('Câmera indisponível: ' + e.message, 'err');
    });
}

let _qrSkip = 0;
function loopQR(ctx, video, canvas) {
  if (!qrStream) return;
  // decodifica a cada 2 frames — metade do custo de CPU, scan continua fluido
  _qrSkip = (_qrSkip + 1) % 2;
  if (_qrSkip === 0) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts:'dontInvert' });
    if (code?.data) {
      const parsed = NFCE.fromScan(code.data);
      if (parsed?.chave || parsed?.cnpj) {
        fecharQR();
        if (parsed.chave) {
          navigator.clipboard?.writeText(parsed.chave).catch(() => {});
          toast('Chave NFCe copiada!');
        }
        abrirFormNota({ ...parsed, metodo_captura:'qrcode' });
        return;
      }
    }
  }
  qrFrame = requestAnimationFrame(() => loopQR(ctx, video, canvas));
}

function fecharQR() {
  cancelAnimationFrame(qrFrame);
  qrStream?.getTracks().forEach(t => t.stop());
  qrStream = null;
  $('qr-overlay').style.display = 'none';
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
  $('qr-hint').textContent = 'Aponte para o código de barras';
  $('qr-status-txt').textContent = '';

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
              if (parsed.chave) {
                navigator.clipboard?.writeText(parsed.chave).catch(() => {});
                toast('Chave NFCe copiada!');
              }
              abrirFormNota({ ...parsed, metodo_captura:'barcode' });
            } else {
              toast('Código de barras não reconhecido como NFC-e', 'err');
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
  $('qr-hint').textContent = 'Aponte para o QR Code da NFCe';
}

/* ── Chave NFCe (digitar 44 dígitos) ──────────────────── */
function iniciarChaveNFCe() {
  const chave = prompt('Cole a chave de acesso de 44 dígitos da NFC-e:');
  if (!chave || !chave.trim()) return;
  onChaveNFCe(chave.trim());
}

async function onChaveNFCe(raw) {
  setLoading(true);
  try {
    const result = await SEFAZ.consultarChave(raw);
    const badges = { chave:'🔑 Chave', sefaz_json:'🌐 SEFAZ', sefaz_proxy:'🌐 SEFAZ', sefaz_html:'🌐 SEFAZ' };
    abrirFormNota({
      cnpj           : result.cnpj || '',
      valor          : result.valor || '',
      data           : result.data || hoje(),
      razao_social   : result.razao_social || '',
      chave          : result.chave || '',
      uf             : result.uf || '',
      metodo_captura : `chave_nfce_${result.fonte}`,
      mes            : result.mes,
      ano            : result.ano,
    });
    const fonte = badges[result.fonte] || result.fonte;
    toast(`Nota encontrada via ${fonte}`);
  } catch (e) {
    toast(e.message, 'err');
  } finally { setLoading(false); }
}

/* ── OCR ─────────────────────────────────────────────────── */
function iniciarOCR() {
  fecharCaptura();
  $('f-foto-ocr').click();
}

async function onFotoOCR(e) {
  const file = e.target.files[0];
  if (!file) return;
  fotoBlob = file;

  const ov = $('ocr-overlay');
  ov.style.display = 'flex';
  $('ocr-progress').textContent = 'Iniciando OCR…';

  try {
    const result = await OCR.processar(file);
    ov.style.display = 'none';
    abrirFormNota({
      cnpj         : result.cnpj  || '',
      valor        : result.valor || '',
      data         : result.data  || hoje(),
      razao_social : result.razao_social || '',
      chave        : result.chave || '',
      uf           : result.uf    || '',
      metodo_captura: 'ocr',
    });
  } catch(err) {
    ov.style.display = 'none';
    toast('Erro no OCR: ' + err.message, 'err');
  }
  e.target.value = '';
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
  const badges = { qrcode:'📷 QR Code', ocr:'🔍 OCR', manual:'✏️ Manual', barcode:'📊 Cód. Barras', chave_nfce_chave:'🔑 Chave', chave_nfce_sefaz_json:'🌐 SEFAZ', chave_nfce_sefaz_proxy:'🌐 SEFAZ', chave_nfce_sefaz_html:'🌐 SEFAZ' };
  $('captura-badge').textContent = badges[dados.metodo_captura||'manual']||'✏️ Manual';

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

  // título
  $('nf-titulo').textContent = dados.id ? 'Editar Nota' : 'Nova Nota';
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

/* Lê um QR Code que esteja dentro de uma imagem (foto do cupom) */
async function _lerQRdaImagem(file) {
  try {
    await _ensureJsQR();
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload  = () => res(im);
      im.onerror = () => rej(new Error('img'));
      im.src = url;
    });
    URL.revokeObjectURL(url);
    // limita resolução p/ performance, mas alto o bastante p/ achar QR pequeno
    let w = img.width, h = img.height;
    const max = 2000;
    if (Math.max(w, h) > max) { const s = max / Math.max(w, h); w = Math.round(w*s); h = Math.round(h*s); }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h);
    const code = jsQR(d.data, d.width, d.height, { inversionAttempts:'attemptBoth' });
    if (code?.data) return NFCE.fromScan(code.data);
  } catch (_) {}
  return null;
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

    // Busca 2: OCR do texto impresso
    $('ocr-progress').textContent = 'Lendo o texto…';
    let ocr = {};
    try { ocr = await OCR.processar(file); } catch (_) {}

    // Mescla: QR tem prioridade p/ chave/CNPJ; valor = QR(pipe) → OCR
    const dados = {
      chave        : (qr?.chave && qr.chave.length === 44) ? qr.chave : (ocr.chave || ''),
      cnpj         : qr?.cnpj || ocr.cnpj || '',
      valor        : qr?.valor || ocr.valor || null,
      data         : ocr.data || qr?.data || null,
      razao_social : ocr.razao_social || null,
    };

    const preencheu = [];
    if (dados.valor && !$('nf-valor').value) {
      $('nf-valor').value = dados.valor; preencheu.push('valor');
    }
    if (dados.cnpj && !$('nf-cnpj').value) {
      $('nf-cnpj').value = BrasilAPI.formatar(dados.cnpj); preencheu.push('CNPJ');
    }
    if (dados.chave && dados.chave.length === 44 && !$('nf-chave').value) {
      $('nf-chave').value = dados.chave;
    }
    if (!$('nf-razao').value) {
      if (dados.razao_social) { $('nf-razao').value = dados.razao_social; preencheu.push('razão'); }
      else if (dados.cnpj)    { buscarRazaoSocial(dados.cnpj); }  // Busca 3: CNPJ → BrasilAPI
    }
    if (dados.data && (!$('nf-data').value || $('nf-data').value === hoje())) {
      $('nf-data').value = dados.data; preencheu.push('data');
    }

    ov.style.display = 'none';

    // Busca 4 (background): SEFAZ pela chave, se ainda faltar o valor
    if (dados.chave && dados.chave.length === 44 && !$('nf-valor').value) {
      enriquecerViaSefaz(dados.chave);
    }

    const via = qr ? ' (QR + texto)' : '';
    toast(preencheu.length
      ? `Foto lida${via}: ${preencheu.join(', ')}`
      : 'Não consegui ler — confira manualmente', preencheu.length ? 'ok' : 'err');
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
}

async function salvarNota() {
  const tipo  = $('nf-tipo').value;
  const valor = parseFloat($('nf-valor').value);
  const data  = $('nf-data').value;
  if (!tipo||!valor||!data) { toast('Tipo, valor e data são obrigatórios','err'); return; }

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
    toast('Nota salva!');
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
