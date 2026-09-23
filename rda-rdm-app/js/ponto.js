'use strict';
/* ─────────────────────────────────────────────────────────────
   PONTO.js — presença, horas extras, domingos e feriados (18/09/2026)

   O colaborador bate o ponto em um botão só: o app sabe qual é a próxima
   marcação do dia (entrada → saída p/ intervalo → volta → saída). A hora é
   a do servidor; sem internet a marcação fica na fila com a hora do
   aparelho e sobe depois. Horas normais, extras 50% (dia útil) e 100%
   (domingo/feriado) são calculadas pela API (PontoCalculo) — aqui só
   mostramos. Gestor vê todos, corrige dias, mantém feriados e exporta.

   Depende de globais do app.js: $, sb, user, toast, setLoading, esc,
   fmtData, filMes, filAno, MESES, _ehGestorOuAdmin, DB, viewAtual.
───────────────────────────────────────────────────────────── */
window.Ponto = (() => {

  const MARC = [
    { k: 'entrada',         rot: 'Entrada',               ico: '🟢', prox: 'Bater ENTRADA' },
    { k: 'saida_intervalo', rot: 'Saída p/ intervalo',    ico: '🍽️', prox: 'Sair para o INTERVALO' },
    { k: 'volta_intervalo', rot: 'Volta do intervalo',    ico: '🔁', prox: 'VOLTAR do intervalo' },
    { k: 'saida',           rot: 'Saída',                 ico: '🔴', prox: 'Bater SAÍDA' },
  ];
  const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const hm = min => { min = Math.max(0, Math.round(Number(min) || 0)); return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`; };
  const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const agoraHM = () => new Date().toTimeString().slice(0, 5);

  let dias = [];          // registros do mês (visíveis)
  let resumo = null;      // GET /ponto/resumo
  let feriados = [];
  let _offline = false, _cacheEm = null;
  let _timer = null;
  let _filtroPessoa = null;

  const KEY_CACHE = () => `ponto_cache_${filAno}_${filMes}`;
  const KEY_FILA = 'ponto_fila';

  /* ── Fila offline de marcações ─────────────────────────── */
  async function _fila() { try { return (await DB.getMeta(KEY_FILA)) || []; } catch (_) { return []; } }
  async function _salvarFila(f) { try { await DB.setMeta(KEY_FILA, f); } catch (_) {} }
  let _subindo = false;
  async function subirFila() {
    if (_subindo || !sb || !navigator.onLine) return 0;
    _subindo = true; let ok = 0;
    try {
      const f = await _fila();
      if (!f.length) return 0;
      const resto = [];
      for (const it of f) {
        try { await sb.ponto.bater(it); ok++; }
        catch (e) {
          const semRede = !e?.status;
          resto.push({ ...it, erro: semRede ? null : (e.message || 'falhou') });
          if (semRede) { resto.push(...f.slice(f.indexOf(it) + 1)); break; }
        }
      }
      await _salvarFila(resto);
      if (ok) toast(`${ok} marcação${ok > 1 ? 'ões' : ''} de ponto enviada${ok > 1 ? 's' : ''} ✅`);
    } finally { _subindo = false; }
    return ok;
  }
  window.addEventListener('online', () => { subirFila().then(n => { if (n && viewAtual === 'ponto') render(); }).catch(() => {}); });

  /* ── Carga ──────────────────────────────────────────────── */
  async function carregar() {
    if (!sb || !navigator.onLine) throw new Error('offline');
    await subirFila();
    const [r, f] = await Promise.all([sb.ponto.resumo(filAno, filMes), sb.ponto.feriados(filAno)]);
    resumo = r; dias = r?.dias || []; feriados = f || [];
    _offline = false; _cacheEm = new Date().toISOString();
    try { await DB.setMeta(KEY_CACHE(), { resumo, feriados, em: _cacheEm }); } catch (_) {}
  }
  async function carregarDoCache() {
    const c = await DB.getMeta(KEY_CACHE()).catch(() => null);
    resumo = c?.resumo || null; dias = resumo?.dias || []; feriados = c?.feriados || [];
    _cacheEm = c?.em || null; _offline = true;
  }

  /* estado de HOJE para o botão: registro do servidor + marcações na fila */
  async function _hojeInfo() {
    const d = hoje();
    const meu = dias.find(x => x.user_id === user?.id && x.data === d) || null;
    const fila = (await _fila()).filter(x => x.hora?.slice(0, 10) === d);
    const feitas = MARC.map(m => ({ ...m, hora: meu?.[m.k] || fila.find(x => x.marcacao === m.k)?.hora?.slice(11, 16) || null, pendente: !meu?.[m.k] && !!fila.find(x => x.marcacao === m.k) }));
    const prox = feitas.find(m => !m.hora) || null;
    return { meu, feitas, prox, fila };
  }

  /* ── Tela ───────────────────────────────────────────────── */
  async function render() {
    const el = $('app-content');
    el.innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando ponto…</p></div>';
    try { await carregar(); }
    catch (e) {
      await carregarDoCache();
    }
    const gestor = _ehGestorOuAdmin();
    const periodo = `${MESES[filMes - 1]} ${filAno}`;
    const h = await _hojeInfo();
    const filaTotal = (await _fila()).length;
    clearInterval(_timer);

    let html = `
    <div class="db-container">
      ${_offline ? `<div class="ini-dica" style="border-left:3px solid var(--warning)">📴 <b>Sem internet</b> — pode bater o ponto normalmente: a marcação fica guardada com a hora do aparelho e sobe sozinha.</div>` : ''}
      ${filaTotal ? `<div class="ini-dica" style="border-left:3px solid var(--warning)">⏳ <b>${filaTotal} marcação${filaTotal > 1 ? 'ões' : ''} aguardando envio</b>. ${navigator.onLine ? '<a class="link" onclick="Ponto.reenviar()">Enviar agora</a>' : ''}</div>` : ''}

      <button class="pnl pnl-grande" onclick="Ponto.bater()" ${h.prox ? '' : 'disabled style="opacity:.75"'}>
        <span class="pnl-conteudo" style="max-width:82%">
          <span class="pnl-ico">${h.prox ? h.prox.ico : '✅'}</span>
          <span class="pnl-tit">${h.prox ? h.prox.prox : 'Ponto de hoje completo'}</span>
          <span class="pnl-sub" id="ponto-relogio">${_relogioTxt()}</span>
        </span>
      </button>

      <div class="db-card">
        <div class="db-card-title"><span>Hoje · ${fmtData(hoje())} (${DIAS[new Date().getDay()]})</span>
          ${h.meu ? `<button class="btn btn-sm btn-outline" onclick="Ponto.abrirForm('${h.meu.id}')">Corrigir</button>` : ''}</div>
        <div class="ponto-marcs">
          ${h.feitas.map(m => `<div class="ponto-marc ${m.hora ? 'ok' : ''} ${m.pendente ? 'pend' : ''}"><span class="ponto-marc-ico">${m.ico}</span><span class="ponto-marc-rot">${m.rot}</span><span class="ponto-marc-h">${m.hora || '—'}${m.pendente ? ' ⏳' : ''}</span></div>`).join('')}
        </div>
        ${h.meu && h.meu.minutos ? `<div class="ponto-hoje-tot">Trabalhado: <b>${hm(h.meu.minutos)}</b>${h.meu.extra50 ? ` · extra 50%: <b>${hm(h.meu.extra50)}</b>` : ''}${h.meu.extra100 ? ` · extra 100%: <b>${hm(h.meu.extra100)}</b>` : ''}</div>` : ''}
        ${h.meu?.feriado ? `<div class="ponto-hoje-tot">🎉 Feriado: ${esc(h.meu.feriado)} — horas contam como extra 100%</div>` : (new Date().getDay() === 0 ? '<div class="ponto-hoje-tot">Domingo — horas contam como extra 100%</div>' : '')}
      </div>

      <div class="page-hd" style="padding:0">
        <div class="mes-nav">
          <button class="btn-mes-nav" onclick="Ponto.mudarMes(-1)">‹</button>
          <span class="mes-label">${periodo}</span>
          <button class="btn-mes-nav" onclick="Ponto.mudarMes(1)">›</button>
        </div>
      </div>`;

    html += _dashboardHTML(gestor, periodo);

    /* Espelho do mês */
    const lista = (_filtroPessoa ? dias.filter(d => d.user_id === _filtroPessoa) : dias).slice().sort((a, b) => b.data.localeCompare(a.data) || String(a.user_nome).localeCompare(String(b.user_nome)));
    html += `
      <div class="ini-titulo" style="display:flex;justify-content:space-between;align-items:center">
        <span>${gestor ? 'Espelho do mês' : 'Meus dias'} (${lista.length})</span>
        <span style="display:flex;gap:6px">
          ${_filtroPessoa ? `<button class="btn btn-sm btn-outline" onclick="Ponto.filtrarPessoa(null)">Todos</button>` : ''}
          ${gestor ? `<button class="btn btn-sm btn-outline" onclick="Ponto.abrirForm(null)">＋ Lançar dia</button>` : ''}
        </span>
      </div>
      <div class="notas-list">
        ${lista.length ? lista.map(d => `
        <div class="nota-card" data-tipo="${d.domingo || d.feriado ? 'RDM' : 'RDA'}">
          <div class="nota-head">
            <span class="tipo-badge tipo-${d.domingo || d.feriado ? 'RDM' : 'RDA'}">${DIAS[d.dia_semana]} ${fmtData(d.data)}</span>
            ${gestor && d.user_nome ? `<span class="subtipo-tag">👤 ${esc(d.user_nome)}</span>` : ''}
            ${d.feriado ? `<span class="doc-tag nfse">🎉 ${esc(d.feriado)}</span>` : ''}
            ${d.domingo ? '<span class="doc-tag danfe">domingo</span>' : ''}
            ${d.tipo_dia !== 'trabalho' ? `<span class="doc-tag outro">${d.tipo_dia}</span>` : ''}
            ${d.aberto ? '<span class="sync-pill pending">⏳ em aberto</span>' : ''}
          </div>
          <div class="nota-body">
            <div class="nota-empresa" style="font-size:15.5px">${[d.entrada, d.saida_intervalo, d.volta_intervalo, d.saida].map(x => x || '—').join(' · ')}</div>
            <div class="nota-cnpj">${d.minutos ? `${hm(d.minutos)} trabalhadas` : (d.tipo_dia === 'trabalho' ? 'sem horas' : '')}${d.extra50 ? ` · <b>+${hm(d.extra50)} (50%)</b>` : ''}${d.extra100 ? ` · <b>+${hm(d.extra100)} (100%)</b>` : ''}</div>
            ${d.observacao ? `<div class="nota-obs">${esc(d.observacao)}</div>` : ''}
          </div>
          <div class="nota-foot">
            <span></span>
            <div class="nota-actions">
              ${(gestor || d.user_id === user?.id) ? `<button class="btn-icon-sm" onclick="Ponto.abrirForm('${d.id}')" title="Corrigir">✏️</button>` : ''}
              ${gestor ? `<button class="btn-icon-sm danger" onclick="Ponto.excluir('${d.id}')" title="Excluir">🗑</button>` : ''}
            </div>
          </div>
        </div>`).join('') : '<p class="muted-p">Nenhum registro neste mês.</p>'}
      </div>`;

    /* Feriados (gestor) */
    if (gestor) {
      html += `
      <div class="ini-titulo" style="display:flex;justify-content:space-between;align-items:center">
        <span>Feriados ${filAno} (${feriados.length})</span>
        <button class="btn btn-sm btn-primary" onclick="Ponto.abrirFeriado()" ${_offline ? 'disabled' : ''}>＋ Feriado</button>
      </div>
      <div class="db-card">
        ${feriados.length ? feriados.map(f => `<div class="ponto-feriado"><span>${fmtData(f.data)} — ${esc(f.nome)}</span><button class="btn-icon-sm danger" onclick="Ponto.excluirFeriado('${f.data}')" title="Remover">🗑</button></div>`).join('') : '<p class="muted-p">Nenhum feriado cadastrado para o ano. Cadastre os nacionais, estaduais e municipais — eles viram extra 100%.</p>'}
      </div>`;
    }

    html += '</div>';
    el.innerHTML = html;
    _timer = setInterval(() => { const r = $('ponto-relogio'); if (r) r.textContent = _relogioTxt(); }, 1000);
  }
  function _relogioTxt() { const d = new Date(); return `${d.toLocaleDateString('pt-BR', { weekday: 'long' })}, ${d.toLocaleTimeString('pt-BR')}`; }

  /* ── Dashboard ──────────────────────────────────────────── */
  function _dashboardHTML(gestor, periodo) {
    if (!resumo) return '';
    const pessoas = resumo.pessoas || [];
    const eu = pessoas.find(p => p.user_id === user?.id);
    const T = gestor ? resumo.total : (eu || { minutos: 0, normal: 0, extra50: 0, extra100: 0, domingos: 0, feriados: 0, dias: 0 });
    const kpi = (lbl, val, sub, alerta) => `<div class="ini-kpi ${alerta ? 'alerta' : ''}"><div class="ini-kpi-lbl">${lbl}</div><div class="ini-kpi-val">${val}</div><div class="ini-kpi-sub">${sub}</div></div>`;
    let html = `
      <div class="ini-titulo">${gestor ? 'Equipe' : 'Meu mês'} — ${periodo}</div>
      <div class="ini-resumo">
        ${kpi('Horas trabalhadas', hm(T.minutos), `${T.dias} dia${T.dias === 1 ? '' : 's'} com ponto`)}
        ${kpi('Extras 50%', hm(T.extra50), 'além da jornada em dia útil', T.extra50 > 0)}
        ${kpi('Extras 100%', hm(T.extra100), 'domingos e feriados', T.extra100 > 0)}
        ${kpi('Domingos · feriados', `${T.domingos} · ${T.feriados}`, 'trabalhados no mês')}
      </div>`;
    if (gestor && pessoas.length) {
      const max = Math.max(1, ...pessoas.map(p => p.minutos));
      html += `
      <div class="db-card">
        <div class="db-card-title"><span>Horas por colaborador</span><span style="font-size:13px;color:var(--text2)">toque para filtrar</span></div>
        <div class="db-rank">
          ${pessoas.slice().sort((a, b) => b.minutos - a.minutos).map((p, i) => `
          <div class="db-rank-item" style="cursor:pointer" onclick="Ponto.filtrarPessoa('${p.user_id}')">
            <div class="db-rank-meta"><span class="db-rank-pos">${i + 1}º</span><span class="db-rank-name">${esc(p.nome)}</span>
              <span class="db-rank-val">${hm(p.minutos)}${p.extra50 || p.extra100 ? ` <small style="opacity:.8">(+${hm(p.extra50 + p.extra100)})</small>` : ''}${p.abertos ? ' ⏳' : ''}</span></div>
            <div class="db-rank-track"><div class="db-rank-fill" style="width:${Math.max(3, Math.round(p.minutos / max * 100))}%"></div></div>
          </div>`).join('')}
        </div>
      </div>`;
    }
    /* mapa de dias do mês (pessoa em foco ou eu) */
    const alvo = gestor ? (pessoas.find(p => p.user_id === _filtroPessoa) || eu || pessoas[0]) : eu;
    if (alvo) {
      const nd = new Date(filAno, filMes, 0).getDate();
      const fer = new Set(feriados.map(f => f.data));
      html += `
      <div class="db-card">
        <div class="db-card-title"><span>Calendário · ${esc(alvo.nome)}</span><span style="font-size:13px;color:var(--text2)">horas por dia</span></div>
        <div class="ponto-cal">
          ${DIAS.map(d => `<span class="ponto-cal-h">${d}</span>`).join('')}
          ${Array(new Date(filAno, filMes - 1, 1).getDay()).fill('<span></span>').join('')}
          ${Array.from({ length: nd }, (_, i) => {
            const dia = i + 1, min = alvo.por_dia?.[i], ds = `${filAno}-${String(filMes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
            const dow = new Date(filAno, filMes - 1, dia).getDay();
            const cls = min > 0 ? (dow === 0 || fer.has(ds) ? 'x100' : 'ok') : (min === 0 ? 'zero' : '');
            return `<span class="ponto-cal-d ${cls} ${ds === hoje() ? 'hoje' : ''}" title="${ds}${min != null ? ' · ' + hm(min) : ''}"><b>${dia}</b>${min != null ? `<small>${min > 0 ? hm(min) : '·'}</small>` : ''}</span>`;
          }).join('')}
        </div>
      </div>`;
    }
    html += `
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" onclick="Ponto.exportarCSV()">CSV ${MESES[filMes - 1]}</button>
        <button class="btn btn-primary btn-sm" onclick="Ponto.exportarExcel()">📗 Planilha de ponto ${MESES[filMes - 1]}/${filAno}</button>
      </div>`;
    return html;
  }

  function filtrarPessoa(id) { _filtroPessoa = id; render(); }
  function mudarMes(delta) {
    filMes += delta;
    if (filMes > 12) { filMes = 1; filAno++; }
    if (filMes < 1) { filMes = 12; filAno--; }
    render();
  }
  async function reenviar() { setLoading(true); try { await subirFila(); } finally { setLoading(false); } render(); }

  /* ── Bater ──────────────────────────────────────────────── */
  async function bater() {
    const h = await _hojeInfo();
    if (!h.prox) { toast('As quatro marcações de hoje já foram feitas', 'err'); return; }
    if (!confirm(`${h.prox.prox} agora (${agoraHM()})?`)) return;
    const item = { marcacao: h.prox.k, hora: new Date().toISOString() };
    if (h.prox.k === 'entrada' && navigator.geolocation) {
      try {
        const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 4000, maximumAge: 60000 }));
        item.lat = pos.coords.latitude; item.lng = pos.coords.longitude;
      } catch (_) {}
    }
    setLoading(true);
    try {
      if (!navigator.onLine || !sb) { await _enfileirar(item); toast('📴 Sem internet: marcação guardada com a hora do aparelho'); }
      else {
        try { await sb.ponto.bater(item); toast(`${h.prox.rot} registrada ✅ ${agoraHM()}`); }
        catch (e) {
          if (!e?.status) { await _enfileirar(item); toast('📴 Conexão falhou: marcação guardada no aparelho'); }
          else throw e;
        }
      }
      await render();
    } catch (e) { toast(e.message || 'Não foi possível bater o ponto', 'err'); }
    finally { setLoading(false); }
  }
  async function _enfileirar(item) { const f = await _fila(); f.push({ ...item, erro: null }); await _salvarFila(f); }

  /* ── Formulário do dia (correção / lançamento) ─────────── */
  function abrirForm(id) {
    const d = id ? dias.find(x => x.id === id) : null;
    const gestor = _ehGestorOuAdmin();
    $('pt-id').value = d?.id || '';
    const sel = $('pt-pessoa');
    if (gestor) {
      const pessoas = Object.values(window.equipePorId || {}).sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || '')));
      sel.innerHTML = pessoas.map(p => `<option value="${p.id}">${esc(p.nome || p.email)}</option>`).join('');
      sel.value = d?.user_id || user?.id; sel.disabled = !!d;
      $('pt-pessoa-wrap').style.display = '';
    } else { $('pt-pessoa-wrap').style.display = 'none'; sel.innerHTML = `<option value="${user?.id}">${esc(user?.nome || '')}</option>`; }
    $('pt-data').value = d?.data || hoje();
    $('pt-data').disabled = !!d;
    for (const m of MARC) $('pt-' + m.k).value = d?.[m.k] || '';
    $('pt-tipo').value = d?.tipo_dia || 'trabalho';
    $('pt-obs').value = d?.observacao || '';
    $('pt-titulo').textContent = d ? `Corrigir ${fmtData(d.data)}` : 'Lançar dia de ponto';
    $('pt-overlay').style.display = 'flex';
  }
  function fecharForm() { $('pt-overlay').style.display = 'none'; }
  async function salvar() {
    const id = $('pt-id').value || crypto.randomUUID();
    const payload = { user_id: $('pt-pessoa').value || user?.id, data: $('pt-data').value, tipo_dia: $('pt-tipo').value, observacao: $('pt-obs').value.trim() || null };
    for (const m of MARC) payload[m.k] = $('pt-' + m.k).value || null;
    if (!payload.data) { toast('Informe a data', 'err'); return; }
    if (!navigator.onLine) { toast('Correção precisa de internet', 'err'); return; }
    setLoading(true);
    try { await sb.ponto.upsert(id, payload); fecharForm(); toast('Ponto salvo ✅'); await render(); }
    catch (e) { toast(e.message || 'Não foi possível salvar', 'err'); }
    finally { setLoading(false); }
  }
  async function excluir(id) {
    const d = dias.find(x => x.id === id);
    if (!d || !confirm(`Excluir o ponto de ${fmtData(d.data)}${d.user_nome ? ' de ' + d.user_nome : ''}?`)) return;
    setLoading(true);
    try { await sb.ponto.delete(id); toast('Excluído'); await render(); }
    catch (e) { toast(e.message, 'err'); } finally { setLoading(false); }
  }

  /* ── Feriados ───────────────────────────────────────────── */
  function abrirFeriado() {
    const d = prompt('Data do feriado (AAAA-MM-DD):', `${filAno}-${String(filMes).padStart(2, '0')}-`);
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.trim())) { if (d) toast('Data inválida', 'err'); return; }
    const nome = prompt('Nome do feriado:');
    if (!nome || !nome.trim()) return;
    setLoading(true);
    sb.ponto.feriadoUpsert(d.trim(), nome.trim()).then(() => { toast('Feriado salvo ✅'); return render(); })
      .catch(e => toast(e.message, 'err')).finally(() => setLoading(false));
  }
  async function excluirFeriado(data) {
    if (!confirm(`Remover o feriado de ${fmtData(data)}?`)) return;
    setLoading(true);
    try { await sb.ponto.feriadoDelete(data); await render(); } catch (e) { toast(e.message, 'err'); } finally { setLoading(false); }
  }

  /* ── Planilhas ──────────────────────────────────────────── */
  async function exportarExcel() {
    if (!resumo) { toast('Abra o Ponto com internet uma vez para gerar a planilha', 'err'); return; }
    setLoading(true, 'Gerando a planilha…');
    try { await Excel.exportarPonto(resumo, feriados); toast('Planilha gerada 📗'); } catch (e) { toast('Planilha: ' + e.message, 'err'); }
    finally { setLoading(false); }
  }
  async function exportarCSV() {
    if (!resumo) { toast('Abra o Ponto com internet uma vez para gerar o CSV', 'err'); return; }
    setLoading(true);
    try { await Excel.exportarPontoCSV(resumo); } catch (e) { toast('CSV: ' + e.message, 'err'); }
    finally { setLoading(false); }
  }

  return { render, bater, mudarMes, filtrarPessoa, reenviar, subirFila, abrirForm, fecharForm, salvar, excluir,
           abrirFeriado, excluirFeriado, exportarExcel, exportarCSV, hm };
})();
