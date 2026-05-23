'use strict';
/* ─────────────────────────────────────────────────────────────
   app.js — Core Petermann PWA
   Troque as duas linhas abaixo com suas credenciais Supabase.
───────────────────────────────────────────────────────────── */
const SUPABASE_URL      = 'COLE_SUA_URL_AQUI';
const SUPABASE_ANON_KEY = 'COLE_SUA_ANON_KEY_AQUI';

const DEMO_MODE = SUPABASE_URL.includes('COLE_SUA');

/* ── Estado global ───────────────────────────────────────── */
let sb        = null;
let user      = null;   // { id, email, nome, role, nucleo }
let notas     = [];
let repasses  = [];
let driveOk   = false;
let viewAtual = 'notas';
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

function setLoading(on) { $('loading-overlay').style.display = on ? 'flex' : 'none'; }

function syncBadge(syncing) {
  const dot = $('sync-dot');
  const txt = $('sync-txt');
  if (syncing) { dot.className='sync-dot syncing'; txt.textContent='sincronizando'; return; }
  if (!navigator.onLine) { dot.className='sync-dot offline'; txt.textContent='offline'; return; }
  dot.className='sync-dot online'; txt.textContent='online';
}

/* ── Inicialização ───────────────────────────────────────── */
async function init() {
  if (!DEMO_MODE) {
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    sb.auth.onAuthStateChange(async (_ev, session) => {
      if (session?.user) {
        await onLogin(session.user);
      } else {
        user = null;
        showTela('auth');
      }
    });
    const { data:{ session } } = await sb.auth.getSession();
    if (!session) { showTela('auth'); renderAuth(); }
  } else {
    // modo demo sem Supabase
    $('demo-banner').style.display = 'flex';
    await DB.open();
    user = { id:'demo-user', email:'demo@petermann.app', nome:'Demo', role:'admin', nucleo:'Cristalina' };
    await carregarDadosLocais();
    showTela('app');
    switchView('notas');
  }

  initDrive();
  window.addEventListener('online',  () => { syncBadge(false); if(sb&&user) DB.sync(sb,user.id); });
  window.addEventListener('offline', () => syncBadge(false));
  window.addEventListener('db-synced', async e => {
    syncBadge(false);
    await carregarDadosLocais();
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
    if (!DEMO_MODE && sb) {
      const { data } = await sb.from('colaboradores').select('*').eq('id', authUser.id).maybeSingle();
      user = data || { id:authUser.id, email:authUser.email, nome:'', role:'colaborador', nucleo:'Cristalina' };
    }
    await DB.open();
    DB.setupAutoSync(sb, () => user?.id);
    await carregarDadosLocais();
    await DB.sync(sb, user.id);
    showTela('app');
    switchView('notas');
  } finally { setLoading(false); }
}

async function carregarDadosLocais() {
  if (!user) return;
  notas    = await DB.getNotasUser(user.id);
  repasses = await DB.getRepassesUser(user.id);
}

/* ── Telas ───────────────────────────────────────────────── */
function showTela(t) {
  ['auth','app'].forEach(id => $(id+'-screen').style.display = t===id ? '' : 'none');
  if (t==='app') {
    $('nav-equipe').style.display = (user?.role==='gestor'||user?.role==='admin') ? 'flex' : 'none';
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
  const { error } = await sb.auth.signInWithPassword({ email, password:pass });
  setLoading(false);
  if (error) toast(error.message,'err');
}

async function register() {
  const nome  = $('a-nome')?.value.trim()  || '';
  const email = $('a-email').value.trim();
  const pass  = $('a-pass').value;
  if (!email||!pass) { toast('Preencha os campos','err'); return; }
  if (pass.length < 6) { toast('Senha deve ter ao menos 6 caracteres','err'); return; }
  setLoading(true);
  const { error } = await sb.auth.signUp({ email, password:pass, options:{ data:{ nome } } });
  setLoading(false);
  if (error) { toast(error.message,'err'); return; }
  toast('Verifique seu e-mail para confirmar o cadastro.');
  renderAuth('login');
}

async function logout() {
  if (sb) await sb.auth.signOut();
  user = null; notas = []; repasses = [];
  showTela('auth'); renderAuth();
}

/* ── Google Drive ────────────────────────────────────────── */
async function initDrive() {
  if (!window.GDrive?.isConfigured()) return;
  try {
    driveOk = await GDrive.init();
    updateDriveBadge();
    if (driveOk && user) await pullFromDrive();
  } catch (e) { console.warn('Drive init:', e); }
}

async function onUploadSA(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  setLoading(true);
  try {
    await GDrive.loadFromFile(file);
    driveOk = true;
    updateDriveBadge();
    await pullFromDrive();
    toast('Google Drive conectado!');
    renderPerfil();
  } catch (err) {
    toast('Erro: ' + (err.message || err), 'err');
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
    if (viewAtual === 'notas')  renderNotas();
    if (viewAtual === 'saldo')  renderSaldo();
  } catch (e) { console.warn('Drive pull:', e); }
}

async function syncToDrive() {
  if (!driveOk || !user) return;
  syncBadge(true);
  try {
    await GDrive.syncNotas(user.id, notas, repasses);
    syncBadge(false);
  } catch (e) {
    syncBadge(false);
    console.error('Drive sync:', e);
    toast('Drive: ' + (e.message || 'Erro ao salvar'), 'err');
  }
}

function updateDriveBadge() {
  const badge = $('drive-badge');
  if (!badge) return;
  if (!window.GDrive?.isConfigured()) { badge.style.display = 'none'; return; }
  badge.style.display = 'flex';
  const connected = driveOk && GDrive.isConnected();
  $('drive-dot').style.background = connected ? '#74C69D' : '#E63946';
  $('drive-txt').textContent       = connected ? 'Drive' : 'Drive off';
}

/* ── Navegação ───────────────────────────────────────────── */
function switchView(v) {
  viewAtual = v;
  document.querySelectorAll('.nav-btn[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view===v)
  );
  const el = $('app-content');
  el.scrollTop = 0;
  if (v==='notas')  renderNotas();
  else if (v==='saldo')  renderSaldo();
  else if (v==='equipe') renderEquipe();
  else if (v==='perfil') renderPerfil();
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
  await Gestor.renderDashboard(el, sb, user, () => renderEquipe());
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
    <div style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">
      <p class="lbl" style="margin-bottom:8px">Google Drive</p>
      ${driveOk && GDrive.isConnected()
        ? `<p style="font-size:13px;color:var(--text2);margin-bottom:4px">✅ Conectado como:</p>
           <p style="font-size:12px;color:var(--primary);font-weight:600;margin-bottom:10px;word-break:break-all">${esc(GDrive.getEmail()||'')}</p>
           <button class="btn btn-outline btn-full" style="margin-bottom:8px" onclick="testarDrive()">🔍 Testar conexão</button>
           <button class="btn btn-danger-outline btn-full" onclick="disconnectDrive()">Desconectar Drive</button>`
        : `<p style="font-size:13px;color:var(--text2);margin-bottom:10px">
             Faça upload do arquivo <strong>JSON da Conta de Serviço</strong> do Google para sincronizar notas e fotos no Drive.
           </p>
           <input type="file" id="f-sa-json" accept=".json,application/json" style="display:none" onchange="onUploadSA(event)">
           <button class="btn btn-primary btn-full" onclick="$('f-sa-json').click()">
             ☁️ Upload JSON da Conta de Serviço
           </button>`
      }
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
function iniciarQR() {
  fecharCaptura();
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

function loopQR(ctx, video, canvas) {
  if (!qrStream) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts:'dontInvert' });
  if (code?.data) {
    const parsed = NFCE.fromScan(code.data);
    if (parsed?.chave || parsed?.cnpj) {
      fecharQR();
      abrirFormNota({ ...parsed, metodo_captura:'qrcode' });
      return;
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
      cnpj : result.cnpj  || '',
      valor: result.valor || '',
      data : result.data  || hoje(),
      metodo_captura: 'ocr',
    });
  } catch(err) {
    ov.style.display = 'none';
    toast('Erro no OCR: ' + err.message, 'err');
  }
  e.target.value = '';
}

/* ── Form Nota ───────────────────────────────────────────── */
function abrirFormNota(dados = {}) {
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
  const badges = { qrcode:'📷 QR Code', ocr:'🔍 OCR', manual:'✏️ Manual' };
  $('captura-badge').textContent = badges[dados.metodo_captura||'manual']||'✏️ Manual';

  toggleSubtipo();
  atualizarPreviewFoto(dados.foto_path ? `supabase:${dados.foto_path}` : null);

  // se vier com CNPJ, busca razão social
  if (dados.cnpj && !dados.razao_social) buscarRazaoSocial(dados.cnpj);

  // título
  $('nf-titulo').textContent = dados.id ? 'Editar Nota' : 'Nova Nota';
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

function onFotoNotaChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  fotoBlob = file;
  fotoURL  = URL.createObjectURL(file);
  atualizarPreviewFoto(fotoURL);
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
  // 1. foto local (IndexedDB)
  const local = await DB.getFotoLocal(id);
  if (local?.blob) { window.open(URL.createObjectURL(local.blob), '_blank'); return; }
  // 2. Google Drive
  const driveUrl = GDrive.getFotoUrl?.(id);
  if (driveUrl) { window.open(driveUrl, '_blank'); return; }
  // 3. Supabase Storage
  if (n.foto_path && sb) {
    const { data } = await sb.storage.from('notas-fotos').createSignedUrl(n.foto_path, 300);
    if (data?.signedUrl) window.open(data.signedUrl, '_blank');
  }
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
function exportCSV()   { Excel.exportarCSV(filMes, filAno, notas, repasses, user); }
function exportExcel() { Excel.exportarAnual(filAno, notas, repasses, user); }

/* ── Boot ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  init();
  renderAuth('login');
});
