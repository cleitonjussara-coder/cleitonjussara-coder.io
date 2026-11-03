'use strict';
/* ─────────────────────────────────────────────────────────────
   REPASSES E RECARGAS DA EQUIPE (03/11/2026, pedido do Cleiton) — gestor/admin.
   Aberta pelo botão "💸 Repasses e recargas" da Equipe. Lista o dinheiro já
   registrado de todos (pedido pendente não entra: não é dinheiro na mão), com
   filtros RDM, RDA, Cartão RDM e Cartão RDA, por mês (ou ano todo) e por pessoa.
   ✏️ e 🗑 usam os mesmos editarRepasseDeOutro / excluirRepasseDeOutro da ficha;
   o saldo e as planilhas leem do servidor, então acompanham a correção.
   Grupo do registro: destino 'recarga' = cartão; tipo diz RDM ou RDA.
   Depende de globais do app.js: $, sb, esc, brl, toast, _at, fmtDataBR, MESES,
   filMes, filAno, _ehGestorOuAdmin, switchView, _repasseEhRecebido,
   editarRepasseDeOutro, excluirRepasseDeOutro.
───────────────────────────────────────────────────────────── */
window.RepassesEquipe = (() => {
  const GRUPOS = [
    { id: 'RDM', rotulo: '💼 RDM' },
    { id: 'RDA', rotulo: '🍽️ RDA' },
    { id: 'CRDM', rotulo: '💳 Cartão RDM' },
    { id: 'CRDA', rotulo: '💳 Cartão RDA' },
  ];
  let ano = null, mes = null;        // mes 0 = ano todo
  let pessoa = '', grupo = 'todos';
  let lista = [], nomes = {}, erro = '';
  let pedidoAtual = 0;               // resposta lenta de outro ano não pinta por cima

  const grupoDe = r => (r.destino === 'recarga' ? 'C' : '') + (r.tipo === 'RDA' ? 'RDA' : 'RDM');
  const rotuloDe = id => GRUPOS.find(g => g.id === id)?.rotulo || id;
  const soma = arr => arr.reduce((a, r) => a + (Number(r.valor) || 0), 0);
  const nomeDe = r => nomes[r.user_id] || 'Colaborador';

  async function carregar() {
    const meu = ++pedidoAtual;
    if (!sb || !navigator.onLine) { erro = 'Precisa de internet para ver os repasses da equipe.'; lista = []; _pintar(); return; }
    try {
      const [rows, todos] = await Promise.all([sb.repasses.list({ ano, deleted: '0' }), sb.colaboradores.listTodos()]);
      if (meu !== pedidoAtual) return;
      nomes = Object.fromEntries((todos || []).map(c => [c.id, c.nome || c.email || 'Colaborador']));
      lista = (rows || []).filter(r => !r.deleted && _repasseEhRecebido(r));
      window._repassesDaFicha = lista;   // o ✏️ e o 🗑 acham o registro por aqui (_repasseDaEquipe)
      erro = '';
    } catch (e) {
      if (meu !== pedidoAtual) return;
      erro = 'Não deu para carregar: ' + (e.message || 'erro');
      lista = [];
    }
    _pintar();
  }

  function _pintar() {
    if (viewAtual !== 'repasses') return;
    const doPeriodo = lista.filter(r => (!mes || r.mes === mes) && (!pessoa || r.user_id === pessoa));
    const visiveis = doPeriodo
      .filter(r => grupo === 'todos' || grupoDe(r) === grupo)
      .sort((a, b) => String(b.data).localeCompare(String(a.data)) || nomeDe(a).localeCompare(nomeDe(b)));

    const chip = (id, rotulo, arr) => `<button type="button" class="chip ${grupo === id ? 'active' : ''}" aria-pressed="${grupo === id}" data-g="${id}" onclick="RepassesEquipe.filtrar(this.dataset.g)">${rotulo} · ${arr.length}</button>`;
    const pessoas = Object.entries(Object.fromEntries(lista.map(r => [r.user_id, nomeDe(r)])))
      .sort((a, b) => a[1].localeCompare(b[1]));
    if (pessoa && !pessoas.some(([id]) => id === pessoa)) pessoas.push([pessoa, nomes[pessoa] || 'Colaborador']);

    const item = r => {
      const g = grupoDe(r);
      return `<div class="rep-item cdet-rep" style="flex-direction:column;align-items:stretch;gap:4px">
        <div style="display:flex;align-items:center;gap:8px">
          <span class="cdet-rep-ico">${g[0] === 'C' ? '💳' : g === 'RDA' ? '🍽️' : '💼'}</span>
          <div class="rep-desc" style="white-space:normal;overflow-wrap:anywhere;min-width:0"><b>${esc(nomeDe(r))}</b></div>
          <span class="rep-val cdet-rep-val" style="margin-left:auto;color:#b9e24a">${brl(r.valor)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="cdet-rep-sub" style="flex:1;min-width:0;overflow-wrap:anywhere">${fmtDataBR(r.data)} · ${esc(rotuloDe(g).replace(/^\S+ /, ''))}${r.descricao ? ' · ' + esc(r.descricao) : ''}</div>
          <button class="btn-icon-sm" title="Corrigir" aria-label="Corrigir" data-rep="${_at(r.id)}" onclick="editarRepasseDeOutro(this.dataset.rep)">✏️</button>
          <button class="btn-icon-sm danger" title="Excluir" aria-label="Excluir" data-rep="${_at(r.id)}" onclick="excluirRepasseDeOutro(this.dataset.rep)">🗑</button>
        </div>
      </div>`;
    };

    $('app-content').innerHTML = `
      <div class="ini-ola" style="padding:4px 2px 6px"><h2>💸 Repasses e recargas</h2><span>Corrija valor, data, descrição e grupo de toda a equipe</span></div>
      <div class="page-hd" style="flex-wrap:wrap;gap:8px">
        <div class="mes-nav">
          <button class="btn-mes-nav" aria-label="Anterior" onclick="RepassesEquipe.andar(-1)">‹</button>
          <span class="mes-label">${mes ? MESES[mes - 1] + ' ' : 'Ano todo · '}${ano}</span>
          <button class="btn-mes-nav" aria-label="Próximo" onclick="RepassesEquipe.andar(1)">›</button>
        </div>
        <button type="button" class="chip ${mes ? '' : 'active'}" aria-pressed="${!mes}" onclick="RepassesEquipe.anoTodo()">Ano todo</button>
      </div>
      <select class="inp" style="margin:0 0 10px" aria-label="Colaborador" onchange="RepassesEquipe.pessoa(this.value)">
        <option value="">Todos os colaboradores</option>
        ${pessoas.map(([id, nome]) => `<option value="${_at(id)}"${id === pessoa ? ' selected' : ''}>${esc(nome)}</option>`).join('')}
      </select>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px">
        ${chip('todos', 'Todos', doPeriodo)}${GRUPOS.map(g => chip(g.id, g.rotulo, doPeriodo.filter(r => grupoDe(r) === g.id))).join('')}
      </div>
      ${erro ? `<div class="empty-state"><p>${esc(erro)}</p></div>` : `
      <div class="colab-resumo" style="margin:0 0 10px">Total ${grupo === 'todos' ? 'da lista' : 'do filtro'}: <b>${brl(soma(visiveis))}</b> · ${visiveis.length} lançamento${visiveis.length === 1 ? '' : 's'}</div>
      ${visiveis.length ? visiveis.map(item).join('') : '<div class="empty-state" style="padding:24px 14px">Nada com esse filtro neste período.</div>'}`}`;
  }

  function andar(delta) {
    if (!mes) { ano += delta; carregar(); return; }
    mes += delta;
    if (mes >= 1 && mes <= 12) { _pintar(); return; }
    ano += delta; mes = delta > 0 ? 1 : 12;
    carregar();
  }

  function render() {
    if (typeof _ehGestorOuAdmin === 'function' && !_ehGestorOuAdmin()) { switchView('inicio'); return; }
    if (ano == null) { ano = filAno; mes = filMes; }
    $('app-content').innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando repasses…</p></div>';
    carregar();
  }

  return {
    render,
    atualizar: () => carregar(),
    andar,
    anoTodo: () => { mes = mes ? 0 : filMes; _pintar(); },
    pessoa: id => { pessoa = id; _pintar(); },
    filtrar: id => { grupo = grupo === id ? 'todos' : id; _pintar(); },
  };
})();
