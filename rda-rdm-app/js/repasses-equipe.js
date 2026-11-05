'use strict';
/* ─────────────────────────────────────────────────────────────
   REPASSES E RECARGAS DA EQUIPE (03/11/2026, pedido do Cleiton) — gestor/admin.
   Aberta só pelo menu (05/11/2026). Lista o dinheiro já registrado de todos
   (pedido pendente não entra: não é dinheiro na mão), com filtros RDM, RDA,
   Cartão RDM e Cartão RDA, por mês (ou ano todo) e por pessoa.
   ✏️ abre o editor na própria linha: enquanto o gestor digita, o quadro mostra
   como o saldo fica e os lançamentos do mês e grupo escolhidos. É prévia: nada
   grava antes do Salvar, que usa salvarCorrecaoRepasse, o mesmo da ficha.
   🗑 usa excluirRepasseDeOutro. O saldo é o de hoje, de todo o histórico da
   pessoa (Gestor.saldoAnoAnterior do ano seguinte), a conta da ficha e da planilha.
   Grupo do registro: destino 'recarga' = cartão; tipo diz RDM ou RDA.
   Depende de globais do app.js: $, sb, esc, brl, toast, _at, fmtDataBR, MESES,
   filMes, filAno, viewAtual, FusoBR, _ehGestorOuAdmin, _ehCV, switchView,
   _repasseEhRecebido, _notaDoCartao, _mesAnoDaData, _dataNoFuturo,
   _gruposDoRepasse, _grupoDoRepasse, _repasseNoGrupo, salvarCorrecaoRepasse,
   excluirRepasseDeOutro; e de Gestor (gestor.js).
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
  let colabs = {};                   // id → colaborador (o regime decide as contas e os grupos)
  let aberto = null, rascunho = null;   // id em edição e o que foi digitado
  let hist = {};                     // user_id → { notas, reps }; null = não carregou

  const grupoDe = r => (r.destino === 'recarga' ? 'C' : '') + (r.tipo === 'RDA' ? 'RDA' : 'RDM');
  const rotuloDe = id => GRUPOS.find(g => g.id === id)?.rotulo || id;
  const soma = arr => arr.reduce((a, r) => a + (Number(r.valor) || 0), 0);
  const nomeDe = r => nomes[r.user_id] || 'Colaborador';
  const donoDe = r => colabs[r.user_id] || equipePorId[r.user_id];
  const abertoAgora = () => lista.find(r => r.id === aberto) || null;
  const lerValor = t => {
    const s = String(t).trim();
    return parseFloat(s.includes(',') ? s.replace(/[.]/g, '').replace(',', '.') : s);
  };

  /* O rascunho já convertido; `erro` diz o que falta para poder salvar. */
  function _lido() {
    const valor = lerValor(rascunho.valor);
    const [mesD, anoD] = _mesAnoDaData(rascunho.data);
    const dataOk = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(rascunho.data);
    const erroLido = !(valor > 0) ? 'Valor inválido.' : !dataOk ? 'Data inválida.' : (_dataNoFuturo(rascunho.data) || '');
    return { valor, data: rascunho.data, mes: mesD, ano: anoD, grupo: rascunho.grupo, descricao: rascunho.desc.trim() || null, erro: erroLido };
  }

  /* O registro como ficaria depois de salvar, para a prévia. */
  function _simulado(r, c) {
    return { ...r, ..._repasseNoGrupo(r, c.grupo, donoDe(r)), valor: c.erro ? r.valor : c.valor, data: c.data, mes: c.mes, ano: c.ano };
  }

  async function _carregarHistorico(uid) {
    if (hist[uid] !== undefined) return;
    try {
      const [ns, rs] = await Promise.all([
        sb.notas.list({ user_id: uid, deleted: '0', fields: 'valor,mes,ano,tipo,pagamento,data,subtipo,razao_social' }),
        sb.repasses.list({ user_id: uid, deleted: '0' }),
      ]);
      hist[uid] = { notas: ns || [], reps: rs || [] };
    } catch (_) { hist[uid] = null; }
  }

  /* A prévia: saldo antes → depois e os lançamentos do mês e do grupo escolhidos. Só repinta este quadro, para não tirar o foco de quem digita. */
  function _pintarEfeito() {
    const el = $('repc-efeito'), r = abertoAgora();
    if (!el || !r) return;
    const c = _lido();
    const aviso = $('repc-erro');
    if (aviso) aviso.textContent = c.erro;
    const h = hist[r.user_id];
    if (h === undefined) { el.innerHTML = '<div class="repc-nota">Carregando saldo e lançamentos…</div>'; return; }
    if (h === null) { el.innerHTML = '<div class="repc-nota">Não deu para carregar o saldo e os lançamentos. A correção ainda pode ser salva.</div>'; return; }

    const sim = _simulado(r, c);
    const repsDepois = h.reps.map(x => (x.id === r.id ? sim : x));
    const anoFim = Number(String(sb?.hojeDoServidor?.() || FusoBR.hojeISO()).slice(0, 4)) + 1;
    const antes = Gestor.saldoAnoAnterior(h.notas, h.reps, anoFim);
    const depois = Gestor.saldoAnoAnterior(h.notas, repsDepois, anoFim);
    const cv = _ehCV(donoDe(r) || {});
    const contas = cv
      ? [['cartao', '💳 Cartão'], ['reembRDM', '💵 Reembolso RDM'], ['reembRDA', '💵 Reembolso RDA']]
      : [['RDM', '💼 RDM'], ['RDA', '🍽️ RDA'], ['cartao', '💳 Cartão']];
    const ehRecarga = sim.destino === 'recarga';
    const contaDele = ehRecarga ? 'cartao' : (cv ? 'reemb' : '') + sim.tipo;
    const mudaram = contas.filter(([k]) => antes[k] !== depois[k]);
    const linhas = (mudaram.length ? mudaram : contas.filter(([k]) => k === contaDele)).map(([k, rot]) => {
      const sentido = Gestor.sentidoSaldo(depois[k]);
      return `<div class="repc-saldo"><span>${rot}</span><b>${antes[k] === depois[k] ? brl(depois[k]) : `${brl(antes[k])} → <span class="${depois[k] < 0 ? 'neg' : 'pos'}">${brl(depois[k])}</span>`}</b></div>${sentido ? `<div class="repc-nota" style="text-align:right">${sentido}</div>` : ''}`;
    }).join('');

    const daConta = n => (ehRecarga ? _notaDoCartao(n) : cv ? n.pagamento === 'carteira' : n.pagamento !== 'empresa');
    const doMes = o => Number(o.mes) === sim.mes && Number(o.ano) === sim.ano && o.tipo === sim.tipo;
    const notasMes = h.notas.filter(n => doMes(n) && daConta(n)).sort((a, b) => String(b.data).localeCompare(String(a.data)));
    const repsMes = repsDepois.filter(x => doMes(x) && _repasseEhRecebido(x) && (x.destino === 'recarga') === ehRecarga);
    const periodo = `${MESES[sim.mes - 1]}/${sim.ano}`;
    const grupoRot = `${ehRecarga ? 'Cartão ' : ''}${sim.tipo}`;

    el.innerHTML = `
      <div class="repc-tit">Saldo de hoje${mudaram.length ? ' com esta correção' : ''}</div>
      ${linhas}
      ${mudaram.length ? '' : '<div class="repc-nota">Esta correção não muda o saldo.</div>'}
      <div class="repc-tit" style="margin-top:10px">Lançamentos de ${periodo} · ${grupoRot}</div>
      <div class="repc-saldo"><span>Recebido ${repsMes.length > 1 ? `(${repsMes.length} registros)` : ''}</span><b>${brl(soma(repsMes))}</b></div>
      <div class="repc-saldo"><span>Lançado</span><b>${brl(soma(notasMes))}</b></div>
      ${notasMes.length ? `<div class="repc-notas">${notasMes.map(n => `<div class="repc-linha"><span>${esc(fmtDataBR(n.data).slice(0, 5))}</span><span class="repc-emit">${esc(n.razao_social || n.subtipo || 'Sem emitente')}</span><b>${brl(n.valor)}</b></div>`).join('')}</div>`
        : '<div class="repc-nota">Nenhum lançamento neste mês e grupo.</div>'}
      <button type="button" class="btn btn-sm btn-outline" style="margin-top:8px" data-uid="${_at(r.user_id)}" data-mes="${sim.mes}" data-ano="${sim.ano}" onclick="RepassesEquipe.ficha(this.dataset)">Abrir a ficha de ${esc(nomeDe(r).split(' ')[0])} ›</button>`;
  }

  function _editor(r) {
    const grupos = _gruposDoRepasse(r, donoDe(r));
    const hoje = sb?.hojeDoServidor?.() || FusoBR.hojeISO();
    return `<div class="repc-ed" id="repc-ed">
      <div class="repc-grupos" role="group" aria-label="Grupo">
        ${grupos.map(g => `<button type="button" class="chip ${rascunho.grupo === g.valor ? 'active' : ''}" aria-pressed="${rascunho.grupo === g.valor}" data-g="${_at(g.valor)}" onclick="RepassesEquipe.grupoDoRascunho(this.dataset.g)">${esc(g.rotulo)}</button>`).join('')}
      </div>
      <div class="repc-campos">
        <label class="repc-campo">Valor (R$)<input class="inp" inputmode="decimal" value="${_at(rascunho.valor)}" oninput="RepassesEquipe.campo('valor',this.value)"></label>
        <label class="repc-campo">Data<input class="inp" type="date" max="${_at(hoje)}" value="${_at(rascunho.data)}" oninput="RepassesEquipe.campo('data',this.value)"></label>
      </div>
      <label class="repc-campo">Descrição<input class="inp" placeholder="Opcional" value="${_at(rascunho.desc)}" oninput="RepassesEquipe.campo('desc',this.value)"></label>
      <div class="repc-efeito" id="repc-efeito" aria-live="polite"></div>
      <div class="repc-erro" id="repc-erro" role="alert"></div>
      <div class="repc-acoes">
        <button type="button" class="btn btn-sm btn-outline" onclick="RepassesEquipe.fechar()">Cancelar</button>
        <button type="button" class="btn btn-sm btn-primary" onclick="RepassesEquipe.salvar()">Salvar</button>
      </div>
    </div>`;
  }

  async function abrir(id) {
    if (aberto === id) { fechar(); return; }
    if (!sb || !navigator.onLine) { toast('Precisa de internet para corrigir', 'err'); return; }
    const r = lista.find(x => x.id === id);
    if (!r) { toast('Repasse não encontrado', 'err'); return; }
    aberto = id;
    rascunho = { grupo: _grupoDoRepasse(r), valor: String(Number(r.valor) || 0), data: String(r.data).slice(0, 10), desc: r.descricao || '' };
    _pintar();
    $('repc-ed')?.scrollIntoView({ block: 'nearest' });
    await _carregarHistorico(r.user_id);
    if (aberto === id) _pintarEfeito();
  }

  function fechar() { aberto = null; rascunho = null; _pintar(); }

  async function salvar() {
    const r = abertoAgora();
    if (!r) return;
    const c = _lido();
    if (c.erro) { toast(c.erro, 'err'); return; }
    const igual = c.grupo === _grupoDoRepasse(r) && c.valor === Number(r.valor) && c.data === String(r.data).slice(0, 10) && c.descricao === (r.descricao || null);
    if (igual) { fechar(); return; }
    const guardado = { id: aberto, rascunho };
    aberto = null; rascunho = null;   // o recarregar da lista já chega com o editor fechado
    const ok = await salvarCorrecaoRepasse(r, { ...c, dono: donoDe(r) });
    if (ok || viewAtual !== 'repasses') return;
    aberto = guardado.id; rascunho = guardado.rascunho;   // não salvou: o que foi digitado continua lá
    _pintar();
  }

  async function carregar() {
    const meu = ++pedidoAtual;
    hist = {};
    if (!sb || !navigator.onLine) { erro = 'Precisa de internet para ver os repasses da equipe.'; lista = []; _pintar(); return; }
    try {
      const [rows, todos] = await Promise.all([sb.repasses.list({ ano, deleted: '0' }), sb.colaboradores.listTodos()]);
      if (meu !== pedidoAtual) return;
      nomes = Object.fromEntries((todos || []).map(c => [c.id, c.nome || c.email || 'Colaborador']));
      colabs = Object.fromEntries((todos || []).map(c => [c.id, c]));
      lista = (rows || []).filter(r => !r.deleted && _repasseEhRecebido(r));
      window._repassesDaFicha = lista;   // o 🗑 acha o registro por aqui (_repasseDaEquipe)
      erro = '';
      if (aberto && !abertoAgora()) { aberto = null; rascunho = null; }   // foi excluído
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
          <button class="btn-icon-sm" title="Corrigir" aria-label="Corrigir" aria-expanded="${aberto === r.id}" data-rep="${_at(r.id)}" onclick="RepassesEquipe.abrir(this.dataset.rep)">✏️</button>
          <button class="btn-icon-sm danger" title="Excluir" aria-label="Excluir" data-rep="${_at(r.id)}" onclick="excluirRepasseDeOutro(this.dataset.rep)">🗑</button>
        </div>
        ${aberto === r.id ? _editor(r) : ''}
      </div>`;
    };

    $('app-content').innerHTML = `
      <div class="ini-ola" style="padding:4px 2px 6px"><h2>💸 Repasses e recargas</h2><span>Toque no ✏️ para corrigir e ver na hora o saldo e os lançamentos</span></div>
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
    _pintarEfeito();
  }

  function andar(delta) {
    aberto = null; rascunho = null;
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
    anoTodo: () => { mes = mes ? 0 : filMes; fechar(); },
    pessoa: id => { pessoa = id; fechar(); },
    filtrar: id => { grupo = grupo === id ? 'todos' : id; fechar(); },
    abrir,
    fechar,
    salvar,
    campo: (k, v) => { if (rascunho) { rascunho[k] = v; _pintarEfeito(); } },
    grupoDoRascunho: g => {
      if (!rascunho) return;
      rascunho.grupo = g;
      document.querySelectorAll('#repc-ed .repc-grupos .chip').forEach(b => {
        const ativo = b.dataset.g === g;
        b.classList.toggle('active', ativo);
        b.setAttribute('aria-pressed', String(ativo));
      });
      _pintarEfeito();
    },
    /* a ficha abre no mês que está na tela, senão mostraria outro */
    ficha: d => {
      filMes = Number(d.mes); filAno = Number(d.ano);
      switchView('equipe');
      setTimeout(() => Gestor.abrir(d.uid), 400);
    },
  };
})();
