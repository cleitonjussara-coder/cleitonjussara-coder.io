'use strict';
/* ─────────────────────────────────────────────────────────────
   gdrive.js — Google Drive como banco de dados (Petermann App)

   CONFIGURAÇÃO (Google Console → console.cloud.google.com):
     1. Ative: APIs & Services → Enable APIs → "Google Drive API"
     2. Crie: APIs & Services → Credentials → OAuth 2.0 Client ID
        • Application type: Web application
        • Authorized JavaScript origins:
            https://cleitonjussara-coder.github.io
            http://localhost:8080  (para testes locais)
     3. Cole o Client ID abaixo (NÃO a API Key — não serve para Drive)
───────────────────────────────────────────────────────────── */
window.GDrive = (() => {
  const GDRIVE_CLIENT_ID = 'SEU_CLIENT_ID_AQUI.apps.googleusercontent.com';
  const SCOPE       = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER_NAME = 'Petermann App';
  const FILES_API   = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD_API  = 'https://www.googleapis.com/upload/drive/v3/files';

  let tokenClient = null;
  let accessToken = null;
  let tokenExpiry = 0;
  let folderId    = null;
  let fileIndex   = {}; // filename → fileId

  /* ── Carrega Google Identity Services ─────────────────── */
  function _loadGIS() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src     = 'https://accounts.google.com/gsi/client';
      s.onload  = res;
      s.onerror = () => rej(new Error('Falha ao carregar Google Identity Services'));
      document.head.appendChild(s);
    });
  }

  /* ── Inicialização: tenta restaurar sessão salva ───────── */
  async function init() {
    if (!isConfigured()) return false;
    try { await _loadGIS(); } catch (e) { console.warn('GDrive: GIS não carregou', e); return false; }

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GDRIVE_CLIENT_ID,
      scope: SCOPE,
      callback: () => {},
    });

    const saved = sessionStorage.getItem('gdrive_tok');
    if (saved) {
      try {
        const { tok, exp } = JSON.parse(saved);
        if (Date.now() < exp) {
          accessToken = tok;
          tokenExpiry = exp;
          await _ensureFolder();
          return true;
        }
      } catch (_) {}
      sessionStorage.removeItem('gdrive_tok');
      // Token expirou — tenta refresh silencioso
      try { await _silentRefresh(); return true; } catch (_) {}
    }
    return false;
  }

  /* ── Refresh silencioso (sem popup se já consentido) ───── */
  function _silentRefresh() {
    return new Promise((resolve, reject) => {
      tokenClient.callback = async resp => {
        if (resp.error) { reject(new Error(resp.error)); return; }
        _saveToken(resp);
        try { await _ensureFolder(); resolve(); } catch (e) { reject(e); }
      };
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  /* ── Solicita acesso (popup Google consentimento) ──────── */
  function requestAccess() {
    return new Promise((resolve, reject) => {
      tokenClient.callback = async resp => {
        if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
        _saveToken(resp);
        try { await _ensureFolder(); resolve(true); } catch (e) { reject(e); }
      };
      tokenClient.requestAccessToken({ prompt: 'consent' });
    });
  }

  function _saveToken(resp) {
    accessToken = resp.access_token;
    tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
    sessionStorage.setItem('gdrive_tok', JSON.stringify({ tok: accessToken, exp: tokenExpiry }));
  }

  /* ── Desconectar ────────────────────────────────────────── */
  function disconnect() {
    if (accessToken && window.google?.accounts?.oauth2) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null; tokenExpiry = 0; folderId = null; fileIndex = {};
    sessionStorage.removeItem('gdrive_tok');
  }

  /* ── Fetch autenticado ──────────────────────────────────── */
  async function _req(url, opts = {}) {
    const headers = { Authorization: `Bearer ${accessToken}`, ...(opts.headers || {}) };
    if (opts.json) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method : opts.method || 'GET',
      headers,
      body   : opts.json ? JSON.stringify(opts.json) : (opts.body ?? undefined),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Drive API ${res.status}`);
    }
    if (res.status === 204) return null;
    return res.headers.get('content-type')?.includes('json') ? res.json() : res;
  }

  /* ── Pasta "Petermann App" ──────────────────────────────── */
  async function _ensureFolder() {
    const q = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const { files } = await _req(`${FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name)`);
    if (files?.length) {
      folderId = files[0].id;
    } else {
      const f = await _req(`${FILES_API}?fields=id`, {
        method: 'POST',
        json  : { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
      });
      folderId = f.id;
    }
    await _refreshIndex();
  }

  async function _refreshIndex() {
    const q = `'${folderId}' in parents and trashed=false`;
    const { files } = await _req(
      `${FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1000`
    );
    fileIndex = {};
    (files || []).forEach(f => { fileIndex[f.name] = f.id; });
  }

  /* ── Salvar JSON no Drive ───────────────────────────────── */
  async function saveJSON(filename, data) {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    if (fileIndex[filename]) {
      await fetch(`${UPLOAD_API}/${fileIndex[filename]}?uploadType=media`, {
        method : 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body   : blob,
      });
    } else {
      const form = new FormData();
      form.append('metadata', new Blob(
        [JSON.stringify({ name: filename, parents: [folderId] })], { type: 'application/json' }
      ));
      form.append('file', blob);
      const res = await fetch(`${UPLOAD_API}?uploadType=multipart&fields=id`, {
        method : 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body   : form,
      });
      const { id } = await res.json();
      fileIndex[filename] = id;
    }
  }

  /* ── Ler JSON do Drive ──────────────────────────────────── */
  async function loadJSON(filename) {
    if (!fileIndex[filename]) return null;
    const res = await fetch(`${FILES_API}/${fileIndex[filename]}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok ? res.json() : null;
  }

  /* ── Upload foto ────────────────────────────────────────── */
  async function uploadFoto(blob, notaId) {
    if (!isConnected()) return null;
    const filename   = `foto-${notaId}.jpg`;
    const existingId = fileIndex[filename];
    const meta       = existingId ? {} : { name: filename, parents: [folderId] };
    const form       = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', blob instanceof Blob ? blob : new Blob([blob], { type: 'image/jpeg' }));

    const url = existingId
      ? `${UPLOAD_API}/${existingId}?uploadType=multipart&fields=id`
      : `${UPLOAD_API}?uploadType=multipart&fields=id`;
    const res = await fetch(url, {
      method : existingId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body   : form,
    });
    const { id } = await res.json();
    if (!existingId) fileIndex[filename] = id;
    return fileIndex[filename];
  }

  /* ── URL da foto (para visualização) ───────────────────── */
  function getFotoUrl(notaId) {
    const fid = fileIndex[`foto-${notaId}.jpg`];
    if (!fid || !isConnected()) return null;
    return `${FILES_API}/${fid}?alt=media&access_token=${encodeURIComponent(accessToken)}`;
  }

  /* ── Sync completo notas + repasses ────────────────────── */
  async function syncNotas(userId, ns, rs) {
    if (!isConnected()) return;
    await Promise.all([
      saveJSON(`notas-${userId}.json`,    ns),
      saveJSON(`repasses-${userId}.json`, rs),
    ]);
  }

  /* ── Carregar dados do Drive ────────────────────────────── */
  async function loadNotas(userId) {
    if (!isConnected()) return null;
    const [ns, rs] = await Promise.all([
      loadJSON(`notas-${userId}.json`),
      loadJSON(`repasses-${userId}.json`),
    ]);
    return { notas: ns || [], repasses: rs || [] };
  }

  function isConnected()  { return !!accessToken && Date.now() < tokenExpiry; }
  function isConfigured() { return !GDRIVE_CLIENT_ID.includes('SEU_CLIENT'); }

  return {
    init, requestAccess, disconnect,
    syncNotas, loadNotas,
    uploadFoto, getFotoUrl,
    isConnected, isConfigured,
  };
})();
