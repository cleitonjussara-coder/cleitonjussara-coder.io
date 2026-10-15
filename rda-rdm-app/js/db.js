'use strict';
/* ─────────────────────────────────────────────────────────────
   DB.js — IndexedDB offline-first + engine de sincronização
   Stores: notas | repasses | fotos | meta
   O parâmetro `sb` das funções de sync é o cliente da API (js/api.js).
───────────────────────────────────────────────────────────── */
globalThis.DB = (() => {      // globalThis: este arquivo também roda no service worker (envio em segundo plano, fase 2)
  const DB_NAME = 'petermann_v1';
  const DB_VER  = 4;
  const MAX_SYNC_ATTEMPTS = 5;
  const SYNC_RETRY_MS = 2_000;
  let _db = null;
  /* Quem está logado NESTE aparelho agora. A fila de envio é compartilhada por todas as contas que já entraram
     no mesmo navegador; cada item leva o carimbo de quem o criou (queued_by) e só sobe com a sessão DELE.
     Antes, trocar de conta empurrava a fila da outra conta com o token da nova — 403 sem fim, ou, pior,
     lançamento gravado no nome errado (03/10/2026). */
  let _sessaoUid = null;

  /* ── Abertura / migração ─────────────────────────────── */
  function open() {
    return new Promise((res, rej) => {
      if (_db) { res(_db); return; }
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('notas')) {
          const s = d.createObjectStore('notas', { keyPath: 'id' });
          s.createIndex('user_id',    'user_id',    { unique: false });
          s.createIndex('synced',     'synced',     { unique: false });
          s.createIndex('updated_at', 'updated_at', { unique: false });
        }
        if (!d.objectStoreNames.contains('repasses')) {
          const s = d.createObjectStore('repasses', { keyPath: 'id' });
          s.createIndex('user_id', 'user_id', { unique: false });
          s.createIndex('synced',  'synced',  { unique: false });
        }
        if (!d.objectStoreNames.contains('fotos')) {
          // armazena blob local até o upload pro servidor
          d.createObjectStore('fotos', { keyPath: 'nota_id' });
        }
        if (!d.objectStoreNames.contains('meta')) {
          d.createObjectStore('meta', { keyPath: 'k' });
        }
        if (!d.objectStoreNames.contains('lancamentos_apagados')) {
          const s = d.createObjectStore('lancamentos_apagados', { keyPath: 'id' });
          s.createIndex('user_id', 'user_id', { unique: false });
          s.createIndex('deleted_at', 'deleted_at', { unique: false });
        }
        if (!d.objectStoreNames.contains('sync_queue')) {
          const s = d.createObjectStore('sync_queue', { keyPath: 'id' });
          s.createIndex('status', 'status', { unique: false });
          s.createIndex('next_attempt_at', 'next_attempt_at', { unique: false });
        }
      };
      req.onsuccess = e => {
        _db = e.target.result;
        /* Agora o service worker também abre este banco (envio em segundo plano). Se outra parte do app pedir
           troca de versão ou exclusão do banco, esta conexão FECHA — senão o pedido fica preso até o worker ser
           desligado pelo navegador, e nenhuma abertura nova do banco anda enquanto isso. A próxima chamada reabre. */
        const conn = _db;
        conn.onversionchange = () => { try { conn.close(); } catch (_) {} if (_db === conn) _db = null; };
        res(_db);
      };
      req.onerror   = e => rej(e.target.error);
    });
  }

  /* ── Helpers IDB ─────────────────────────────────────── */
  function _tx(stores, mode, fn) {
    return open().then(d => new Promise((res, rej) => {
      const t = d.transaction(stores, mode);
      t.onerror = e => rej(e.target.error);
      fn(t, res, rej);
    }));
  }

  const _put = (store, obj) =>
    _tx([store], 'readwrite', (t, res, rej) => {
      const r = t.objectStore(store).put(obj);
      r.onsuccess = () => res(obj);
      r.onerror   = e => rej(e.target.error);
    });

  const _get = (store, key) =>
    _tx([store], 'readonly', (t, res, rej) => {
      const r = t.objectStore(store).get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror   = e => rej(e.target.error);
    });

  const _del = (store, key) =>
    _tx([store], 'readwrite', (t, res, rej) => {
      const r = t.objectStore(store).delete(key);
      r.onsuccess = () => res();
      r.onerror   = e => rej(e.target.error);
    });

  const _getAll = (store) =>
    _tx([store], 'readonly', (t, res, rej) => {
      const r = t.objectStore(store).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror   = e => rej(e.target.error);
    });

  const _getAllByIdx = (store, idx, val) =>
    _tx([store], 'readonly', (t, res, rej) => {
      const r = t.objectStore(store).index(idx).getAll(val);
      r.onsuccess = () => res(r.result || []);
      r.onerror   = e => rej(e.target.error);
    });

  const _normalizeRecord = (item, fallbackStatus = 'synced') => {
    if (!item) return item;
    const status = item.sync_status || (item.synced === false ? 'pending' : fallbackStatus);
    /* 08/10/2026: nota guardada antes da migração de 16/09 (que preencheu número
       e série pela chave só no servidor, sem mexer no updated_at) chegava aqui
       sem número — completa na leitura, a partir da própria chave. */
    const ch = String(item.chave_nfce || '').replace(/\D/g, '');
    const daChave = ch.length === 44 && !String(item.numero || '').trim()
      ? { numero: ch.slice(25, 34).replace(/^0+/, '') || '0', serie: item.serie || ch.slice(22, 25).replace(/^0+/, '') || '0' }
      : null;
    return {
      ...item,
      ...(daChave || {}),
      synced: typeof item.synced === 'boolean' ? item.synced : status !== 'synced',
      sync_status: status,
      sync_error: item.sync_error || null,
    };
  };

  /* Entrou item na fila: pede ao navegador o envio em segundo plano (ver registrarEnvioFundo). Não espera, não falha. */
  const _queueOp = async (entry) => {
    const item = await _queueOpInterno(entry);
    registrarEnvioFundo();
    return item;
  };

  const _queueOpInterno = async (entry) => {
    const now = new Date().toISOString();
    const existingItems = await _getAll('sync_queue');
    const existingItem = existingItems.find(item =>
      item.entity === entry.entity &&
      item.entity_id === entry.entity_id &&
      item.action === entry.action
    );

    const item = {
      id: entry.id || existingItem?.id || crypto.randomUUID(),
      entity: entry.entity,
      entity_id: entry.entity_id,
      action: entry.action,
      payload: entry.payload || null,
      status: entry.status || 'pending',
      attempts: entry.attempts || existingItem?.attempts || 0,
      next_attempt_at: entry.next_attempt_at || now,
      created_at: entry.created_at || existingItem?.created_at || now,
      updated_at: entry.updated_at || now,
      last_error: entry.last_error || existingItem?.last_error || null,
      queued_by: entry.queued_by || _sessaoUid || existingItem?.queued_by || null,
    };

    const _alinharCarimbo = async (itemId, quem) => {
      if (!quem || (entry.entity !== 'nota' && entry.entity !== 'foto')) return;
      for (const i of existingItems) {
        if (i.entity_id === entry.entity_id && i.id !== itemId && (i.entity === 'nota' || i.entity === 'foto') && i.queued_by !== quem) {
          await _put('sync_queue', { ...i, queued_by: quem });
        }
      }
    };

    if (existingItem) {
      const merged = {
        ...existingItem,
        ...item,
        id: existingItem.id,
        created_at: existingItem.created_at || item.created_at,
        status: existingItem.status === 'running' ? existingItem.status : (entry.status || 'pending'),
        attempts: entry.attempts ?? existingItem.attempts ?? 0,
        payload: entry.payload ?? existingItem.payload ?? null,
        next_attempt_at: entry.next_attempt_at || (existingItem.status === 'running' ? existingItem.next_attempt_at : now),
        last_error: entry.last_error ?? existingItem.last_error ?? null,
        queued_by: item.queued_by,
        updated_at: now,
      };
      await _put('sync_queue', merged);
      await _alinharCarimbo(existingItem.id, merged.queued_by);
      return merged;
    }

    await _put('sync_queue', item);
    await _alinharCarimbo(item.id, item.queued_by);
    return item;
  };

  const _retryDelayMs = attempts => Math.min(60_000, SYNC_RETRY_MS * 2 ** Math.max(0, attempts - 1));

  /* Erro de CLIENTE (o servidor entendeu e RECUSOU: 403/404/409/413/422…): repetir de minuto em minuto não
     adianta — só muda se a pessoa mexer na nota ou entrar com a conta certa. Depois de 3 tentativas o app
     espera 30 min entre uma e outra (e o "Tentar de novo" da nota zera isso). Falha de rede ou 5xx segue com a
     espera curta de sempre. (03/10/2026: uma nota com anexo vazio foi reenviada de minuto em minuto por horas.) */
  const STATUS_RECUSADO = [400, 403, 404, 409, 413, 422];
  const ESPERA_RECUSADO_MS = 30 * 60_000;
  const _esperaDoErro = (e, attempts) =>
    (STATUS_RECUSADO.includes(e?.status) && attempts >= 3) ? ESPERA_RECUSADO_MS : _retryDelayMs(attempts);

  /* O item da fila é desta sessão? Item novo leva o carimbo queued_by. Item ANTIGO (sem carimbo) vale para o
     dono do registro — ou para quem não tem dono (Faturamento sem colaborador). */
  async function _itemEhDaSessao(item, meuId) {
    if (!meuId) return true;
    if (item.queued_by) return item.queued_by === meuId;
    const reg = item.entity === 'foto' ? await _get('notas', item.entity_id) : item.payload;
    if (!reg) return true;                                  // sem registro: a limpeza que já existe decide
    const dono = reg.user_id;
    if (dono === undefined || dono === meuId) return true;
    if (reg.created_by === meuId || reg.updated_by === meuId) return true;   // gestor/admin lançou ou editou para OUTRO colaborador
    if (dono === null) return !reg.created_by && !reg.updated_by;            // Faturamento sem colaborador: só quem lançou
    return false;
  }

  async function getSyncQueueSummary() {
    const todos = await _getAll('sync_queue');
    const queueItems = [];
    for (const item of todos) { if (await _itemEhDaSessao(item, _sessaoUid)) queueItems.push(item); }
    const now = Date.now();
    const pendingItems = queueItems.filter(item => item.status !== 'running');
    const failedItems = queueItems.filter(item => item.status === 'failed' || item.attempts >= MAX_SYNC_ATTEMPTS);
    const scheduledItems = pendingItems.filter(item => item.next_attempt_at && new Date(item.next_attempt_at).getTime() > now);
    /* "falhou" espera 30 min e não conta para quem decide se vale ficar tentando (envio em segundo plano) */
    const ativosAgendados = scheduledItems.filter(item => !(item.status === 'failed' || item.attempts >= MAX_SYNC_ATTEMPTS));
    const proximaAtivaAt = ativosAgendados.length ? Math.min(...ativosAgendados.map(item => new Date(item.next_attempt_at).getTime())) : null;
    const nextAttemptAt = scheduledItems.length
      ? scheduledItems.reduce((earliest, item) => {
          const ts = new Date(item.next_attempt_at).getTime();
          return ts < earliest ? ts : earliest;
        }, new Date(scheduledItems[0].next_attempt_at).getTime())
      : null;
    return {
      count: queueItems.length,
      pendingCount: pendingItems.length,
      failedCount: failedItems.length,
      scheduledCount: scheduledItems.length,
      nextAttemptAt,
      proximaAtivaAt,
    };
  }

  /* Por que um registro não subiu (tela da nota): o erro guardado no registro e o de cada item da fila.
     Só leitura. */
  async function getFalhaSync(entityId) {
    const nota = await _get('notas', entityId).catch(() => null);
    const itens = (await _getAll('sync_queue')).filter(i => i.entity_id === entityId);
    const foto = await getFotoLocal(entityId).catch(() => null);
    return {
      nota_erro: nota?.sync_error || null,
      anexo_bytes: foto?.blob ? (foto.blob.size ?? null) : null,
      itens: itens.map(i => ({ entity: i.entity, status: i.status, attempts: i.attempts || 0, last_error: i.last_error || null, updated_at: i.updated_at || null, queued_by: i.queued_by || null })),
    };
  }

  /* "Tentar de novo": zera as tentativas e a espera dos itens deste registro — sem apagar nada. */
  async function tentarDeNovo(entityId) {
    const now = new Date().toISOString();
    let n = 0;
    for (const i of (await _getAll('sync_queue')).filter(x => x.entity_id === entityId)) {
      await _mutarFila(i.id, cur => ({ ...cur, attempts: 0, contada_em: null, status: 'pending', next_attempt_at: now, last_error: null, updated_at: now }));
      n++;
    }
    const nota = await _get('notas', entityId).catch(() => null);
    if (nota && nota.sync_status === 'failed') await _put('notas', { ...nota, synced: false, sync_status: 'pending', sync_error: null });
    return n;
  }

  /* ── Meta (last_sync, etc.) ──────────────────────────── */
  const getMeta = async (k, def = null) => { const r = await _get('meta', k); return r ? r.v : def; };
  const setMeta = (k, v) => _put('meta', { k, v });

  /* ── NOTAS ───────────────────────────────────────────── */
  async function saveNota(nota, userId) {
    if (userId) _sessaoUid = userId;
    const now = new Date().toISOString();
    const fotoLocal = nota.foto_local || null;
    const id = nota.id || crypto.randomUUID();
    const obj = {
      ...nota,                                        // spread primeiro
      id,
      /* Faturamento sem colaborador (28/09/2026): user_id explicitamente
         null (não "ainda não escolhido") tem que continuar null aqui —
         só cai no userId de quem está logado quando a chave nem veio. */
      user_id    : nota.user_id === undefined ? userId : nota.user_id,
      created_at : nota.created_at || now,
      updated_at : now,
      synced     : false,
      sync_status: 'pending',
      sync_error : null,
      deleted    : nota.deleted || false,
    };
    const localObj = { ...obj, foto_local: fotoLocal };
    await _put('notas', localObj);
    const payload = { ...localObj };
    delete payload.foto_local;
    delete payload.synced;
    delete payload.sync_status;
    delete payload.sync_error;
    await _queueOp({ entity: 'nota', entity_id: id, action: 'upsert', payload });
    return localObj;
  }
 
  async function getNotasUser(userId, includeDeleted = false) {
    const all = await _getAllByIdx('notas', 'user_id', userId);
    return all.filter(n => includeDeleted || !n.deleted).map(n => _normalizeRecord(n));
  }

  async function softDeleteNota(id) {
    const n = await _get('notas', id);
    if (!n || n.deleted) return;
    const now = new Date().toISOString();
    const archived = {
      ...n,
      user_id: n.user_id || null,
      deleted: true,
      deleted_at: now,
      deleted_from: 'local',
      restored: false,
      updated_at: now,
      synced: true,
      sync_status: 'synced',
      sync_error: null,
    };
    await _put('lancamentos_apagados', archived);
    const updated = { ...n, deleted: true, synced: false, sync_status: 'pending', sync_error: null, updated_at: now };
    await _put('notas', updated);
    const payload = { ...updated };
    delete payload.foto_local;
    delete payload.synced;
    delete payload.sync_status;
    delete payload.sync_error;
    await _queueOp({ entity: 'nota', entity_id: id, action: 'upsert', payload });
  }

  /* A lixeira junta DUAS origens:
       • `lancamentos_apagados` — o arquivo que a exclusão de hoje cria;
       • `notas` com deleted=true e SEM cópia arquivada — órfãs da versão
         anterior do app, que só marcava a nota e não arquivava nada (a
         store nem existia). Sem isto elas somem da lista e da lixeira ao
         mesmo tempo, e não sobra tela nenhuma para restaurá-las.
     A leitura é da store inteira, e não pelo índice `user_id`, porque o
     IndexedDB não indexa registro cujo valor da chave seja null — e o
     arquivamento grava `user_id: n.user_id || null`. Pelo índice, nota
     sem dono ficava invisível para sempre. */
  /* Expurgo LOCAL da nota: some das duas stores e leva junto o anexo e
     qualquer item de fila que ainda aponte para ela — senão a fila tentaria
     ressincronizar uma nota que não existe mais.
     Não fala com o servidor: quem apaga lá é o app, e só com internet, para
     não sobrar o caso de sumir aqui e continuar existindo no Supabase (o
     pull traria de volta na sincronização seguinte). */
  async function purgeNotaLocal(id) {
    if (!id) return;
    await _del('notas', id).catch(() => {});
    await _del('lancamentos_apagados', id).catch(() => {});
    await _del('fotos', id).catch(() => {});
    const fila = await _getAll('sync_queue').catch(() => []);
    for (const item of fila) {
      if (item.entity_id === id) await _del('sync_queue', item.id).catch(() => {});
    }
  }

  /* Colaborador excluído de vez (20/09/2026): as linhas dele já não voltam
     do servidor, então saem daqui também. */
  async function purgeNotasDeUsuario(userId) {
    if (!userId) return 0;
    let n = 0;
    for (const store of ['notas', 'lancamentos_apagados', 'repasses']) {
      const rows = await _getAll(store).catch(() => []);
      for (const r of rows) {
        if (r.user_id === userId) { await _del(store, r.id).catch(() => {}); n++; }
      }
    }
    return n;
  }

  /* Tira um item da lixeira local. tudo=true apaga também a linha em
     `notas` e a foto (cópia órfã: não existe mais no servidor); false só
     limpa o arquivo (a nota viva voltou pelo sync). */
  async function limparDaLixeira(id, tudo) {
    await _del('lancamentos_apagados', id).catch(() => {});
    if (tudo) {
      await _del('notas', id).catch(() => {});
      await _del('fotos', id).catch(() => {});
      const fila = await _getAll('sync_queue').catch(() => []);
      for (const item of fila) {
        if (item.entity_id === id) await _del('sync_queue', item.id).catch(() => {});
      }
    }
  }

  async function getDeletedNotasUser(userId) {
    /* Cada store é lida por conta própria: num aparelho que ainda não
       abriu o app novo, `lancamentos_apagados` pode não existir, e um
       Promise.all comum derrubaria também a leitura das órfãs — que são
       justamente as que precisam aparecer ali. */
    const [arquivadas, notas] = await Promise.all([
      _getAll('lancamentos_apagados').catch(() => []),
      _getAll('notas').catch(() => []),
    ]);
    const doUsuario = n => !userId || !n.user_id || n.user_id === userId;

    /* Cópia arquivada só conta se a nota viva ainda estiver apagada. Quando
       a restauração chega pelo servidor (outro aparelho, ou um reparo no
       banco), `notas` volta a deleted=false mas ninguém limpa o arquivo —
       e a mesma nota aparecia na lista e na lixeira. */
    const vivas = new Map(notas.map(n => [n.id, n]));
    const lista = arquivadas.filter(doUsuario).filter(a => {
      const viva = vivas.get(a.id);
      return !viva || viva.deleted;
    });
    const jaListadas = new Set(lista.map(n => n.id));

    for (const n of notas) {
      if (!n.deleted || jaListadas.has(n.id) || !doUsuario(n)) continue;
      lista.push({
        ...n,
        deleted_at  : n.deleted_at   || n.updated_at || null,
        deleted_from: n.deleted_from || 'local',
      });
    }
    return lista.map(n => _normalizeRecord(n));
  }

  async function restoreNota(id) {
    const archived = await _get('lancamentos_apagados', id);
    const current = await _get('notas', id);
    const base = archived || current;
    if (!base) return null;

    const now = new Date().toISOString();
    const restored = {
      ...base,
      id,
      deleted: false,
      restored_at: now,
      synced: false,
      sync_status: 'pending',
      sync_error: null,
      updated_at: now,
    };
    delete restored.deleted_at;
    delete restored.deleted_from;
    delete restored.restored;
    delete restored.restored_at;
    delete restored.synced;
    delete restored.sync_status;
    delete restored.sync_error;
    await _put('notas', { ...restored, synced: false, sync_status: 'pending', sync_error: null, updated_at: now });
    await _del('lancamentos_apagados', id);

    const payload = { ...restored, synced: false, sync_status: 'pending', sync_error: null, updated_at: now };
    delete payload.foto_local;
    delete payload.synced;
    delete payload.sync_status;
    delete payload.sync_error;
    await _queueOp({ entity: 'nota', entity_id: id, action: 'upsert', payload });
    return restored;
  }

  /* ── ANEXOS / FOTOS (blob local: foto, PDF ou XML) ────── */
  const MIME_POR_EXT = {
    jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp',
    heic:'image/heic', gif:'image/gif', pdf:'application/pdf', xml:'text/xml',
  };
  const saveFotoLocal = async (nota_id, blob, ext) => {
    /* `em`: carimbo desta versão do anexo — o envio compara antes de apagar o blob local (anexo trocado durante o upload) */
    const entry = { nota_id, blob, ext: (ext || 'jpg').toLowerCase(), em: new Date().toISOString() + ':' + Math.random().toString(36).slice(2, 8) };
    await _put('fotos', entry);
    await _queueOp({ entity: 'foto', entity_id: nota_id, action: 'upload', payload: entry });
    return entry;
  };
  const getFotoLocal = (nota_id) => _get('fotos', nota_id);
  const delFotoLocal = (nota_id) => _del('fotos', nota_id);

  const EXT_POR_MIME = { ...Object.fromEntries(
    Object.entries(MIME_POR_EXT).map(([e, m]) => [m, e])), 'image/jpeg': 'jpg' };
  const _extDeBlob = b => EXT_POR_MIME[b?.type] || 'jpg';

  /* ── Migração única: solta os blobs presos no registro da nota ──────
     O anexo era guardado em DOIS lugares: na store 'fotos' (de onde o
     upload sai) e também dentro do próprio registro da nota, no campo
     foto_local. Só a cópia da store era apagada depois de subir — a de
     dentro da nota ficava para sempre, então o aparelho acumulava todas
     as fotos já lançadas, de 3 a 5 MB cada.
     Nada nunca leu esse blob: os três lugares que olham foto_local só
     testam se ele existe, para saber se a nota tem anexo. Então aqui ele
     é trocado por um marcador curto (a extensão), o que mantém esse teste
     funcionando e devolve o espaço.
     Se o blob for a ÚNICA cópia (não está na fila nem subiu ainda), ele é
     movido para a store 'fotos' antes — assim a foto ainda consegue subir
     em vez de ser descartada. */
  async function repararFotosLocais() {
    if (await getMeta('foto_local_migrado', false)) return null;
    let trocados = 0, recuperados = 0;
    for (const n of await _getAll('notas')) {
      if (!(n.foto_local instanceof Blob)) continue;
      const ext = _extDeBlob(n.foto_local);
      if (!n.foto_path && !(await _get('fotos', n.id))) {
        await saveFotoLocal(n.id, n.foto_local, ext);
        recuperados++;
      }
      await _put('notas', { ...n, foto_local: ext });
      trocados++;
    }
    await setMeta('foto_local_migrado', true);
    return { trocados, recuperados };
  }

  /* ── REPASSES ────────────────────────────────────────── */
  async function saveRepasse(rep, userId) {
    if (userId) _sessaoUid = userId;
    const now = new Date().toISOString();
    const id = rep.id || crypto.randomUUID();
    const obj = {
      ...rep,                                        // spread primeiro
      id,
      user_id    : rep.user_id || userId,
      created_at : rep.created_at || now,
      updated_at : now,
      synced     : false,
      sync_status: 'pending',
      sync_error : null,
      deleted    : rep.deleted || false,
    };
    await _put('repasses', obj);
    const payload = { ...obj };
    delete payload.synced;
    delete payload.sync_status;
    delete payload.sync_error;
    await _queueOp({ entity: 'repass', entity_id: id, action: 'upsert', payload });
    return obj;
  }
 
  async function getRepassesUser(userId, includeDeleted = false) {
    const all = await _getAllByIdx('repasses', 'user_id', userId);
    return all.filter(r => includeDeleted || !r.deleted).map(r => _normalizeRecord(r));
  }
  /* Todos os repasses que chegaram a este aparelho (gestor/admin/contabilidade
     recebem os de toda a equipe pelo pull) — para as notificações de pedido
     de repasse (21/09/2026). */
  async function getRepassesTodos() {
    const all = await _getAll('repasses');
    return all.filter(r => !r.deleted).map(r => _normalizeRecord(r));
  }
 
  async function softDeleteRepasse(id) {
    const r = await _get('repasses', id);
    if (r) {
      const now = new Date().toISOString();
      const updated = { ...r, deleted: true, synced: false, sync_status: 'pending', sync_error: null, updated_at: now };
      await _put('repasses', updated);
      const payload = { ...updated };
      delete payload.synced;
      delete payload.sync_status;
      delete payload.sync_error;
      await _queueOp({ entity: 'repass', entity_id: id, action: 'upsert', payload });
    }
  }

  /* ── Merge dados vindos do Drive (Drive vence se mais recente) */
  /* O arquivo do Drive é CÓPIA, não fonte de verdade. Ele só serve para
     repor o que este aparelho não tem (troca de celular, IndexedDB limpo).
     Registro que já existe aqui fica exatamente como está — apagado,
     restaurado, editado, o que for. Quem decide entre aparelhos é o
     Supabase, no pullIncremental, comparando updated_at.

     Histórico do que este trecho já fez de errado, para ninguém repetir:
       • "sumiu do Drive = foi excluído": comia lançamento novo, porque o
         push ao Supabase termina antes do upload ao Drive e o db-synced
         relia o snapshot antigo (repasse sumindo após "enviado 1").
       • "veio apagado do Drive = apaga aqui", sem olhar data: desfazia
         restauração e mandava nota viva para a lixeira sempre que algum
         aparelho tinha subido uma versão apagada antes (o "erro crônico").
       • "veio vivo do Drive e é mais novo = sobrescreve": desfazia
         exclusão feita aqui.
     Os três eram a mesma ideia — confiar no Drive sobre o estado local. */
  async function upsertFromDrive(store, records) {
    const incoming = (records || []).filter(rec => rec && rec.id);
    let repostos = 0;
    for (const rec of incoming) {
      if (rec.deleted === true || rec.deleted_at || rec._deleted === true) continue;
      const local = await _get(store, rec.id);
      if (local) continue;
      await _put(store, {
        ...rec,
        synced: true,
        sync_status: 'synced',
        sync_error: null,
        foto_local: null,
      });
      repostos++;
    }
    return repostos;
  }
 
  /* ── SYNC ────────────────────────────────────────────── */
  let _running = false;
  let _novaRodada = null;          // pedido de sync feito DURANTE uma rodada: roda de novo assim que ela terminar
  let _loopAtual = null;           // promessa da rodada em andamento (quem precisa esperar usa aguardarSync())
  let _ultimoInicio = 0;           // quando a última rodada começou (evita disparos em rajada)
  let _timerReenvio = null;        // reenvio rápido enquanto sobra coisa na fila
  let _rapidosSeguidos = 0;        // reenvios rápidos já feitos nesta sequência de falhas (para depois de 4)
  let _ultimoDisparo = 0;          // quando o último gatilho automático disparou (trava de rajada)
  let _auto = null;                // { sb, getUid } do setupAutoSync (instala os ouvintes UMA vez)
  /* Quem está logado AGORA, perguntado ao app (getUid do setupAutoSync). _sessaoUid é a memória do db.js e pode estar
     velha (o logout não avisa o db.js); nenhum envio pode usar um uid capturado antes de uma troca de conta. Sem
     getter registrado, não bloqueia nada. */
  let _uidVivo = null;
  const _contaViva = uid => { if (!uid || !_uidVivo) return true; try { return _uidVivo() === uid; } catch (_) { return true; } };

  /* Lê e grava o item da fila NA MESMA transação: o que se grava é o registro ATUAL, não uma cópia lida antes (uma
     edição que entrou no meio não é desfeita), e item já enviado e apagado não ressuscita. fn devolve o novo item ou null. */
  const _mutarFila = (id, fn) => _tx(['sync_queue'], 'readwrite', (t, res, rej) => {
    const s = t.objectStore('sync_queue');
    const g = s.get(id);
    g.onerror = e => rej(e.target.error);
    g.onsuccess = () => {
      const cur = g.result;
      if (!cur) { res(null); return; }
      const novo = fn(cur);
      if (!novo) { res(cur); return; }
      const p = s.put(novo);
      p.onsuccess = () => res(novo);
      p.onerror = e => rej(e.target.error);
    };
  });

  async function _ensureQueueFromExisting() {
    const [allN, allR, allFotos, queueItems] = await Promise.all([
      _getAll('notas'),
      _getAll('repasses'),
      _getAll('fotos'),
      _getAll('sync_queue'),
    ]);
    const existing = new Set(queueItems.filter(i => i.entity === 'nota').map(i => i.entity_id));
    for (const n of allN.filter(x => x.synced === false || x.sync_status === 'pending' || x.sync_status === 'failed' || x.sync_status === 'retrying')) {
      if (!existing.has(n.id)) {
        const payload = { ...n };
        delete payload.foto_local;
        delete payload.synced;
        delete payload.sync_status;
        delete payload.sync_error;
        await _queueOp({ entity: 'nota', entity_id: n.id, action: 'upsert', payload, queued_by: n.created_by || n.user_id || _sessaoUid });
      }
    }
    const existingRep = new Set(queueItems.filter(i => i.entity === 'repass').map(i => i.entity_id));
    for (const r of allR.filter(x => x.synced === false || x.sync_status === 'pending' || x.sync_status === 'failed' || x.sync_status === 'retrying')) {
      if (!existingRep.has(r.id)) {
        const payload = { ...r };
        delete payload.synced;
        delete payload.sync_status;
        delete payload.sync_error;
        await _queueOp({ entity: 'repass', entity_id: r.id, action: 'upsert', payload, queued_by: r.created_by || r.user_id || _sessaoUid });
      }
    }
    const existingFoto = new Set(queueItems.filter(i => i.entity === 'foto').map(i => i.entity_id));
    for (const f of allFotos) {
      if (!existingFoto.has(f.nota_id) && !f.recusada) {
        const dono = allN.find(x => x.id === f.nota_id);
        await _queueOp({ entity: 'foto', entity_id: f.nota_id, action: 'upload', payload: f, queued_by: dono?.created_by || dono?.user_id || _sessaoUid });
      }
    }
  }

  /* opts (12/10/2026, envio em segundo plano):
       travado — quem chama SEGURA a trava de envio entre página e service worker: nenhum outro contexto está enviando
                 agora, então item "running" é órfão (o contexto que o pegou morreu) e vale já, sem esperar os 30 s;
       ate     — instante-limite (ms) para COMEÇAR um item novo: o service worker só tem alguns minutos por evento. */
  async function pushPending(sb, userId, opts) {
    if (!sb || !navigator.onLine) return { ok: 0, fail: 0, fotosOk: 0, fotosFail: 0, erroFoto: null };
    await _ensureQueueFromExisting();
    const queueItems = await _getAll('sync_queue');
    const now = Date.now();
    let dueItems = queueItems.filter(item => {
      const isDue = !item.next_attempt_at || new Date(item.next_attempt_at).getTime() <= now;
      if (item.status === 'running') {
        if (opts?.travado) return isDue;
        const updatedAt = item.updated_at ? new Date(item.updated_at).getTime() : 0;
        return isDue && now - updatedAt > 30_000;
      }
      return isDue;
    });
    /* só o que ESTA conta pôs na fila: o resto espera a conta certa entrar (nada é apagado nem marcado como falha) */
    const meuId = userId || _sessaoUid;
    if (meuId) {
      const meus = [];
      for (const item of dueItems) { if (await _itemEhDaSessao(item, meuId)) meus.push(item); }
      dueItems = meus;
    }
    /* Anexos ANTES dos registros, e na ordem em que entraram na fila. A API
       só aceita nota NOVA se o arquivo dela já estiver no disco (anexo
       obrigatório vale no servidor também), e o POST da foto aceita nota que
       ainda não existe lá. Se a foto falhar, a nota cai no catch (422) e as
       duas tentam de novo juntas. O getAll devolve pelo id (UUID, aleatório),
       por isso a ordenação explícita. */
    dueItems.sort((a, b) =>
      ((b.entity === 'foto') - (a.entity === 'foto')) ||
      String(a.created_at || '').localeCompare(String(b.created_at || '')));
    let ok = 0, fail = 0;
    let fotosOk = 0, fotosFail = 0, erroFoto = null;
    const falhou = m => { fotosFail++; erroFoto = erroFoto || m; };

    for (const item0 of dueItems) {
      if (opts?.ate && Date.now() > opts.ate) break;      // sem tempo para começar mais um: o resto vai no próximo evento
      /* trocou de conta no meio do ciclo (upload longo): o que falta é da conta antiga e espera ela voltar.
         _contaViva pergunta ao app quem está logado AGORA — _sessaoUid sozinho pode estar velho (revisão 11/10/2026). */
      if (meuId && ((_sessaoUid && _sessaoUid !== meuId) || !_contaViva(meuId))) break;
      /* o item pode ter mudado desde que a lista foi montada (edição da nota, "Enviar agora", envio concluído): usa o ATUAL */
      const item = await _get('sync_queue', item0.id);
      if (!item) continue;
      const now = new Date().toISOString();
      await _put('sync_queue', { ...item, status: 'running', updated_at: now });
      try {
        if (item.entity === 'foto') {
          const payload = item.payload || null;
          if (!payload?.blob) { await _del('sync_queue', item.id); continue; }
          const nota = await _get('notas', item.entity_id);
          /* 28/09/2026: user_id === undefined é registro quebrado de verdade
             (limpa e desiste, como antes). user_id === null é Faturamento
             sem colaborador — legítimo, não é mais motivo pra descartar o
             anexo em silêncio. */
          if (!nota || nota.user_id === undefined) { await delFotoLocal(item.entity_id); await _del('sync_queue', item.id); continue; }
          const ext = (payload.ext || 'jpg').toLowerCase();
          const mime = MIME_POR_EXT[ext] || 'application/octet-stream';
          /* A API grava o arquivo em disco (user_id/nota_id.ext) e, se a nota
             já existe lá, atualiza o foto_path dela na mesma chamada. Se ainda
             não existe, o arquivo fica esperando e o upsert da nota (logo em
             seguida) o encontra pelo id — por isso vai o user_id junto. */
          const blob = payload.blob instanceof Blob ? payload.blob : new Blob([payload.blob], { type: mime });
          /* 03/10/2026: o iPhone entrega arquivo de 0 bytes quando ele está só na nuvem (iCloud/WhatsApp). Mandar
             isso só gera 422 sem fim; recusa aqui com o motivo, que a nota passa a mostrar. */
          if (!blob.size) { const vazio = new Error('Anexo vazio (0 KB): o arquivo não chegou inteiro ao app'); vazio.status = 422; throw vazio; }
          const { foto_path: path } = await sb.notas.foto(item.entity_id, blob, ext, nota.user_id, nota.user_id === null);
          /* 14/10/2026 (revisão): a nota é LIDA DE NOVO e só recebe o caminho do anexo — a cópia lida antes do upload
             (até 120 s atrás) desfazia a edição ou a exclusão feita nesse meio tempo. updated_at não é mexido, para o
             envio da nota perceber a edição (compara updated_at). */
          const notaAgora = await _get('notas', item.entity_id);
          if (notaAgora) await _put('notas', { ...notaAgora, foto_path: path, foto_local: ext, sync_error: null });
          /* o anexo foi TROCADO enquanto este subia (a pessoa corrigiu a nota/o Contador trocou a foto): o que subiu é
             o antigo. Não apaga o blob novo nem o item — ele volta para a fila e sobe na próxima rodada. */
          const fotoAgora = await _get('fotos', item.entity_id).catch(() => null);
          const itemAgora = await _get('sync_queue', item.id).catch(() => null);
          const trocou = (fotoAgora && (fotoAgora.em || null) !== (payload.em || null))
            || (itemAgora && itemAgora.payload && (itemAgora.payload.em || null) !== (payload.em || null));
          if (trocou) {
            if (itemAgora) await _put('sync_queue', { ...itemAgora, status: 'pending', attempts: 0, contada_em: null, next_attempt_at: now, updated_at: now });
          } else {
            await delFotoLocal(item.entity_id);
            await _del('sync_queue', item.id);
          }
          /* o anexo chegou: a nota que esperava por ele (422 "Anexo obrigatório") não precisa esperar a espera dela */
          for (const q of await _getAll('sync_queue')) {
            if (q.entity === 'nota' && q.entity_id === item.entity_id) {
              await _put('sync_queue', { ...q, attempts: 0, status: 'pending', next_attempt_at: now, updated_at: now });
              const nl = await _get('notas', item.entity_id);
              if (nl && nl.sync_status === 'failed') await _put('notas', { ...nl, synced: false, sync_status: 'pending', sync_error: null });
            }
          }
          fotosOk++;
          continue;
        }

        const record = item.entity === 'nota' ? await _get('notas', item.entity_id) : await _get('repasses', item.entity_id);
        if (!record) { await _del('sync_queue', item.id); continue; }

        const payload = { ...(item.payload || {}) };
        delete payload.foto_local;
        delete payload.synced;
        delete payload.sync_status;
        delete payload.sync_error;
        delete payload.updated_at;       // quem carimba é o servidor
        delete payload.user_nome;        // campo só de tela (notas da equipe)
        if (item.entity === 'repass') delete payload.email_sent;   // decisão do servidor

        /* lança em caso de erro → catch abaixo agenda a nova tentativa */
        if (item.entity === 'nota') await sb.notas.upsert(payload);
        else                        await sb.repasses.upsert(payload);

        const store = item.entity === 'nota' ? 'notas' : 'repasses';
        const atualReg = await _get(store, item.entity_id);
        if (atualReg && record.updated_at && atualReg.updated_at !== record.updated_at) {
          /* A pessoa MEXEU no registro enquanto o envio estava no ar: o que subiu é a versão anterior. Não marca como
             enviado nem apaga o item da fila — a versão nova sobe na próxima rodada, sem sobrescrever a edição. */
          const q = await _get('sync_queue', item.id);
          if (q) await _put('sync_queue', { ...q, status: 'pending', attempts: 0, contada_em: null, next_attempt_at: now, updated_at: now });
        } else {
          await _put(store, { ...record, synced: true, sync_status: 'synced', sync_error: null, updated_at: now });
          await _del('sync_queue', item.id);
        }
        ok++;
      } catch (e) {
        const message = e?.message || 'falha na sincronização';
        /* Recusa por PAPEL (Contador, 14/10/2026): o servidor nunca vai aceitar esse item — quem virou Contador com
           nota nova ou repasse parado na fila ficava com "N itens pendentes" para sempre. Sai da fila (o aviso some);
           o registro continua guardado no aparelho, só sem tentar subir de novo. */
        if (e?.status === 403 && /^contabilidade/i.test(message)) {
          await _del('sync_queue', item.id);
          if (item.entity === 'foto') {
            /* o anexo fica guardado, mas marcado: sem isto _ensureQueueFromExisting o recolocava na fila a cada rodada
               e o arquivo inteiro subia de novo só para tomar 403 (revisão de 14/10/2026) */
            const f = await _get('fotos', item.entity_id);
            if (f) await _put('fotos', { ...f, recusada: true });
          } else {
            const lojaRec = item.entity === 'nota' ? 'notas' : 'repasses';
            const local = await _get(lojaRec, item.entity_id);
            if (local) await _put(lojaRec, { ...local, synced: true, sync_status: 'synced', sync_error: message });
          }
          continue;
        }
        /* Falha de REDE/5xx só gasta uma das MAX_SYNC_ATTEMPTS tentativas se a última contada tem 1 min ou mais: com o
           reenvio rápido (3-20 s), sinal ruim passageiro não pode virar "falhou" em meio minuto. Recusa do servidor
           (422/403…) conta sempre. */
        const agoraMs = Date.now();
        const ultimaContada = item.contada_em ? new Date(item.contada_em).getTime() : 0;
        /* nota recusada por "Anexo obrigatório" enquanto o anexo ainda está na fila tentando subir (sinal fraco) é
           dependência passageira, não recusa: segue com a espera curta de sempre */
        const irmaFoto = item.entity === 'nota' && /anexo obrigat/i.test(message)
          ? (await _getAll('sync_queue')).find(q => q.entity === 'foto' && q.entity_id === item.entity_id && q.status !== 'failed') : null;
        const recusado = !irmaFoto && STATUS_RECUSADO.includes(e?.status);
        const conta = recusado || agoraMs - ultimaContada >= 60_000;
        const attempts = (item.attempts || 0) + (conta ? 1 : 0);
        const espera = recusado ? _esperaDoErro(e, attempts) : (conta ? _retryDelayMs(attempts) : Math.min(20_000, Math.max(3_000, _retryDelayMs(Math.max(1, attempts)))));
        const nextAttemptAt = new Date(Date.now() + espera).toISOString();
        /* recusa do servidor (422/403…) vira "falhou" já na 3ª tentativa: a pessoa precisa ver o aviso logo, não só
           depois de 1 hora de espera de 30 min entre as tentativas */
        const nextStatus = (attempts >= MAX_SYNC_ATTEMPTS || (recusado && attempts >= 3)) ? 'failed' : 'pending';
        /* grava sobre o item ATUAL (uma edição pode ter entrado no payload durante o envio) */
        await _mutarFila(item.id, cur => ({ ...cur, attempts, contada_em: conta ? now : (item.contada_em || null), next_attempt_at: nextAttemptAt, status: nextStatus, last_error: message, updated_at: now }));
        if (item.entity === 'foto') {
          falhou(message);
        } else {
          const store = item.entity === 'nota' ? 'notas' : 'repasses';
          const local = await _get(store, item.entity_id);
          if (local) {
            await _put(store, { ...local, synced: false, sync_status: nextStatus === 'failed' ? 'failed' : 'pending', sync_error: message, updated_at: now });
          }
          fail++;
        }
      }
    }

    return { ok, fail, fotosOk, fotosFail, erroFoto };
  }

  /* Grava no aparelho a(s) linha(s) de repasse que o servidor acabou de
     devolver (ex.: lançamento do gestor para outro colaborador, que vai
     direto ao servidor). Sem isto o registro só chegava no próximo pull. */
  async function mesclarRepassesRemotos(rows) {
    return _mesclarRemotas('repasses', Array.isArray(rows) ? rows : [rows]);
  }

  /* Mescla linhas vindas do servidor no store local. Devolve quantas entraram. */
  async function _mesclarRemotas(table, data) {
    let pulled = 0;
    for (const row of (data || [])) {
          const local = await _get(table, row.id);
          /* Remoto vence quando a linha não existe aqui ou quando é mais
             recente. `local.synced` NÃO entra nessa conta: estar sincronizado
             diz apenas que o push já saiu daqui, não que o servidor tenha algo
             mais novo. Com ele na condição, uma linha antiga do servidor
             sobrescrevia o estado local recém-gravado — era mais um caminho
             para exclusão desfeita, igual ao que o Drive fazia.
             O `|| 0` evita que uma data ausente vire Invalid Date e trave a
             comparação, o que bloquearia atualizações legítimas. */
          if (!local || new Date(row.updated_at || 0) >= new Date(local.updated_at || 0)) {
            const merge = { ...row, synced: true, foto_local: local?.foto_local || null };
            /* foto_path é a exceção ao "remoto vence": o app nunca remove
               anexo (ele é obrigatório), então null do servidor não é uma
               remoção intencional — é a linha que ficou para trás. Deixar
               sobrescrever apagava a referência de uma foto que está no
               disco do servidor, e a nota ficava sem imagem para sempre. */
            if (table === 'notas' && !row.foto_path && local?.foto_path) {
              merge.foto_path = local.foto_path;
            }
            await _put(table, merge);
            pulled++;
          }
    }
    return pulled;
  }

  /* ── Janela por ano (20/09/2026) ────────────────────────────
     Antes, o primeiro sync de um aparelho pedia TUDO (since=1970): para o
     gestor, todas as notas de todos os colaboradores, de todos os anos.
     Com centenas de notas por dia isso vira minutos de download e um
     IndexedDB de dezenas de MB só para olhar o mês atual.
     Agora o primeiro sync traz só o ANO ATUAL; outros anos entram quando a
     pessoa navega até eles (garantirAno, chamado pelo app ao mudar filAno).
     Depois disso, o since= traz apenas o que mudou, de qualquer ano — como
     sempre. Aparelho antigo (last_sync já gravado) já tem tudo: marcado
     com '*' para não baixar de novo. */
  const ANOS_KEY = 'anos_sync';
  async function garantirAno(sb, userId, ano) {
    ano = parseInt(ano, 10);
    if (!sb || !navigator.onLine || !userId || !(ano >= 2000 && ano <= 2100)) return 0;
    let anos = await getMeta(ANOS_KEY, null);
    if (!Array.isArray(anos)) {
      anos = (await getMeta('last_sync', null)) ? ['*'] : [];
      await setMeta(ANOS_KEY, anos);
    }
    if (anos.includes('*') || anos.includes(ano)) return 0;
    const data = await sb.notas.list({ ano });
    const n = await _mesclarRemotas('notas', data);
    anos.push(ano);
    await setMeta(ANOS_KEY, anos);
    return n;
  }
  async function anosSincronizados() {
    const a = await getMeta(ANOS_KEY, null);
    return Array.isArray(a) ? a : [];
  }

  /* Só apaga o que o servidor DIZ que foi apagado — nunca por dedução. E
     nunca o que ainda está na fila para subir. */
  async function _limparApagadas(sb, since) {
    if (!sb?.notas?.apagadas) return 0;
    const ids = await sb.notas.apagadas(since);
    if (!Array.isArray(ids) || !ids.length) return 0;
    const fila = await _getAll('sync_queue').catch(() => []);
    const pendentes = new Set(fila.map(i => i.entity_id));
    let limpas = 0;
    for (const id of ids) {
      if (pendentes.has(id)) continue;
      if (!(await _get('notas', id).catch(() => null))) continue;
      await purgeNotaLocal(id);
      limpas++;
    }
    return limpas;
  }

  /* Ids que ainda esperam subir — nada que esteja aqui pode ser removido
     do aparelho, sob pena de perder um lançamento que o servidor nunca viu. */
  async function idsNaFila() {
    const fila = await _getAll('sync_queue').catch(() => []);
    return new Set(fila.map(i => i.entity_id).filter(Boolean));
  }

  /* 08/10/2026: uma vez por aparelho, pede de novo as notas inteiras de cada
     ano guardado aqui. O celular do Cleiton cobrava "sem nº" de uma nota da
     equipe (JOSPINA, 16/06) que o servidor corrigiu em 25/09: a versão nova
     caiu na janela que a marca antiga do sync perdia (corrigida em 01/10) e
     nunca mais foi pedida. A mescla só troca o que o servidor tem de igual ou
     mais novo, então repetir é seguro. Se falhar, tenta no próximo sync. */
  const REVISAO_KEY = 'revisao_completa';
  const REVISAO_VERSAO = 1;
  async function _revisaoCompleta(sb) {
    if (Number(await getMeta(REVISAO_KEY, 0)) >= REVISAO_VERSAO) return 0;
    const locais = await _getAll('notas');
    const anos = new Set([new Date().getFullYear()]);
    for (const n of locais) {
      const a = Number(n.ano) || parseInt(String(n.data || '').slice(0, 4), 10);
      if (a >= 2000 && a <= 2100) anos.add(a);
    }
    let n = 0;
    for (const ano of anos) n += await _mesclarRemotas('notas', await sb.notas.list({ ano }));
    await setMeta(REVISAO_KEY, REVISAO_VERSAO);
    return n;
  }

  async function pullIncremental(sb, userId) {
    if (!sb || !navigator.onLine || !userId) return 0;
    const since = await getMeta('last_sync', null);
    let pulled = 0;
    /* 01/10/2026: a marca do próximo sync é tirada ANTES de pedir e vem da
       hora do SERVIDOR, com 5 min de folga. Antes era o relógio do aparelho
       lido DEPOIS do pull: o que o servidor gravasse nesse intervalo, ou num
       celular adiantado, nunca mais era pedido — repasse e recarga "sumiam"
       do aparelho (a mescla é idempotente, repetir a janela não faz mal). */
    const _agoraSrv = (typeof API !== 'undefined' && API.horaServidorMs) ? API.horaServidorMs() : Date.now();
    const marca = new Date(Math.min(_agoraSrv, Date.now()) - 5 * 60 * 1000).toISOString();

    if (!since) {
      /* primeiro sync deste aparelho: notas só do ano atual; repasses são
         poucos e vêm inteiros */
      try {
        await setMeta(ANOS_KEY, []);
        const anoAtual = new Date().getFullYear();
        pulled += await garantirAno(sb, userId, anoAtual);
        const reps = await sb.repasses.list({});
        pulled += await _mesclarRemotas('repasses', reps);
        /* "sempre somar os saldos dos meses anteriores" (01/10/2026): o saldo acumulado precisa das
           NOTAS de todo ano em que ha repasse. Sem isto, num aparelho novo em janeiro o credito dos
           repasses do ano passado ficava sem os gastos do ano passado (so o ano atual vinha) e o
           saldo aparecia inflado. Como o sistema e de 2026, hoje isso e um ano so. */
        const anosComRepasse = [...new Set((reps || []).map(r => Number(r.ano)).filter(a => a >= 2000 && a < anoAtual))];
        for (const a of anosComRepasse) pulled += await garantirAno(sb, userId, a);
        /* e as notas PRÓPRIAS de anos anteriores mesmo sem repasse naquele ano (quem gastou e ainda não
           recebeu nada): sem elas o saldo anterior do Painel saía maior que o da Equipe e do PDF */
        const minhasAntigas = ((await sb.notas.list({ user_id: userId })) || []).filter(n => Number(n.ano) < anoAtual);
        pulled += await _mesclarRemotas('notas', minhasAntigas);
      } catch (_) { return pulled; }   // sem last_sync gravado: tenta de novo no próximo
    } else {
      let falhou = false;
      for (const table of ['notas', 'repasses']) {
        try {
          const data = await (table === 'notas' ? sb.notas : sb.repasses).list({ since });
          pulled += await _mesclarRemotas(table, data);
        } catch (_) { falhou = true; }
      }
      /* As lápides (25/09/2026): nota apagada em definitivo sai da tabela, e
         a consulta por updated_at nunca mais a mostra — sem isto, a cópia
         deste aparelho ficava para sempre, aparecendo em pendências. */
      try { await _limparApagadas(sb, since); } catch (_) {}
      /* falhou alguma lista (timeout, 5xx, sinal ruim): NÃO avança a marca,
         para tentar a mesma janela de novo no próximo sync. */
      if (falhou) return pulled;
      try { pulled += await _revisaoCompleta(sb); } catch (_) {}
    }

    await setMeta('last_sync', marca);
    return pulled;
  }

  /* Notas de OUTROS colaboradores guardadas neste aparelho (gestor/admin
     recebem as da equipe no mesmo pull). Sem as apagadas. */
  async function getNotasEquipe(meuId) {
    const all = await _getAll('notas');
    return all.filter(n => n.user_id !== meuId && !n.deleted).map(n => _normalizeRecord(n));
  }

  /* Recupera notas que perderam o foto_path mas cujo arquivo continua no
     disco do servidor. O caminho é determinístico (user_id/nota_id.ext),
     então o servidor lista a pasta do usuário e casa pelo id da nota
     (POST /notas/reparar-fotos). Só reconecta referência: não apaga nem
     sobe nada. */
  async function repararFotosOrfas(sb, userId) {
    if (!sb || !navigator.onLine || !userId) return 0;
    const orfas = (await _getAllByIdx('notas', 'user_id', userId))
      .filter(n => !n.deleted && !n.foto_path);
    if (!orfas.length) return 0;

    const r = await sb.notas.repararFotos();
    let recuperadas = 0;
    for (const { id, foto_path } of (r?.notas || [])) {
      const n = orfas.find(x => x.id === id);
      if (!n || !foto_path) continue;
      await _put('notas', { ...n, foto_path });
      recuperadas++;
    }
    return recuperadas;
  }

  /* Notas lidas por QR antes da v59 têm a URL real só em meta ('qr_<chave>'),
     neste aparelho — o servidor ficou sem qr_url e o 🔗 delas caía no portal
     nacional, que não mostra NFC-e. Reenfileira cada uma com a URL achada;
     roda a cada sync, mas só toca nas que ainda estão sem. */
  async function repararQrUrls(userId) {
    const minhas = await _getAllByIdx('notas', 'user_id', userId).catch(() => []);
    let n = 0;
    for (const nota of minhas) {
      if (nota.deleted || nota.qr_url) continue;
      const chave = String(nota.chave_nfce || '').replace(/\D/g, '');
      if (chave.length !== 44) continue;
      const url = await getMeta('qr_' + chave).catch(() => null);
      if (!url || !/^https?:\/\//i.test(url)) continue;
      await saveNota({ ...nota, qr_url: url }, userId);
      n++;
    }
    if (n) console.info(`[qr] ${n} nota(s) reenviada(s) com a URL do QR guardada neste aparelho`);
    return n;
  }

  /* Uma rodada: sobe o que está na fila e (se não for "leve") baixa novidades e repara anexos órfãos.
     A rodada LEVE é a do reenvio rápido: só envia, sem puxar tudo do servidor a cada 3 s. */
  async function _rodada(sb, userId, leve) {
    if (!leve) { try { await repararQrUrls(userId); } catch (_) {} }
    /* o envio é um só por vez ENTRE contextos: se o service worker está enviando em segundo plano, a página espera a
       vez (_esperaTravaMs: 8 s; 30 s no "Enviar agora") em vez de mandar a mesma fila em dobro; sem a vez, pula o envio
       desta rodada (resultado traz ocupado: true) e segue com o resto */
    const env = await _comTravaDeEnvio(travado => pushPending(sb, userId, { travado }), _esperaTravaMs);
    const push = env.ocupado ? { ok: 0, fail: 0, fotosOk: 0, fotosFail: 0, erroFoto: null, ocupado: true } : env.valor;
    if (leve) {
      const rl = { ...push, pulled: 0, recuperadas: 0 };
      if (push.ok || push.fotosOk) window.dispatchEvent(new CustomEvent('db-synced', { detail: rl }));
      return rl;
    }
    const pulled = await pullIncremental(sb, userId);
    let recuperadas = 0;
    try { recuperadas = await repararFotosOrfas(sb, userId); } catch (_) {}
    const result = { ...push, pulled, recuperadas };
    window.dispatchEvent(new CustomEvent('db-synced', { detail: result }));
    return result;
  }

  /* 11/10/2026 — envio das notas que ficava "pendente" no celular. Antes: um pedido de sync feito enquanto outra
     rodada já rodava era DESCARTADO (a nota recém-salva esperava até 60 s pelo próximo ciclo). Agora ele vira uma
     rodada a mais, logo em seguida. Devolve null nesse caso, como sempre (quem precisa esperar: aguardarSync()).
     Devolve undefined (não null) se a conta que pediu já não é a que está logada: nada é enviado. */
  async function sync(sb, userId, leve) {
    if (userId && !_contaViva(userId)) return undefined;
    if (userId) _sessaoUid = userId;
    if (_running) {
      _novaRodada = { sb, userId: userId || _sessaoUid, leve: !!leve && (_novaRodada ? _novaRodada.leve : true) };
      return null;
    }
    _running = true;
    _ultimoInicio = Date.now();
    _loopAtual = (async () => {
      let caiu = false;
      try {
        let result = await _rodada(sb, userId, leve);
        for (let voltas = 0; _novaRodada && voltas < 3; voltas++) {
          const p = _novaRodada; _novaRodada = null;
          if (!_contaViva(p.userId || userId)) break;      // quem pediu saiu ou trocou de conta: o que é dele espera ele voltar
          if (p.userId) _sessaoUid = p.userId;
          result = await _rodada(p.sb || sb, p.userId || userId, p.leve);
        }
        return result;
      } catch (e) {
        caiu = true; throw e;
      } finally {
        _running = false; _loopAtual = null; _novaRodada = null;
        if (!caiu) _reagendarReenvio(sb);                   // rodada que estourou não gera laço de reenvio
      }
    })();
    return _loopAtual;
  }
  const aguardarSync = () => _loopAtual || Promise.resolve(null);

  /* Sobrou coisa na fila (rede fraca, servidor ocupado)? Tenta de novo logo — 3 a 20 s — em vez de esperar o ciclo de
     60 s, que nem corre com o app em segundo plano. Só enquanto nada tiver "falhado" de vez, no máximo 4 vezes seguidas
     (depois disso valem o ciclo de 60 s, os gatilhos e o botão) e só para a conta que está logada AGORA. */
  async function _reagendarReenvio(sb) {
    if (_timerReenvio) { clearTimeout(_timerReenvio); _timerReenvio = null; }
    const uid = _uidVivo ? _uidVivo() : _sessaoUid;
    if (!sb || !uid || uid !== _sessaoUid || !navigator.onLine) return;
    let r; try { r = await getSyncQueueSummary(); } catch (_) { return; }
    if (!r.count) { _rapidosSeguidos = 0; return; }
    if (r.failedCount > 0 || _rapidosSeguidos >= 4) return;
    const espera = r.nextAttemptAt ? r.nextAttemptAt - Date.now() : 0;
    if (espera > 30_000) return;
    const ms = Math.min(20_000, Math.max(3_000, espera + 500));
    _timerReenvio = setTimeout(() => {
      _timerReenvio = null;
      const u = _uidVivo ? _uidVivo() : _sessaoUid;
      if (u && u === _sessaoUid && navigator.onLine && !document.hidden) { _rapidosSeguidos++; sync(sb, u, true).catch(() => {}); }
    }, ms);
  }

  /* Voltou para o app, a rede mudou ou voltou: a espera CURTA (até 2 min) deixa de valer — o motivo da falha pode ter
     passado, inclusive em item que já tinha virado "falhou" por rede. Recusa do servidor (espera de 30 min) não é
     tocada: só o botão "Enviar agora" libera. Grava sobre o item ATUAL (_mutarFila). */
  async function _liberarEsperaCurta(userId) {
    const iso = new Date().toISOString();
    const curta = it => {
      if (!it || it.status === 'running' || !it.next_attempt_at) return false;
      const falta = new Date(it.next_attempt_at).getTime() - Date.now();
      return falta > 0 && falta <= 120_000;
    };
    for (const i of await _getAll('sync_queue')) {
      if (!curta(i)) continue;
      if (userId && !(await _itemEhDaSessao(i, userId))) continue;
      await _mutarFila(i.id, cur => (curta(cur) ? { ...cur, next_attempt_at: iso } : null));
    }
  }

  /* "Enviar agora": zera a espera e as tentativas de TUDO que esta conta tem na fila (inclusive o que já tinha
     virado "falhou") e envia já, esperando terminar. Devolve quantos itens havia, quantos restam e o 1º motivo. */
  async function forcarEnvio(sb, userId) {
    if (userId && !_contaViva(userId)) return { tinha: 0, restam: 0, falharam: 0, motivo: null };
    if (userId) _sessaoUid = userId;
    const meuId = userId || _sessaoUid;
    _rapidosSeguidos = 0;
    /* a rodada em voo ainda vai gravar os itens que já leu (tentativas e espera antigas): zerar antes disso não vale */
    while (_running) await aguardarSync().catch(() => {});
    const agora = new Date().toISOString();
    /* conta ANTES de esperar a trava: se o service worker esvaziar a fila enquanto esperamos, o aviso diz
       "tudo enviado" em vez de "nada pendente" (revisão de 14/10/2026) */
    let tinhaAntes = 0;
    for (const i of await _getAll('sync_queue')) { if (!meuId || await _itemEhDaSessao(i, meuId)) tinhaAntes++; }
    let tinha = 0;
    const zerar = async () => {
      tinha = 0;
      for (const i of await _getAll('sync_queue')) {
        if (meuId && !(await _itemEhDaSessao(i, meuId))) continue;
        tinha++;
        await _mutarFila(i.id, cur => ({ ...cur, attempts: 0, contada_em: null, status: 'pending', next_attempt_at: agora, updated_at: agora }));
        const store = i.entity === 'repass' ? 'repasses' : i.entity === 'nota' ? 'notas' : null;
        if (store) {
          const loc = await _get(store, i.entity_id).catch(() => null);
          if (loc && loc.sync_status === 'failed') await _put(store, { ...loc, synced: false, sync_status: 'pending', sync_error: null });
        }
      }
    };
    /* o reset roda COM a trava de envio: um envio em voo no service worker (ou em outra aba) gravaria o resultado dele
       por cima do zero. Sem conseguir a vez em 30 s, zera assim mesmo (como antes). */
    if ((await _comTravaDeEnvio(zerar, 30_000)).ocupado) await zerar();
    /* sync() devolve null quando outra rodada ocupa o lugar (um gatilho pode ter começado uma no meio): espera e tenta de novo */
    const esperaAntes = _esperaTravaMs;
    _esperaTravaMs = 30_000;
    let ocupado = false;
    try {
      for (let k = 0; k < 4; k++) {
        const r = await sync(sb, meuId);
        if (r !== null) { ocupado = !!(r && r.ocupado); break; }
        await aguardarSync().catch(() => {});
      }
    } finally { _esperaTravaMs = esperaAntes; }
    const resumo = await getSyncQueueSummary();
    let motivo = null;
    for (const i of await _getAll('sync_queue')) {
      if (i.last_error && (!meuId || await _itemEhDaSessao(i, meuId))) { motivo = i.last_error; break; }
    }
    return { tinha: Math.max(tinha, tinhaAntes), restam: resumo.count, falharam: resumo.failedCount, motivo, ocupado };
  }

  /* ── ENVIO EM SEGUNDO PLANO (fase 2, 12/10/2026) ──────────────────────────────────────────────────────────────
     Chrome/Edge no Android: o navegador acorda o service worker (evento "sync") quando a rede volta — com o app
     FECHADO — e ele manda a fila. iPhone/Safari e Firefox não têm Background Sync: lá tudo isto é no-op e o envio
     continua pela página (builds 379+). O service worker carrega este arquivo e o api.js (importScripts): a lógica de
     envio é a MESMA da página (pushPending), com o mesmo cliente da API.
       • sessão — o SW não lê o localStorage: o par token+uid da conta logada é espelhado no IndexedDB (meta
         'sessao_fundo') pelo api.js e apagado no logout/401. Só sobe o que ESSA conta pôs na fila; sem espelho o SW
         não envia nada. O token fica no mesmo domínio do localStorage (mesma exposição).
       • trava — Web Locks 'petermann-envio': página e SW nunca enviam ao mesmo tempo (nem duas abas). */
  const TRAVA_ENVIO = 'petermann-envio';
  const TAG_ENVIO_FUNDO = 'petermann-envio';
  let _esperaTravaMs = 8_000;         // quanto a PÁGINA espera pela vez de enviar (o "Enviar agora" sobe isto para 30 s)
  const _dorme = ms => new Promise(r => setTimeout(r, ms));

  /* Roda fn(travado) com a trava de envio. Espera a vez por até esperaMs; se não vier, devolve { ocupado: true } sem
     rodar fn. travado = true quando a trava foi obtida (nenhum outro contexto envia: "running" na fila é órfão);
     sem Web Locks no navegador roda direto, com travado = false (vale a regra velha dos 30 s). */
  async function _comTravaDeEnvio(fn, esperaMs) {
    const locks = globalThis.navigator?.locks;
    if (!locks?.request) return { ocupado: false, valor: await fn(false) };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), esperaMs);
    let dentro = false;
    try {
      return await locks.request(TRAVA_ENVIO, { signal: ctrl.signal }, async () => {
        dentro = true; clearTimeout(t);
        return { ocupado: false, valor: await fn(true) };
      });
    } catch (e) {
      if (!dentro && e && e.name === 'AbortError') return { ocupado: true, valor: null };   // esgotou a espera pela vez
      /* a trava falhou por outro motivo ANTES de fn rodar (navegador recusou, modo restrito...): FALHA SEGURA — envia sem
         ela, como no build 379. Nunca derrubar o envio da página por causa de um recurso novo (iPhone passa por aqui). */
      if (!dentro) { console.warn('[envio] trava indisponível, enviando sem ela:', e); return { ocupado: false, valor: await fn(false) }; }
      throw e;
    } finally { clearTimeout(t); }
  }

  let _fundoUid = null;               // no service worker: a conta que está enviando AGORA (null = sessão encerrada)
  let _espelhoFila = Promise.resolve();   // grava/apaga o espelho NA ORDEM em que foi pedido

  /* Chamado pelo api.js a cada mudança de sessão. token+uid completos → grava; qualquer outra coisa → apaga e avisa o
     service worker, que para de enviar no meio do ciclo (logout/troca de conta/401). */
  /* Apaga o espelho SÓ se ele ainda guarda este token (leitura e exclusão na mesma transação): o 401 de um envio em
     segundo plano com o token VELHO não pode apagar o espelho da conta que acabou de entrar na página. */
  const _apagarEspelhoSe = tk => _tx(['meta'], 'readwrite', (t, res, rej) => {
    const s = t.objectStore('meta');
    const g = s.get('sessao_fundo');
    g.onerror = e => rej(e.target.error);
    g.onsuccess = () => {
      if (!(g.result && g.result.v && g.result.v.token === tk)) { res(false); return; }
      const d = s.delete('sessao_fundo');
      d.onsuccess = () => res(true);
      d.onerror = e => rej(e.target.error);
    };
  });

  function espelharSessao(token, uid, tokenAnterior) {
    const completo = !!(token && uid);
    if (!completo) {
      _fundoUid = null;
      try { globalThis.navigator?.serviceWorker?.controller?.postMessage({ tipo: 'sessao-encerrada' }); } catch (_) {}
    }
    /* no service worker (sem document) a ordem de apagar vem de um 401: só vale para o token que levou o 401 */
    const noWorker = typeof document === 'undefined';
    const op = () => (completo
      ? _put('meta', { k: 'sessao_fundo', v: { token, uid, em: new Date().toISOString() } })
      : (noWorker && tokenAnterior ? _apagarEspelhoSe(tokenAnterior) : _del('meta', 'sessao_fundo'))).catch(() => {});
    _espelhoFila = _espelhoFila.then(op, op);
    return _espelhoFila;
  }
  const encerrarSessaoFundo = () => { _fundoUid = null; };

  /* Pede ao navegador um evento "sync" (envio em segundo plano). Com internet ele dispara já; sem, dispara quando a
     rede voltar — inclusive com o app fechado. Mesma tag = um pedido só. `forcar` ignora o intervalo mínimo de 1,5 s
     entre pedidos (chamado ao sair do app). Nunca lança. */
  let _regFundoTimer = null;
  async function _registrarAgora() {
    try {
      const reg = await Promise.race([navigator.serviceWorker.ready, _dorme(4000).then(() => { throw new Error('sem service worker'); })]);
      await reg.sync.register(TAG_ENVIO_FUNDO);
      return true;
    } catch (_) { return false; }     // sem suporte/permissão: o envio pela página continua valendo
  }
  /* Sem forçar, o pedido espera 2 s e vira um só: a nota entra na fila ANTES do anexo (saveNota e depois saveFotoLocal),
     e um service worker acordado entre os dois mandaria a nota sem o arquivo (422 à toa). */
  function registrarEnvioFundo(forcar) {
    try {
      if (!('serviceWorker' in globalThis.navigator) || !('SyncManager' in globalThis)) return Promise.resolve(false);
      if (forcar) {
        if (_regFundoTimer) { clearTimeout(_regFundoTimer); _regFundoTimer = null; }
        return _registrarAgora();
      }
      if (!_regFundoTimer) _regFundoTimer = setTimeout(() => { _regFundoTimer = null; _registrarAgora(); }, 2000);
      return Promise.resolve(true);
    } catch (_) { return Promise.resolve(false); }
  }

  /* Corpo do evento "sync" do service worker: manda a fila da conta espelhada. Dois pedidos juntos viram um só.
     Devolve { ok, fail, fotosOk, fotosFail, restam, repetir, motivo } — repetir = sobrou coisa que vale tentar de novo
     (o SW rejeita o evento e o navegador reagenda). Tempo: o SW tem ~5 min por evento; não começa item novo depois de
     prazoMs (padrão 150 s) e um upload leva no máximo 120 s. */
  let _fundoEmVoo = null;
  function enviarEmFundo(opts) {
    if (!_fundoEmVoo) _fundoEmVoo = _enviarEmFundo(opts || {}).finally(() => { _fundoEmVoo = null; });
    return _fundoEmVoo;
  }

  async function _enviarEmFundo({ prazoMs = 150_000, esperaTravaMs = 30_000 }) {
    const r = { ok: 0, fail: 0, fotosOk: 0, fotosFail: 0, restam: 0, repetir: false, motivo: null };
    /* o orçamento do evento (~5 min no Chrome) conta desde AGORA, inclusive a espera pela trava: prazoMs 150 s + um
       upload de até 120 s + espera pela trava de 30 s cabem com folga */
    const ate = Date.now() + prazoMs;
    for (let volta = 0; volta < 3 && Date.now() < ate; volta++) {
      let parar = false, esperar = 0;
      /* UMA volta por vez COM a trava; a espera entre voltas é feita FORA dela, para a página poder enviar nesse meio tempo */
      const env = await _comTravaDeEnvio(async travado => {
        /* a sessão é lida DEPOIS de conseguir a vez: se a conta mudou enquanto esperava, vale a de agora */
        const reg = await _get('meta', 'sessao_fundo').catch(() => null);
        const s = reg && reg.v;
        if (!s || !s.token || !s.uid) { r.motivo = 'sem-sessao'; r.repetir = false; parar = true; return; }
        const api = globalThis.API;
        if (!api?.auth?.usarToken) { r.motivo = 'sem-api'; parar = true; return; }
        _fundoUid = s.uid; _uidVivo = () => _fundoUid; _sessaoUid = s.uid;
        api.auth.usarToken(s.token);
        const p = await pushPending(api, s.uid, { travado, ate });
        r.ok += p.ok; r.fail += p.fail; r.fotosOk += p.fotosOk; r.fotosFail += p.fotosFail;
        if (!_fundoUid) { r.motivo = 'sessao-encerrada'; r.repetir = false; parar = true; return; }   // logout/troca de conta/401 no meio
        const sum = await getSyncQueueSummary();
        r.restam = sum.count;
        const pend = sum.count - sum.failedCount;
        /* o próximo envio conta só entre os itens que serão tentados: um item "falhou" (30 min de espera) não pode
           fazer o worker desistir de itens vencidos que sobraram (revisão de 14/10/2026) */
        r.repetir = pend > 0 && (!sum.proximaAtivaAt || sum.proximaAtivaAt - Date.now() <= 120_000);
        if (pend <= 0) { parar = true; return; }                          // nada mais para enviar
        const espera = sum.proximaAtivaAt ? sum.proximaAtivaAt - Date.now() : 0;
        const fez = p.ok || p.fail || p.fotosOk || p.fotosFail;
        if (espera > 45_000 || (!fez && espera <= 0)) { parar = true; return; }
        esperar = Math.max(0, espera);
      }, esperaTravaMs);
      if (env.ocupado) { r.motivo = 'ocupado'; r.repetir = true; return r; }
      if (parar || volta >= 2 || Date.now() + esperar >= ate) break;      // sem tempo (ou última volta): não dorme à toa
      if (esperar > 0) await _dorme(esperar + 300);                       // espera curta de nova tentativa
    }
    return r;
  }

  /* Gatilhos automáticos. Instala os ouvintes UMA vez (cada login chama de novo: só atualiza sb e getUid). */
  function setupAutoSync(sb, getUid) {
    _uidVivo = getUid;
    /* espelha a sessão para o envio em segundo plano (quem já estava logado antes desta versão ganha o espelho aqui) */
    try {
      const tk = sb?.auth?.token, ue = sb?.auth?.user?.id;
      if (tk && ue && ue === getUid()) espelharSessao(tk, ue);
    } catch (_) {}
    if (_auto) { _auto.sb = sb; _auto.getUid = getUid; return; }
    _auto = { sb, getUid };
    /* Dispara uma rodada agora. Em rajada (foco + visibilidade + rede ao mesmo tempo) só a primeira conta: o carimbo
       é gravado ANTES de qualquer await. */
    const disparar = (livre) => {
      const uid = _auto.getUid();
      if (!uid || !navigator.onLine) return;
      if (!livre && Date.now() - Math.max(_ultimoInicio, _ultimoDisparo) < 3000) return;
      _ultimoDisparo = Date.now();
      _rapidosSeguidos = 0;
      _liberarEsperaCurta(uid).catch(() => {}).then(() => sync(_auto.sb, uid)).catch(() => {});
    };
    window.addEventListener('online', () => disparar(true));
    /* 11/10/2026: voltar para o app (da câmera, de outro app, do bloqueio de tela) envia na hora — antes só o relógio
       de 60 s, que o celular pausa com o app em segundo plano. */
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { disparar(false); return; }
      /* saiu do app (bloqueou a tela, trocou de app) com coisa na fila: entrega ao service worker, que segue enviando
         mesmo que o navegador congele ou feche esta página (só onde há Background Sync) */
      getSyncQueueSummary().then(r => { if (r.count - r.failedCount > 0) registrarEnvioFundo(true); }).catch(() => {});
    });
    /* o service worker terminou um envio em segundo plano: atualiza as telas como depois de qualquer sincronização */
    try {
      navigator.serviceWorker?.addEventListener('message', e => {
        const d = e.data;
        if (!d || d.tipo !== 'envio-fundo' || !(d.ok || d.fotosOk)) return;
        window.dispatchEvent(new CustomEvent('db-synced', { detail: { ok: d.ok || 0, fail: d.fail || 0, fotosOk: d.fotosOk || 0, fotosFail: d.fotosFail || 0, erroFoto: null, pulled: 0, recuperadas: 0, doFundo: true } }));
      });
    } catch (_) {}
    window.addEventListener('pageshow', e => { if (e.persisted) disparar(false); });
    window.addEventListener('focus', () => disparar(false));
    try { navigator.connection?.addEventListener?.('change', () => disparar(false)); } catch (_) {}
    setInterval(() => disparar(true), 60_000);
  }

  return {
    open,
    saveNota, getNotasUser, softDeleteNota, getDeletedNotasUser, restoreNota,
    purgeNotaLocal, limparDaLixeira, purgeNotasDeUsuario,
    saveFotoLocal, getFotoLocal, repararFotosLocais, repararFotosOrfas, getFalhaSync, tentarDeNovo,
    saveRepasse, getRepassesUser, getRepassesTodos, softDeleteRepasse, mesclarRepassesRemotos,
    upsertFromDrive,
    sync, aguardarSync, forcarEnvio, setupAutoSync, getMeta, setMeta, getSyncQueueSummary, idsNaFila, repararQrUrls,
    espelharSessao, encerrarSessaoFundo, registrarEnvioFundo, enviarEmFundo,
    garantirAno, anosSincronizados, getNotasEquipe,
  };
})();
