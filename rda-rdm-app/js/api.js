'use strict';
/* ─────────────────────────────────────────────────────────────
   API.js — cliente da Petermann API (Laravel na Locaweb)
   Substitui o supabase-js: login, dados, anexos.

   • Token (Sanctum) fica no localStorage; vai em Authorization: Bearer.
   • Toda função devolve o JSON já convertido ou lança Error com a
     mensagem do servidor (message) — quem chama trata com try/catch.
   • Anexos: o servidor guarda o ARQUIVO em disco e o banco só o caminho
     (foto_path). Para <img> usa-se URL assinada (fotos.urls); para
     baixar, fotos.download (Bearer).
───────────────────────────────────────────────────────────── */
window.API = (() => {
  /* Produção: subdomínio da API. Em desenvolvimento local (http-server na
     8080 + `php artisan serve` na 8000) cai no segundo. */
  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  /* Homologação (21/09/2026): teste.pmservicosagronomicos.com.br fala com a
     API de teste (api-teste na Locaweb, banco e fotos próprios). Nada que
     se faça lá toca a produção. */
  const HOMOLOG = location.hostname === 'teste.pmservicosagronomicos.com.br';
  const BASE  = LOCAL   ? 'http://127.0.0.1:8000/api'
              : HOMOLOG ? 'https://api.pmservicosagronomicos.com.br/teste/api'
                        : 'https://api.pmservicosagronomicos.com.br/api';

  const K_TOKEN = 'api_token';
  let _token = null;
  try { _token = localStorage.getItem(K_TOKEN) || null; } catch (_) {}

  /* Perfil em cache: é o que deixa o app abrir SEM rede (o token continua
     válido; o /me falha e o cache responde). */
  const K_USER = 'api_user';
  let _user = null;
  try { _user = JSON.parse(localStorage.getItem(K_USER) || 'null'); } catch (_) {}
  const _listeners = [];
  let _googleOk = null;

  function _setUser(u) {
    _user = u || null;
    try { u ? localStorage.setItem(K_USER, JSON.stringify(u)) : localStorage.removeItem(K_USER); } catch (_) {}
  }

  function _setToken(t) {
    _token = t || null;
    try { t ? localStorage.setItem(K_TOKEN, t) : localStorage.removeItem(K_TOKEN); } catch (_) {}
  }

  function _emit(ev, extra) {
    _listeners.forEach(cb => { try { cb(ev, _user, extra || {}); } catch (e) { console.warn('API listener:', e); } });
  }

  /* ── requisição base ─────────────────────────────────────── */
  async function req(method, path, { body, query, form, blob, timeout = 30_000 } = {}) {
    let url = BASE + path;
    if (query) {
      const qs = Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    const headers = { Accept: 'application/json' };
    if (_token) headers.Authorization = 'Bearer ' + _token;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeout);
    let r;
    try {
      r = await fetch(url, { method, headers, body: payload, signal: ctrl.signal });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'Servidor demorou para responder' : 'Sem conexão com o servidor', { cause: e });
    } finally { clearTimeout(tid); }

    if (r.status === 401 && _token) {
      /* token revogado/expirado: derruba a sessão local e avisa o app */
      _setToken(null); _setUser(null); _emit('SIGNED_OUT');
    }
    if (blob) {
      if (!r.ok) throw new Error(await _msg(r));
      return r.blob();
    }
    if (r.status === 204) return null;
    const txt = await r.text();
    let j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch (_) { /* resposta não era JSON */ }
    if (!r.ok) {
      const e = new Error((j && j.message) || `Erro ${r.status}`);
      e.status = r.status; e.errors = j?.errors || null;
      throw e;
    }
    return j;
  }
  async function _msg(r) {
    try { const j = await r.json(); return j.message || `Erro ${r.status}`; } catch (_) { return `Erro ${r.status}`; }
  }

  /* ── sessão ──────────────────────────────────────────────── */
  const auth = {
    get token() { return _token; },
    get user()  { return _user; },
    isLogged: () => !!_token,

    onChange(cb) { _listeners.push(cb); },

    /* Chamado no boot. Lê o retorno do Google (#token=…) e o link de
       redefinição (?reset=…&email=…), depois valida o token guardado.
       Devolve { user, recovery } — recovery = veio do e-mail de senha. */
    async init() {
      const out = { user: null, recovery: null, googleToken: null, authError: null, convite: null };

      // retorno do login Google: tudo vem no fragmento da URL
      if (location.hash && location.hash.length > 1) {
        const h = new URLSearchParams(location.hash.slice(1));
        if (h.get('token')) {
          _setToken(h.get('token'));
          if (h.get('google_token')) {
            out.googleToken = { token: h.get('google_token'), exp: Number(h.get('google_exp') || 0) * 1000 };
          }
          history.replaceState(null, '', location.pathname + location.search);
        } else if (h.get('auth_error')) {
          out.authError = h.get('auth_error');
          history.replaceState(null, '', location.pathname + location.search);
        } else if (h.get('drive_backup')) {
          // volta da autorização do Drive para o backup (21/09/2026): ok | cancelado | google | invalido
          out.driveBackup = h.get('drive_backup');
          history.replaceState(null, '', location.pathname + location.search);
        }
      }
      // link do e-mail "esqueci a senha"
      const q = new URLSearchParams(location.search);
      if (q.get('reset') && q.get('email')) {
        out.recovery = { token: q.get('reset'), email: q.get('email') };
      }
      // link de convite do gestor (21/09/2026): ?convite=<token> → cadastro com papel pré-definido
      if (q.get('convite')) out.convite = q.get('convite');

      if (_token) {
        try { _setUser(await req('GET', '/me')); out.user = _user; }
        catch (e) {
          /* sem rede: mantém o token e abre com o perfil em cache;
             401 já derrubou tudo no req() */
          out.user = e.status === 401 ? null : _user;
        }
      }
      return out;
    },

    async register({ nome, email, password, convite }) {
      const r = await req('POST', '/auth/register', { body: { nome, email, password, convite: convite || undefined } });
      _setToken(r.token); _setUser(r.user); _emit('SIGNED_IN');
      return r.user;
    },
    async login({ email, password }) {
      const r = await req('POST', '/auth/login', { body: { email, password } });
      _setToken(r.token); _setUser(r.user); _emit('SIGNED_IN');
      return r.user;
    },
    async logout() {
      try { if (_token) await req('POST', '/auth/logout'); } catch (_) {}
      _setToken(null); _setUser(null); _emit('SIGNED_OUT');
    },
    /* limpa só o lado local (sessão temporária do link de senha, erro etc.) */
    clearLocal() { _setToken(null); _setUser(null); },

    forgot: email => req('POST', '/auth/forgot', { body: { email } }),
    reset: ({ email, token, password }) => req('POST', '/auth/reset', { body: { email, token, password } }),

    /* O login Google existe no servidor? (GOOGLE_CLIENT_ID configurado).
       Consultado uma vez por sessão; sem rede assume que não. */
    async googleDisponivel() {
      if (_googleOk !== null) return _googleOk;
      try { _googleOk = !!(await req('GET', '/ping', { timeout: 8_000 }))?.google; }
      catch (_) { return false; }
      return _googleOk;
    },

    /* URL para onde mandar o navegador. drive=true pede o escopo do Drive
       (gestor/admin); hint = e-mail para o Google pré-selecionar a conta. */
    googleUrl({ drive = false, hint = '' } = {}) {
      const p = new URLSearchParams();
      if (drive) p.set('drive', '1');
      if (hint)  p.set('hint', hint);
      const qs = p.toString();
      return `${BASE}/auth/google/redirect${qs ? '?' + qs : ''}`;
    },

    me: async () => { _setUser(await req('GET', '/me')); return _user; },
    updateMe: async nome => { _setUser(await req('PATCH', '/me', { body: { nome } })); return _user; },
    fotoPerfil: async (blob, ext) => {
      const form = new FormData(); form.append('file', blob, `perfil.${ext || 'jpg'}`); if (ext) form.append('ext', ext);
      _setUser(await req('POST', '/me/foto', { form, timeout: 120_000 })); return _user;
    },
    removerFotoPerfil: async () => { _setUser(await req('DELETE', '/me/foto')); return _user; },
  };

  /* ── dados ───────────────────────────────────────────────── */
  const colaboradores = {
    list: () => req('GET', '/colaboradores'),
    get: id => req('GET', `/colaboradores/${id}`),
    update: (id, data) => req('PATCH', `/colaboradores/${id}`, { body: data }),
    /* 20/09/2026: desativar/reativar e exclusão em duas confirmações */
    listTodos: () => req('GET', '/colaboradores', { query: { todos: '1' } }),
    ativo: (id, ativo) => req('PATCH', `/colaboradores/${id}/ativo`, { body: { ativo } }),
    excluir: id => req('POST', `/colaboradores/${id}/excluir`, { body: {}, timeout: 120_000 }),
    cancelarExclusao: id => req('DELETE', `/colaboradores/${id}/excluir`),
    /* 22/09/2026: gestor confirma (ou recusa) a entrada de cadastro novo */
    confirmar: (id, aceita = true) => req('POST', `/colaboradores/${id}/confirmar`, { body: { aceita } }),
  };

  /* params: { since, ano, mes, user_id, deleted: '0'|'1', fields: 'a,b' } */
  const notas = {
    list: params => req('GET', '/notas', { query: params }),
    upsert: rec => req('PUT', `/notas/${rec.id}`, { body: rec }),
    delete: id => req('DELETE', `/notas/${id}`),
    /* valor/data/emitente oficiais pela URL do QR (servidor abre o portal do
       SEFAZ). null quando o portal não respondeu — o app fica com o OCR. */
    consultarQr: async (qrUrl, chave) => {
      const r = await req('POST', '/notas/consultar-qr', { body: { qr_url: qrUrl, chave: chave || null }, timeout: 25_000 });
      return (r && typeof r.valor === 'number') ? r : null;
    },
    existem: async ids => (await req('POST', '/notas/existem', { body: { ids } })).notas || [],
    chaveExiste: async (chave, ignoreId) =>
      (await req('POST', '/notas/chave-existe', { body: { chave, ignore_id: ignoreId || null } })).existe,
    /* sobe o anexo; o servidor grava em disco e devolve { foto_path }.
       userId = dono da nota, para quando ela ainda não existe no servidor
       (o anexo sobe antes da nota — anexo obrigatório vale na API). */
    foto(id, blob, ext, userId) {
      const form = new FormData();
      form.append('file', blob, `anexo.${ext || 'jpg'}`);
      if (ext) form.append('ext', ext);
      if (userId) form.append('user_id', userId);
      return req('POST', `/notas/${id}/foto`, { form, timeout: 120_000 });
    },
    repararFotos: () => req('POST', '/notas/reparar-fotos'),
  };

  const repasses = {
    list: params => req('GET', '/repasses', { query: params }),
    upsert: rec => req('PUT', `/repasses/${rec.id}`, { body: rec }),
    /* gestor/admin marca o pedido como pago: o servidor cria o repasse recebido (21/09/2026) */
    atendido: id => req('PATCH', `/repasses/${id}/atendido`),
    /* 2ª etapa (23/09/2026): quem recebe confirma (ou recusa) */
    confirmar: (id, aceita = true) => req('PATCH', `/repasses/${id}/confirmar`, { body: { aceita } }),
  };

  const fotos = {
    /* [paths] → { path: urlAssinada | null } (vale FOTO_URL_TTL, 5 min) */
    async urls(paths) {
      const lista = (paths || []).filter(Boolean);
      if (!lista.length) return {};
      const r = await req('POST', '/fotos/urls', { body: { paths: lista } });
      const out = {};
      (r || []).forEach(x => { out[x.path] = x.url; });
      return out;
    },
    async url(path) { return (await fotos.urls([path]))[path] || null; },
    download: path => req('GET', `/fotos/${path}`, { blob: true, timeout: 120_000 }),
  };

  /* Frota: veículos e registros de km (16/09/2026). Online, sem fila. */
  const frota = {
    veiculos: todos => req('GET', '/veiculos', { query: todos ? { todos: '1' } : undefined }),
    veiculoUpsert: (id, d) => req('PUT', `/veiculos/${id}`, { body: d }),
    km: params => req('GET', '/km', { query: params }),
    kmUpsert: (id, d) => req('PUT', `/km/${id}`, { body: d }),
    kmDelete: id => req('DELETE', `/km/${id}`),
    kmFoto(id, blob, ext) {
      const form = new FormData();
      form.append('file', blob, `odometro.${ext || 'jpg'}`);
      if (ext) form.append('ext', ext);
      return req('POST', `/km/${id}/foto`, { form, timeout: 120_000 });
    },
    resumo: (ano, mes) => req('GET', '/frota/resumo', { query: { ano, mes } }),
    anual: ano => req('GET', '/frota/anual', { query: { ano } }),
  };

  /* Ponto de presença (18/09/2026). */
  const ponto = {
    list: params => req('GET', '/ponto', { query: params }),
    bater: item => req('POST', '/ponto/bater', { body: item }),
    upsert: (id, d) => req('PUT', `/ponto/${id}`, { body: d }),
    delete: id => req('DELETE', `/ponto/${id}`),
    resumo: (ano, mes) => req('GET', '/ponto/resumo', { query: { ano, mes } }),
    feriados: ano => req('GET', '/feriados', { query: { ano } }),
    feriadoUpsert: (data, nome) => req('PUT', '/feriados', { body: { data, nome } }),
    feriadoDelete: data => req('DELETE', `/feriados/${data}`),
  };

  /* Backup do banco (SQLite) — só admin. Devolve o arquivo como Blob. */
  const backup = {
    banco: () => req('GET', '/backup/banco', { blob: true, timeout: 300_000 }),
    lista: () => req('GET', '/backup/lista'),
    completo: () => req('GET', '/backup/completo', { blob: true, timeout: 600_000 }),
    arquivo: nome => req('GET', `/backup/arquivo/${encodeURIComponent(nome)}`, { blob: true, timeout: 600_000 }),
    /* cópia no Google Drive (21/09/2026): status, URL de autorização, envio manual, desconectar */
    drive: () => req('GET', '/backup/drive'),
    driveUrl: () => req('GET', '/backup/drive/url'),
    driveEnviar: () => req('POST', '/backup/drive/enviar', { timeout: 600_000 }),
    driveDesconectar: () => req('DELETE', '/backup/drive'),
  };

  /* Planilha de C.V. no modelo da empresa, preenchida pelo servidor (19/09/2026). */
  /* Convite por link (21/09/2026): gestor/admin cria; a tela de cadastro consulta (público). */
  const convites = {
    criar: (role, nome) => req('POST', '/convites', { body: { role, nome: nome || undefined } }),
    lista: () => req('GET', '/convites'),
    ver: token => req('GET', '/auth/convites/' + encodeURIComponent(token)),
  };

  const relatorio = {
    cv: (ano, userId, formato) => req('GET', '/relatorio/cv', { query: { ano, user_id: userId || undefined, formato }, blob: true, timeout: 300_000 }),
    rdmrda: (ano, userId, formato) => req('GET', '/relatorio/rdmrda', { query: { ano, user_id: userId || undefined, formato: formato || 'xlsx' }, blob: true, timeout: 300_000 }),   // modelo RDM/RDA (21/09/2026)
    equipe: (ano, mes, ids) => req('GET', '/relatorio/equipe', { query: { ano, mes, ids: ids?.length ? ids.join(',') : undefined }, blob: true, timeout: 300_000 }),
    cvEquipe: (ano, ids, modo) => req('GET', '/relatorio/cv-equipe', { query: { ano, ids: ids?.length ? ids.join(',') : undefined, modo: modo || 'unico' }, blob: true, timeout: 600_000 }),
  };

  /* Arquivos no servidor, no lugar do Drive (19/09/2026). */
  const arquivos = {
    resumo: ano => req('GET', '/arquivos/resumo', { query: { ano } }),
    notas: (userId, ano, mes) => req('GET', '/arquivos/notas', { query: { user_id: userId || undefined, ano, mes: mes || undefined } }),
    zip: (userId, ano, mes) => req('GET', '/arquivos/zip', { query: { user_id: userId || undefined, ano, mes: mes || undefined }, blob: true, timeout: 300_000 }),
  };

  /* Manutenção do servidor — só admin (a hospedagem não tem terminal). */
  const admin = {
    status: () => req('GET', '/admin/status'),
    migrar: () => req('POST', '/admin/migrar', { timeout: 120_000 }),
    armazenamento: () => req('GET', '/admin/armazenamento'),   // espaço em disco (21/09/2026)
  };

  const cnpj = {
    get: c => req('GET', `/cnpj/${c}`),
    set: (c, data) => req('PUT', `/cnpj/${c}`, { body: data }),
  };

  return { BASE, HOMOLOG, req, auth, colaboradores, notas, repasses, fotos, cnpj, backup, admin, frota, ponto, relatorio, arquivos, convites };
})();
