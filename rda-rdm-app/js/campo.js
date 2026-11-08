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
   admin sempre veem a tela para acompanhar quem está em campo e onde.

   Depende de globais do app.js: $, sb, user, toast, setLoading, esc,
   fmtData, filMes, filAno, MESES, _ehGestorOuAdmin, _registraCampo, DB,
   viewAtual, FusoBR, pedirCampos, pedirConfirmacao.
───────────────────────────────────────────────────────────── */
window.Campo = (() => {

  const KEY_FILA = 'campo_fila';
  const KEY_CACHE = () => `campo_cache_${filAno}_${filMes}`;
  const KEY_ULTIMOS = 'campo_ultimos';      // fazendas/campos usados por último (sugestão)
  const _atG = s => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const hm = min => { min = Math.max(0, Math.round(Number(min) || 0)); return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`; };
  const horaBR = iso => iso ? FusoBR.hora(new Date(iso), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '—';
  const dataBR = iso => iso ? fmtData(new Date(iso).toLocaleDateString('sv-SE', { timeZone: FusoBR.TZ })) : '';   // sv-SE = AAAA-MM-DD
  const mapa = (lat, lng) => (lat != null && lng != null) ? `https://www.google.com/maps?q=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}` : null;

  let lista = [];          // atividades do mês (minhas; do gestor: todas)
  let equipe = [];         // gestor: último registro de cada pessoa ligada
  let _offline = false, _cacheEm = null;
  let _filtroPessoa = null;

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
    const gestor = _ehGestorOuAdmin();
    const [l, e] = await Promise.all([sb.atividadesCampo.list(_periodo()), gestor ? sb.atividadesCampo.equipe() : Promise.resolve([])]);
    lista = l || []; equipe = e || [];
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
  async function render() {
    const el = $('app-content');
    el.innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando atividade em campo…</p></div>';
    try { await carregar(); } catch (_) { await carregarDoCache(); }
    const gestor = _ehGestorOuAdmin();
    const registra = _registraCampo();
    const aberta = registra ? await _aberta() : null;
    const fila = await _minhas();
    const comErro = fila.filter(x => x.erro);
    const periodo = `${MESES[filMes - 1]} ${filAno}`;

    let html = `<div class="db-container">
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

    const vis = (_filtroPessoa ? lista.filter(a => a.user_id === _filtroPessoa) : (gestor ? lista : lista.filter(a => a.user_id === user?.id)));
    html += `
      <div class="ini-titulo" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <span>${gestor ? 'Registros da equipe' : 'Meus registros'} (${vis.length})</span>
        <span style="display:flex;gap:6px;flex-wrap:wrap">
          ${_filtroPessoa ? '<button class="btn btn-sm btn-outline" onclick="Campo.filtrarPessoa(null)">Todos</button>' : ''}
          ${vis.length ? `<button class="btn btn-sm btn-primary" onclick="Campo.exportarExcel()">📗 Planilha ${MESES[filMes - 1]}</button>` : ''}
        </span>
      </div>
      <div class="notas-list">
        ${vis.length ? vis.map(a => _cartao(a, gestor)).join('') : '<p class="muted-p">Nenhum registro neste mês.</p>'}
      </div>
    </div>`;
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
          </div>
          <div class="nota-body">
            <div class="nota-empresa">${esc(_faz(a.fazenda))} · <b>${esc(a.campo)}</b></div>
            <div class="nota-cnpj">${horaBR(a.inicio)} → ${a.fim ? horaBR(a.fim) : '…'}${a.minutos != null ? ` · ${hm(a.minutos)}` : ''}</div>
            <div class="nota-cnpj campo-links">
              ${mi ? `<a class="link" href="${_atG(mi)}" target="_blank" rel="noopener">📍 início${a.precisao_inicio ? ` (±${a.precisao_inicio} m)` : ''}</a>` : '<span>📍 início sem localização</span>'}
              ${a.fim ? (mf ? `<a class="link" href="${_atG(mf)}" target="_blank" rel="noopener">📍 fim${a.precisao_fim ? ` (±${a.precisao_fim} m)` : ''}</a>` : '<span>📍 fim sem localização</span>') : ''}
            </div>
          </div>
          ${a.user_id === user?.id ? `<div class="nota-foot"><span></span><div class="nota-actions">
            <button class="btn btn-sm btn-outline" data-id="${_atG(a.id)}" onclick="Campo.compartilharId(this.dataset.id)">📤 Compartilhar</button>
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

  function filtrarPessoa(id) { _filtroPessoa = id; render(); }
  function mudarMes(delta) {
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
  async function _ultimos() { try { return (await DB.getMeta(KEY_ULTIMOS)) || {}; } catch (_) { return {}; } }

  async function iniciar() {
    if (!_registraCampo()) { toast('A atividade em campo não está liberada para a sua conta', 'err'); return; }
    const aberta = await _aberta();
    const ult = await _ultimos();
    const r = await pedirCampos({
      titulo: 'Início das atividades',
      dica: aberta ? `O campo ${aberta.campo} será finalizado agora.` : 'A localização do aparelho é gravada neste toque.',
      confirmar: 'Registrar início',
      campos: [
        { id: 'fazenda', rotulo: 'Fazenda', valor: ult.fazenda || '', placeholder: 'ex.: São José', maxlength: 120, validar: t => (t.trim() ? '' : 'Informe a fazenda.') },
        { id: 'campo', rotulo: 'Campo', valor: '', placeholder: 'ex.: BRCB147A-B', maxlength: 60, validar: t => (t.trim() ? '' : 'Informe o código do campo.') },
      ],
    });
    if (!r) return;
    setLoading(true, 'Pegando a localização…');
    let depois = null;   // oferta de compartilhar só depois de fechar o "carregando"
    try {
      const loc = await localizar();
      const dados = { id: crypto.randomUUID(), fazenda: r.fazenda.trim(), campo: r.campo.trim().toUpperCase(), hora: new Date().toISOString() };
      if (!loc.erro) Object.assign(dados, { lat: loc.lat, lng: loc.lng, precisao: Math.round(loc.precisao) });
      /* Iniciar sem fechar: o servidor fecha o anterior sozinho; na fila, o fim automático acontece quando subir. */
      await _registrar({ tipo: 'iniciar', dados }, () => sb.atividadesCampo.iniciar(dados));
      try { await DB.setMeta(KEY_ULTIMOS, { fazenda: dados.fazenda }); } catch (_) {}
      if (loc.erro) toast('Registrado sem localização: ' + loc.erro, 'err', 6000);
      await render();
      depois = { ...dados, lat_inicio: dados.lat, lng_inicio: dados.lng };
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
      depois = { ...aberta, lat_fim: dados.lat, lng_fim: dados.lng };
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
    return [qual === 'fim' ? 'Fim das atividades' : 'Início das atividades', _faz(a.fazenda), String(a.campo || '').toUpperCase(), m ? `📍 ${m}` : null]
      .filter(Boolean).join('\n');
  }
  async function _oferecerCompartilhar(qual, a) {
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
  async function compartilharId(id) {
    const a = lista.find(x => x.id === id);
    if (!a) return;
    await compartilhar(_texto(a.fim ? 'fim' : 'inicio', a));
  }

  /* ── Planilha do mês ───────────────────────────────────── */
  async function exportarExcel() {
    const vis = _filtroPessoa ? lista.filter(a => a.user_id === _filtroPessoa) : (_ehGestorOuAdmin() ? lista : lista.filter(a => a.user_id === user?.id));
    if (!vis.length) { toast('Nada para exportar neste mês', 'err'); return; }
    setLoading(true, 'Gerando a planilha…');
    try { await Excel.exportarCampo(vis, filMes, filAno); toast('Planilha gerada 📗'); }
    catch (e) { toast('Planilha: ' + e.message, 'err'); }
    finally { setLoading(false); }
  }

  return { render, iniciar, finalizar, mudarMes, filtrarPessoa, reenviar, descartarRecusados, subirFila, compartilharId, exportarExcel, _texto };
})();
