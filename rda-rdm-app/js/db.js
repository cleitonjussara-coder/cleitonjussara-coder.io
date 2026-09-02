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

  /* ── ANEXOS / FOTOS (blob local: foto, PDF ou XML) ────── */
  const MIME_POR_EXT = {
    jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp',
    heic:'image/heic', gif:'image/gif', pdf:'application/pdf', xml:'text/xml',
  };
  const saveFotoLocal  = (nota_id, blob, ext) => _put('fotos', { nota_id, blob, ext: (ext || 'jpg').toLowerCase() });
  const getFotoLocal   = (nota_id) => _get('fotos', nota_id);
  const delFotoLocal   = (nota_id) => _del('fotos', nota_id);

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

  /* Vira true se o Supabase ainda não tem a coluna qr_url; volta a false a
     cada recarga do app, então a migração é detectada sem limpar nada. */
  let _semColunaQrUrl = false;
  const _ehErroQrUrl = e =>
    /qr_url/i.test(`${e?.message || ''} ${e?.details || ''} ${e?.hint || ''}`);

  async function pushPending(sb) {
    if (!sb || !navigator.onLine) return { ok: 0, fail: 0, fotosOk: 0, fotosFail: 0, erroFoto: null };
    const [allN, allR] = await Promise.all([_getAll('notas'), _getAll('repasses')]);
    let ok = 0, fail = 0;

    // Notas
    for (const n of allN.filter(x => !x.synced)) {
      const payload = { ...n };
      delete payload.foto_local; // não sobe o blob
      delete payload.synced;     // coluna só existe localmente (IndexedDB)
      if (_semColunaQrUrl) delete payload.qr_url;
      try {
        let { error } = await sb.from('notas').upsert(payload);
        /* qr_url é coluna nova (v59). Enquanto o `alter table` não roda no
           Supabase, o PostgREST recusa o registro inteiro por causa dela e o
           sync parava de subir QUALQUER nota. Detecta, marca e repete sem a
           coluna — quando a migração rodar, volta a subir sozinho. */
        if (error && _ehErroQrUrl(error)) {
          _semColunaQrUrl = true;
          delete payload.qr_url;
          ({ error } = await sb.from('notas').upsert(payload));
        }
        if (!error) { await _put('notas', { ...n, synced: true }); ok++; }
        else fail++;
      } catch (_) { fail++; }
    }

    // Anexos pendentes (foto, PDF ou XML)
    let fotosOk = 0, fotosFail = 0, erroFoto = null;
    const falhou = m => { fotosFail++; erroFoto = erroFoto || m; };

    for (const f of await _getAll('fotos')) {
      try {
        const nota = await _get('notas', f.nota_id);
        // Sem a nota não há para quem o anexo pertencer — antes isso montava
        // um caminho "undefined/…" e subia lixo para o bucket a cada sync.
        if (!nota?.user_id) { await delFotoLocal(f.nota_id); continue; }

        const ext  = (f.ext || 'jpg').toLowerCase();
        const mime = MIME_POR_EXT[ext] || 'application/octet-stream';
        const path = `${nota.user_id}/${f.nota_id}.${ext}`;

        const { error } = await sb.storage.from('notas-fotos').upload(path, f.blob,
          { contentType: mime, upsert: true });
        if (error) { falhou(error.message); continue; }

        /* O erro deste update PRECISA ser checado. Sem isso, quando ele
           falhava (RLS, queda de rede, linha ainda não inserida) o código
           seguia em frente, apagava o blob local e o servidor ficava sem
           foto_path — no pull seguinte o null do servidor sobrescrevia o
           caminho local e a foto sumia de vez, mesmo estando no Storage.
           Falhando aqui, o blob fica e a próxima sync tenta de novo. */
        const { error: erroRef } = await sb.from('notas')
          .update({ foto_path: path }).eq('id', f.nota_id);
        if (erroRef) { falhou(erroRef.message); continue; }

        // grava o caminho TAMBÉM no registro local: sem isso a nota ficava sem
        // foto_path até o próximo pull, o 📎 desaparecia da lista e o painel
        // contava a nota como "sem anexo" mesmo com a foto já no servidor.
        await _put('notas', { ...nota, foto_path: path, foto_local: ext });
        await delFotoLocal(f.nota_id);
        fotosOk++;
      } catch (e) { falhou(e?.message || 'falha ao enviar o anexo'); }
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

  /* Conta o que ainda não subiu: notas/repasses não sincronizados + anexos
     na fila. Alimenta o "N ⏳" ao lado do indicador de rede no topo. */
  async function countPending() {
    const [ns, rs, fs] = await Promise.all([_getAll('notas'), _getAll('repasses'), _getAll('fotos')]);
    return ns.filter(n => !n.synced).length
         + rs.filter(r => !r.synced).length
         + fs.length;
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
    saveNota, getNotasUser, softDeleteNota,
    saveFotoLocal, getFotoLocal, repararFotosLocais, repararFotosOrfas,
    saveRepasse, getRepassesUser, softDeleteRepasse,
    upsertFromDrive,
    sync, setupAutoSync, getMeta, setMeta, countPending,
  };
})();
