'use strict';
/* ─────────────────────────────────────────────────────────────
   DB.js — IndexedDB offline-first + engine de sincronização
   Stores: notas | repasses | fotos | meta
   O parâmetro `sb` das funções de sync é o cliente da API (js/api.js).
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
          /* A API grava o arquivo em disco (user_id/nota_id.ext) e, se a nota
             já existe lá, atualiza o foto_path dela na mesma chamada. Se ainda
             não existe, o arquivo fica esperando e o upsert da nota (logo em
             seguida) o encontra pelo id — por isso vai o user_id junto. */
          const blob = payload.blob instanceof Blob ? payload.blob : new Blob([payload.blob], { type: mime });
          const { foto_path: path } = await sb.notas.foto(item.entity_id, blob, ext, nota.user_id);
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
        delete payload.updated_at;       // quem carimba é o servidor
        delete payload.user_nome;        // campo só de tela (notas da equipe)
        if (item.entity === 'repass') delete payload.email_sent;   // decisão do servidor

        /* lança em caso de erro → catch abaixo agenda a nova tentativa */
        if (item.entity === 'nota') await sb.notas.upsert(payload);
        else                        await sb.repasses.upsert(payload);

        if (item.entity === 'nota') {
          await _put('notas', { ...record, synced: true, sync_status: 'synced', sync_error: null, updated_at: now });
        } else {
          await _put('repasses', { ...record, synced: true, sync_status: 'synced', sync_error: null, updated_at: now });
        }
        await _del('sync_queue', item.id);
        ok++;
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

  async function pullIncremental(sb, userId) {
    if (!sb || !navigator.onLine || !userId) return 0;
    const since = await getMeta('last_sync', null);
    let pulled = 0;

    if (!since) {
      /* primeiro sync deste aparelho: notas só do ano atual; repasses são
         poucos e vêm inteiros */
      try {
        await setMeta(ANOS_KEY, []);
        pulled += await garantirAno(sb, userId, new Date().getFullYear());
        pulled += await _mesclarRemotas('repasses', await sb.repasses.list({}));
      } catch (_) { return pulled; }   // sem last_sync gravado: tenta de novo no próximo
    } else {
      for (const table of ['notas', 'repasses']) {
        try {
          const data = await (table === 'notas' ? sb.notas : sb.repasses).list({ since });
          pulled += await _mesclarRemotas(table, data);
        } catch (_) {}
      }
    }

    await setMeta('last_sync', new Date().toISOString());
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

  async function sync(sb, userId) {
    if (_running) return null;
    _running = true;
    try {
      try { await repararQrUrls(userId); } catch (_) {}
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
    purgeNotaLocal, limparDaLixeira, purgeNotasDeUsuario,
    saveFotoLocal, getFotoLocal, repararFotosLocais, repararFotosOrfas,
    saveRepasse, getRepassesUser, softDeleteRepasse,
    upsertFromDrive,
    sync, setupAutoSync, getMeta, setMeta, getSyncQueueSummary, repararQrUrls,
    garantirAno, anosSincronizados, getNotasEquipe,
  };
})();
