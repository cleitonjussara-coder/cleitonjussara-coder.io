'use strict';
/* ─────────────────────────────────────────────────────────────
   gdrive.js — Google Drive OAuth 2.0
   Regra de ouro: popup NUNCA abre sozinho — só via clique do usuário.
───────────────────────────────────────────────────────────── */
window.GDrive = (() => {
  const CLIENT_ID  = '15986245838-lnmg53ueee1cn0dfk56fi0om7gjsp3q6.apps.googleusercontent.com';
  const SCOPE      = 'https://www.googleapis.com/auth/drive';
  const FOLDER_ID  = '14vXW3SJqPp3fOhW4p4xOU7Y5AB_sWi6L';
  const FILES_API  = 'https://www.googleapis.com/drive/v3/files'; 
  const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
  const LS_KEY     = 'gdrive_tok_v3';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const MESES = ['', 'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                 'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

  let tokenClient  = null;
  let accessToken  = null;
  let tokenExpiry  = 0;
  let fileIndex    = {};
  let _folderCache = {};   // chave `${paiId}/${nome}` → Promise<id> (evita criar 2x)
  let _gisReady    = false;

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
    accessToken  = null;
    tokenExpiry  = 0;
    fileIndex    = {};
    _folderCache = {};
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
     VARREDURA DA ÁRVORE (raiz + subpastas)
     BFS por nível: 1 consulta agrupa todos os pais
     do mesmo nível (barato, não 1 chamada por pasta).
     Retorna só ARQUIVOS (pastas viram próximos pais).
  ════════════════════════════════════════════ */
  async function _walkTree(rootId) {
    const files = [];
    let level = [rootId];
    let guard = 0;
    while (level.length && guard++ < 12) {
      const next = [];
      for (let i = 0; i < level.length; i += 40) {
        const ids = level.slice(i, i + 40);
        const q = '(' + ids.map(id => `'${id}' in parents`).join(' or ') + ') and trashed=false';
        let pageToken = null;
        do {
          const url = `${FILES_API}?q=${encodeURIComponent(q)}`
            + `&fields=nextPageToken,files(id,name,mimeType,appProperties,createdTime)`
            + `&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
          const data = await _req(url);
          for (const f of (data.files || [])) {
            if (f.mimeType === FOLDER_MIME) next.push(f.id);
            else files.push(f);
          }
          pageToken = data.nextPageToken || null;
        } while (pageToken);
      }
      level = next;
    }
    return files;
  }

  /* ════════════════════════════════════════════
     ÍNDICE DE ARQUIVOS (nome → id), árvore inteira.
     Inclui os JSON da raiz e as fotos em subpastas.
     Nome de foto é único (foto-<id>.<ext>), então
     guardar "plano" por nome continua funcionando.
  ════════════════════════════════════════════ */
  async function _refreshIndex() {
    const files = await _walkTree(FOLDER_ID);
    fileIndex = {};
    files.forEach(f => { fileIndex[f.name] = f.id; });
    console.log(`GDrive ✓ ${Object.keys(fileIndex).length} arquivos (raiz + subpastas)`);
  }

  /* ════════════════════════════════════════════
     SUBPASTAS — acha ou cria, com cache de Promise
     para não criar a mesma pasta duas vezes.
  ════════════════════════════════════════════ */
  function _getOrCreateFolder(name, parentId) {
    const safe = String(name || 'sem-nome');
    const key  = parentId + '/' + safe;
    if (_folderCache[key]) return _folderCache[key];
    const p = (async () => {
      const esc = safe.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const q = `mimeType='${FOLDER_MIME}' and name='${esc}' and '${parentId}' in parents and trashed=false`;
      const found = await _req(
        `${FILES_API}?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`
      );
      if (found.files && found.files[0]) return found.files[0].id;
      const made = await _req(`${FILES_API}?fields=id`, {
        method: 'POST',
        json: { name: safe, mimeType: FOLDER_MIME, parents: [parentId] },
      });
      return made.id;
    })();
    p.catch(() => { delete _folderCache[key]; }); // se falhar, permite tentar de novo
    _folderCache[key] = p;
    return p;
  }

  /* nomes das pastas: Colaborador / Mês-Ano / Tipo */
  const _slug = s => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .trim().toLowerCase().replace(/[^a-z0-9.]+/g, '.').replace(/^\.+|\.+$/g, '');

  function _colabFolderName(nota) {
    const email = String(nota.user_email || '').trim();
    if (email.includes('@')) return email.split('@')[0].toLowerCase(); // ex: naycon.cenci
    const nome = _slug(nota.user_nome);
    if (nome) return nome;
    return 'colaborador-' + _trim(nota.user_id, 8);
  }
  function _mesAnoFolder(nota) {
    const m = parseInt(nota.mes, 10);
    const a = parseInt(nota.ano, 10);
    const nome = (m >= 1 && m <= 12) ? MESES[m] : ('Mes-' + (nota.mes || 'NA'));
    return `${nome}-${a || 'NA'}`;                                      // ex: Junho-2026
  }
  function _tipoFolder(nota) {
    const t = String(nota.tipo || '').toUpperCase();
    return (t === 'RDA' || t === 'RDM') ? t : 'OUTROS';
  }

  /* destino final do upload; se algo falhar, volta pra raiz (nunca perde a foto) */
  async function _resolveDestino(nota) {
    try {
      const colab  = await _getOrCreateFolder(_colabFolderName(nota), FOLDER_ID);
      const mesAno = await _getOrCreateFolder(_mesAnoFolder(nota), colab);
      const tipo   = await _getOrCreateFolder(_tipoFolder(nota), mesAno);
      return tipo;
    } catch (e) {
      console.warn('GDrive subpastas falharam — salvando na raiz:', e.message);
      return FOLDER_ID;
    }
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

  async function uploadFotoComDados(blob, nota, ext) {
    if (!nota?.id || !isConnected()) return null;
    _checkConnected();

    const fileext    = (ext || 'jpg').toLowerCase();
    const filename   = `foto-${nota.id}.${fileext}`;
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

    // arquivo novo → resolve subpasta Colaborador/Mês-Ano/Tipo (cai na raiz se falhar)
    // arquivo já existente → mantém onde está (PATCH só atualiza conteúdo/metadados)
    const parentId = existingId ? FOLDER_ID : await _resolveDestino(nota);
    const meta = existingId
      ? { appProperties }
      : { name: filename, parents: [parentId], appProperties };

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

  // nome do arquivo do anexo no Drive (foto-<id>.<ext>), qualquer extensão
  function _fotoFilename(notaId) {
    return Object.keys(fileIndex).find(k => k.startsWith(`foto-${notaId}.`)) || null;
  }
  function getFotoUrl(notaId) {
    const name = _fotoFilename(notaId);
    if (!name || !isConnected()) return null;
    return `${FILES_API}/${fileIndex[name]}?alt=media&access_token=${encodeURIComponent(accessToken)}`;
  }
  function getFotoExt(notaId) {
    const name = _fotoFilename(notaId);
    const m = name && name.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : null;
  }

  async function listarFotasComDados() {
    if (!isConnected()) return [];
    const files = await _walkTree(FOLDER_ID);      // raiz + subpastas
    return files
      .filter(f => f.name && f.name.indexOf('foto-') === 0)
      .map(f => ({
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

  /* token + pasta expostos p/ o módulo Google Sheets (mesmo escopo 'drive') */
  function getToken()    { _checkConnected(); return accessToken; }
  function getFolderId() { return FOLDER_ID; }
  function minutosRestantes() {
    if (!isConnected()) return 0;
    return Math.max(0, Math.round((tokenExpiry - Date.now()) / 60000));
  }

  return {
    init, requestAccess, disconnect, testarConexao,
    syncNotas, loadNotas,
    uploadFotoComDados, listarFotasComDados, getFotoUrl, getFotoExt,
    isConnected, isConfigured, minutosRestantes,
    getToken, getFolderId,
  };
})();
