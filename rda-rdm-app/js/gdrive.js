'use strict';
/* ─────────────────────────────────────────────────────────────
   gdrive.js — Google Drive via OAuth 2.0 (GIS)

   POR QUÊ OAuth e não Service Account?
   Service accounts não têm cota de armazenamento no My Drive.
   Apenas OAuth 2.0 permite criar arquivos na conta do usuário.

   CONFIGURAR (Google Console → APIs & Services → Credentials):
   1. Ative "Google Drive API"
   2. Crie: OAuth 2.0 Client ID → Web application
      • Authorized JavaScript origins:
          https://cleitonjussara-coder.github.io
          http://localhost:5500
          http://127.0.0.1:5500
   3. Cole o Client ID abaixo (termina em .apps.googleusercontent.com)
───────────────────────────────────────────────────────────── */
window.GDrive = (() => {
  const CLIENT_ID  = '15986245838-lnmg53ueee1cn0dfk56fi0om7gjsp3q6.apps.googleusercontent.com';
  const SCOPE      = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER_ID  = '14vXW3SJqPp3fOhW4p4xOU7Y5AB_sWi6L';
  const FILES_API  = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
  const LS_KEY     = 'gdrive_tok_v2';

  let tokenClient = null;
  let accessToken = null;
  let tokenExpiry = 0;
  let fileIndex   = {}; // filename → fileId

  /* ══════════════════════════════════════
     INIT — restaura token salvo
  ══════════════════════════════════════ */
  async function init() {
    if (!isConfigured()) return false;
    try {
      await _loadGIS();
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPE, callback: () => {},
      });
      const saved = sessionStorage.getItem(LS_KEY);
      if (saved) {
        const { tok, exp } = JSON.parse(saved);
        if (Date.now() < exp) {
          accessToken = tok; tokenExpiry = exp;
          await _refreshIndex();
          return true;
        }
      }
      // tenta refresh silencioso
      try { await _silentRefresh(); return true; } catch (_) {}
    } catch (e) { console.warn('GDrive init:', e.message); }
    return false;
  }

  function _loadGIS() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = res;
      s.onerror = () => rej(new Error('Falha ao carregar Google Identity Services'));
      document.head.appendChild(s);
    });
  }

  /* ══════════════════════════════════════
     AUTH
  ══════════════════════════════════════ */
  function requestAccess() {
    return new Promise((resolve, reject) => {
      tokenClient.callback = async resp => {
        if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
        _saveToken(resp);
        try { await _refreshIndex(); resolve(true); } catch (e) { reject(e); }
      };
      tokenClient.requestAccessToken({ prompt: 'consent' });
    });
  }

  function _silentRefresh() {
    return new Promise((resolve, reject) => {
      tokenClient.callback = async resp => {
        if (resp.error) { reject(new Error(resp.error)); return; }
        _saveToken(resp);
        try { await _refreshIndex(); resolve(); } catch (e) { reject(e); }
      };
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  function _saveToken(resp) {
    accessToken = resp.access_token;
    tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
    sessionStorage.setItem(LS_KEY, JSON.stringify({ tok: accessToken, exp: tokenExpiry }));
  }

  function disconnect() {
    if (accessToken && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(accessToken, () => {});
    accessToken = null; tokenExpiry = 0; fileIndex = {};
    sessionStorage.removeItem(LS_KEY);
  }

  /* ══════════════════════════════════════
     FETCH AUTENTICADO
  ══════════════════════════════════════ */
  async function _ensureToken() {
    if (!isConnected()) {
      try { await _silentRefresh(); } catch (_) { throw new Error('Sessão expirada — reconecte o Drive'); }
    }
  }

  async function _req(url, opts = {}) {
    await _ensureToken();
    const headers = { Authorization: `Bearer ${accessToken}`, ...(opts.headers || {}) };
    if (opts.json) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method: opts.method || 'GET', headers,
      body: opts.json ? JSON.stringify(opts.json) : (opts.body ?? undefined),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg  = body.error?.message || `HTTP ${res.status}`;
      throw new Error(`Drive: ${msg}`);
    }
    if (res.status === 204) return null;
    return res.headers.get('content-type')?.includes('json') ? res.json() : res;
  }

  /* ══════════════════════════════════════
     ÍNDICE DE ARQUIVOS NA PASTA
  ══════════════════════════════════════ */
  async function _refreshIndex() {
    const q = `'${FOLDER_ID}' in parents and trashed=false`;
    const data = await _req(`${FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1000`);
    fileIndex = {};
    (data.files || []).forEach(f => { fileIndex[f.name] = f.id; });
    console.log(`GDrive: ${Object.keys(fileIndex).length} arquivos na pasta`);
  }

  /* ══════════════════════════════════════
     JSON (índice de notas/repasses)
  ══════════════════════════════════════ */
  async function saveJSON(filename, data) {
    await _ensureToken();
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
      form.append('metadata', new Blob([JSON.stringify({ name: filename, parents: [FOLDER_ID] })], { type: 'application/json' }));
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
    if (!fileIndex[filename]) return null;
    await _ensureToken();
    const res = await fetch(`${FILES_API}/${fileIndex[filename]}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok ? res.json() : null;
  }

  /* ══════════════════════════════════════
     FOTO COM DADOS DA NOTA (appProperties)
  ══════════════════════════════════════ */
  const _trim = (v, n = 124) => String(v ?? '').slice(0, n);

  async function uploadFotoComDados(blob, nota) {
    if (!nota?.id) return null;
    await _ensureToken();
    const filename   = `foto-${nota.id}.jpg`;
    const existingId = fileIndex[filename];
    const appProperties = {
      nota_id: _trim(nota.id), tipo: _trim(nota.tipo), subtipo: _trim(nota.subtipo),
      valor: _trim(nota.valor), data: _trim(nota.data), mes: _trim(nota.mes), ano: _trim(nota.ano),
      cnpj: _trim(nota.cnpj), razao_social: _trim(nota.razao_social, 120),
      observacao: _trim(nota.observacao, 120), user_id: _trim(nota.user_id),
      captura: _trim(nota.metodo_captura), chave_nfce: _trim(nota.chave_nfce, 50),
    };
    const meta = existingId ? { appProperties } : { name: filename, parents: [FOLDER_ID], appProperties };
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

  async function listarFotasComDados() {
    if (!isConnected()) return [];
    const q = `'${FOLDER_ID}' in parents and mimeType='image/jpeg' and trashed=false`;
    const data = await _req(`${FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name,appProperties,createdTime)&pageSize=1000`);
    return (data.files || []).map(f => ({ fileId: f.id, filename: f.name, criadoEm: f.createdTime, dados: f.appProperties || {} }));
  }

  function getFotoUrl(notaId) {
    const fid = fileIndex[`foto-${notaId}.jpg`];
    if (!fid || !isConnected()) return null;
    return `${FILES_API}/${fid}?alt=media&access_token=${encodeURIComponent(accessToken)}`;
  }

  /* ══════════════════════════════════════
     SYNC / LOAD
  ══════════════════════════════════════ */
  async function syncNotas(userId, notas, repasses) {
    if (!isConnected()) throw new Error('Drive não conectado');
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

  async function testarConexao() {
    await _ensureToken();
    const res = await fetch(`${FILES_API}/${FOLDER_ID}?fields=id,name,capabilities`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404) throw new Error('Pasta não encontrada');
    if (res.status === 403) throw new Error('Sem permissão na pasta');
    if (!res.ok) throw new Error(`Erro ${res.status}`);
    const data = await res.json();
    if (!data.capabilities?.canAddChildren) throw new Error('Usuário não tem permissão de Editor na pasta');
    return { ok: true, nome: data.name };
  }

  async function _throwUploadError(res, filename) {
    const body   = await res.json().catch(() => ({}));
    const msg    = body.error?.message || `HTTP ${res.status}`;
    const reason = body.error?.errors?.[0]?.reason || '';
    throw new Error(`Drive (${filename}): ${msg} [${reason}]`);
  }

  function isConnected()  { return !!accessToken && Date.now() < tokenExpiry; }
  function isConfigured() { return !CLIENT_ID.includes('SEU_CLIENT'); }
  function getEmail()     { return null; }

  return {
    init, requestAccess, disconnect, testarConexao,
    syncNotas, loadNotas,
    uploadFotoComDados, listarFotasComDados, getFotoUrl,
    isConnected, isConfigured, getEmail,
  };
})();
