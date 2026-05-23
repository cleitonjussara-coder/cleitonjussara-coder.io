'use strict';
/* ─────────────────────────────────────────────────────────────
   gdrive.js — Google Drive via Conta de Serviço (Service Account)

   COMO USAR:
   1. Google Console → IAM & Admin → Contas de Serviço
   2. Crie uma conta → Gerar chave → JSON → Baixar arquivo
   3. Ative Google Drive API no projeto
   4. O usuário faz upload desse JSON no app (aba Perfil)
   5. O app assina um JWT e troca por access token automaticamente
   6. Token é renovado silenciosamente a cada hora
───────────────────────────────────────────────────────────── */
window.GDrive = (() => {
  const SCOPE       = 'https://www.googleapis.com/auth/drive.file';
  const TOKEN_URI   = 'https://oauth2.googleapis.com/token';
  const FILES_API   = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD_API  = 'https://www.googleapis.com/upload/drive/v3/files';
  const FOLDER_NAME = 'Petermann App';
  const LS_KEY      = 'gdrive_sa_v1'; // chave no localStorage

  let creds       = null;  // JSON da conta de serviço
  let accessToken = null;
  let tokenExpiry = 0;
  let folderId    = null;
  let fileIndex   = {};    // filename → fileId

  /* ── Upload do JSON pelo usuário ────────────────────── */
  async function loadFromFile(file) {
    const text = await file.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { throw new Error('Arquivo JSON inválido.'); }
    if (json.type !== 'service_account') throw new Error('O arquivo não é uma Conta de Serviço do Google.');
    if (!json.private_key || !json.client_email) throw new Error('Arquivo incompleto — private_key ou client_email ausente.');
    creds = json;
    localStorage.setItem(LS_KEY, text);
    await _authenticate();
    await _ensureFolder();
    return true;
  }

  /* ── Restaurar de localStorage ao abrir o app ───────── */
  async function init() {
    const saved = localStorage.getItem(LS_KEY);
    if (!saved) return false;
    try {
      creds = JSON.parse(saved);
      await _authenticate();
      await _ensureFolder();
      return true;
    } catch (e) {
      console.warn('GDrive init falhou:', e.message);
      return false;  // não remove — pode ser erro de rede
    }
  }

  /* ── JWT → Access Token (Google OAuth2) ─────────────── */
  async function _authenticate() {
    if (isConnected()) return;
    const now  = Math.floor(Date.now() / 1000);
    const head = _b64url(JSON.stringify({ alg:'RS256', typ:'JWT', kid: creds.private_key_id }));
    const body = _b64url(JSON.stringify({
      iss: creds.client_email,
      scope: SCOPE,
      aud: TOKEN_URI,
      iat: now,
      exp: now + 3600,
    }));
    const unsigned = `${head}.${body}`;
    const key = await _importKey(creds.private_key);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
    const jwt = `${unsigned}.${_b64urlBytes(sig)}`;

    const res = await fetch(TOKEN_URI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  }

  /* ── Importar chave privada PEM (PKCS8) ─────────────── */
  async function _importKey(pem) {
    const b64  = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    const bin  = atob(b64);
    const buf  = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return crypto.subtle.importKey(
      'pkcs8', buf.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['sign']
    );
  }

  /* ── Helpers base64url ──────────────────────────────── */
  const _b64url      = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const _b64urlBytes = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');

  /* ── Auto-refresh antes de qualquer chamada ─────────── */
  async function _ensureToken() {
    if (!isConnected()) await _authenticate();
  }

  /* ── Fetch autenticado ──────────────────────────────── */
  async function _req(url, opts = {}) {
    await _ensureToken();
    const headers = { Authorization: `Bearer ${accessToken}`, ...(opts.headers || {}) };
    if (opts.json) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.json ? JSON.stringify(opts.json) : (opts.body ?? undefined),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Drive API ${res.status}`);
    }
    if (res.status === 204) return null;
    return res.headers.get('content-type')?.includes('json') ? res.json() : res;
  }

  /* ── Pasta "Petermann App" ──────────────────────────── */
  async function _ensureFolder() {
    const q = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const { files } = await _req(`${FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name)`);
    if (files?.length) {
      folderId = files[0].id;
    } else {
      const f = await _req(`${FILES_API}?fields=id`, {
        method: 'POST',
        json: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
      });
      folderId = f.id;
    }
    await _refreshIndex();
  }

  async function _refreshIndex() {
    const q = `'${folderId}' in parents and trashed=false`;
    const { files } = await _req(`${FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1000`);
    fileIndex = {};
    (files || []).forEach(f => { fileIndex[f.name] = f.id; });
  }

  /* ── Salvar JSON no Drive ───────────────────────────── */
  async function saveJSON(filename, data) {
    await _ensureToken();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    if (fileIndex[filename]) {
      await fetch(`${UPLOAD_API}/${fileIndex[filename]}?uploadType=media`, {
        method : 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body   : blob,
      });
    } else {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ name: filename, parents: [folderId] })], { type: 'application/json' }));
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

  /* ── Ler JSON do Drive ──────────────────────────────── */
  async function loadJSON(filename) {
    if (!fileIndex[filename]) return null;
    await _ensureToken();
    const res = await fetch(`${FILES_API}/${fileIndex[filename]}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok ? res.json() : null;
  }

  /* ── Upload de foto ─────────────────────────────────── */
  async function uploadFoto(blob, notaId) {
    if (!isConnected()) return null;
    await _ensureToken();
    const filename   = `foto-${notaId}.jpg`;
    const existingId = fileIndex[filename];
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(
      existingId ? {} : { name: filename, parents: [folderId] }
    )], { type: 'application/json' }));
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

  /* ── URL de foto para visualização ─────────────────── */
  function getFotoUrl(notaId) {
    const fid = fileIndex[`foto-${notaId}.jpg`];
    if (!fid || !isConnected()) return null;
    return `${FILES_API}/${fid}?alt=media&access_token=${encodeURIComponent(accessToken)}`;
  }

  /* ── Sync completo (notas + repasses) ───────────────── */
  async function syncNotas(userId, notas, repasses) {
    if (!isConnected()) return;
    await Promise.all([
      saveJSON(`notas-${userId}.json`,    notas),
      saveJSON(`repasses-${userId}.json`, repasses),
    ]);
  }

  /* ── Carregar dados do Drive ────────────────────────── */
  async function loadNotas(userId) {
    if (!isConnected()) return null;
    const [ns, rs] = await Promise.all([
      loadJSON(`notas-${userId}.json`),
      loadJSON(`repasses-${userId}.json`),
    ]);
    return { notas: ns || [], repasses: rs || [] };
  }

  /* ── Desconectar / remover credenciais ──────────────── */
  function disconnect() {
    accessToken = null; tokenExpiry = 0; folderId = null; fileIndex = {}; creds = null;
    localStorage.removeItem(LS_KEY);
  }

  function isConnected()  { return !!accessToken && Date.now() < tokenExpiry; }
  function isConfigured() { return !!creds || !!localStorage.getItem(LS_KEY); }
  function getEmail()     { return creds?.client_email ?? JSON.parse(localStorage.getItem(LS_KEY) || '{}').client_email ?? null; }

  return {
    init, loadFromFile, disconnect,
    syncNotas, loadNotas,
    uploadFoto, getFotoUrl,
    isConnected, isConfigured, getEmail,
  };
})();
