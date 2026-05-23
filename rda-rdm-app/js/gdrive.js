'use strict';
/* ─────────────────────────────────────────────────────────────
   gdrive.js — Google Drive via Conta de Serviço

   COMO USAR:
   1. Google Console → IAM & Admin → Contas de Serviço
   2. Crie a conta → Chaves → Adicionar chave → JSON → Baixar
   3. Ative Google Drive API no projeto
   4. Compartilhe a pasta do Drive com o e-mail da conta de serviço
   5. Usuário faz upload do JSON no app (aba Perfil)

   DADOS DAS NOTAS: salvos como appProperties na foto + JSON índice
───────────────────────────────────────────────────────────── */
window.GDrive = (() => {
  const SCOPE      = 'https://www.googleapis.com/auth/drive';
  const TOKEN_URI  = 'https://oauth2.googleapis.com/token';
  const FILES_API  = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
  const FOLDER_ID  = '14vXW3SJqPp3fOhW4p4xOU7Y5AB_sWi6L';
  const LS_KEY     = 'gdrive_sa_v1';

  let creds       = null;
  let accessToken = null;
  let tokenExpiry = 0;
  let fileIndex   = {}; // filename → fileId

  /* ══════════════════════════════════════════
     AUTH
  ══════════════════════════════════════════ */

  async function loadFromFile(file) {
    const text = await file.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { throw new Error('Arquivo JSON inválido.'); }
    if (json.type !== 'service_account')       throw new Error('Não é uma Conta de Serviço do Google.');
    if (!json.private_key || !json.client_email) throw new Error('JSON incompleto — private_key ou client_email ausente.');
    creds = json;
    localStorage.setItem(LS_KEY, text);
    await _authenticate();
    await _refreshIndex();
    return true;
  }

  async function init() {
    const saved = localStorage.getItem(LS_KEY);
    if (!saved) return false;
    try {
      creds = JSON.parse(saved);
      await _authenticate();
      await _refreshIndex();
      return true;
    } catch (e) {
      console.warn('GDrive init:', e.message);
      return false;
    }
  }

  /* ── JWT → Access Token ─────────────────────────────── */
  async function _authenticate() {
    if (isConnected()) return;
    const now  = Math.floor(Date.now() / 1000);
    const head = _b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: creds.private_key_id }));
    const body = _b64url(JSON.stringify({
      iss: creds.client_email, scope: SCOPE,
      aud: TOKEN_URI, iat: now, exp: now + 3600,
    }));
    const unsigned = `${head}.${body}`;
    const key = await _importKey(creds.private_key);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
    const jwt = `${unsigned}.${_b64urlBytes(sig)}`;

    const res  = await fetch(TOKEN_URI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(`Auth: ${data.error_description || data.error}`);
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  }

  async function _importKey(pem) {
    const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return crypto.subtle.importKey(
      'pkcs8', buf.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['sign']
    );
  }

  const _b64url      = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const _b64urlBytes = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');

  async function _ensureToken() {
    if (!isConnected()) await _authenticate();
  }

  /* ══════════════════════════════════════════
     FETCH AUTENTICADO
  ══════════════════════════════════════════ */
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
      const body = await res.json().catch(() => ({}));
      const reason  = body.error?.errors?.[0]?.reason || '';
      const message = body.error?.message || `Drive ${res.status}`;
      const hint =
        res.status === 403 && reason === 'notFound'      ? ' — pasta não encontrada' :
        res.status === 403                                ? ' — verifique: 1) Drive API ativada no Console  2) Pasta compartilhada com a conta de serviço como Editor' :
        res.status === 401                                ? ' — token inválido, faça upload do JSON novamente' : '';
      throw new Error(message + hint);
    }
    if (res.status === 204) return null;
    return res.headers.get('content-type')?.includes('json') ? res.json() : res;
  }

  /* ══════════════════════════════════════════
     ÍNDICE DE ARQUIVOS NA PASTA
  ══════════════════════════════════════════ */
  async function _refreshIndex() {
    const q = `'${FOLDER_ID}' in parents and trashed=false`;
    const data = await _req(
      `${FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1000`
    );
    fileIndex = {};
    (data.files || []).forEach(f => { fileIndex[f.name] = f.id; });
    console.log(`GDrive: ${Object.keys(fileIndex).length} arquivos na pasta`);
  }

  /* ══════════════════════════════════════════
     JSON (índice de notas e repasses)
  ══════════════════════════════════════════ */
  async function saveJSON(filename, data) {
    await _ensureToken();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    if (fileIndex[filename]) {
      const res = await fetch(`${UPLOAD_API}/${fileIndex[filename]}?uploadType=media`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: blob,
      });
      if (!res.ok) throw new Error(`Drive: falha ao atualizar ${filename} (${res.status})`);
    } else {
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({
        name: filename, parents: [FOLDER_ID],
      })], { type: 'application/json' }));
      form.append('file', blob);
      const res = await fetch(`${UPLOAD_API}?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      });
      if (!res.ok) throw new Error(`Drive: falha ao criar ${filename} (${res.status})`);
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
    if (!res.ok) return null;
    return res.json();
  }

  /* ══════════════════════════════════════════
     FOTO COM DADOS DA NOTA NOS METADADOS
     (appProperties do arquivo no Drive)
  ══════════════════════════════════════════ */
  const _trim = (v, n = 124) => String(v ?? '').slice(0, n);

  async function uploadFotoComDados(blob, nota) {
    if (!nota?.id) return null;
    await _ensureToken();

    const filename = `foto-${nota.id}.jpg`;
    const existingId = fileIndex[filename];

    // Dados do formulário salvos como metadata no próprio arquivo
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
      observacao   : _trim(nota.observacao,   120),
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
    if (!res.ok) throw new Error(`Drive: falha ao enviar foto (${res.status})`);
    const { id } = await res.json();
    if (!existingId) fileIndex[filename] = id;
    return fileIndex[filename];
  }

  /* ── Listar fotos com todos os dados (reconstrução) ─── */
  async function listarFotasComDados() {
    if (!isConnected()) return [];
    const q = `'${FOLDER_ID}' in parents and mimeType='image/jpeg' and trashed=false`;
    const data = await _req(
      `${FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name,appProperties,createdTime)&pageSize=1000`
    );
    return (data.files || []).map(f => ({
      fileId    : f.id,
      filename  : f.name,
      criadoEm  : f.createdTime,
      dados     : f.appProperties || {},
    }));
  }

  function getFotoUrl(notaId) {
    const fid = fileIndex[`foto-${notaId}.jpg`];
    if (!fid || !isConnected()) return null;
    return `${FILES_API}/${fid}?alt=media&access_token=${encodeURIComponent(accessToken)}`;
  }

  /* ══════════════════════════════════════════
     SYNC COMPLETO
  ══════════════════════════════════════════ */
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

  /* ── Testar conexão ─────────────────────────────────── */
  async function testarConexao() {
    await _ensureToken();
    // 1. verifica se o token é válido
    const me = await fetch('https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=' + accessToken);
    if (!me.ok) throw new Error('Token inválido — faça upload do JSON novamente');
    // 2. verifica acesso à pasta
    const res = await fetch(`${FILES_API}/${FOLDER_ID}?fields=id,name,capabilities`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404) throw new Error('Pasta não encontrada — verifique o ID da pasta');
    if (res.status === 403) throw new Error('Sem permissão na pasta — compartilhe com a conta de serviço como Editor');
    if (!res.ok) throw new Error(`Erro ${res.status} ao acessar pasta`);
    const data = await res.json();
    const podeEditar = data.capabilities?.canAddChildren;
    if (!podeEditar) throw new Error('Conta de serviço não tem permissão de Editor na pasta');
    return { ok: true, nome: data.name };
  }

  function disconnect() {
    accessToken = null; tokenExpiry = 0; fileIndex = {}; creds = null;
    localStorage.removeItem(LS_KEY);
  }

  function isConnected()  { return !!accessToken && Date.now() < tokenExpiry; }
  function isConfigured() { return !!creds || !!localStorage.getItem(LS_KEY); }
  function getEmail()     {
    try { return creds?.client_email ?? JSON.parse(localStorage.getItem(LS_KEY)||'{}').client_email ?? null; }
    catch(_) { return null; }
  }

  return {
    init, loadFromFile, disconnect, testarConexao,
    syncNotas, loadNotas,
    uploadFotoComDados, listarFotasComDados, getFotoUrl,
    isConnected, isConfigured, getEmail,
  };
})();
