'use strict';
/* ─────────────────────────────────────────────────────────────
   ARQUIVOS.js — os anexos direto do servidor (19/09/2026)

   Substitui o que o gestor ia buscar no Google Drive: a árvore
   Colaborador → Ano → Mês → grupo/categoria, com miniatura de cada nota
   e o botão "Baixar ZIP" (do mês ou do ano) já na nomenclatura da pasta
   modelo da empresa, com a Planilha CV dentro.

   Nada é lido do disco: o servidor monta tudo a partir do banco
   (GET /arquivos/resumo e /arquivos/notas). As miniaturas vêm assinadas
   por 1–2 h e ficam no cache do navegador.

   Três níveis: colaboradores (gestor/admin) → meses → notas do mês.
   Colaborador comum cai direto nos próprios meses.

   Depende de globais do app.js: $, sb, user, toast, setLoading, esc,
   fmtData, brl, filAno, MESES, _ehGestorOuAdmin, viewAtual.
───────────────────────────────────────────────────────────── */
window.Arquivos = (() => {

  let ano = null;          // ano em foco (começa no filAno do app)
  let colab = null;        // {user_id, nome, ...} escolhido
  let mes = null;          // 1–12 ou null (nível meses)
  let resumo = null;       // GET /arquivos/resumo do ano
  let lista = null;        // GET /arquivos/notas do mês

  const MESES_LONGO = ['', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const ini = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase();

  /* ── entrada ─────────────────────────────────────────────── */
  async function render() {
    if (ano === null) ano = filAno;
    const el = $('app-content');
    if (!navigator.onLine) {
      el.innerHTML = `<div class="db-container"><div class="db-card" style="text-align:center;padding:24px">
        <div style="font-size:30px">📁</div><p style="margin-top:8px;color:var(--text2)">Os arquivos ficam no servidor: precisa de internet para abrir esta tela.</p>
        <button class="btn btn-outline" style="margin-top:12px" onclick="Arquivos.render()">Tentar de novo</button></div></div>`;
      return;
    }
    if (!_veEquipe() && !colab) colab = { user_id: user.id, nome: user.nome || user.email };
    try {
      if (colab && mes) await renderMes();
      else if (colab) await renderMeses();
      else await renderColabs();
    } catch (e) {
      el.innerHTML = `<div class="db-container"><div class="db-card" style="text-align:center;padding:24px">
        <p style="color:var(--danger)">Não consegui carregar: ${esc(e.message || 'erro')}</p>
        <button class="btn btn-outline" style="margin-top:12px" onclick="Arquivos.render()">Tentar de novo</button></div></div>`;
    }
  }

  function _cabecalho(titulo, sub, voltar) {
    return `
      <div class="arq-hd">
        ${voltar ? `<button class="btn-voltar" onclick="${voltar}">‹ Voltar</button>` : ''}
        <div class="mes-nav" style="margin-left:auto">
          <button class="btn-mes-nav" onclick="Arquivos.mudarAno(-1)">‹</button>
          <span class="mes-label">${ano}</span>
          <button class="btn-mes-nav" onclick="Arquivos.mudarAno(1)">›</button>
        </div>
      </div>
      <div class="arq-titulo">${titulo}</div>
      ${sub ? `<div class="arq-sub">${sub}</div>` : ''}`;
  }

  /* ── nível 1: colaboradores ──────────────────────────────── */
  async function renderColabs() {
    const el = $('app-content');
    el.innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando arquivos…</p></div>';
    resumo = await sb.arquivos.resumo(ano);
    const cs = resumo.colaboradores || [];
    const totalNotas = cs.reduce((s, c) => s + c.qtd, 0);
    const totalValor = cs.reduce((s, c) => s + c.total, 0);
    const semAnexo = cs.reduce((s, c) => s + (c.qtd - c.com_anexo), 0);

    let html = `<div class="db-container">
      ${_cabecalho('📁 Arquivos no servidor', `${totalNotas} nota${totalNotas === 1 ? '' : 's'} em ${ano} · ${brl(totalValor)}${semAnexo ? ` · <b style="color:#ffd166">${semAnexo} sem anexo</b>` : ''}`)}
      <div class="ini-dica">Toque no colaborador para ver os meses; de cada mês dá para baixar um ZIP já nas pastas do modelo da empresa (com a Planilha CV dentro). Não depende do Google Drive.</div>`;

    if (!cs.length) html += `<div class="db-card" style="text-align:center;color:var(--text2)">Nenhum colaborador.</div>`;
    for (const c of cs) {
      const vazio = !c.qtd;
      html += `
        <button class="arq-colab ${vazio ? 'arq-vazio' : ''}" onclick="Arquivos.abrirColab('${c.user_id}')">
          <div class="avatar" data-foto="${esc(c.foto_path || '')}">${esc(ini(c.nome || c.email))}</div>
          <div class="arq-colab-txt">
            <div class="arq-colab-nome">${esc(c.nome || c.email)}${c.ativo === false ? ' <span style="font-size:12px;opacity:.75">🚫 desativado</span>' : ''}</div>
            <div class="arq-colab-sub">${vazio ? 'sem notas em ' + ano : `${c.qtd} nota${c.qtd === 1 ? '' : 's'} · ${brl(c.total)}${c.qtd - c.com_anexo ? ` · <span style="color:#ffd166">${c.qtd - c.com_anexo} sem anexo</span>` : ''}`}</div>
          </div>
          <span class="arq-seta">›</span>
        </button>`;
    }
    html += '</div>';
    el.innerHTML = html;
    window.Gestor?.carregarAvatares?.();
  }

  /* ── nível 2: meses do colaborador ───────────────────────── */
  async function renderMeses() {
    const el = $('app-content');
    el.innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando meses…</p></div>';
    if (!resumo || resumo.ano !== ano) resumo = await sb.arquivos.resumo(ano);
    const c = (resumo.colaboradores || []).find(x => x.user_id === colab.user_id) || { ...colab, qtd: 0, total: 0, com_anexo: 0, meses: [] };
    colab = c;
    const porMes = {};
    (c.meses || []).forEach(m => { porMes[m.mes] = m; });

    let html = `<div class="db-container">
      ${_cabecalho(`📁 ${esc(c.nome || c.email)}`, `${c.qtd} nota${c.qtd === 1 ? '' : 's'} em ${ano} · ${brl(c.total)}`, _veEquipe() ? 'Arquivos.voltarColabs()' : "switchView('inicio')")}
      ${c.qtd ? `<button class="btn btn-primary btn-full" style="min-height:50px" onclick="Arquivos.baixarZip(null)">⬇️ Baixar ZIP do ano ${ano} (${c.com_anexo} anexo${c.com_anexo === 1 ? '' : 's'} + Planilha CV)</button>` : ''}
      <div class="arq-meses">`;
    for (let m = 1; m <= 12; m++) {
      const d = porMes[m];
      html += `
        <button class="arq-mes ${d ? '' : 'arq-vazio'}" ${d ? `onclick="Arquivos.abrirMes(${m})"` : 'disabled'}>
          <span class="arq-mes-nome">${MESES[m - 1]}</span>
          <span class="arq-mes-qtd">${d ? d.qtd + (d.qtd === 1 ? ' nota' : ' notas') : '—'}</span>
          <span class="arq-mes-val">${d ? brl(d.total) : ''}</span>
          ${d && d.qtd - d.com_anexo ? `<span class="arq-mes-alerta">${d.qtd - d.com_anexo} sem anexo</span>` : ''}
        </button>`;
    }
    html += '</div></div>';
    el.innerHTML = html;
  }

  /* ── nível 3: notas do mês, agrupadas como na pasta modelo ─ */
  async function renderMes() {
    const el = $('app-content');
    el.innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando notas…</p></div>';
    lista = await sb.arquivos.notas(colab.user_id, ano, mes);
    const ns = lista.notas || [];
    const total = ns.reduce((s, n) => s + (n.valor || 0), 0);
    const comAnexo = ns.filter(n => n.foto_path).length;

    /* agrupa pela trilha da pasta (RDA ALIMENTAÇÃO / RDM · ABASTECIMENTO …) na
       ordem em que aparecem na pasta modelo */
    const ordem = ['RDA ALIMENTAÇÃO', 'RDM · ABASTECIMENTO', 'RDM · HOSPEDAGENS', 'RDM · OUTROS'];
    const grupos = {};
    ns.forEach(n => { (grupos[n.grupo] = grupos[n.grupo] || []).push(n); });
    const chaves = Object.keys(grupos).sort((a, b) => (ordem.indexOf(a) + 100) % 100 - (ordem.indexOf(b) + 100) % 100);

    let html = `<div class="db-container">
      ${_cabecalho(`📁 ${esc(colab.nome || colab.email)} · ${MESES_LONGO[mes]}`, `${ns.length} nota${ns.length === 1 ? '' : 's'} · ${brl(total)} · ${comAnexo} com anexo`, 'Arquivos.voltarMeses()')}
      ${ns.length ? `<button class="btn btn-primary btn-full" style="min-height:50px" onclick="Arquivos.baixarZip(${mes})">⬇️ Baixar ZIP de ${MESES_LONGO[mes]} (${comAnexo} anexo${comAnexo === 1 ? '' : 's'} + Planilha CV)</button>` : ''}`;

    if (!ns.length) html += `<div class="db-card" style="text-align:center;color:var(--text2)">Nenhuma nota neste mês.</div>`;
    for (const g of chaves) {
      const itens = grupos[g];
      const sub = itens.reduce((s, n) => s + (n.valor || 0), 0);
      html += `
        <div class="arq-grupo">
          <div class="arq-grupo-hd"><span>${esc(g)}</span><span>${itens.length} · ${brl(sub)}</span></div>
          <div class="arq-grade">`;
      for (const n of itens) {
        const legenda = `${fmtData(n.data)}<br><b>${brl(n.valor)}</b>`;
        const forn = esc((n.razao_social || '').split(' ').slice(0, 3).join(' '));
        if (n.mini_url) {
          html += `<button class="arq-item" onclick="Arquivos.ver('${n.id}')" title="${esc(n.arquivo || '')}">
              <img src="${n.mini_url}" alt="" decoding="async">
              <span class="arq-leg">${legenda}</span>${forn ? `<span class="arq-forn">${forn}</span>` : ''}</button>`;
        } else if (n.foto_path) {
          html += `<button class="arq-item" onclick="Arquivos.ver('${n.id}')" title="${esc(n.arquivo || '')}">
              <span class="arq-ico">${n.ext === 'pdf' ? '📄 PDF' : n.ext === 'xml' ? '🧾 XML' : '🖼️ ' + (n.ext || '').toUpperCase()}</span>
              <span class="arq-leg">${legenda}</span>${forn ? `<span class="arq-forn">${forn}</span>` : ''}</button>`;
        } else {
          html += `<div class="arq-item arq-sem" title="Sem anexo no servidor">
              <span class="arq-ico">⚠️<br><small>sem anexo</small></span>
              <span class="arq-leg">${legenda}</span>${forn ? `<span class="arq-forn">${forn}</span>` : ''}</div>`;
        }
      }
      html += '</div></div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  /* ── ações ───────────────────────────────────────────────── */
  function mudarAno(d) { ano += d; resumo = null; lista = null; if (mes) mes = null; render(); }
  function abrirColab(id) { colab = (resumo?.colaboradores || []).find(c => c.user_id === id) || { user_id: id }; mes = null; render(); }
  function abrirMes(m) { mes = m; render(); }
  function voltarMeses() { mes = null; lista = null; render(); }
  function voltarColabs() { colab = null; mes = null; lista = null; render(); }

  /* abre a foto inteira (URL assinada de 5 min) no visualizador do app;
     PDF/XML vão para uma aba nova */
  async function ver(id) {
    const n = (lista?.notas || []).find(x => x.id === id);
    if (!n || !n.foto_path) return;
    setLoading(true);
    try {
      const url = await sb.fotos.url(n.foto_path);
      if (!url) { toast('Anexo não encontrado', 'err'); return; }
      if (n.ext === 'pdf' || n.ext === 'xml') { window.open(url, '_blank'); return; }
      $('foto-viewer-img').src = url;
      $('foto-viewer-info').innerHTML = `<b style="font-size:16px;color:#fff">${esc(n.razao_social || 'Sem fornecedor')}</b><br>${esc(n.grupo)} · ${fmtData(n.data)} · ${brl(n.valor)}<br><small style="opacity:.7">${esc(n.pasta)}/${esc(n.arquivo || '')}</small>`;
      $('foto-viewer-overlay').style.display = 'flex';
    } catch (e) { toast('Não abriu: ' + (e.message || 'erro'), 'err'); }
    finally { setLoading(false); }
  }

  async function baixarZip(m) {
    if (!navigator.onLine) { toast('Precisa de internet', 'err'); return; }
    setLoading(true, m ? `Montando o ZIP de ${MESES_LONGO[m]}…` : `Montando o ZIP de ${ano} (pode levar 1 min)…`);
    try {
      const blob = await sb.arquivos.zip(colab.user_id, ano, m);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const nome = (colab.pasta || colab.nome || 'colaborador').replace(/[^A-Za-z0-9_-]+/g, '_');
      a.href = url; a.download = `Notas_${nome}_${ano}${m ? '-' + String(m).padStart(2, '0') : ''}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast(`ZIP pronto (${(blob.size / 1024 / 1024).toFixed(1)} MB) ✅`);
    } catch (e) {
      toast('Não foi possível montar o ZIP: ' + (e.message || 'erro'), 'err');
    } finally { setLoading(false); }
  }

  function reset() { colab = null; mes = null; lista = null; }

  return { render, mudarAno, abrirColab, abrirMes, voltarMeses, voltarColabs, ver, baixarZip, reset };
})();
