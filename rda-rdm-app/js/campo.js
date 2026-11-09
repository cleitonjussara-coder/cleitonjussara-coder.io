'use strict';
/* ─────────────────────────────────────────────────────────────
   CAMPO.js — atividade em campo (08/11/2026)

   Antes, cada pessoa escrevia no grupo do WhatsApp "Início das atividades /
   Faz. São José / BRCB147A-B" ao chegar no campo e "Fim das atividades" ao
   sair. Agora é um botão: o app grava fazenda, campo, hora e a localização
   do aparelho NO TOQUE (nunca em segundo plano). Sem internet, o toque fica
   na fila com a hora do aparelho e sobe sozinho. Iniciar outro campo fecha
   o anterior. Depois de registrar, "Compartilhar" monta a mensagem no mesmo
   padrão do grupo, com o link do mapa — enviar é escolha da pessoa.

   Quem vê: o gestor liga a função por pessoa (Equipe → editar). Gestor e
   admin sempre veem a tela para acompanhar quem está em campo e onde; o
   focal (09/11/2026, colaborador com a chave ligada) também, só nesta função.

   Depende de globais do app.js: $, sb, user, toast, setLoading, esc,
   fmtData, filMes, filAno, MESES, _acompanhaCampo, _registraCampo, DB,
   viewAtual, FusoBR, pedirCampos, pedirConfirmacao.
───────────────────────────────────────────────────────────── */
window.Campo = (() => {

  const KEY_FILA = 'campo_fila';
  const KEY_CACHE = () => `campo_cache_${filAno}_${filMes}`;
  /* Histórico de fazenda + campo (08/11/2026, pedido do Cleiton): cada início guarda o par no aparelho, por conta, para
     escolher na próxima visita em vez de digitar. Mais recente primeiro; os registros do mês vindos do servidor
     também entram, então trocar de celular não zera a lista. */
  const KEY_HIST = () => `campo_historico_${user?.id || 'anon'}`;
  const HIST_MAX = 30;
  const _atG = s => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const hm = min => { min = Math.max(0, Math.round(Number(min) || 0)); return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`; };
  const horaBR = iso => iso ? FusoBR.hora(new Date(iso), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';
  const dataBR = iso => iso ? fmtData(new Date(iso).toLocaleDateString('sv-SE', { timeZone: FusoBR.TZ })) : '';   // sv-SE = AAAA-MM-DD
  const mapa = (lat, lng) => (lat != null && lng != null) ? `https://www.google.com/maps?q=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}` : null;

  let lista = [];          // atividades do mês (minhas; do gestor: todas)
  let camposEquipe = null; // GET /atividades-campo/campos: fazendas e campos já registrados (buscador)
  const KEY_CAMPOS = 'campo_campos_equipe';
  let equipe = [];         // gestor: último registro de cada pessoa ligada
  let _offline = false, _cacheEm = null;
  let _filtroPessoa = null;
  /* Planilha dinâmica do gestor (08/11/2026) */
  let _aba = 'painel';           // 'painel' | 'registros' | 'campos' (cadastro de campos, 09/11/2026)
  let _filtroFazenda = null;     // nome da fazenda já com "Faz."
  let _filtroDia = null;         // 'AAAA-MM-DD' (só na aba Registros)
  let _filtroPend = null;        // 'abertas' | 'auto' | 'semloc' (só na aba Registros)

  /* ── Fila offline ──────────────────────────────────────────
     Igual à do ponto: a fila é do aparelho e cada item guarda a conta (uid).
     Só sobem os de quem está logado. A ordem importa (iniciar antes de finalizar). */
  async function _fila() { try { return (await DB.getMeta(KEY_FILA)) || []; } catch (_) { return []; } }
  const _meu = it => !!user?.id && it.uid === user.id;
  async function _minhas() { return (await _fila()).filter(_meu); }
  async function _salvarFila(f) { try { await DB.setMeta(KEY_FILA, f); } catch (_) {} }
  async function _enfileirar(item) { const f = await _fila(); f.push({ ...item, uid: user?.id, erro: null }); await _salvarFila(f); }

  let _subindo = false;
  async function subirFila() {
    if (_subindo || !sb || !user?.id || !navigator.onLine) return 0;
    _subindo = true; let ok = 0;
    try {
      const todos = await _fila();
      const f = todos.filter(_meu);
      if (!f.length) return 0;
      const outros = todos.filter(it => !_meu(it));
      const resto = [];
      for (let i = 0; i < f.length; i++) {
        const it = f[i];
        try {
          if (it.tipo === 'iniciar') await sb.atividadesCampo.iniciar(it.dados);
          else await sb.atividadesCampo.finalizar(it.id, it.dados);
          ok++;
        } catch (e) {
          if (!e?.status) { resto.push(...f.slice(i)); break; }      // sem rede: tenta depois, na mesma ordem
          resto.push({ ...it, erro: e.message || 'falhou' });         // recusado pelo servidor: fica visível com o motivo
        }
      }
      await _salvarFila([...outros, ...resto]);
      if (ok) toast(`${ok} registro${ok > 1 ? 's' : ''} de campo enviado${ok > 1 ? 's' : ''} ✅`);
    } finally { _subindo = false; }
    return ok;
  }
  window.addEventListener('online', () => { subirFila().then(n => { if (n && viewAtual === 'campo') render(); }).catch(() => {}); });

  /* ── Localização no toque ──────────────────────────────── */
  function localizar() {
    return new Promise(resolve => {
      if (!navigator.geolocation) { resolve({ erro: 'Este aparelho não informa a localização.' }); return; }
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, precisao: p.coords.accuracy }),
        e => resolve({ erro: e.code === 1 ? 'Localização bloqueada para o app. Libere nas permissões do navegador.' : 'Não foi possível pegar a localização agora.' }),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
      );
    });
  }

  /* ── Carga ─────────────────────────────────────────────── */
  const _periodo = () => {
    const de = `${filAno}-${String(filMes).padStart(2, '0')}-01`;
    const ate = `${filAno}-${String(filMes).padStart(2, '0')}-${String(new Date(filAno, filMes, 0).getDate()).padStart(2, '0')}`;
    return { de, ate };
  };
  async function carregar() {
    if (!sb || !navigator.onLine) throw new Error('offline');
    await subirFila();
    const gestor = _acompanhaCampo();   // gestor, admin e focal (09/11/2026)
    const [l, e, c] = await Promise.all([sb.atividadesCampo.list(_periodo()), gestor ? sb.atividadesCampo.equipe() : Promise.resolve([]),
      _registraCampo() || gestor ? sb.atividadesCampo.campos().catch(() => null) : Promise.resolve(null)]);
    lista = l || []; equipe = e || [];
    if (c) { camposEquipe = c; try { await DB.setMeta(KEY_CAMPOS, c); } catch (_) {} }   // guardado para buscar sem internet
    _offline = false; _cacheEm = new Date().toISOString();
    try { await DB.setMeta(KEY_CACHE(), { lista, equipe, em: _cacheEm }); } catch (_) {}
  }
  async function carregarDoCache() {
    const c = await DB.getMeta(KEY_CACHE()).catch(() => null);
    lista = c?.lista || []; equipe = c?.equipe || []; _cacheEm = c?.em || null; _offline = true;
  }

  /* Atividade aberta AGORA (servidor + fila): o que a fila iniciou e ainda não finalizou vale mais. */
  async function _aberta() {
    const fila = await _minhas();
    const fimNaFila = new Set(fila.filter(x => x.tipo === 'finalizar').map(x => x.id));
    const iniFila = fila.filter(x => x.tipo === 'iniciar' && !fimNaFila.has(x.dados.id)).pop();
    if (iniFila) return { id: iniFila.dados.id, fazenda: iniFila.dados.fazenda, campo: iniFila.dados.campo.toUpperCase(), inicio: iniFila.dados.hora,
      lat_inicio: iniFila.dados.lat, lng_inicio: iniFila.dados.lng, pendente: true };
    const iniciadasNaFila = fila.some(x => x.tipo === 'iniciar');
    const doServidor = lista.filter(a => a.user_id === user?.id && a.em_campo && !fimNaFila.has(a.id))
      .sort((a, b) => b.inicio.localeCompare(a.inicio))[0];
    return iniciadasNaFila ? null : (doServidor || null);
  }

  /* ── Tela ──────────────────────────────────────────────── */
  /* Abrir rápido (09/11/2026, "página demorando abrir"): antes cada abertura E cada clique em aba/filtro
     apagava a tela e esperava fila + 3 consultas ao servidor. Agora: com cópia do mês no aparelho, desenha na
     hora e atualiza por trás; abas e filtros só redesenham com o que já está na memória (_desenhar). */
  let _seq = 0, _atualizando = false;
  async function render() {
    const el = $('app-content'), seq = ++_seq, chave = KEY_CACHE();
    const c = navigator.onLine ? await DB.getMeta(chave).catch(() => null) : null;
    if (c) {
      lista = c.lista || []; equipe = c.equipe || []; _cacheEm = c.em || null; _offline = false; _atualizando = true;
      if (!camposEquipe) { try { camposEquipe = (await DB.getMeta(KEY_CAMPOS)) || null; } catch (_) {} }
      await _desenhar();
    } else {
      el.innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando atividade em campo…</p></div>';
    }
    try { await carregar(); } catch (_) { await carregarDoCache(); }
    _atualizando = false;
    if (seq !== _seq || viewAtual !== 'campo' || chave !== KEY_CACHE()) return;   // saiu da tela ou mudou de mês no meio
    const y = window.scrollY;
    await _desenhar();
    if (c) window.scrollTo(0, y);
  }

  async function _desenhar() {
    const el = $('app-content');
    const gestor = _acompanhaCampo();   // gestor, admin e focal (09/11/2026)
    const registra = _registraCampo();
    const aberta = registra ? await _aberta() : null;
    const fila = await _minhas();
    const comErro = fila.filter(x => x.erro);
    const periodo = `${MESES[filMes - 1]} ${filAno}`;

    let html = `<div class="db-container">
      ${_atualizando ? '<div class="nota-cnpj" style="text-align:center;opacity:.75">🔄 atualizando…</div>' : ''}
      ${_offline ? `<div class="ini-dica" style="border-left:3px solid var(--warning)">📴 <b>Sem internet</b> — pode registrar normalmente: fica guardado com a hora do aparelho e sobe sozinho.</div>` : ''}
      ${fila.length ? `<div class="ini-dica" style="border-left:3px solid var(--warning)">⏳ <b>${fila.length} registro${fila.length > 1 ? 's' : ''} aguardando envio</b>. ${navigator.onLine ? '<a class="link" onclick="Campo.reenviar()">Enviar agora</a>' : ''}
        ${comErro.map(x => `<div style="margin-top:4px;color:var(--danger)">⚠️ ${esc(x.erro)}</div>`).join('')}
        ${comErro.length ? '<a class="link" onclick="Campo.descartarRecusados()">Descartar os recusados</a>' : ''}</div>` : ''}`;

    if (registra) {
      html += aberta ? `
      <div class="db-card" style="border-left:4px solid var(--success, #2e7d32)">
        <div class="db-card-title"><span>🟢 Em campo agora${aberta.pendente ? ' ⏳' : ''}</span></div>
        <div class="campo-atual">
          <div class="campo-faz">${esc(_faz(aberta.fazenda))}</div>
          <div class="campo-cod">${esc(aberta.campo)}</div>
          <div class="campo-sub">desde ${horaBR(aberta.inicio)}${mapa(aberta.lat_inicio, aberta.lng_inicio) ? ' · 📍 localização gravada' : ' · sem localização'}</div>
        </div>
      </div>
      <button class="pnl pnl-grande" onclick="Campo.finalizar()">
        <span class="pnl-conteudo"><span class="pnl-ico">🔴</span><span class="pnl-tit">Fim das atividades</span>
        <span class="pnl-sub">${esc(_faz(aberta.fazenda))} · ${esc(aberta.campo)}</span></span>
      </button>
      <button class="btn btn-outline btn-full" style="margin-top:8px" onclick="Campo.iniciar()">↪️ Iniciar outro campo (fecha este)</button>` : `
      <button class="pnl pnl-grande" onclick="Campo.iniciar()">
        <span class="pnl-conteudo"><span class="pnl-ico">🟢</span><span class="pnl-tit">Início das atividades</span>
        <span class="pnl-sub">fazenda, campo e localização no toque</span></span>
      </button>`;
    }

    if (gestor) html += _equipeHTML();

    html += `
      <div class="page-hd" style="padding:0">
        <div class="mes-nav">
          <button class="btn-mes-nav" onclick="Campo.mudarMes(-1)">‹</button>
          <span class="mes-label">${periodo}</span>
          <button class="btn-mes-nav" onclick="Campo.mudarMes(1)">›</button>
        </div>
      </div>`;

    if (gestor) {
      /* Planilha dinâmica (08/11/2026): só gestor e admin. Painel = dashboard no padrão do Painel das Notas; Registros = lista filtrada. */
      const regs = _filtrados();
      html += `
      <div class="cp-abas">
        <button class="chip ${_aba === 'painel' ? 'active' : ''}" onclick="Campo.aba('painel')">📊 Painel</button>
        <button class="chip ${_aba === 'registros' ? 'active' : ''}" onclick="Campo.aba('registros')">📋 Registros (${_registrosVisiveis(regs).length})</button>
        <button class="chip ${_aba === 'campos' ? 'active' : ''}" onclick="Campo.aba('campos')">🌾 Campos (${(camposEquipe || []).length})</button>
      </div>
      ${_aba === 'campos' ? '' : _filtrosHTML()}`;
      html += _aba === 'campos' ? _camposHTML() : _aba === 'painel' ? _painelHTML(regs) : _registrosHTML(regs, true);
    } else {
      html += _registrosHTML(lista.filter(a => a.user_id === user?.id), false);
    }
    html += '</div>';
    el.innerHTML = html;
  }

  const _faz = f => { f = String(f || '').trim(); return /^faz/i.test(f) ? f : `Faz. ${f}`; };

  function _cartao(a, gestor) {
    const mi = mapa(a.lat_inicio, a.lng_inicio), mf = mapa(a.lat_fim, a.lng_fim);
    return `
        <div class="nota-card">
          <div class="nota-head">
            <span class="tipo-badge tipo-RDA">${dataBR(a.inicio)}</span>
            ${gestor && a.user_nome ? `<span class="subtipo-tag">👤 ${esc(a.user_nome)}</span>` : ''}
            ${a.em_campo ? '<span class="sync-pill pending">🟢 em campo</span>' : ''}
            ${a.fim_automatico ? '<span class="doc-tag outro" title="Fechada quando outro campo foi iniciado">fim automático</span>' : ''}
            ${a.editado_em ? `<span class="doc-tag outro" title="Corrigido em ${_atG(dataBR(a.editado_em))} às ${_atG(horaBR(a.editado_em))}${a.editado_por_nome ? ` por ${_atG(a.editado_por_nome)}` : ''}">✏️ editado</span>` : ''}
          </div>
          <div class="nota-body">
            <div class="nota-empresa">${esc(_faz(a.fazenda))} · <b>${esc(a.campo)}</b></div>
            <div class="nota-cnpj">${horaBR(a.inicio)} → ${a.fim ? horaBR(a.fim) : '…'}${a.minutos != null ? ` · ${hm(a.minutos)}` : ''}</div>
            <div class="nota-cnpj campo-links">
              ${mi ? `<a class="link" href="${_atG(mi)}" target="_blank" rel="noopener">📍 início${a.precisao_inicio ? ` (±${a.precisao_inicio} m)` : ''}</a>` : '<span>📍 início sem localização</span>'}
              ${a.fim ? (mf ? `<a class="link" href="${_atG(mf)}" target="_blank" rel="noopener">📍 fim${a.precisao_fim ? ` (±${a.precisao_fim} m)` : ''}</a>` : '<span>📍 fim sem localização</span>') : ''}
            </div>
          </div>
          ${a.observacao ? `<div class="nota-cnpj" style="padding:0 14px 8px">📝 ${esc(a.observacao)}</div>` : ''}
          ${a.user_id === user?.id || _acompanhaCampo() ? `<div class="nota-foot"><span></span><div class="nota-actions">
            <button class="btn btn-sm btn-outline" data-id="${_atG(a.id)}" onclick="Campo.editar(this.dataset.id)">✏️ Editar</button>
            ${a.user_id === user?.id ? `<button class="btn btn-sm btn-outline" data-id="${_atG(a.id)}" onclick="Campo.compartilharId(this.dataset.id)">📤 Compartilhar</button>` : ''}
          </div></div>` : ''}
        </div>`;
  }

  function _equipeHTML() {
    if (!equipe.length) return `
      <div class="ini-titulo">Equipe em campo</div>
      <div class="db-card"><p class="muted-p">Ninguém está com a atividade em campo ligada. Ligue em <b>Equipe → editar colaborador → 📍 Registra atividade em campo</b>.</p></div>`;
    const ord = equipe.slice().sort((x, y) => (y.ultima?.em_campo ? 1 : 0) - (x.ultima?.em_campo ? 1 : 0) || String(x.nome).localeCompare(String(y.nome)));
    const agora = ord.filter(p => p.ultima?.em_campo).length;
    return `
      <div class="ini-titulo">Equipe em campo — ${agora} agora</div>
      <div class="db-card">
        ${ord.map(p => {
          const u = p.ultima;
          const m = u ? (mapa(u.lat_fim, u.lng_fim) && !u.em_campo ? mapa(u.lat_fim, u.lng_fim) : mapa(u.lat_inicio, u.lng_inicio)) : null;
          return `<div class="campo-pessoa" data-uid="${_atG(p.user_id)}" onclick="Campo.filtrarPessoa(this.dataset.uid)">
            <div class="campo-pessoa-nome">${u?.em_campo ? '🟢' : '⚪'} ${esc(p.nome)}</div>
            <div class="campo-pessoa-info">${u
              ? `${esc(_faz(u.fazenda))} · <b>${esc(u.campo)}</b><br>${u.em_campo ? `em campo desde ${dataBR(u.inicio)} ${horaBR(u.inicio)}` : `saiu ${dataBR(u.fim)} ${horaBR(u.fim)}`}`
              : 'sem registro ainda'}
              ${m ? ` · <a class="link" href="${_atG(m)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">📍 última localização</a>` : ''}</div>
          </div>`;
        }).join('')}
      </div>`;
  }

  /* ── Planilha dinâmica (gestor/admin) ──────────────────── */
  const _diaDe = iso => new Date(iso).toLocaleDateString('sv-SE', { timeZone: FusoBR.TZ });
  const _semLoc = a => a.lat_inicio == null || (!!a.fim && !a.fim_automatico && a.lat_fim == null);
  const PEND = {
    abertas: { ico: '🟢', txt: 'Em campo, sem fim registrado', f: a => a.em_campo },
    auto:    { ico: '⏱️', txt: 'Fechadas sozinhas (esqueceu o fim)', f: a => a.fim_automatico },
    semloc:  { ico: '📍', txt: 'Sem localização no início ou no fim', f: _semLoc },
  };

  /* pessoa e fazenda valem para o painel e para a lista; dia e pendência só para a lista */
  function _filtrados() {
    return lista.filter(a => (!_filtroPessoa || a.user_id === _filtroPessoa) && (!_filtroFazenda || _faz(a.fazenda) === _filtroFazenda));
  }
  function _registrosVisiveis(regs) {
    return regs.filter(a => (!_filtroDia || _diaDe(a.inicio) === _filtroDia) && (!_filtroPend || PEND[_filtroPend].f(a)));
  }

  /* Números do dashboard e da planilha. Horas = só atividades fechadas; a aberta aparece em Pendências. */
  function agregar(regs, ano = filAno, mes = filMes) {
    const nd = new Date(ano, mes, 0).getDate();
    const P = new Map(), F = new Map(), porDia = Array(nd).fill(0), gente = Array.from({ length: nd }, () => new Set());
    let min = 0;
    for (const a of regs) {
      const m = Number(a.minutos) || 0, d = _diaDe(a.inicio), i = Number(d.slice(8)) - 1;
      min += m;
      if (d.slice(0, 7) === `${ano}-${String(mes).padStart(2, '0')}`) { porDia[i] += m; gente[i].add(a.user_id); }
      const p = P.get(a.user_id) || { user_id: a.user_id, nome: a.user_nome || '?', min: 0, visitas: 0, dias: new Set(), abertas: 0, auto: 0, semloc: 0, porDia: Array(nd).fill(null) };
      p.min += m; p.visitas++; p.dias.add(d); if (a.em_campo) p.abertas++; if (a.fim_automatico) p.auto++; if (_semLoc(a)) p.semloc++;
      if (d.slice(0, 7) === `${ano}-${String(mes).padStart(2, '0')}`) p.porDia[i] = (p.porDia[i] || 0) + m;
      P.set(a.user_id, p);
      const fz = _faz(a.fazenda);
      const f = F.get(fz) || { fazenda: fz, min: 0, visitas: 0, pessoas: new Set(), campos: new Map() };
      f.min += m; f.visitas++; f.pessoas.add(a.user_id);
      const c = f.campos.get(a.campo) || { campo: a.campo, min: 0, visitas: 0 };
      c.min += m; c.visitas++; f.campos.set(a.campo, c); F.set(fz, f);
    }
    const pessoas = [...P.values()].map(p => ({ ...p, dias: p.dias.size })).sort((a, b) => b.min - a.min || a.nome.localeCompare(b.nome));
    const fazendas = [...F.values()].map(f => ({ ...f, pessoas: f.pessoas.size, campos: [...f.campos.values()].sort((a, b) => b.min - a.min) }))
      .sort((a, b) => b.min - a.min || b.visitas - a.visitas);
    const pend = Object.fromEntries(Object.entries(PEND).map(([k, v]) => [k, regs.filter(v.f)]));
    return { ano, mes, nd, min, visitas: regs.length, pessoas, fazendas, porDia, gentePorDia: gente.map(s => s.size),
      diasPessoa: pessoas.reduce((s, p) => s + p.dias, 0), campos: fazendas.reduce((s, f) => s + f.campos.length, 0), pend };
  }

  function _filtrosHTML() {
    const pessoas = [...new Map(lista.map(a => [a.user_id, a.user_nome || '?'])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const fazendas = [...new Set(lista.map(a => _faz(a.fazenda)))].sort((a, b) => a.localeCompare(b));
    const chipsLista = [
      _filtroDia ? `<button class="chip active" onclick="Campo.filtrarDia(null)">📅 ${fmtData(_filtroDia)} ✕</button>` : '',
      _filtroPend ? `<button class="chip active" onclick="Campo.filtrarPend(null)">${PEND[_filtroPend].ico} ${esc(PEND[_filtroPend].txt)} ✕</button>` : '',
    ].join('');
    return `
      <div class="cp-filtros">
        <select class="inp" aria-label="Colaborador" onchange="Campo.filtrarPessoa(this.value || null)">
          <option value="">👥 Todos os colaboradores</option>
          ${pessoas.map(([id, nome]) => `<option value="${_atG(id)}" ${id === _filtroPessoa ? 'selected' : ''}>${esc(nome)}</option>`).join('')}
        </select>
        <select class="inp" aria-label="Fazenda" onchange="Campo.filtrarFazenda(this.value || null)">
          <option value="">🌾 Todas as fazendas</option>
          ${fazendas.map(f => `<option value="${_atG(f)}" ${f === _filtroFazenda ? 'selected' : ''}>${esc(f)}</option>`).join('')}
        </select>
      </div>
      ${_aba === 'registros' && chipsLista ? `<div class="cp-chips">${chipsLista}</div>` : ''}`;
  }

  function _painelHTML(regs) {
    if (!regs.length) return '<div class="db-card"><p class="muted-p">Nenhuma atividade neste mês com esses filtros.</p></div>';
    const A = agregar(regs);
    const nPend = A.pend.abertas.length + A.pend.auto.length + A.pend.semloc.length;
    const kpi = (lbl, val, sub, extra = '', acao = '') => `<button class="ini-kpi ${extra}" ${acao ? `onclick="${acao}"` : 'style="cursor:default"'}><div class="ini-kpi-lbl">${lbl}</div><div class="ini-kpi-val">${val}</div><div class="ini-kpi-sub">${sub}</div></button>`;
    const umaPessoa = !!_filtroPessoa;
    let html = `
      <div class="cp-kpis">
        ${kpi('Horas em campo', hm(A.min), `${A.visitas} atividade${A.visitas === 1 ? '' : 's'} no mês`, '', "Campo.aba('registros')")}
        ${kpi('Dias em campo', String(umaPessoa ? (A.pessoas[0]?.dias || 0) : A.diasPessoa), umaPessoa ? 'dias com atividade' : `soma de ${A.pessoas.length} pessoa${A.pessoas.length === 1 ? '' : 's'}`)}
        ${kpi('Fazendas · campos', `${A.fazendas.length} · ${A.campos}`, 'visitados no mês')}
        ${kpi('Pendências', String(nPend), nPend ? 'toque para ver' : 'tudo em ordem', nPend ? 'alerta' : '', nPend ? "Campo.filtrarPend('" + (A.pend.abertas.length ? 'abertas' : A.pend.auto.length ? 'auto' : 'semloc') + "')" : '')}
      </div>`;

    /* Horas por dia: barra por dia do mês; tocar abre os registros do dia */
    const max = Math.max(1, ...A.porDia);
    const hojeISO = FusoBR.hojeISO();
    html += `
      <div class="db-card">
        <div class="db-card-title"><span>Horas em campo por dia</span><span style="font-size:13px;color:var(--text2)">toque no dia</span></div>
        <div class="cp-barras" role="list">
          ${A.porDia.map((m, i) => {
            const ds = `${A.ano}-${String(A.mes).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
            return `<button class="cp-barra ${ds === hojeISO ? 'hoje' : ''}" role="listitem" title="${fmtData(ds)} · ${hm(m)}" aria-label="${fmtData(ds)}: ${hm(m)}" ${m ? `data-dia="${ds}" onclick="Campo.filtrarDia(this.dataset.dia)"` : 'disabled'}>
              <span class="cp-barra-fill" style="height:${m ? Math.max(6, Math.round(m / max * 100)) : 0}%"></span>
              <small>${(i + 1) % 5 === 0 || i === 0 ? i + 1 : ''}</small></button>`;
          }).join('')}
        </div>
      </div>`;

    if (!umaPessoa && A.pessoas.length) {
      const maxP = Math.max(1, ...A.pessoas.map(p => p.min));
      html += `
      <div class="db-card">
        <div class="db-card-title"><span>Por colaborador</span><span style="font-size:13px;color:var(--text2)">toque para filtrar</span></div>
        <div class="db-rank">
          ${A.pessoas.map((p, i) => `
          <div class="db-rank-item" style="cursor:pointer" data-uid="${_atG(p.user_id)}" onclick="Campo.filtrarPessoa(this.dataset.uid)">
            <div class="db-rank-meta"><span class="db-rank-pos">${i + 1}º</span><span class="db-rank-name">${esc(p.nome)}</span>
              <span class="db-rank-val">${hm(p.min)}</span></div>
            <div class="db-rank-track"><div class="db-rank-fill" style="width:${Math.max(3, Math.round(p.min / maxP * 100))}%"></div></div>
            <div class="cp-rank-sub">${p.dias} dia${p.dias === 1 ? '' : 's'} · ${p.visitas} atividade${p.visitas === 1 ? '' : 's'}${p.abertas ? ' · 🟢 em campo' : ''}</div>
          </div>`).join('')}
        </div>
      </div>`;
    }

    const maxF = Math.max(1, ...A.fazendas.map(f => f.min));
    html += `
      <div class="db-card">
        <div class="db-card-title"><span>Por fazenda e campo</span><span style="font-size:13px;color:var(--text2)">toque para filtrar</span></div>
        <div class="db-rank">
          ${A.fazendas.map(f => `
          <div class="db-rank-item" style="cursor:pointer" data-faz="${_atG(f.fazenda)}" onclick="Campo.filtrarFazenda(this.dataset.faz)">
            <div class="db-rank-meta"><span class="db-rank-name">${esc(f.fazenda)}</span><span class="db-rank-val">${hm(f.min)}</span></div>
            <div class="db-rank-track"><div class="db-rank-fill" style="width:${Math.max(3, Math.round(f.min / maxF * 100))}%"></div></div>
            <div class="cp-rank-sub">${f.visitas} visita${f.visitas === 1 ? '' : 's'} · ${f.pessoas} pessoa${f.pessoas === 1 ? '' : 's'} · ${f.campos.slice(0, 4).map(c => `<b>${esc(c.campo)}</b> ${hm(c.min)}`).join(' · ')}${f.campos.length > 4 ? ` · +${f.campos.length - 4}` : ''}</div>
          </div>`).join('')}
        </div>
      </div>`;

    html += `
      <div class="db-card">
        <div class="db-card-title"><span>Pendências</span></div>
        <div class="db-pend">
          ${nPend ? Object.entries(PEND).map(([k, v]) => A.pend[k].length ? `
          <button class="db-pend-item" onclick="Campo.filtrarPend('${k}')">
            <span class="db-pend-ico">${v.ico}</span><span class="db-pend-txt">${esc(v.txt)}</span>
            <span class="db-pend-n">${A.pend[k].length}</span><span class="db-pend-seta">›</span>
          </button>` : '').join('') : '<div class="db-pend-item ok"><span class="db-pend-ico">✅</span><span class="db-pend-txt">Nenhuma pendência no mês</span></div>'}
        </div>
      </div>`;

    /* Dias em campo: calendário do mês; com uma pessoa, as horas dela; com a equipe, quantas pessoas foram ao campo */
    const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    html += `
      <div class="db-card">
        <div class="db-card-title"><span>Dias em campo</span><span style="font-size:13px;color:var(--text2)">${umaPessoa ? 'horas por dia' : 'pessoas por dia'}</span></div>
        <div class="ponto-cal">
          ${DIAS.map(d => `<span class="ponto-cal-h">${d}</span>`).join('')}
          ${Array(new Date(A.ano, A.mes - 1, 1).getDay()).fill('<span></span>').join('')}
          ${A.porDia.map((m, i) => {
            const ds = `${A.ano}-${String(A.mes).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
            const n = A.gentePorDia[i];
            return `<span class="ponto-cal-d ${n ? 'ok' : ''} ${ds === hojeISO ? 'hoje' : ''}" ${n ? `style="cursor:pointer" data-dia="${ds}" onclick="Campo.filtrarDia(this.dataset.dia)"` : ''}><b>${i + 1}</b>${n ? `<small>${umaPessoa ? hm(m) : n + ' 👤'}</small>` : ''}</span>`;
          }).join('')}
        </div>
      </div>
      <button class="btn btn-primary btn-full" onclick="Campo.exportarExcel()">📗 Planilha de atividade em campo — ${MESES[filMes - 1]}/${filAno}</button>`;
    return html;
  }

  function _registrosHTML(regs, gestor) {
    const vis = gestor ? _registrosVisiveis(regs) : regs;
    return `
      <div class="ini-titulo" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <span>${gestor ? 'Registros da equipe' : 'Meus registros'} (${vis.length})</span>
        ${gestor && vis.length ? `<button class="btn btn-sm btn-primary" onclick="Campo.exportarExcel()">📗 Planilha ${MESES[filMes - 1]}</button>` : ''}
      </div>
      <div class="notas-list">
        ${vis.length ? vis.map(a => _cartao(a, gestor)).join('') : '<p class="muted-p">Nenhum registro neste mês.</p>'}
      </div>`;
  }

  function aba(qual) { _aba = ['registros', 'campos'].includes(qual) ? qual : 'painel'; if (_aba === 'painel') { _filtroDia = null; _filtroPend = null; } _desenhar(); }

  /* ── Cadastro de campos (09/11/2026) ────────────────────
     Gestor, admin e focal cadastram fazenda + campo sem registrar atividade e corrigem o nome de um campo. A lista junta
     o cadastro com o que a equipe já registrou (GET /atividades-campo/campos). Nada de dado na onclick: só o índice. */
  function _camposHTML() {
    const lst = (camposEquipe || []).slice().sort((a, b) => _semAcento(_faz(a.fazenda)).localeCompare(_semAcento(_faz(b.fazenda))) || String(a.campo).localeCompare(String(b.campo)));
    _camposTela = lst;
    const linha = (c, i) => `
      <div class="campo-cad" data-busca="${_atG(_semAcento(`${c.fazenda} ${c.campo}`))}">
        <div style="flex:1;min-width:0">
          <div class="nota-name" style="overflow-wrap:anywhere">${esc(c.campo)}</div>
          <div class="nota-cnpj">${esc(_faz(c.fazenda))} · ${c.usos ? `${c.usos} visita${c.usos === 1 ? '' : 's'}` : 'sem visita ainda'}${c.cadastrado ? ' · cadastrado' : ''}</div>
        </div>
        <button class="btn btn-sm btn-outline" data-i="${i}" onclick="Campo.editarCampo(Number(this.dataset.i))">✏️ Editar</button>
      </div>`;
    return `
      <div class="db-card">
        <div class="db-card-title"><span>Campos (${lst.length})</span></div>
        <p class="campo-sub" style="margin:0 0 10px">Cadastre o campo antes da visita: ele aparece no buscador de quem registra. Corrigir um nome errado vale para o buscador; os registros antigos só mudam se você escolher.</p>
        <button class="btn btn-primary btn-full" onclick="Campo.novoCampoCadastro()">➕ Cadastrar campo</button>
        <input class="inp" type="search" placeholder="🔎 Buscar fazenda ou campo" style="margin:10px 0" oninput="Campo.filtrarCampos(this.value)" autocomplete="off">
        <div id="campo-cad-lista">${lst.length ? lst.map(linha).join('') : '<p class="campo-sub">Nenhum campo ainda.</p>'}</div>
        <p id="campo-cad-vazio" class="campo-sub" style="display:none">Nenhum campo com esse nome.</p>
      </div>`;
  }
  let _camposTela = [];
  function filtrarCampos(txt) {
    const q = _semAcento(txt).trim();
    let n = 0;
    document.querySelectorAll('#campo-cad-lista .campo-cad').forEach(el => {
      const ok = !q || el.dataset.busca.includes(q);
      el.style.display = ok ? '' : 'none';
      if (ok) n++;
    });
    const v = document.getElementById('campo-cad-vazio');
    if (v) v.style.display = n ? 'none' : '';
  }
  const _validaFaz = t => (t.trim() ? '' : 'Informe a fazenda.');
  const _validaCampo = t => (t.trim() ? '' : 'Informe o código do campo.');
  async function novoCampoCadastro() {
    if (!_acompanhaCampo()) return;
    const r = await pedirCampos({
      titulo: 'Cadastrar campo', dica: 'Não registra atividade: só deixa o campo pronto no buscador da equipe.', confirmar: 'Cadastrar',
      campos: [
        { id: 'fazenda', rotulo: 'Fazenda', placeholder: 'ex.: São José', maxlength: 120, validar: _validaFaz },
        { id: 'campo', rotulo: 'Campo', placeholder: 'ex.: BRCB147A-B', maxlength: 60, validar: _validaCampo },
      ],
    });
    if (!r) return;
    setLoading(true, 'Cadastrando…');
    try { await sb.atividadesCampo.cadastrarCampo({ fazenda: r.fazenda.trim(), campo: r.campo.trim() }); toast('Campo cadastrado ✅'); }
    catch (e) { toast(e.message || 'Não foi possível cadastrar', 'err'); }
    finally { setLoading(false); }
    _aba = 'campos';
    await render();
  }
  async function editarCampo(i) {
    const c = _camposTela[i];
    if (!c || !_acompanhaCampo()) return;
    const campos = [
      { id: 'fazenda', rotulo: 'Fazenda', valor: c.fazenda, maxlength: 120, validar: _validaFaz },
      { id: 'campo', rotulo: 'Campo', valor: c.campo, maxlength: 60, validar: _validaCampo },
    ];
    if (c.usos) campos.push({ id: 'registros', valor: 'nao', rotulo: c.usos === 1 ? 'O registro já feito neste campo' : `Os ${c.usos} registros já feitos neste campo`, opcoes: [
      { valor: 'nao', rotulo: 'Deixar como estão' },
      { valor: 'sim', rotulo: 'Corrigir também para o nome novo' },
    ] });
    const r = await pedirCampos({ titulo: 'Editar campo', dica: `${_faz(c.fazenda)} · ${c.campo}`, confirmar: 'Salvar', campos });
    if (!r) return;
    setLoading(true, 'Salvando…');
    try {
      const res = await sb.atividadesCampo.editarCampo({ fazenda_antiga: c.fazenda, campo_antigo: c.campo, fazenda: r.fazenda.trim(), campo: r.campo.trim(), corrigir_registros: r.registros === 'sim' });
      toast(res?.registros_corrigidos ? `Campo corrigido ✅ (${res.registros_corrigidos} registro${res.registros_corrigidos === 1 ? '' : 's'})` : 'Campo corrigido ✅');
    } catch (e) { toast(e.message || 'Não foi possível salvar', 'err'); }
    finally { setLoading(false); }
    await render();
  }
  function filtrarFazenda(f) { _filtroFazenda = f || null; _desenhar(); }
  function filtrarDia(d) { _filtroDia = d || null; if (d) _aba = 'registros'; _desenhar(); }
  function filtrarPend(k) { _filtroPend = PEND[k] ? k : null; if (k) _aba = 'registros'; _desenhar(); }

  function filtrarPessoa(id) { _filtroPessoa = id; _desenhar(); }
  function mudarMes(delta) {
    _filtroDia = null;
    filMes += delta;
    if (filMes > 12) { filMes = 1; filAno++; }
    if (filMes < 1) { filMes = 12; filAno--; }
    render();
  }
  async function reenviar() { setLoading(true); try { await subirFila(); } finally { setLoading(false); } render(); }
  /* Registro que o servidor recusou (ex.: relógio errado) não sobe nunca: a pessoa vê o motivo e pode tirar da fila. */
  async function descartarRecusados() {
    const recusados = (await _minhas()).filter(x => x.erro);
    if (!recusados.length) return;
    if (!(await pedirConfirmacao({ mensagem: `Descartar ${recusados.length} registro${recusados.length > 1 ? 's' : ''} recusado${recusados.length > 1 ? 's' : ''} pelo servidor?\nEles não serão enviados.`, confirmar: 'Descartar', perigo: true }))) return;
    await _salvarFila((await _fila()).filter(x => !(_meu(x) && x.erro)));
    render();
  }

  /* ── Registrar ─────────────────────────────────────────── */
  const _chave = (f, c) => `${String(f || '').trim().replace(/^faz(enda)?\.?\s*/i, '').toUpperCase()}|${String(c || '').trim().toUpperCase()}`;
  async function _historico() {
    let salvo = [];
    try { salvo = (await DB.getMeta(KEY_HIST())) || []; } catch (_) {}
    const doServidor = lista.filter(a => a.user_id === user?.id).map(a => ({ fazenda: a.fazenda, campo: a.campo, em: a.inicio }));
    const vistos = new Map();
    [...salvo, ...doServidor].forEach(h => {
      if (!h?.fazenda || !h?.campo) return;
      const k = _chave(h.fazenda, h.campo), ja = vistos.get(k);
      if (!ja || String(h.em || '') > String(ja.em || '')) vistos.set(k, { fazenda: h.fazenda, campo: String(h.campo).toUpperCase(), em: h.em || '' });
    });
    return [...vistos.values()].sort((a, b) => String(b.em).localeCompare(String(a.em))).slice(0, HIST_MAX);
  }
  async function _guardarNoHistorico(fazenda, campo) {
    const k = _chave(fazenda, campo);
    const h = (await _historico()).filter(x => _chave(x.fazenda, x.campo) !== k);
    h.unshift({ fazenda, campo: campo.toUpperCase(), em: new Date().toISOString() });
    try { await DB.setMeta(KEY_HIST(), h.slice(0, HIST_MAX)); } catch (_) {}
  }

  /* Campos para o buscador: os meus (histórico do aparelho + mês) primeiro, depois os que a equipe já registrou. */
  async function _camposParaBuscar() {
    if (!camposEquipe) { try { camposEquipe = (await DB.getMeta(KEY_CAMPOS)) || []; } catch (_) { camposEquipe = []; } }
    const meus = await _historico();
    const mapa = new Map();
    meus.forEach(h => mapa.set(_chave(h.fazenda, h.campo), { fazenda: h.fazenda, campo: String(h.campo).toUpperCase(), meu: true, em: h.em || '', usos: 0 }));
    (camposEquipe || []).forEach(c => {
      const k = _chave(c.fazenda, c.campo), ja = mapa.get(k);
      if (ja) { ja.usos = Math.max(ja.usos, c.usos || 0); return; }
      mapa.set(k, { fazenda: c.fazenda, campo: String(c.campo).toUpperCase(), meu: (c.meus || 0) > 0, em: c.ultimo_uso || '', usos: c.usos || 0 });
    });
    return [...mapa.values()].sort((a, b) => (b.meu - a.meu) || String(b.em).localeCompare(String(a.em)));
  }
  const _semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

  /* Formulário de campo novo (o ➕ do buscador vai direto para cá). */
  async function _novoCampo(dica, sugestao = {}) {
    return pedirCampos({
      titulo: 'Novo campo', dica, confirmar: 'Registrar início',
      campos: [
        { id: 'fazenda', rotulo: 'Fazenda', valor: sugestao.fazenda || '', placeholder: 'ex.: São José', maxlength: 120, validar: t => (t.trim() ? '' : 'Informe a fazenda.') },
        { id: 'campo', rotulo: 'Campo', valor: sugestao.campo || '', placeholder: 'ex.: BRCB147A-B', maxlength: 60, validar: t => (t.trim() ? '' : 'Informe o código do campo.') },
      ],
    });
  }

  /* Buscador (08/11/2026): procura nos campos já registrados por fazenda ou código; ➕ Novo campo vai direto ao cadastro.
     Devolve {fazenda, campo} ou null. */
  async function _escolherCampo(aberta) {
    const dica = aberta ? `O campo ${aberta.campo} será finalizado agora.` : 'A localização do aparelho é gravada neste toque.';
    const todos = (await _camposParaBuscar()).filter(h => !aberta || _chave(h.fazenda, h.campo) !== _chave(aberta.fazenda, aberta.campo));
    if (!todos.length) return _novoCampo(dica);

    const escolha = await new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay open cp-busca-ov';
      ov.innerHTML = `
        <div class="modal-card cp-busca" role="dialog" aria-label="Escolher campo">
          <div class="modal-hd"><h3>Início das atividades</h3><button class="btn-close-modal" aria-label="Fechar">✕</button></div>
          <div class="modal-bd">
            <p class="cp-busca-dica">${esc(dica)}</p>
            <button class="btn btn-primary btn-full" data-acao="novo">➕ Novo campo</button>
            <input class="inp cp-busca-inp" type="search" placeholder="🔎 Buscar fazenda ou campo" autocomplete="off" autocapitalize="characters" enterkeyhint="search">
            <div class="cp-busca-lista" role="list"></div>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const inp = ov.querySelector('.cp-busca-inp'), listaEl = ov.querySelector('.cp-busca-lista');
      const fechar = v => { ov.remove(); resolve(v); };
      const pintar = () => {
        const q = _semAcento(inp.value.trim());
        const termos = q.split(/\s+/).filter(Boolean);
        const achados = todos.filter(h => { const t = _semAcento(`${_faz(h.fazenda)} ${h.campo}`); return termos.every(x => t.includes(x)); });
        listaEl.innerHTML = achados.length ? achados.slice(0, 60).map(h => `
          <button class="cp-busca-item" role="listitem" data-i="${todos.indexOf(h)}">
            <span class="cp-busca-campo">${esc(h.campo)}</span>
            <span class="cp-busca-faz">${esc(_faz(h.fazenda))}</span>
            <span class="cp-busca-sub">${h.meu ? '⭐ já usado por você' : '👥 registrado pela equipe'}${h.em ? ' · último ' + dataBR(h.em) : ''}</span>
          </button>`).join('') + (achados.length > 60 ? `<p class="muted-p">+ ${achados.length - 60} — refine a busca</p>` : '')
          : `<p class="muted-p">Nenhum campo encontrado${q ? ` para “${esc(inp.value.trim())}”` : ''}.</p>
             ${q ? `<button class="btn btn-outline btn-full" data-acao="novo-busca">➕ Cadastrar “${esc(inp.value.trim().toUpperCase())}” como novo campo</button>` : ''}`;
      };
      /* tocar fora da caixa fecha; dentro dela, só os botões agem */
      ov.addEventListener('click', e => {
        if (e.target === ov || e.target.closest('.btn-close-modal')) return fechar(null);
        if (!e.target.closest('.cp-busca')) return;
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.acao === 'novo') return fechar({ novo: true });
        if (b.dataset.acao === 'novo-busca') return fechar({ novo: true, campo: inp.value.trim().toUpperCase() });
        if (b.dataset.i != null) return fechar(todos[Number(b.dataset.i)]);
      });
      inp.addEventListener('input', pintar);
      ov.addEventListener('keydown', e => { if (e.key === 'Escape') fechar(null); });
      pintar();
      setTimeout(() => inp.focus(), 50);
    });
    if (!escolha) return null;
    if (escolha.novo) return _novoCampo(dica, { fazenda: todos.find(h => h.meu)?.fazenda || '', campo: escolha.campo || '' });
    const ok = await pedirConfirmacao({ mensagem: `Iniciar atividade agora?\n${_faz(escolha.fazenda)} · ${escolha.campo}`, confirmar: 'Registrar início' });
    return ok ? { fazenda: escolha.fazenda, campo: escolha.campo } : null;
  }

  async function iniciar() {
    if (!_registraCampo()) { toast('A atividade em campo não está liberada para a sua conta', 'err'); return; }
    const aberta = await _aberta();
    const r = await _escolherCampo(aberta);
    if (!r) return;
    setLoading(true, 'Pegando a localização…');
    let depois = null;   // oferta de compartilhar só depois de fechar o "carregando"
    try {
      const loc = await localizar();
      const dados = { id: crypto.randomUUID(), fazenda: r.fazenda.trim(), campo: r.campo.trim().toUpperCase(), hora: new Date().toISOString() };
      if (!loc.erro) Object.assign(dados, { lat: loc.lat, lng: loc.lng, precisao: Math.round(loc.precisao) });
      /* Iniciar sem fechar: o servidor fecha o anterior sozinho; na fila, o fim automático acontece quando subir. */
      await _registrar({ tipo: 'iniciar', dados }, () => sb.atividadesCampo.iniciar(dados));
      await _guardarNoHistorico(dados.fazenda, dados.campo);
      if (loc.erro) toast('Registrado sem localização: ' + loc.erro, 'err', 6000);
      await render();
      depois = { ...dados, inicio: dados.hora, lat_inicio: dados.lat, lng_inicio: dados.lng };
    } catch (e) { toast(e.message || 'Não foi possível registrar', 'err'); }
    finally { setLoading(false); }
    if (depois) await _oferecerCompartilhar('inicio', depois);
  }

  async function finalizar() {
    const aberta = await _aberta();
    if (!aberta) { toast('Nenhuma atividade aberta', 'err'); return; }
    if (!(await pedirConfirmacao({ mensagem: `Fim das atividades\n${_faz(aberta.fazenda)} · ${aberta.campo}`, confirmar: 'Registrar fim' }))) return;
    setLoading(true, 'Pegando a localização…');
    let depois = null;
    try {
      const loc = await localizar();
      const dados = { hora: new Date().toISOString() };
      if (!loc.erro) Object.assign(dados, { lat: loc.lat, lng: loc.lng, precisao: Math.round(loc.precisao) });
      await _registrar({ tipo: 'finalizar', id: aberta.id, dados }, () => sb.atividadesCampo.finalizar(aberta.id, dados));
      if (loc.erro) toast('Registrado sem localização: ' + loc.erro, 'err', 6000);
      await render();
      depois = { ...aberta, fim: dados.hora, lat_fim: dados.lat, lng_fim: dados.lng };
    } catch (e) { toast(e.message || 'Não foi possível registrar', 'err'); }
    finally { setLoading(false); }
    if (depois) await _oferecerCompartilhar('fim', depois);
  }

  /* online → envia; sem rede (ou caiu no meio) → fila. Erro de regra do servidor (403/422) sobe para quem chamou. */
  async function _registrar(item, enviar) {
    const filaAntes = await _minhas();
    if (!navigator.onLine || !sb || filaAntes.length) {
      /* com fila pendente, entra no fim dela para manter a ordem (iniciar antes de finalizar) */
      await _enfileirar(item);
      if (navigator.onLine && sb) await subirFila();
      else toast('📴 Sem internet: registro guardado com a hora do aparelho');
      return;
    }
    try { await enviar(); toast(item.tipo === 'iniciar' ? 'Início registrado ✅' : 'Fim registrado ✅'); }
    catch (e) {
      if (!e?.status) { await _enfileirar(item); toast('📴 Conexão falhou: registro guardado no aparelho'); }
      else throw e;
    }
  }

  /* ── Compartilhar no padrão do grupo (pedido do Paulo) ──── */
  function _texto(qual, a) {
    const lat = qual === 'fim' ? a.lat_fim : a.lat_inicio, lng = qual === 'fim' ? a.lng_fim : a.lng_inicio;
    const m = mapa(lat, lng);
    /* horário do registro (fuso de Brasília); no fim, também o início e a duração */
    const quando = qual === 'fim' ? a.fim : a.inicio;
    let hora = quando ? `🕒 ${dataBR(quando)} às ${horaBR(quando)}` : null;
    if (hora && qual === 'fim' && a.inicio) {
      const min = (new Date(a.fim) - new Date(a.inicio)) / 60000;
      hora += ` (início ${horaBR(a.inicio)}${min >= 0 ? ` · ${hm(min)}` : ''})`;
    }
    return [qual === 'fim' ? 'Fim das atividades' : 'Início das atividades', _faz(a.fazenda), String(a.campo || '').toUpperCase(), hora, m ? `📍 ${m}` : null]
      .filter(Boolean).join('\n');
  }
  /* Pedido de 09/11/2026: com o OK do registro, já abrir o compartilhar (postar sozinho no grupo
     não dá: a API oficial do WhatsApp não entra em grupo existente). O celular só deixa abrir o
     menu de compartilhar logo depois de um toque; se o GPS demorou e esse "crédito" do toque
     acabou, cai na pergunta de antes, cujo botão vale como toque novo. */
  async function _oferecerCompartilhar(qual, a) {
    if (navigator.share && navigator.userActivation?.isActive) {
      try { await navigator.share({ text: _texto(qual, a) }); return; }
      catch (e) { if (e?.name === 'AbortError') return; }
    }
    if (await pedirConfirmacao({ mensagem: `${qual === 'fim' ? 'Fim' : 'Início'} registrado ✅\nQuer compartilhar no grupo?`, confirmar: '📤 Compartilhar', cancelar: 'Agora não' })) {
      await compartilhar(_texto(qual, a));
    }
  }
  async function compartilhar(texto) {
    if (navigator.share) {
      try { await navigator.share({ text: texto }); return; }
      catch (e) { if (e?.name === 'AbortError') return; }
    }
    window.open('https://wa.me/?text=' + encodeURIComponent(texto), '_blank', 'noopener');
  }
  /* ── Corrigir registro (09/11/2026) ─────────────────────── */
  /* Dono e gestor/admin corrigem fazenda, campo e observação; só gestor/admin a hora. Localização nunca muda.
     A hora é digitada HH:MM no dia do início (fuso de Brasília); fim menor que o início = passou da meia-noite. */
  const _hhmm = /^([01]?\d|2[0-3]):?([0-5]\d)$/;
  const _isoBR = (dia, txt) => { const m = txt.match(_hhmm); return `${dia}T${m[1].padStart(2, '0')}:${m[2]}:00-03:00`; };
  async function editar(id) {
    const a = lista.find(x => x.id === id);
    if (!a) return;
    if (!navigator.onLine || !sb) { toast('Sem internet: corrija quando voltar a conexão', 'err'); return; }
    const gestor = _acompanhaCampo();   // gestor, admin e focal corrigem a hora
    const campos = [
      { id: 'fazenda', rotulo: 'Fazenda', valor: a.fazenda, maxlength: 120, validar: t => t ? '' : 'Informe a fazenda' },
      { id: 'campo', rotulo: 'Campo', valor: a.campo, maxlength: 60, validar: t => t ? '' : 'Informe o campo' },
    ];
    if (gestor) {
      campos.push({ id: 'inicio', rotulo: `Hora do início (${dataBR(a.inicio)})`, valor: horaBR(a.inicio), inputmode: 'numeric', placeholder: 'HH:MM',
        validar: t => _hhmm.test(t) ? '' : 'Hora do início no formato HH:MM' });
      if (a.fim) campos.push({ id: 'fim', rotulo: 'Hora do fim', valor: horaBR(a.fim), inputmode: 'numeric', placeholder: 'HH:MM',
        validar: t => _hhmm.test(t) ? '' : 'Hora do fim no formato HH:MM' });
    }
    campos.push({ id: 'observacao', rotulo: 'Observação (opcional)', valor: a.observacao || '', maxlength: 500, linhas: 2 });
    const r = await pedirCampos({
      titulo: '✏️ Corrigir registro',
      dica: gestor ? 'A localização não muda. O registro fica marcado como editado.' : 'A localização e a hora não mudam (hora errada? peça ao gestor ou ao focal). O registro fica marcado como editado.',
      confirmar: 'Salvar correção', campos,
    });
    if (!r) return;
    const corpo = { fazenda: r.fazenda, campo: r.campo, observacao: r.observacao };
    if (gestor) {
      const dia = new Date(a.inicio).toLocaleDateString('sv-SE', { timeZone: FusoBR.TZ });
      corpo.inicio = _isoBR(dia, r.inicio);
      if (a.fim) {
        let fim = _isoBR(dia, r.fim);
        if (new Date(fim) < new Date(corpo.inicio)) {   // passou da meia-noite
          const d = new Date(dia + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
          fim = _isoBR(d.toISOString().slice(0, 10), r.fim);
        }
        corpo.fim = fim;
      }
    }
    setLoading(true, 'Salvando a correção…');
    try {
      const novo = await sb.atividadesCampo.editar(id, corpo);
      const i = lista.findIndex(x => x.id === id);
      if (i >= 0) lista[i] = { ...lista[i], ...novo };
      toast(novo.editado_em ? 'Registro corrigido ✏️' : 'Nada mudou');
      await render();
    } catch (e) { toast(e.message || 'Não foi possível corrigir', 'err', 6000); }
    finally { setLoading(false); }
  }

  async function compartilharId(id) {
    const a = lista.find(x => x.id === id);
    if (!a) return;
    await compartilhar(_texto(a.fim ? 'fim' : 'inicio', a));
  }

  /* ── Planilha do mês ───────────────────────────────────── */
  /* Só gestor/admin (pedido de 08/11/2026). Leva os filtros de colaborador e fazenda que estão na tela. */
  async function exportarExcel() {
    if (!_acompanhaCampo()) { toast('A planilha é do gestor e do focal', 'err'); return; }
    const vis = _filtrados();
    if (!vis.length) { toast('Nada para exportar neste mês', 'err'); return; }
    const filtro = [
      _filtroPessoa ? `Colaborador: ${vis[0]?.user_nome || ''}` : 'Todos os colaboradores',
      _filtroFazenda ? `Fazenda: ${_filtroFazenda}` : 'todas as fazendas',
    ].join(' · ');
    setLoading(true, 'Gerando a planilha…');
    try { await Excel.exportarCampo(vis, filMes, filAno, agregar(vis), filtro); toast('Planilha gerada 📗'); }
    catch (e) { toast('Planilha: ' + e.message, 'err'); }
    finally { setLoading(false); }
  }

  return { render, iniciar, finalizar, mudarMes, filtrarPessoa, filtrarFazenda, filtrarDia, filtrarPend, aba, agregar, reenviar, descartarRecusados, subirFila, compartilharId, editar, exportarExcel, novoCampoCadastro, editarCampo, filtrarCampos, _texto };
})();
