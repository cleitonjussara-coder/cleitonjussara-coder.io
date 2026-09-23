'use strict';
/* ─────────────────────────────────────────────────────────────
   FROTA.js — registro de KM dos veículos (pedido em 16/09/2026)

   Cada colaborador registra a leitura do odômetro do veículo que está
   usando (data, km, observação e, se quiser, foto do painel). O gestor vê,
   por veículo, o km rodado no mês e quem dirigiu; também cadastra os
   veículos. Dashboard e planilha (Excel/CSV) vêm de GET /frota/anual.

   OFFLINE (18/09/2026): a tela guarda no aparelho o que baixou por último
   (veículos, registros do mês, resumo, anual) e mostra isso sem internet;
   registro novo sem sinal entra numa FILA local (com a foto) e sobe
   sozinho quando a conexão volta — igual às notas. Cadastro de veículo
   continua só online (é raro e é do gestor).

   Depende de globais do app.js: $, sb, user, toast, setLoading, esc,
   fmtData, filMes, filAno, MESES, _ehGestorOuAdmin, switchView, DB.
───────────────────────────────────────────────────────────── */
window.Frota = (() => {

  let veiculos = [];      // ativos (gestor: todos, ao gerenciar)
  let registros = [];     // do mês em foco (visíveis para mim) + pendentes locais
  let resumo = null;      // {veiculos:[...], total_km}
  let anual = null;       // GET /frota/anual do ano em foco
  let _fotoKm = null;     // File escolhido no formulário
  let _offline = false;   // renderizou a partir do cache
  let _cacheEm = null;    // quando o cache foi gravado
  let _filtroVeiculo = null;

  const kmFmt = n => Number(n || 0).toLocaleString('pt-BR');
  const KEY_CACHE = () => `frota_cache_${filAno}_${filMes}`;
  const KEY_ANUAL = () => `frota_anual_${filAno}`;
  const KEY_FILA = 'frota_fila';

  /* ── Fila local (registros feitos sem internet) ─────────── */
  async function _fila() { try { return (await DB.getMeta(KEY_FILA)) || []; } catch (_) { return []; } }
  async function _salvarFila(f) { try { await DB.setMeta(KEY_FILA, f); } catch (_) {} }

  async function enfileirar(id, payload, foto) {
    const f = await _fila();
    const i = f.findIndex(x => x.id === id);
    const item = { id, payload, foto: foto || (i >= 0 ? f[i].foto : null), criado_em: new Date().toISOString(), erro: null };
    if (i >= 0) f[i] = item; else f.push(item);
    await _salvarFila(f);
  }

  /* Sobe a fila. Chamado ao abrir a tela com internet, ao salvar e no evento
     'online'. 422 (odômetro menor) fica na fila com o erro, para a pessoa
     corrigir pelo ✏️ — nunca se perde. */
  let _subindo = false;
  async function subirFila() {
    if (_subindo || !sb || !navigator.onLine) return 0;
    _subindo = true;
    let ok = 0;
    try {
      const f = await _fila();
      if (!f.length) return 0;
      const resto = [];
      for (const it of f) {
        try {
          await sb.frota.kmUpsert(it.id, it.payload);
          if (it.foto?.blob) {
            try { await sb.frota.kmFoto(it.id, it.foto.blob, it.foto.ext || 'jpg'); }
            catch (e) { console.warn('[frota] foto da fila não subiu:', e.message); }
          }
          ok++;
        } catch (e) {
          const semRede = !e?.status;                       // fetch falhou: tenta depois
          resto.push({ ...it, erro: semRede ? null : (e.message || 'falhou') });
          if (semRede) { resto.push(...f.slice(f.indexOf(it) + 1)); break; }
        }
      }
      await _salvarFila(resto);
      if (ok) toast(`${ok} registro${ok > 1 ? 's' : ''} de KM enviado${ok > 1 ? 's' : ''} ✅`);
    } finally { _subindo = false; }
    return ok;
  }
  window.addEventListener('online', () => { subirFila().then(n => { if (n && viewAtual === 'frota') render(); }).catch(() => {}); });

  /* ── Carga (rede → cache) ───────────────────────────────── */
  async function carregar() {
    if (!sb || !navigator.onLine) throw new Error('offline');
    await subirFila();
    const gestor = _ehGestorOuAdmin();
    const [v, r, s, a] = await Promise.all([
      sb.frota.veiculos(gestor),
      sb.frota.km({ ano: filAno, mes: filMes }),
      gestor ? sb.frota.resumo(filAno, filMes) : Promise.resolve(null),
      sb.frota.anual(filAno),
    ]);
    veiculos = v || []; registros = r || []; resumo = s; anual = a;
    _offline = false; _cacheEm = new Date().toISOString();
    try {
      await DB.setMeta(KEY_CACHE(), { veiculos, registros, resumo, em: _cacheEm });
      await DB.setMeta(KEY_ANUAL(), anual);
      await DB.setMeta('frota_veiculos', veiculos);        // para o formulário offline em qualquer mês
    } catch (_) {}
  }
  async function carregarDoCache() {
    const c = await DB.getMeta(KEY_CACHE()).catch(() => null);
    veiculos = c?.veiculos || (await DB.getMeta('frota_veiculos').catch(() => null)) || [];
    registros = c?.registros || []; resumo = c?.resumo || null;
    anual = await DB.getMeta(KEY_ANUAL()).catch(() => null);
    _cacheEm = c?.em || null; _offline = true;
  }
  /* registros da fila aparecem na lista como pendentes */
  async function _mesclarPendentes() {
    const f = await _fila();
    const pend = f.filter(it => { const d = it.payload.data || ''; return Number(d.slice(0, 4)) === filAno && Number(d.slice(5, 7)) === filMes; })
      .map(it => {
        const v = veiculos.find(x => x.id === it.payload.veiculo_id);
        return { id: it.id, veiculo_id: it.payload.veiculo_id, placa: v?.placa || '?', modelo: v?.modelo, user_id: user?.id, user_nome: user?.nome,
                 data: it.payload.data, odometro: it.payload.odometro, observacao: it.payload.observacao, foto_path: null,
                 _pendente: true, _erro: it.erro, _foto: !!it.foto };
      });
    const ids = new Set(pend.map(p => p.id));
    registros = [...pend, ...registros.filter(r => !ids.has(r.id))];
  }

  /* ── Tela ───────────────────────────────────────────────── */
  async function render() {
    const el = $('app-content');
    el.innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando frota…</p></div>';
    try { await carregar(); }
    catch (e) {
      await carregarDoCache();
      if (!veiculos.length && !registros.length && !anual) {
        el.innerHTML = `<div class="db-container"><div class="db-card" style="text-align:center;padding:24px">
          <div style="font-size:31px">🚗</div><p style="margin-top:8px;color:var(--text2)">Sem conexão e sem dados guardados ainda. Abra a Frota uma vez com internet.</p>
          <button class="btn btn-outline" style="margin-top:12px" onclick="Frota.render()">Tentar de novo</button></div></div>`;
        return;
      }
    }
    await _mesclarPendentes();
    const gestor = _ehGestorOuAdmin();
    const periodo = `${MESES[filMes - 1]} ${filAno}`;
    const fila = await _fila();

    let html = `
    <div class="db-container">
      <div class="page-hd" style="padding:0">
        <div class="mes-nav">
          <button class="btn-mes-nav" onclick="Frota.mudarMes(-1)">‹</button>
          <span class="mes-label">${periodo}</span>
          <button class="btn-mes-nav" onclick="Frota.mudarMes(1)">›</button>
        </div>
      </div>
      ${_offline ? `<div class="ini-dica" style="border-left:3px solid var(--warning)">📴 <b>Sem internet</b> — mostrando o que foi baixado${_cacheEm ? ' em ' + new Date(_cacheEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}. Você pode registrar KM normalmente: fica guardado e sobe sozinho.</div>` : ''}
      ${fila.length ? `<div class="ini-dica" style="border-left:3px solid var(--warning)">⏳ <b>${fila.length} registro${fila.length > 1 ? 's' : ''} aguardando envio</b>${fila.some(f => f.erro) ? ' — algum foi recusado pelo servidor; veja o ⚠️ na lista e corrija pelo ✏️' : ''}. ${navigator.onLine ? '<a class="link" onclick="Frota.reenviar()">Enviar agora</a>' : ''}</div>` : ''}

      <button class="pnl" onclick="Frota.abrirForm()">
        <span class="pnl-conteudo" style="max-width:80%">
          <span class="pnl-ico">🛣️</span>
          <span class="pnl-tit">Registrar KM</span>
          <span class="pnl-sub">Leitura do odômetro do veículo que você está usando — leva 10 segundos.</span>
        </span>
      </button>`;

    if (!veiculos.filter(v => v.ativo !== false).length) {
      html += `<div class="ini-dica">🚗 Nenhum veículo cadastrado ainda.${gestor ? ' Cadastre o primeiro em <b>Veículos</b>, abaixo.' : ' Peça ao gestor para cadastrar os veículos.'}</div>`;
    }

    html += _dashboardHTML(gestor, periodo);

    /* Registros do mês */
    const lista = _filtroVeiculo ? registros.filter(r => r.veiculo_id === _filtroVeiculo) : registros;
    html += `
      <div class="ini-titulo" style="display:flex;justify-content:space-between;align-items:center">
        <span>${gestor ? 'Registros do mês' : 'Meus registros'} (${lista.length})</span>
        ${_filtroVeiculo ? `<button class="btn btn-sm btn-outline" onclick="Frota.filtrarVeiculo(null)">Todos os veículos</button>` : ''}
      </div>
      <div class="notas-list">
        ${lista.length ? lista.map(r => `
        <div class="nota-card" style="${r._pendente ? 'border-left:3px solid var(--warning)' : ''}">
          <div class="nota-head">
            <span class="tipo-badge tipo-RDM">🚗 ${esc(r.placa || '?')}</span>
            ${gestor && r.user_nome ? `<span class="subtipo-tag">👤 ${esc(r.user_nome)}</span>` : ''}
            ${r._pendente ? (r._erro ? `<span class="doc-tag dup" title="${esc(r._erro)}">⚠️ recusado</span>` : '<span class="sync-pill pending">⏳ pendente</span>') : ''}
            <span class="nota-data">${fmtData(r.data)}</span>
          </div>
          <div class="nota-body">
            <div class="nota-empresa">${kmFmt(r.odometro)} km</div>
            ${r.observacao ? `<div class="nota-obs">${esc(r.observacao)}</div>` : ''}
            ${r._erro ? `<div class="nota-obs" style="color:#a12626">${esc(r._erro)}</div>` : ''}
          </div>
          <div class="nota-foot">
            <span class="nota-valor" style="font-size:14px;color:var(--text2)">${r.foto_path || r._foto ? '📷 com foto' : ''}</span>
            <div class="nota-actions">
              ${r.foto_path ? `<button class="btn-icon-sm" onclick="Frota.verFoto('${r.id}')" title="Ver foto do odômetro">📎</button>` : ''}
              ${(r.user_id === user?.id || user?.role === 'admin') ? `
              <button class="btn-icon-sm" onclick="Frota.abrirForm('${r.id}')" title="Editar">✏️</button>
              <button class="btn-icon-sm danger" onclick="Frota.excluir('${r.id}')" title="Excluir">🗑</button>` : ''}
            </div>
          </div>
        </div>`).join('') : `<p class="muted-p">Nenhum registro neste mês.</p>`}
      </div>`;

    /* Veículos (gestor/admin) */
    if (gestor) {
      html += `
      <div class="ini-titulo" style="display:flex;justify-content:space-between;align-items:center">
        <span>Veículos (${veiculos.length})</span>
        <button class="btn btn-sm btn-primary" onclick="Frota.abrirFormVeiculo()" ${_offline ? 'disabled title="Precisa de internet"' : ''}>＋ Veículo</button>
      </div>
      <div class="notas-list">
        ${veiculos.map(v => `
        <div class="nota-card" style="${v.ativo === false ? 'opacity:.55' : ''}">
          <div class="nota-head">
            <span class="tipo-badge tipo-RDM">🚗 ${esc(v.placa)}</span>
            ${v.modelo ? `<span class="subtipo-tag">${esc(v.modelo)}</span>` : ''}
            ${v.ativo === false ? '<span class="subtipo-tag">inativo</span>' : ''}
            <span class="nota-data">${v.responsavel_nome ? '👤 ' + esc(v.responsavel_nome) : ''}</span>
          </div>
          <div class="nota-foot">
            <span></span>
            <div class="nota-actions"><button class="btn-icon-sm" onclick="Frota.abrirFormVeiculo('${v.id}')" title="Editar" ${_offline ? 'disabled' : ''}>✏️</button></div>
          </div>
        </div>`).join('')}
      </div>`;
    }

    html += '</div>';
    el.innerHTML = html;
  }

  /* ── Dashboard ──────────────────────────────────────────── */
  function _dashboardHTML(gestor, periodo) {
    if (!anual) return '';
    const i = filMes - 1;
    const kmMes = anual.meses_total?.[i] || 0;
    const kmAno = anual.total || 0;
    const vAtivos = (anual.veiculos || []).filter(v => v.ativo !== false);
    const leiturasMes = (anual.leituras || []).filter(l => l.mes === filMes).length;
    const media = vAtivos.length ? Math.round(kmMes / vAtivos.length) : 0;
    const porVeiculo = vAtivos.map(v => ({ nome: `${v.placa}${v.modelo ? ' · ' + v.modelo : ''}`, id: v.veiculo_id, val: v.meses?.[i] || 0 })).sort((a, b) => b.val - a.val);
    const porMotorista = (anual.motoristas || []).map(m => ({ nome: m.nome, val: m.meses?.[i] || 0 })).filter(m => m.val > 0).sort((a, b) => b.val - a.val);
    const maxV = Math.max(1, ...porVeiculo.map(x => x.val));
    const maxM = Math.max(1, ...porMotorista.map(x => x.val));
    const maxMes = Math.max(1, ...(anual.meses_total || []));
    const rank = (arr, max, onclick) => arr.length ? arr.map((f, k) => `
      <div class="db-rank-item" ${onclick ? `style="cursor:pointer" onclick="${onclick(f)}"` : ''}>
        <div class="db-rank-meta"><span class="db-rank-pos">${k + 1}º</span><span class="db-rank-name">${esc(f.nome)}</span><span class="db-rank-val">${kmFmt(f.val)} km</span></div>
        <div class="db-rank-track"><div class="db-rank-fill" style="width:${Math.max(3, Math.round(f.val / max * 100))}%"></div></div>
      </div>`).join('') : '<p class="muted-p">Sem km neste mês.</p>';

    return `
      <div class="ini-titulo">${gestor ? 'Frota' : 'Meus km'} — ${periodo}</div>
      <div class="ini-resumo">
        <div class="ini-kpi"><div class="ini-kpi-lbl">Km no mês</div><div class="ini-kpi-val">${kmFmt(kmMes)}</div><div class="ini-kpi-sub">${leiturasMes} leitura${leiturasMes === 1 ? '' : 's'}</div></div>
        <div class="ini-kpi"><div class="ini-kpi-lbl">Km no ano</div><div class="ini-kpi-val">${kmFmt(kmAno)}</div><div class="ini-kpi-sub">${anual.ano}</div></div>
        ${gestor ? `
        <div class="ini-kpi"><div class="ini-kpi-lbl">Veículos ativos</div><div class="ini-kpi-val">${vAtivos.length}</div><div class="ini-kpi-sub">${porVeiculo.filter(v => v.val > 0).length} rodaram no mês</div></div>
        <div class="ini-kpi"><div class="ini-kpi-lbl">Média por veículo</div><div class="ini-kpi-val">${kmFmt(media)}</div><div class="ini-kpi-sub">km no mês</div></div>` : ''}
      </div>

      <div class="db-card">
        <div class="db-card-title"><span>Evolução ${anual.ano}</span><span style="font-size:13px;color:var(--text2)">km por mês</span></div>
        <div class="evo">${(anual.meses_total || []).map((v, k) => `<div class="evo-col ${k === i ? 'cur' : ''}" title="${MESES[k]}: ${kmFmt(v)} km"><div class="evo-bar" style="height:${Math.max(2, Math.round(v / maxMes * 100))}%"></div></div>`).join('')}</div>
        <div class="evo-labels">${MESES.map((m, k) => `<span class="${k === i ? 'cur' : ''}">${m.slice(0, 3)}</span>`).join('')}</div>
      </div>

      <div class="db-card">
        <div class="db-card-title"><span>Km por veículo</span><span style="font-size:13px;color:var(--text2)">${periodo}</span></div>
        <div class="db-rank">${rank(porVeiculo, maxV, f => `Frota.filtrarVeiculo('${f.id}')`)}</div>
      </div>
      ${gestor ? `
      <div class="db-card">
        <div class="db-card-title"><span>Km por motorista</span><span style="font-size:13px;color:var(--text2)">${periodo}</span></div>
        <div class="db-rank">${rank(porMotorista, maxM)}</div>
      </div>` : ''}

      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" onclick="Frota.exportarCSV()">CSV ${MESES[filMes - 1]}</button>
        <button class="btn btn-primary btn-sm" onclick="Frota.exportarExcel()">📗 Planilha de controle ${anual.ano} (Excel)</button>
      </div>`;
  }

  async function exportarExcel() {
    if (!anual) { toast('Abra a Frota com internet uma vez para gerar a planilha', 'err'); return; }
    setLoading(true, 'Gerando a planilha…');
    try { await Excel.exportarFrota(anual); toast('Planilha gerada 📗'); } catch (e) { toast('Planilha: ' + e.message, 'err'); }
    finally { setLoading(false); }
  }
  async function exportarCSV() {
    if (!anual) { toast('Abra a Frota com internet uma vez para gerar o CSV', 'err'); return; }
    setLoading(true);
    try { await Excel.exportarFrotaCSV(anual, filMes); } catch (e) { toast('CSV: ' + e.message, 'err'); }
    finally { setLoading(false); }
  }

  function filtrarVeiculo(id) { _filtroVeiculo = id; render(); }

  function mudarMes(delta) {
    filMes += delta;
    if (filMes > 12) { filMes = 1; filAno++; }
    if (filMes < 1) { filMes = 12; filAno--; }
    render();
  }

  async function reenviar() { setLoading(true); try { await subirFila(); } finally { setLoading(false); } render(); }

  /* ── Formulário de KM ──────────────────────────────────── */
  async function abrirForm(id = null) {
    if (!veiculos.length) { try { veiculos = (await DB.getMeta('frota_veiculos')) || []; } catch (_) {} }
    const ativos = veiculos.filter(v => v.ativo !== false);
    if (!ativos.length) { toast('Nenhum veículo cadastrado — peça ao gestor', 'err'); return; }
    const r = id ? registros.find(x => x.id === id) : null;
    _fotoKm = null;
    $('km-id').value = r?.id || '';
    const sel = $('km-veiculo');
    sel.innerHTML = ativos.map(v => `<option value="${v.id}">${esc(v.placa)}${v.modelo ? ' · ' + esc(v.modelo) : ''}</option>`).join('');
    const meuUltimo = registros.find(x => x.user_id === user?.id);
    const meu = ativos.find(v => v.responsavel_id === user?.id);
    sel.value = r?.veiculo_id || meuUltimo?.veiculo_id || meu?.id || ativos[0].id;
    $('km-data').value = r?.data || new Date().toISOString().slice(0, 10);
    $('km-odometro').value = r?.odometro ?? '';
    $('km-obs').value = r?.observacao || '';
    $('km-foto-nome').textContent = r?.foto_path || r?._foto ? '📷 foto já guardada — escolha outra para trocar' : '';
    $('km-titulo').textContent = r ? 'Editar registro de KM' : 'Registrar KM';
    _mostrarUltimaLeitura();
    $('km-overlay').style.display = 'flex';
    setTimeout(() => $('km-odometro').focus(), 50);
  }
  function fecharForm() { $('km-overlay').style.display = 'none'; }

  function _mostrarUltimaLeitura() {
    const vid = $('km-veiculo').value;
    const ult = registros.filter(r => r.veiculo_id === vid && r.id !== $('km-id').value).sort((a, b) => b.data.localeCompare(a.data) || b.odometro - a.odometro)[0];
    const res = resumo?.veiculos?.find(v => v.veiculo_id === vid);
    const odo = ult?.odometro ?? res?.ultimo_odometro;
    const dt = ult?.data ?? res?.ultima_data;
    $('km-ultima').textContent = odo != null ? `Última leitura: ${kmFmt(odo)} km em ${fmtData(dt)}` : 'Primeira leitura deste veículo';
  }

  function onFoto(e) {
    _fotoKm = e.target.files?.[0] || null;
    $('km-foto-nome').textContent = _fotoKm ? `📷 ${_fotoKm.name || 'foto do odômetro'} pronta para enviar` : '';
  }

  async function salvar() {
    const id = $('km-id').value || crypto.randomUUID();
    const payload = {
      veiculo_id: $('km-veiculo').value,
      data: $('km-data').value,
      odometro: parseInt($('km-odometro').value, 10),
      observacao: $('km-obs').value.trim() || null,
    };
    if (!payload.veiculo_id || !payload.data || !Number.isFinite(payload.odometro)) { toast('Veículo, data e odômetro são obrigatórios', 'err'); return; }

    let foto = null;
    if (_fotoKm) {
      let blob = _fotoKm, ext = 'jpg';
      try { if (typeof _comprimirImagem === 'function') ({ blob, ext } = await _comprimirImagem(_fotoKm, 'jpg')); } catch (_) {}
      foto = { blob, ext };
    }

    setLoading(true);
    try {
      if (!navigator.onLine || !sb) {
        await enfileirar(id, payload, foto);
        fecharForm();
        toast('📴 Sem internet: registro guardado no aparelho — sobe sozinho quando voltar o sinal');
        await render();
        return;
      }
      try {
        await sb.frota.kmUpsert(id, payload);
      } catch (e) {
        if (!e?.status) {                          // caiu a rede no meio: fila
          await enfileirar(id, payload, foto);
          fecharForm(); toast('📴 Conexão falhou: registro guardado no aparelho');
          await render(); return;
        }
        throw e;                                    // 422/403: mostra o motivo
      }
      if (foto) {
        try { await sb.frota.kmFoto(id, foto.blob, foto.ext); }
        catch (e) { toast('Registro salvo, mas a foto não subiu: ' + e.message, 'err'); }
      }
      /* se era um item da fila (edição de pendente), tira da fila */
      const f = await _fila(); if (f.some(x => x.id === id)) await _salvarFila(f.filter(x => x.id !== id));
      fecharForm();
      toast('KM registrado ✅');
      await render();
    } catch (e) {
      toast(e.message || 'Não foi possível salvar', 'err');
    } finally { setLoading(false); }
  }

  async function excluir(id) {
    const r = registros.find(x => x.id === id);
    if (!r) return;
    if (!confirm(`Excluir a leitura de ${kmFmt(r.odometro)} km (${fmtData(r.data)}) do veículo ${r.placa}?`)) return;
    if (r._pendente) {                              // só estava no aparelho
      const f = await _fila(); await _salvarFila(f.filter(x => x.id !== id));
      toast('Registro descartado'); await render(); return;
    }
    if (!navigator.onLine) { toast('Excluir precisa de internet', 'err'); return; }
    setLoading(true);
    try { await sb.frota.kmDelete(id); toast('Registro excluído'); await render(); }
    catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  }

  async function verFoto(id) {
    const r = registros.find(x => x.id === id);
    if (!r?.foto_path) return;
    try {
      const url = await sb.fotos.url(r.foto_path);
      if (!url) throw new Error('Foto não encontrada');
      $('foto-viewer-img').src = url;
      $('foto-viewer-info').textContent = `🚗 ${r.placa} · ${kmFmt(r.odometro)} km · ${fmtData(r.data)}`;
      $('foto-viewer-overlay').style.display = 'flex';
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ── Cadastro de veículos (gestor/admin, online) ───────── */
  function abrirFormVeiculo(id = null) {
    if (!navigator.onLine) { toast('Cadastro de veículo precisa de internet', 'err'); return; }
    const v = id ? veiculos.find(x => x.id === id) : null;
    $('vei-id').value = v?.id || '';
    $('vei-placa').value = v?.placa || '';
    $('vei-modelo').value = v?.modelo || '';
    const sel = $('vei-resp');
    const pessoas = Object.values(window.equipePorId || {}).sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || '')));
    sel.innerHTML = '<option value="">— sem responsável fixo —</option>' + pessoas.map(p => `<option value="${p.id}">${esc(p.nome || p.email)}</option>`).join('');
    sel.value = v?.responsavel_id || '';
    $('vei-ativo').checked = v ? v.ativo !== false : true;
    $('vei-titulo').textContent = v ? 'Editar veículo' : 'Novo veículo';
    $('vei-overlay').style.display = 'flex';
  }
  function fecharFormVeiculo() { $('vei-overlay').style.display = 'none'; }

  async function salvarVeiculo() {
    const id = $('vei-id').value || crypto.randomUUID();
    const placa = $('vei-placa').value.trim();
    if (placa.replace(/[^A-Za-z0-9]/g, '').length < 7) { toast('Placa inválida (ex.: ABC1D23)', 'err'); return; }
    setLoading(true);
    try {
      await sb.frota.veiculoUpsert(id, {
        placa, modelo: $('vei-modelo').value.trim() || null,
        responsavel_id: $('vei-resp').value || null, ativo: $('vei-ativo').checked,
      });
      fecharFormVeiculo(); toast('Veículo salvo ✅'); await render();
    } catch (e) { toast(e.message || 'Não foi possível salvar', 'err'); }
    finally { setLoading(false); }
  }

  return { render, mudarMes, filtrarVeiculo, abrirForm, fecharForm, salvar, excluir, verFoto, onFoto,
           abrirFormVeiculo, fecharFormVeiculo, salvarVeiculo, onVeiculoChange: _mostrarUltimaLeitura,
           exportarExcel, exportarCSV, reenviar, subirFila };
})();
