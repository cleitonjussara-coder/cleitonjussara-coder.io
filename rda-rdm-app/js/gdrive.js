'use strict';
/* ─────────────────────────────────────────────────────────────
   gdrive.js — Google Drive OAuth 2.0
   Regra de ouro: popup NUNCA abre sozinho — só via clique do usuário.
───────────────────────────────────────────────────────────── */
window.GDrive = (() => {
  const CLIENT_ID  = '15986245838-lnmg53ueee1cn0dfk56fi0om7gjsp3q6.apps.googleusercontent.com';
  const SCOPE      = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER_ID  = '1IAeqsBJorirze-k6yZWOkw_DDYAtQLo0';
  const FILES_API  = 'https://www.googleapis.com/drive/v3/files'; 
  const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
  const LS_KEY     = 'gdrive_tok_v3';

  let tokenClient = null;
  let accessToken = null;
  let tokenExpiry = 0;
  let fileIndex   = {};
  let _gisReady   = false;

  /* ════════════════════════════════════════════
     INIT — restaura token salvo, SEM popup
  ════════════════════════════════════════════ */
  async function init() {
    try {
      await _loadGIS();
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: () => {}, // substituído em requestAccess()
      });
      _gisReady = true;

      const saved = sessionStorage.getItem(LS_KEY);
      if (!saved) return false;

      const { tok, exp } = JSON.parse(saved);
      if (Date.now() >= exp) {
        // token expirado — limpa, não tenta renovar (precisa de clique)
        sessionStorage.removeItem(LS_KEY);
        return false;
      }

      accessToken = tok;
      tokenExpiry = exp;
      await _refreshIndex();
      return true;
    } catch (e) {
      console.warn('GDrive.init:', e.message);
      return false;
    }
  }

  function _loadGIS() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload  = res;
      s.onerror = () => rej(new Error('Falha ao carregar Google Identity Services'));
      document.head.appendChild(s);
    });
  }

  /* ════════════════════════════════════════════
     CONNECT — só chamado por clique do usuário
  ════════════════════════════════════════════ */
  function requestAccess() {
    if (!_gisReady) return Promise.reject(new Error('Google Identity Services não carregado'));
    return new Promise((resolve, reject) => {
      tokenClient.callback = async resp => {
        if (resp.error) {
          reject(new Error(resp.error === 'access_denied'
            ? 'Acesso negado pelo usuário'
            : resp.error_description || resp.error));
          return;
        }
        accessToken = resp.access_token;
        tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
        sessionStorage.setItem(LS_KEY, JSON.stringify({ tok: accessToken, exp: tokenExpiry }));
        try {
          await _refreshIndex();
          resolve(true);
        } catch (e) { reject(e); }
      };
      // prompt: '' → tenta sem UI se já consentido; 'select_account' → mostra seletor
      tokenClient.requestAccessToken({ prompt: 'select_account' });
    });
  }

  /* ════════════════════════════════════════════
     DISCONNECT
  ════════════════════════════════════════════ */
  function disconnect() {
    if (accessToken && window.google?.accounts?.oauth2) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    tokenExpiry = 0;
    fileIndex   = {};
    sessionStorage.removeItem(LS_KEY);
  }

  /* ════════════════════════════════════════════
     VERIFICAÇÃO INTERNA — sem popup
  ════════════════════════════════════════════ */
  function _checkConnected() {
    if (!accessToken || Date.now() >= tokenExpiry) {
      throw new Error('Drive desconectado — clique em "Conectar Drive" no Perfil');
    }
  }

  /* ════════════════════════════════════════════
     FETCH AUTENTICADO
  ════════════════════════════════════════════ */
  async function _req(url, opts = {}) {
    _checkConnected();
    const headers = { Authorization: `Bearer ${accessToken}`, ...(opts.headers || {}) };
    if (opts.json) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.json ? JSON.stringify(opts.json) : (opts.body ?? undefined),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message || `Drive ${res.status}`);
    }
    if (res.status === 204) return null;
    return res.headers.get('content-type')?.includes('json') ? res.json() : res;
  }

  /* ════════════════════════════════════════════
     ÍNDICE DE ARQUIVOS
  ════════════════════════════════════════════ */
  async function _refreshIndex() {
    const q = `'${FOLDER_ID}' in parents and trashed=false`;
    const data = await _req(
      `${FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1000`
    );
    fileIndex = {};
    (data.files || []).forEach(f => { fileIndex[f.name] = f.id; });
    console.log(`GDrive ✓ ${Object.keys(fileIndex).length} arquivos na pasta`);
  }

  /* ════════════════════════════════════════════
     TESTAR CONEXÃO (para botão de diagnóstico)
  ════════════════════════════════════════════ */
  async function testarConexao() {
    _checkConnected();
    const res = await fetch(`${FILES_API}/${FOLDER_ID}?fields=id,name,capabilities`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404) throw new Error('Pasta não encontrada no Drive');
    if (res.status === 403) throw new Error('Sem permissão na pasta — adicione sua conta como Editor');
    if (!res.ok) throw new Error(`Erro ${res.status} ao acessar pasta`);
    const data = await res.json();
    if (!data.capabilities?.canAddChildren) {
      throw new Error('Você tem acesso somente leitura — precisa ser Editor da pasta');
    }
    return { ok: true, nome: data.name };
  }

  /* ════════════════════════════════════════════
     SALVAR / LER JSON
  ════════════════════════════════════════════ */
  async function saveJSON(filename, data) {
    _checkConnected();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });

    if (fileIndex[filename]) {
      const res = await fetch(`${UPLOAD_API}/${fileIndex[filename]}?uploadType=media`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: blob,
      });
      if (!res.ok) await _throwUploadError(res, filename);
    } else {
      const form = new FormData();
      form.append('metadata', new Blob(
        [JSON.stringify({ name: filename, parents: [FOLDER_ID] })],
        { type: 'application/json' }
      ));
      form.append('file', blob);
      const res = await fetch(`${UPLOAD_API}?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      });
      if (!res.ok) await _throwUploadError(res, filename);
      const { id } = await res.json();
      fileIndex[filename] = id;
    }
  }

  async function loadJSON(filename) {
    if (!fileIndex[filename] || !isConnected()) return null;
    const res = await fetch(`${FILES_API}/${fileIndex[filename]}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok ? res.json() : null;
  }

  /* ════════════════════════════════════════════
     FOTO COM METADADOS DA NOTA (appProperties)
  ════════════════════════════════════════════ */
  const _trim = (v, n = 124) => String(v ?? '').slice(0, n);

  async function uploadFotoComDados(blob, nota) {
    if (!nota?.id || !isConnected()) return null;
    _checkConnected();

    const filename   = `foto-${nota.id}.jpg`;
    const existingId = fileIndex[filename];
    const appProperties = {
      nota_id      : _trim(nota.id),
      tipo         : _trim(nota.tipo),
      subtipo      : _trim(nota.subtipo),
      valor        : _trim(nota.valor),
      data         : _trim(nota.data),
      mes          : _trim(nota.mes),
      ano          : _trim(nota.ano),
      cnpj         : _trim(nota.cnpj),
      razao_social : _trim(nota.razao_social, 120),
      observacao   : _trim(nota.observacao, 120),
      user_id      : _trim(nota.user_id),
      captura      : _trim(nota.metodo_captura),
      chave_nfce   : _trim(nota.chave_nfce, 50),
    };

    const meta = existingId
      ? { appProperties }
      : { name: filename, parents: [FOLDER_ID], appProperties };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', blob instanceof Blob ? blob : new Blob([blob], { type: 'image/jpeg' }));

    const url = existingId
      ? `${UPLOAD_API}/${existingId}?uploadType=multipart&fields=id`
      : `${UPLOAD_API}?uploadType=multipart&fields=id`;

    const res = await fetch(url, {
      method: existingId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
    if (!res.ok) await _throwUploadError(res, filename);
    const { id } = await res.json();
    if (!existingId) fileIndex[filename] = id;
    return fileIndex[filename];
  }

  function getFotoUrl(notaId) {
    const fid = fileIndex[`foto-${notaId}.jpg`];
    if (!fid || !isConnected()) return null;
    return `${FILES_API}/${fid}?alt=media&access_token=${encodeURIComponent(accessToken)}`;
  }

  async function listarFotasComDados() {
    if (!isConnected()) return [];
    const q = `'${FOLDER_ID}' in parents and mimeType='image/jpeg' and trashed=false`;
    const data = await _req(
      `${FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name,appProperties,createdTime)&pageSize=1000`
    );
    return (data.files || []).map(f => ({
      fileId: f.id, filename: f.name, criadoEm: f.createdTime, dados: f.appProperties || {},
    }));
  }

  /* ════════════════════════════════════════════
     SYNC / LOAD COMPLETO
  ════════════════════════════════════════════ */
  async function syncNotas(userId, notas, repasses) {
    _checkConnected();
    await Promise.all([
      saveJSON(`notas-${userId}.json`,    notas),
      saveJSON(`repasses-${userId}.json`, repasses),
    ]);
  }

  async function loadNotas(userId) {
    if (!isConnected()) return null;
    const [ns, rs] = await Promise.all([
      loadJSON(`notas-${userId}.json`),
      loadJSON(`repasses-${userId}.json`),
    ]);
    return { notas: ns || [], repasses: rs || [] };
  }

  /* ════════════════════════════════════════════
     HELPERS
  ════════════════════════════════════════════ */
  async function _throwUploadError(res, filename) {
    const body   = await res.json().catch(() => ({}));
    const msg    = body.error?.message || `HTTP ${res.status}`;
    const reason = body.error?.errors?.[0]?.reason || '';
    throw new Error(`Drive (${filename}): ${msg} [${reason}]`);
  }

  function isConnected()  { return !!accessToken && Date.now() < tokenExpiry; }
  function isConfigured() { return !CLIENT_ID.includes('SEU_CLIENT'); }
  function minutosRestantes() {
    if (!isConnected()) return 0;
    return Math.max(0, Math.round((tokenExpiry - Date.now()) / 60000));
  }

  return {
    init, requestAccess, disconnect, testarConexao,
    syncNotas, loadNotas,
    uploadFotoComDados, listarFotasComDados, getFotoUrl,
    isConnected, isConfigured, minutosRestantes,
  };
})();
