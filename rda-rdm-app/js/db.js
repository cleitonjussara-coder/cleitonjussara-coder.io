'use strict';
/* ─────────────────────────────────────────────────────────────
   DB.js — IndexedDB offline-first + engine de sincronização
   Stores: notas | repasses | fotos | meta
───────────────────────────────────────────────────────────── */
window.DB = (() => {
  const DB_NAME = 'petermann_v1';
  const DB_VER  = 4;
  const MAX_SYNC_ATTEMPTS = 5;
  const SYNC_RETRY_MS = 2_000;
  let _db = null;

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
          // armazena blob local até o upload pro Supabase
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
      req.onsuccess = e => { _db = e.target.result; res(_db); };
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
    return {
      ...item,
      synced: typeof item.synced === 'boolean' ? item.synced : status !== 'synced',
      sync_status: status,
      sync_error: item.sync_error || null,
    };
  };

  const _queueOp = async (entry) => {
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
        updated_at: now,
      };
      await _put('sync_queue', merged);
      return merged;
    }

    await _put('sync_queue', item);
    return item;
  };

  const _retryDelayMs = attempts => Math.min(60_000, SYNC_RETRY_MS * 2 ** Math.max(0, attempts - 1));

  async function getSyncQueueSummary() {
    const queueItems = await _getAll('sync_queue');
    const now = Date.now();
    const pendingItems = queueItems.filter(item => item.status !== 'running');
    const failedItems = queueItems.filter(item => item.status === 'failed' || item.attempts >= MAX_SYNC_ATTEMPTS);
    const scheduledItems = pendingItems.filter(item => item.next_attempt_at && new Date(item.next_attempt_at).getTime() > now);
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
    };
  }

  /* ── Meta (last_sync, etc.) ──────────────────────────── */
  const getMeta = async (k, def = null) => { const r = await _get('meta', k); return r ? r.v : def; };
  const setMeta = (k, v) => _put('meta', { k, v });

  /* ── NOTAS ───────────────────────────────────────────── */
  async function saveNota(nota, userId) {
    const now = new Date().toISOString();
    const fotoLocal = nota.foto_local || null;
    const id = nota.id || crypto.randomUUID();
    const obj = {
      ...nota,                                        // spread primeiro
      id,
      user_id    : nota.user_id || userId,
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

  async function getDeletedNotasUser(userId) {
    const all = await _getAllByIdx('lancamentos_apagados', 'user_id', userId);
    return all.map(n => _normalizeRecord(n));
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
    const entry = { nota_id, blob, ext: (ext || 'jpg').toLowerCase() };
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
  async function upsertFromDrive(store, records, userId = null) {
    const incoming = (records || []).filter(rec => rec && rec.id);
    const incomingIds = new Set(incoming.map(rec => rec.id));
    const now = new Date().toISOString();

    for (const rec of incoming) {
      const local = await _get(store, rec.id);
      const remoteDeleted = rec.deleted === true || rec.deleted_at || rec._deleted === true;

      if (remoteDeleted) {
        if (local && !local.deleted) {
          await _put(store, {
            ...local,
            deleted: true,
            synced: true,
            sync_status: 'synced',
            sync_error: null,
            updated_at: now,
          });
        }
        continue;
      }

      if (!local || local.deleted || new Date(rec.updated_at || 0) >= new Date(local.updated_at || 0)) {
        await _put(store, {
          ...rec,
          synced: true,
          sync_status: 'synced',
          sync_error: null,
          foto_local: local?.foto_local ?? null,
        });
      }
    }

    const localAll = await _getAll(store);
    for (const item of localAll) {
      if (!item?.id) continue;
      if (userId && item.user_id !== userId) continue;
      if (item.deleted) continue;
      if (item.synced === false || item.sync_status === 'pending' || item.sync_status === 'failed' || item.sync_status === 'retrying') continue;
      if (incomingIds.has(item.id)) continue;
      await _put(store, {
        ...item,
        deleted: true,
        synced: true,
        sync_status: 'synced',
        sync_error: null,
        updated_at: now,
      });
    }
  }
 
  /* ── SYNC ────────────────────────────────────────────── */
  let _running = false;

  /* Vira true se o Supabase ainda não tem a coluna qr_url; volta a false a
     cada recarga do app, então a migração é detectada sem limpar nada. */
  let _semColunaQrUrl = false;
  const _ehErroQrUrl = e =>
    /qr_url/i.test(`${e?.message || ''} ${e?.details || ''} ${e?.hint || ''}`);

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
        await _queueOp({ entity: 'nota', entity_id: n.id, action: 'upsert', payload });
      }
    }
    const existingRep = new Set(queueItems.filter(i => i.entity === 'repass').map(i => i.entity_id));
    for (const r of allR.filter(x => x.synced === false || x.sync_status === 'pending' || x.sync_status === 'failed' || x.sync_status === 'retrying')) {
      if (!existingRep.has(r.id)) {
        const payload = { ...r };
        delete payload.synced;
        delete payload.sync_status;
        delete payload.sync_error;
        await _queueOp({ entity: 'repass', entity_id: r.id, action: 'upsert', payload });
      }
    }
    const existingFoto = new Set(queueItems.filter(i => i.entity === 'foto').map(i => i.entity_id));
    for (const f of allFotos) {
      if (!existingFoto.has(f.nota_id)) {
        await _queueOp({ entity: 'foto', entity_id: f.nota_id, action: 'upload', payload: f });
      }
    }
  }

  async function pushPending(sb) {
    if (!sb || !navigator.onLine) return { ok: 0, fail: 0, fotosOk: 0, fotosFail: 0, erroFoto: null };
    await _ensureQueueFromExisting();
    const queueItems = await _getAll('sync_queue');
    const now = Date.now();
    const dueItems = queueItems.filter(item => {
      const isDue = !item.next_attempt_at || new Date(item.next_attempt_at).getTime() <= now;
      if (item.status === 'running') {
        const updatedAt = item.updated_at ? new Date(item.updated_at).getTime() : 0;
        return isDue && now - updatedAt > 30_000;
      }
      return isDue;
    });
    let ok = 0, fail = 0;
    let fotosOk = 0, fotosFail = 0, erroFoto = null;
    const falhou = m => { fotosFail++; erroFoto = erroFoto || m; };

    for (const item of dueItems) {
      const now = new Date().toISOString();
      await _put('sync_queue', { ...item, status: 'running', updated_at: now });
      try {
        if (item.entity === 'foto') {
          const payload = item.payload || null;
          if (!payload?.blob) { await _del('sync_queue', item.id); continue; }
          const nota = await _get('notas', item.entity_id);
          if (!nota?.user_id) { await delFotoLocal(item.entity_id); await _del('sync_queue', item.id); continue; }
          const ext = (payload.ext || 'jpg').toLowerCase();
          const mime = MIME_POR_EXT[ext] || 'application/octet-stream';
          const path = `${nota.user_id}/${item.entity_id}.${ext}`;
          const { error } = await sb.storage.from('notas-fotos').upload(path, payload.blob, { contentType: mime, upsert: true });
          if (error) throw error;
          const { error: erroRef } = await sb.from('notas').update({ foto_path: path }).eq('id', item.entity_id);
          if (erroRef) throw erroRef;
          await _put('notas', { ...nota, foto_path: path, foto_local: ext, sync_error: null, updated_at: now });
          await delFotoLocal(item.entity_id);
          await _del('sync_queue', item.id);
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
        if (_semColunaQrUrl) delete payload.qr_url;

        let { error } = await sb.from(item.entity === 'nota' ? 'notas' : 'repasses').upsert(payload);
        if (error && _ehErroQrUrl(error)) {
          _semColunaQrUrl = true;
          delete payload.qr_url;
          ({ error } = await sb.from(item.entity === 'nota' ? 'notas' : 'repasses').upsert(payload));
        }
        if (!error) {
          if (item.entity === 'nota') {
            await _put('notas', { ...record, synced: true, sync_status: 'synced', sync_error: null, updated_at: now });
          } else {
            await _put('repasses', { ...record, synced: true, sync_status: 'synced', sync_error: null, updated_at: now });
          }
          await _del('sync_queue', item.id);
          ok++;
        } else {
          throw error;
        }
      } catch (e) {
        const message = e?.message || 'falha na sincronização';
        const attempts = (item.attempts || 0) + 1;
        const nextAttemptAt = new Date(Date.now() + _retryDelayMs(attempts)).toISOString();
        const nextStatus = attempts >= MAX_SYNC_ATTEMPTS ? 'failed' : 'pending';
        const updatedItem = { ...item, attempts, next_attempt_at: nextAttemptAt, status: nextStatus, last_error: message, updated_at: now };
        await _put('sync_queue', updatedItem);
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

  async function pullIncremental(sb, userId) {
    if (!sb || !navigator.onLine || !userId) return 0;
    const since = await getMeta('last_sync', '1970-01-01T00:00:00Z');
    let pulled = 0;

    for (const table of ['notas', 'repasses']) {
      try {
        const { data } = await sb.from(table).select('*').gte('updated_at', since);
        if (!data) continue;
        for (const row of data) {
          const local = await _get(table, row.id);
          // remoto vence se local já está sincronizado (ou não existe)
          if (!local || local.synced || new Date(row.updated_at) >= new Date(local.updated_at)) {
            const merge = { ...row, synced: true, foto_local: local?.foto_local || null };
            /* foto_path é a exceção ao "remoto vence": o app nunca remove
               anexo (ele é obrigatório), então null do servidor não é uma
               remoção intencional — é a linha que ficou para trás. Deixar
               sobrescrever apagava a referência de uma foto que está no
               Storage, e a nota ficava sem imagem para sempre. */
            if (table === 'notas' && !row.foto_path && local?.foto_path) {
              merge.foto_path = local.foto_path;
            }
            await _put(table, merge);
            pulled++;
          }
        }
      } catch (_) {}
    }

    await setMeta('last_sync', new Date().toISOString());
    return pulled;
  }

  /* Recupera notas que perderam o foto_path mas cujo arquivo continua no
     Storage — o estrago que o update não checado (corrigido acima) já fez.
     O caminho é determinístico (user_id/nota_id.ext), então basta listar a
     pasta do usuário e casar pelo id da nota. Só reconecta referência: não
     apaga nem sobe nada. */
  async function repararFotosOrfas(sb, userId) {
    if (!sb || !navigator.onLine || !userId) return 0;
    const orfas = (await _getAllByIdx('notas', 'user_id', userId))
      .filter(n => !n.deleted && !n.foto_path);
    if (!orfas.length) return 0;

    const { data: arquivos, error } = await sb.storage.from('notas-fotos')
      .list(userId, { limit: 1000 });
    if (error || !arquivos?.length) return 0;

    const porId = new Map();
    arquivos.forEach(a => porId.set(String(a.name).replace(/\.[^.]+$/, ''), a.name));

    let recuperadas = 0;
    for (const n of orfas) {
      const arq = porId.get(n.id);
      if (!arq) continue;
      const path = `${userId}/${arq}`;
      const { error: e } = await sb.from('notas').update({ foto_path: path }).eq('id', n.id);
      if (e) continue;
      await _put('notas', { ...n, foto_path: path });
      recuperadas++;
    }
    return recuperadas;
  }

  async function sync(sb, userId) {
    if (_running) return null;
    _running = true;
    try {
      const push   = await pushPending(sb);
      const pulled = await pullIncremental(sb, userId);
      let recuperadas = 0;
      try { recuperadas = await repararFotosOrfas(sb, userId); } catch (_) {}
      const result = { ...push, pulled, recuperadas };
      window.dispatchEvent(new CustomEvent('db-synced', { detail: result }));
      return result;
    } finally {
      _running = false;
    }
  }

  function setupAutoSync(sb, getUid) {
    window.addEventListener('online', () => {
      const uid = getUid();
      if (uid) sync(sb, uid);
    });
    setInterval(() => {
      const uid = getUid();
      if (uid && navigator.onLine) sync(sb, uid);
    }, 60_000);
  }

  return {
    open,
    saveNota, getNotasUser, softDeleteNota, getDeletedNotasUser, restoreNota,
    saveFotoLocal, getFotoLocal, repararFotosLocais, repararFotosOrfas,
    saveRepasse, getRepassesUser, softDeleteRepasse,
    upsertFromDrive,
    sync, setupAutoSync, getMeta, setMeta, getSyncQueueSummary,
  };
})();
