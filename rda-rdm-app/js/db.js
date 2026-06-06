'use strict';
/* ─────────────────────────────────────────────────────────────
   DB.js — IndexedDB offline-first + engine de sincronização
   Stores: notas | repasses | fotos | meta
───────────────────────────────────────────────────────────── */
window.DB = (() => {
  const DB_NAME = 'petermann_v1';
  const DB_VER  = 2;
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

  /* ── Meta (last_sync, etc.) ──────────────────────────── */
  const getMeta = async (k, def = null) => { const r = await _get('meta', k); return r ? r.v : def; };
  const setMeta = (k, v) => _put('meta', { k, v });

  /* ── NOTAS ───────────────────────────────────────────── */
  async function saveNota(nota, userId) {
    const now = new Date().toISOString();
    const fotoLocal = nota.foto_local || null;
    const obj = {
      ...nota,                                        // spread primeiro
      id         : nota.id || crypto.randomUUID(),   // sobrescreve id undefined
      user_id    : nota.user_id || userId,
      created_at : nota.created_at || now,
      updated_at : now,
      synced     : false,
      deleted    : nota.deleted || false,
    };
    delete obj.foto_local; // não sobe pro Supabase
    await _put('notas', { ...obj, foto_local: fotoLocal });
    return obj;
  }

  async function getNotasUser(userId) {
    const all = await _getAllByIdx('notas', 'user_id', userId);
    return all.filter(n => !n.deleted);
  }

  async function softDeleteNota(id) {
    const n = await _get('notas', id);
    if (n) await _put('notas', { ...n, deleted: true, synced: false, updated_at: new Date().toISOString() });
  }

  /* ── FOTOS (blob local) ───────────────────────────────── */
  const saveFotoLocal  = (nota_id, blob) => _put('fotos', { nota_id, blob });
  const getFotoLocal   = (nota_id) => _get('fotos', nota_id);
  const delFotoLocal   = (nota_id) => _del('fotos', nota_id);

  /* ── REPASSES ────────────────────────────────────────── */
  async function saveRepasse(rep, userId) {
    const now = new Date().toISOString();
    const obj = {
      ...rep,                                        // spread primeiro
      id         : rep.id || crypto.randomUUID(),   // sobrescreve id undefined
      user_id    : rep.user_id || userId,
      created_at : rep.created_at || now,
      updated_at : now,
      synced     : false,
      deleted    : rep.deleted || false,
    };
    await _put('repasses', obj);
    return obj;
  }

  async function getRepassesUser(userId) {
    const all = await _getAllByIdx('repasses', 'user_id', userId);
    return all.filter(r => !r.deleted);
  }

  async function softDeleteRepasse(id) {
    const r = await _get('repasses', id);
    if (r) await _put('repasses', { ...r, deleted: true, synced: false, updated_at: new Date().toISOString() });
  }

  /* ── Merge dados vindos do Drive (Drive vence se mais recente) */
  async function upsertFromDrive(store, records) {
    for (const rec of (records || [])) {
      if (!rec.id) continue;
      const local = await _get(store, rec.id);
      if (!local || new Date(rec.updated_at || 0) >= new Date(local.updated_at || 0)) {
        await _put(store, { ...rec, synced: true, foto_local: local?.foto_local ?? null });
      }
    }
  }

  /* ── SYNC ────────────────────────────────────────────── */
  let _running = false;

  async function pushPending(sb) {
    if (!sb || !navigator.onLine) return { ok: 0, fail: 0 };
    const [allN, allR] = await Promise.all([_getAll('notas'), _getAll('repasses')]);
    let ok = 0, fail = 0;

    // Notas
    for (const n of allN.filter(x => !x.synced)) {
      const payload = { ...n };
      delete payload.foto_local; // não sobe o blob
      delete payload.synced;     // coluna só existe localmente (IndexedDB)
      try {
        const { error } = await sb.from('notas').upsert(payload);
        if (!error) { await _put('notas', { ...n, synced: true }); ok++; }
        else fail++;
      } catch (_) { fail++; }
    }

    // Fotos pendentes
    const pendingFotos = await _getAll('fotos');
    for (const f of pendingFotos) {
      try {
        const path = `${(await _get('notas', f.nota_id))?.user_id}/${f.nota_id}.jpg`;
        const { error } = await sb.storage.from('notas-fotos').upload(path, f.blob,
          { contentType: 'image/jpeg', upsert: true });
        if (!error) {
          await sb.from('notas').update({ foto_path: path }).eq('id', f.nota_id);
          await delFotoLocal(f.nota_id);
        }
      } catch (_) {}
    }

    // Repasses
    for (const r of allR.filter(x => !x.synced)) {
      const payload = { ...r };
      delete payload.synced;     // coluna só existe localmente (IndexedDB)
      try {
        const { error } = await sb.from('repasses').upsert(payload);
        if (!error) { await _put('repasses', { ...r, synced: true }); ok++; }
        else fail++;
      } catch (_) { fail++; }
    }

    return { ok, fail };
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
            await _put(table, { ...row, synced: true, foto_local: local?.foto_local || null });
            pulled++;
          }
        }
      } catch (_) {}
    }

    await setMeta('last_sync', new Date().toISOString());
    return pulled;
  }

  async function sync(sb, userId) {
    if (_running) return null;
    _running = true;
    try {
      const push   = await pushPending(sb);
      const pulled = await pullIncremental(sb, userId);
      const result = { ...push, pulled };
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
    saveNota, getNotasUser, softDeleteNota,
    saveFotoLocal, getFotoLocal,
    saveRepasse, getRepassesUser, softDeleteRepasse,
    upsertFromDrive,
    sync, setupAutoSync, getMeta, setMeta,
  };
})();
