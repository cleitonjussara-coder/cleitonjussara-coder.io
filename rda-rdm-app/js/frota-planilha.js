'use strict';
/* ─────────────────────────────────────────────────────────────
   FROTA-PLANILHA.js — planilha de KM dinâmica (pedido do Cleiton, 31/10/2026)

   A planilha em Excel (veículo × mês) era difícil de ler. Esta aba mostra o mês
   inteiro na tela, dia a dia, com cor mais forte onde se rodou mais:
   • escolher colaboradores específicos (gestor/admin; colaborador vê só o dele);
   • "Por dia"    — uma linha por dia, uma coluna por pessoa; tocar na célula abre a leitura;
   • "Por pessoa" — ranking do mês; tocar abre a planilha individual da pessoa;
   • planilha individual — as leituras da pessoa no mês (anterior → leitura = km);
   • exportar — um Excel com os escolhidos, ou um arquivo por colaborador.
   Base: GET /frota/anual (leituras com user_id). O servidor já só devolve ao colaborador o que é dele.

   SEGURANÇA: id de pessoa nunca entra em código de onclick — vai em data-id (aspas escapadas por `at`).
   Depende de globais do app.js: $, sb, user, esc, toast, setLoading, DB, fmtData, _ehGestorOuAdmin, FusoBR.
───────────────────────────────────────────────────────────── */
window.FrotaPlanilha = (() => {
  const MESES_L = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const SEM = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const kmFmt = n => Number(n || 0).toLocaleString('pt-BR');
  const at = s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const hoje = () => (sb?.hojeDoServidor ? sb.hojeDoServidor() : FusoBR.hojeISO());
  const primeiroNome = n => String(n || '').trim().split(/\s+/)[0] || '?';
  const dow = (ano, mes, d) => new Date(Date.UTC(ano, mes - 1, d)).getUTCDay();

  const estadoInicial = () => ({ ano: null, mes: null, anual: null, off: false, sel: null, view: 'dia', pick: null });
  let S = estadoInicial();
  let _gen = 0;             // resposta de ano que já foi trocado (ou de aba que já saiu) não pinta nada

  function _css() {
    if (document.getElementById('frota-planilha-css')) return;
    const s = document.createElement('style');
    s.id = 'frota-planilha-css';
    s.textContent = `
      .fp-chips{display:flex;gap:6px;flex-wrap:wrap;padding:6px 14px 0}
      .fp-chips .chip{padding:7px 12px;min-height:36px}
      .fp-chips .chip.todos{border-style:dashed}
      .fp-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -2px}
      .fp-tab{border-collapse:separate;border-spacing:0;width:100%;font-size:14px}
      .fp-tab th{font-size:12px;font-weight:700;color:var(--text2);padding:6px 3px;text-align:center;min-width:52px;max-width:96px;
                 border-bottom:1px solid rgba(255,255,255,.18);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .fp-tab th small{display:block;font-weight:400;opacity:.7;font-size:10.5px}
      .fp-tab td{padding:0;height:34px;text-align:center;border-bottom:1px solid rgba(255,255,255,.07);font-variant-numeric:tabular-nums}
      .fp-tab .d{position:sticky;left:0;z-index:1;min-width:66px;width:66px;font-size:13px;text-align:left;padding-left:6px;color:var(--text2);
                 background:#0f3b22;white-space:nowrap}
      .fp-tab th.d{z-index:2;color:var(--text2)}
      .fp-tab tr.fim .d{color:rgba(255,255,255,.4)}
      .fp-tab tr.sel .d{color:#d9f5a0;font-weight:800}
      .fp-tab td.c{cursor:pointer;-webkit-tap-highlight-color:transparent}
      .fp-tab td.c.sel{outline:2px solid #d9f5a0;outline-offset:-2px}
      .fp-tab .t{min-width:62px;font-weight:800}
      .fp-tab tr.tot td{border-top:2px solid rgba(185,226,74,.5);font-weight:800;height:38px}
      .fp-det{margin:10px 14px 0;padding:10px 12px;border-radius:12px;border:1px solid rgba(185,226,74,.5);background:rgba(185,226,74,.1);line-height:1.5;font-size:14px}
      .fp-ind{margin:10px 14px 0}
      .fp-ind-t{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;font-weight:800}
      .fp-ind-l{font-size:13px;color:var(--text2);line-height:1.4}
      .fp-ind .fp-tab td,.fp-ind .fp-tab th{min-width:0;max-width:none}
      .fp-ind .fp-tab td{height:auto;padding:6px 4px}
      .fp-ind td.o{text-align:left;color:var(--text2);padding-left:6px;overflow-wrap:anywhere}
      .fp-rk{padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08);cursor:pointer}
      .fp-rk:last-child{border:0}
      .fp-rk .db-rank-meta{flex-wrap:nowrap}
      .fp-exp{display:flex;gap:8px;flex-wrap:wrap}
    `;
    document.head.appendChild(s);
  }

  /* ── Dados ───────────────────────────────────────────────── */
  const _chave = ano => `frota_plan_${user?.id}_${ano}`;
  async function _carregar(ano) {
    try {
      if (!sb || !navigator.onLine) throw new Error('offline');
      const d = await sb.frota.anual(ano);
      try { await DB.setMeta(_chave(ano), { d, em: new Date().toISOString() }); } catch (_) {}
      return { d, off: false };
    } catch (e) {
      if (e?.status) throw e;
      const c = await DB.getMeta(_chave(ano)).catch(() => null);
      if (!c?.d) throw e;
      return { d: c.d, off: true };
    }
  }

  /* quem aparece nos botões: quem tem leitura no ano (o servidor já filtra para o colaborador comum) */
  const _pessoas = () => (S.anual?.motoristas || []).map(m => ({ user_id: m.user_id, nome: m.nome })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const _doMes = () => (S.anual?.leituras || []).filter(l => l.mes === S.mes);

  /* ── Tela ────────────────────────────────────────────────── */
  async function montar(el) {
    _css();
    const g = ++_gen;
    if (!S.ano) { const h = hoje(); S.ano = Number(h.slice(0, 4)); S.mes = Number(h.slice(5, 7)); }
    el.innerHTML = '<div class="ini-dica">Carregando a planilha…</div>';
    try {
      const { d, off } = await _carregar(S.ano);
      if (g !== _gen) return;
      S.anual = d; S.off = off;
    } catch (e) {
      if (g !== _gen) return;
      el.innerHTML = `<div class="ini-dica">Não foi possível carregar a planilha${e?.message ? ': ' + esc(e.message) : ''}.</div>`;
      return;
    }
    const ids = new Set(_pessoas().map(p => p.user_id));
    S.sel = S.sel ? new Set([...S.sel].filter(i => ids.has(i))) : new Set(ids);
    if (!S.sel.size && ids.size) S.sel = new Set(ids);
    _pintar();
  }

  function _pintar() {
    const el = $('fq-corpo');
    if (!el) return;
    const pessoas = _pessoas();
    const escolhidas = pessoas.filter(p => S.sel.has(p.user_id));
    const h = hoje(), noFim = S.ano * 12 + S.mes >= Number(h.slice(0, 4)) * 12 + Number(h.slice(5, 7));
    const seg = (k, t) => `<button class="seg-btn ${S.view === k ? 'active' : ''}" onclick="FrotaPlanilha.ver('${k}')">${t}</button>`;
    const varias = pessoas.length > 1;

    let html = `
      ${S.off ? '<div class="ini-dica fq-aviso" style="border-left:3px solid var(--warning)">📴 <b>Sem internet</b> — mostrando o que foi baixado da última vez.</div>' : ''}
      <div class="fq-seg"><div class="seg">${seg('dia', 'Por dia')}${seg('pessoa', 'Por pessoa')}</div></div>
      <div class="fq-nav">
        <button class="btn-mes-nav" onclick="FrotaPlanilha.mes(-1)" aria-label="Mês anterior">‹</button>
        <span class="mes-label">${MESES_L[S.mes - 1]} ${S.ano}</span>
        <button class="btn-mes-nav" onclick="FrotaPlanilha.mes(1)" aria-label="Próximo mês" ${noFim ? 'disabled' : ''}>›</button>
      </div>`;
    if (varias) {
      html += `<div class="fp-chips">
        <button class="chip todos" onclick="FrotaPlanilha.todos()">${S.sel.size === pessoas.length ? 'Limpar' : 'Todos'}</button>
        ${pessoas.map(p => `<button class="chip ${S.sel.has(p.user_id) ? 'active' : ''}" data-id="${at(p.user_id)}" onclick="FrotaPlanilha.alternar(this.dataset.id)">${S.sel.has(p.user_id) ? '✓ ' : ''}${esc(p.nome)}</button>`).join('')}
      </div>`;
    }
    if (!escolhidas.length) {
      el.innerHTML = html + `<p class="muted-p" style="padding:14px">${pessoas.length ? 'Escolha ao menos um colaborador acima.' : 'Nenhuma leitura de KM neste ano.'}</p>`;
      return;
    }

    const ids = new Set(escolhidas.map(p => p.user_id));
    const ls = _doMes().filter(l => ids.has(l.user_id));
    const porDia = {};
    ls.forEach(l => { const k = Number(l.data.slice(8)); porDia[k] = (porDia[k] || 0) + (l.km_rodado || 0); });
    const total = ls.reduce((a, l) => a + (l.km_rodado || 0), 0);
    const diasUso = Object.values(porDia).filter(v => v > 0).length;
    let maior = 0, diaMaior = 0;
    Object.entries(porDia).forEach(([d, v]) => { if (v > maior) { maior = v; diaMaior = Number(d); } });
    const k = (lbl, val, sub) => `<div class="ini-kpi"><div class="ini-kpi-lbl">${lbl}</div><div class="ini-kpi-val">${val}</div><div class="ini-kpi-sub">${sub}</div></div>`;
    html += `<div class="fq-kpis" style="padding-top:8px">
      ${k('Total no mês', kmFmt(total), 'km')}
      ${k('Dias com uso', diasUso, diasUso === 1 ? 'dia' : 'dias')}
      ${k('Média por dia', diasUso ? kmFmt(Math.round(total / diasUso)) : '—', 'km nos dias de uso')}
      ${k('Maior dia', maior ? kmFmt(maior) : '—', maior ? `km · dia ${String(diaMaior).padStart(2, '0')}` : 'km')}
    </div>`;

    html += S.view === 'pessoa' ? _pessoaHTML(escolhidas, ls) : _diaHTML(escolhidas, ls);

    const ind = _individual(escolhidas);
    if (S.view === 'dia' && S.pick && !S.pick.ind && !ind.fixo) html += _detalheDia(escolhidas, ls);
    if (ind.p) html += _individualHTML(ind.p, ind.fixo);
    else if (S.view === 'dia') html += `<p class="fq-dica" style="padding:8px 14px 0">Toque numa célula para ver a leitura do odômetro daquele dia.</p>`;

    html += `<div class="db-card fq-card"><div class="db-card-title"><span>📗 Baixar em Excel</span></div>
      <div class="fq-exp">
        <button class="btn btn-primary btn-sm" onclick="FrotaPlanilha.exportar(false)">${escolhidas.length === 1 ? 'Planilha de ' + esc(primeiroNome(escolhidas[0].nome)) : 'Excel dos ' + escolhidas.length + ' escolhidos'}</button>
        ${escolhidas.length > 1 ? '<button class="btn btn-outline btn-sm" onclick="FrotaPlanilha.exportar(true)">Um arquivo por colaborador</button>' : ''}
      </div>
      <p class="fq-dica" style="margin:8px 0 0">${escolhidas.length > 1 ? 'Cada arquivo traz o resumo do ano, o dia a dia do mês e as leituras de cada pessoa.' : 'Traz o resumo do ano, o dia a dia do mês e todas as leituras da pessoa.'}</p></div>
      <div style="height:18px"></div>`;
    el.innerHTML = html;
  }

  /* planilha individual: uma pessoa só escolhida (fixo) ou aberta pelo ranking/célula */
  function _individual(escolhidas) {
    if (escolhidas.length === 1) return { p: escolhidas[0], fixo: true };
    const p = S.pick?.ind && escolhidas.find(x => x.user_id === S.pick.uid);
    return { p: p || null, fixo: false };
  }

  function _diaHTML(pessoas, ls) {
    const dias = new Date(S.ano, S.mes, 0).getDate();
    const mapa = {};
    ls.forEach(l => { const key = `${l.user_id}|${Number(l.data.slice(8))}`; mapa[key] = (mapa[key] || 0) + (l.km_rodado || 0); });
    const mx = Math.max(1, ...Object.values(mapa));
    const tot = pessoas.map(p => { let s = 0; for (let d = 1; d <= dias; d++) s += mapa[`${p.user_id}|${d}`] || 0; return s; });
    const varias = pessoas.length > 1;
    let h = `<div class="db-card fq-card"><div class="fp-wrap"><table class="fp-tab"><thead><tr><th class="d">Dia</th>
      ${pessoas.map(p => `<th title="${at(p.nome)}">${esc(primeiroNome(p.nome))}</th>`).join('')}${varias ? '<th class="t">Dia</th>' : ''}</tr></thead><tbody>`;
    for (let d = 1; d <= dias; d++) {
      const w = dow(S.ano, S.mes, d), dt = pessoas.reduce((a, p) => a + (mapa[`${p.user_id}|${d}`] || 0), 0);
      h += `<tr class="${w === 0 || w === 6 ? 'fim' : ''} ${S.pick?.d === d ? 'sel' : ''}"><td class="d">${String(d).padStart(2, '0')} ${SEM[w]}</td>`;
      pessoas.forEach(p => {
        const v = mapa[`${p.user_id}|${d}`] || 0;
        const estilo = v ? `background:rgba(185,226,74,${(0.12 + v / mx * 0.45).toFixed(2)});font-weight:700` : '';
        h += `<td class="c ${S.pick && S.pick.d === d && S.pick.uid === p.user_id ? 'sel' : ''}" data-id="${at(p.user_id)}" data-d="${d}" style="${estilo}" onclick="FrotaPlanilha.celula(this.dataset.id,Number(this.dataset.d))">${v ? kmFmt(v) : ''}</td>`;
      });
      if (varias) h += `<td class="t">${dt ? kmFmt(dt) : ''}</td>`;
      h += '</tr>';
    }
    h += `<tr class="tot"><td class="d" style="color:#fff">Total</td>${tot.map(v => `<td>${kmFmt(v)}</td>`).join('')}${varias ? `<td class="t">${kmFmt(tot.reduce((a, b) => a + b, 0))}</td>` : ''}</tr></tbody></table></div></div>`;
    return h;
  }

  function _detalheDia(pessoas, ls) {
    const p = pessoas.find(x => x.user_id === S.pick.uid);
    if (!p) return '';
    const dd = String(S.pick.d).padStart(2, '0') + '/' + String(S.mes).padStart(2, '0');
    const dia = ls.filter(l => l.user_id === p.user_id && Number(l.data.slice(8)) === S.pick.d);
    const corpo = dia.length
      ? dia.map(l => `${l.odometro_anterior != null ? `Anterior <b>${kmFmt(l.odometro_anterior)}</b> km → ` : ''}leitura <b>${kmFmt(l.odometro)}</b> km = <b>${kmFmt(l.km_rodado)} km</b> · ${esc(l.placa)}${l.observacao ? ' · ' + esc(l.observacao) : ''}`).join('<br>')
      : 'Sem leitura neste dia.';
    return `<div class="fp-det"><b>${esc(p.nome)} · ${dd}</b><br>${corpo}
      ${S.sel.size > 1 ? `<div style="margin-top:8px"><button class="btn btn-outline btn-sm" data-id="${at(p.user_id)}" onclick="FrotaPlanilha.individual(this.dataset.id)">Abrir planilha de ${esc(primeiroNome(p.nome))}</button></div>` : ''}</div>`;
  }

  function _individualHTML(p, fixo) {
    const ls = _doMes().filter(l => l.user_id === p.user_id).sort((a, b) => a.data.localeCompare(b.data) || a.odometro - b.odometro);
    const soma = ls.reduce((a, l) => a + (l.km_rodado || 0), 0);
    return `<div class="db-card fq-card fp-ind">
      <div class="fp-ind-t"><span>👤 ${esc(p.nome)} · ${MESES_L[S.mes - 1]}</span>${fixo ? '' : '<button class="btn btn-outline btn-sm" onclick="FrotaPlanilha.fechar()">Voltar</button>'}</div>
      ${ls.length ? `<p class="fp-ind-l" style="margin:0 0 6px">Veículo${new Set(ls.map(l => l.placa)).size === 1 ? '' : 's'}: ${[...new Set(ls.map(l => l.placa))].map(esc).join(', ')}</p><div class="fp-wrap"><table class="fp-tab"><thead><tr><th style="text-align:left;padding-left:6px">Data</th><th>Anterior</th><th>Leitura</th><th>Km</th></tr></thead><tbody>
        ${ls.map(l => `<tr><td style="text-align:left;padding-left:6px;white-space:nowrap">${l.data.slice(8)}/${l.data.slice(5, 7)} <span style="color:var(--text2)">${SEM[dow(S.ano, S.mes, Number(l.data.slice(8)))]}</span></td>
          <td>${l.odometro_anterior != null ? kmFmt(l.odometro_anterior) : '—'}</td><td>${kmFmt(l.odometro)}</td><td style="font-weight:800">${kmFmt(l.km_rodado)}</td></tr>
          ${l.observacao ? `<tr><td class="o" colspan="4" style="font-size:12.5px">${new Set(ls.map(x => x.placa)).size > 1 ? esc(l.placa) + ' · ' : ''}${esc(l.observacao)}</td></tr>` : ''}`).join('')}
        <tr class="tot"><td style="text-align:left;padding-left:6px">Total</td><td></td><td></td><td>${kmFmt(soma)}</td></tr></tbody></table></div>`
        : '<p class="muted-p">Nenhuma leitura neste mês.</p>'}
      <p class="fp-ind-l" style="margin:8px 0 0">Km = leitura menos a leitura anterior do mesmo veículo (que pode ser de outra pessoa).</p>
    </div>`;
  }

  function _pessoaHTML(pessoas, ls) {
    const r = pessoas.map(p => {
      const mine = ls.filter(l => l.user_id === p.user_id);
      const dias = new Set(mine.filter(l => l.km_rodado > 0).map(l => l.data)).size;
      return { p, t: mine.reduce((a, l) => a + (l.km_rodado || 0), 0), dias };
    }).sort((a, b) => b.t - a.t);
    const mx = Math.max(1, r[0].t);
    return `<div class="db-card fq-card"><div class="db-card-title"><span>🏁 Km por colaborador</span><span class="fq-dica">toque para abrir</span></div>
      ${r.map((x, i) => `<div class="fp-rk" data-id="${at(x.p.user_id)}" onclick="FrotaPlanilha.individual(this.dataset.id)">
        <div class="db-rank-meta"><span class="db-rank-pos">${i + 1}º</span><span class="db-rank-name">${esc(x.p.nome)}</span><span class="db-rank-val">${kmFmt(x.t)} km</span></div>
        <div class="db-rank-track"><div class="db-rank-fill" style="width:${Math.max(3, Math.round(x.t / mx * 100))}%"></div></div>
        <div class="fq-sub">${x.dias} dia${x.dias === 1 ? '' : 's'} rodado${x.dias === 1 ? '' : 's'}${x.dias ? ' · média ' + kmFmt(Math.round(x.t / x.dias)) + ' km/dia' : ''}</div>
      </div>`).join('')}</div>`;
  }

  /* ── Ações ───────────────────────────────────────────────── */
  function ver(k) { S.view = k; S.pick = null; _pintar(); }
  function alternar(id) { if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); S.pick = null; _pintar(); }
  function todos() { const ids = _pessoas().map(p => p.user_id); S.sel = S.sel.size === ids.length ? new Set() : new Set(ids); S.pick = null; _pintar(); }
  function celula(id, d) { S.pick = { uid: id, d }; _pintar(); }
  function individual(id) { S.pick = { uid: id, ind: true }; S.view = 'dia'; _pintar(); $('fq-corpo')?.querySelector('.fp-ind')?.scrollIntoView?.({ block: 'start' }); }
  function fechar() { S.pick = null; _pintar(); }
  async function mes(delta) {
    let m = S.mes + delta, a = S.ano;
    if (m > 12) { m = 1; a++; }
    if (m < 1) { m = 12; a--; }
    S.mes = m; S.pick = null;
    if (a !== S.ano) { S.ano = a; S.anual = null; return montar($('fq-corpo')); }
    _pintar();
  }

  async function exportar(separado) {
    const alvo = _pessoas().filter(p => S.sel.has(p.user_id));
    if (!alvo.length) { toast('Escolha ao menos um colaborador', 'err'); return; }
    setLoading(true, 'Gerando a planilha…');
    try { const n = await Excel.exportarFrotaPlanilha(S.anual, alvo, { mes: S.mes, separado }); toast(separado ? `${n} planilhas geradas 📗` : 'Planilha gerada 📗'); }
    catch (e) { toast('Planilha: ' + e.message, 'err'); }
    finally { setLoading(false); }
  }

  return {
    montar, ver, alternar, todos, celula, individual, fechar, mes, exportar,
    cancelar() { _gen++; },                       // trocou de aba: resposta em voo não pinta mais nada
    esquecer() { _gen++; S = estadoInicial(); },  // logout: nada de uma conta fica na memória da próxima
  };
})();
