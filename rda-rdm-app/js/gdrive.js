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

  /* ── Nomenclatura da pasta modelo da empresa ──────────────────────
     Espelha "Colaborador | DESPESAS CORPORATIVAS | CLIENTE" no Drive:
       {Colaborador}/{Ano}/RDM DESPESAS CORPORATIVAS/{CATEGORIA}/{01 jan}
       {Colaborador}/{Ano}/RDA ALIMENTAÇÃO/{01 jan}
     O prefixo numérico do mês é o que faz o Drive ordenar na ordem do
     calendário — com nome por extenso ele lista Abril, Agosto, Dezembro.
     O nível do ano não existe no modelo (a pasta é refeita a cada
     exercício); aqui ele é explícito para não misturar 2025 com 2026. */
  const MESES_PASTA = ['', '01 jan','02 fev','03 mar','04 abr','05 mai','06 jun',
                       '07 jul','08 ago','09 set','10 out','11 nov','12 dez'];
  const GRUPO_RDM = 'RDM DESPESAS CORPORATIVAS';
  const GRUPO_RDA = 'RDA ALIMENTAÇÃO';
  /* subtipo gravado na nota → nome da categoria na pasta modelo
     (a planilha usa "Hospedagem", a pasta usa "HOSPEDAGENS") */
  const CATEGORIA_RDM = { abastecimento: 'ABASTECIMENTO', hospedagem: 'HOSPEDAGENS' };

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
      // índice em segundo plano: abrir o app não espera pela varredura
      _garantirIndice().catch(e => console.warn('GDrive índice:', e.message));
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
        /* Conecta na hora. O índice vai em segundo plano — era ele que fazia
           o botão "Conectar" ficar cada vez mais lento conforme o arquivo de
           fotos crescia, esperando algo que a conexão não usa. */
        _garantirIndice().catch(e => console.warn('GDrive índice:', e.message));
        resolve(true);
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
    accessToken   = null;
    tokenExpiry   = 0;
    fileIndex     = {};
    _folderCache  = {};
    _indicePronto = false;   // sem isso a reconexão reusaria o índice da conta antiga
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
     Passando um Map em `folderMap`, ele sai preenchido com
     id → { name, parent } — a migração usa isso para saber
     em que pasta de colaborador cada arquivo está hoje.
  ════════════════════════════════════════════ */
  async function _walkTree(rootId, folderMap = null) {
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
            + `&fields=nextPageToken,files(id,name,mimeType,appProperties,createdTime,parents)`
            + `&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
          const data = await _req(url);
          for (const f of (data.files || [])) {
            if (f.mimeType === FOLDER_MIME) {
              next.push(f.id);
              if (folderMap) folderMap.set(f.id, { name: f.name, parent: f.parents?.[0] || null });
            } else files.push(f);
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
    _indicePronto = true;
    console.log(`GDrive ✓ ${Object.keys(fileIndex).length} arquivos (raiz + subpastas)`);
  }

  /* ÍNDICE PREGUIÇOSO
     Montar o índice varre a árvore inteira (raiz + as subpastas do modelo),
     e isso crescia junto com o arquivo de fotos. Como ele bloqueava o init() e
     o requestAccess(), conectar no Drive ficava cada vez mais lento no celular
     — esperando um índice que a conexão em si não precisa.
     Agora só quem realmente depende dele espera: o upload, que consulta o
     índice para atualizar o arquivo em vez de duplicar. */
  let _indicePronto  = false;
  let _indicePromise = null;
  function _garantirIndice() {
    if (_indicePronto) return Promise.resolve();
    if (!_indicePromise) {
      _indicePromise = _refreshIndex()
        .finally(() => { _indicePromise = null; });
    }
    return _indicePromise;                 // chamadas simultâneas dividem a mesma varredura
  }

  /* atualiza o índice sob demanda (ex.: antes de consolidar fotos da equipe,
     p/ não recriar o que já está no Drive) — sempre força releitura */
  async function atualizarIndice() { _checkConnected(); _indicePronto = false; await _garantirIndice(); }

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

  /* nome da pasta do colaborador: prioriza o NOME (ex: "Naycon Cenci");
     sem nome cai no email; sem email, no id. Ano/Grupo/Categoria/Mês abaixo. */
  function _colabFolderName(nota) {
    const nome = String(nota.user_nome || '')
      .replace(/[\\/:*?"<>|]/g, ' ')   // tira caracteres que atrapalham nome de pasta
      .replace(/\s+/g, ' ').trim();
    if (nome) return nome;
    const email = String(nota.user_email || '').trim();
    if (email.includes('@')) return email.split('@')[0].toLowerCase();
    return 'colaborador-' + _trim(nota.user_id, 8);
  }
  /* mes/ano da nota; uploads antigos podem não ter os campos, então cai
     na data (YYYY-MM-DD) antes de desistir */
  function _mesAno(nota) {
    let m = parseInt(nota.mes, 10);
    let a = parseInt(nota.ano, 10);
    if (!(m >= 1 && m <= 12) || !(a >= 2000 && a <= 2100)) {
      const d = String(nota.data || '').match(/^(\d{4})-(\d{2})/);
      if (d) { a = parseInt(d[1], 10); m = parseInt(d[2], 10); }
    }
    return {
      mes: (m >= 1 && m <= 12) ? MESES_PASTA[m] : 'sem-mes',
      ano: (a >= 2000 && a <= 2100) ? String(a) : 'sem-ano',
    };
  }

  /* RDA vai direto pros meses — é sempre alimentação, e o modelo não abre
     categoria embaixo dela. RDM abre em ABASTECIMENTO / HOSPEDAGENS /
     OUTROS, que é exatamente o subtipo que a nota já grava. */
  function _trilhaGrupo(nota) {
    if (String(nota.tipo || '').toUpperCase() === 'RDA') return [GRUPO_RDA];
    const sub = String(nota.subtipo || '').trim().toLowerCase();
    return [GRUPO_RDM, CATEGORIA_RDM[sub] || 'OUTROS'];
  }

  /* caminho completo da nota dentro da pasta compartilhada */
  function _trilhaDestino(nota) {
    const { mes, ano } = _mesAno(nota);
    return [_colabFolderName(nota), ano, ..._trilhaGrupo(nota), mes];
  }

  /* destino final do upload; se algo falhar, volta pra raiz (nunca perde a foto) */
  async function _resolveDestino(nota) {
    try {
      let pai = FOLDER_ID;
      for (const nome of _trilhaDestino(nota)) pai = await _getOrCreateFolder(nome, pai);
      return pai;
    } catch (e) {
      console.warn('GDrive subpastas falharam — salvando na raiz:', e.message);
      return FOLDER_ID;
    }
  }

  /* ════════════════════════════════════════════
     MIGRAÇÃO PARA O MODELO PADRÃO
     Move o que já está no Drive do layout antigo
     ({Colab}/Junho-2026/RDM) para o novo. Só move:
     não apaga arquivo nem pasta vazia — quem quiser
     limpar as pastas antigas faz isso à mão.
     Reexecutar é inofensivo (o que já está no lugar
     certo é contado como "ok" e pulado).
  ════════════════════════════════════════════ */

  /* Sobe pelos pais até a pasta logo abaixo da raiz — é a do colaborador.
     null se o arquivo estiver solto na raiz (fallback de upload que falhou). */
  function _pastaColabDe(parentId, folderMap) {
    let atual = parentId, guard = 0;
    while (atual && atual !== FOLDER_ID && guard++ < 12) {
      const info = folderMap.get(atual);
      if (!info) return null;
      if (info.parent === FOLDER_ID) return info.name;
      atual = info.parent;
    }
    return null;
  }

  async function migrarParaModeloPadrao({ nomePorUserId = {}, onProgress = null } = {}) {
    _checkConnected();
    const folderMap = new Map();
    const arquivos  = (await _walkTree(FOLDER_ID, folderMap))
      .filter(f => f.name && f.name.indexOf('foto-') === 0);

    let movidos = 0, jaOk = 0, falhas = 0;
    const erros = [];

    for (let i = 0; i < arquivos.length; i++) {
      const f    = arquivos[i];
      const p    = f.appProperties || {};
      const pai  = f.parents?.[0] || null;
      /* o nome do colaborador não está nas appProperties — vem da pasta em
         que o arquivo já mora; só se ele estiver solto na raiz é que o mapa
         de perfis (passado pelo app) entra */
      const nota = {
        tipo: p.tipo, subtipo: p.subtipo, mes: p.mes, ano: p.ano, data: p.data,
        user_id: p.user_id,
        user_nome: _pastaColabDe(pai, folderMap) || nomePorUserId[p.user_id] || '',
      };
      try {
        const destino = await _resolveDestino(nota);
        if (destino === FOLDER_ID) {
          falhas++;
          if (erros.length < 10) erros.push(`${f.name}: não foi possível criar a subpasta`);
        } else if (destino === pai) {
          jaOk++;
        } else {
          await _req(`${FILES_API}/${f.id}?addParents=${destino}`
            + (pai ? `&removeParents=${pai}` : '') + '&fields=id', { method: 'PATCH' });
          movidos++;
        }
      } catch (e) {
        falhas++;
        if (erros.length < 10) erros.push(`${f.name}: ${e.message}`);
      }
      if (onProgress) onProgress(i + 1, arquivos.length);
    }

    /* os caminhos mudaram; o índice é por nome (não por pasta), mas forçar a
       releitura evita trabalhar em cima de ids de uma árvore que não existe mais */
    _indicePronto = false;
    return { total: arquivos.length, movidos, jaOk, falhas, erros };
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
  /* Acha UM arquivo pelo nome na raiz: uma consulta, em vez da varredura
     inteira. O JSON de notas é tudo que o sync precisa, e ele mora na raiz —
     não faz sentido percorrer as subpastas de fotos para achá-lo. */
  async function _acharNaRaiz(filename) {
    if (fileIndex[filename]) return fileIndex[filename];
    const q = `name='${String(filename).replace(/'/g, "\\'")}' and '${FOLDER_ID}' in parents and trashed=false`;
    const data = await _req(`${FILES_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`);
    const id = data.files?.[0]?.id || null;
    if (id) fileIndex[filename] = id;
    return id;
  }

  async function saveJSON(filename, data) {
    _checkConnected();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });

    const existente = await _acharNaRaiz(filename);
    if (existente) {
      const res = await fetch(`${UPLOAD_API}/${existente}?uploadType=media`, {
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
    if (!isConnected()) return null;
    const id = await _acharNaRaiz(filename).catch(() => null);
    if (!id) return null;
    const res = await fetch(`${FILES_API}/${id}?alt=media`, {
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
    /* Aqui o índice é indispensável: sem ele o upload não sabe que o arquivo
       já existe e criaria uma cópia a cada envio. É o único ponto que ainda
       espera a varredura — e ela roda uma vez só, não a cada conexão. */
    await _garantirIndice();
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

    // arquivo novo → resolve a subpasta do modelo padrão (cai na raiz se falhar)
    // arquivo já existente → mantém onde está (PATCH só atualiza conteúdo/metadados)
    const meta = existingId
      ? { appProperties }
      : { name: filename, parents: [await _resolveDestino(nota)], appProperties };

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
    atualizarIndice, migrarParaModeloPadrao,
    isConnected, isConfigured, minutosRestantes,
    getToken, getFolderId,
  };
})();
