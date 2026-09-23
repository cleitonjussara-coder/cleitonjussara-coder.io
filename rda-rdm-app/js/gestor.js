'use strict';
/* ─────────────────────────────────────────────────────────────
   Gestor.js — dashboard de equipe (gestor / admin)
───────────────────────────────────────────────────────────── */
window.Gestor = (() => {
  const MESES  = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const ROLES   = ['colaborador','gestor','admin','contabilidade'];   // contabilidade: só vê e baixa (21/09/2026)
  /* o que cada papel faz, em uma linha — é o que aparece no seletor da Equipe */
  const PAPEL_TXT = {
    colaborador  : 'Colaborador — lança as próprias notas',
    gestor       : 'Gestor — vê a equipe, edita papéis e cuida do servidor',
    admin        : 'Administrador — tudo, inclusive promover administrador',
    contabilidade: 'Contabilidade — só vê e baixa relatórios',
  };

  const brl = v => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v||0);
  const ini = nome => (nome||'?').split(' ').slice(0,2).map(n=>n[0]||'').join('').toUpperCase();
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fmtData = d => { const s = String(d || '').slice(0, 10); const [a, m, dd] = s.split('-'); return dd ? `${dd}/${m}/${a}` : s; };

  /* Detalhe de um colaborador: id aberto e o contexto do último render, para
     abrir/fechar sem o app.js precisar saber de nada além de re-renderizar. */
  let _detalheId = null;
  let _ctx = null;
  let _cvEquipe = null;   // { collabs, mes, ano, comLancAno, comLancMes } do último dashboard, para o seletor de colaboradores
  function abrir(id)  { _detalheId = id;   _ctx?.onRebuild?.(); }
  /* Busca (20/09/2026): filtra os cartões na hora, sem ir ao servidor;
     abre a seção de desativados se algum deles bater. */
  let _buscaTxt = '';
  function filtrar(txt) {
    _buscaTxt = String(txt || '').trim().toLowerCase();
    const termos = _buscaTxt.split(/\s+/).filter(Boolean);
    let vistos = 0;
    document.querySelectorAll('.colab-card[data-busca]').forEach(c => {
      const ok = termos.every(t => c.dataset.busca.includes(t));
      c.style.display = ok ? '' : 'none';
      if (ok) vistos++;
    });
    const det = document.querySelector('details.dash-card');
    if (det && termos.length) det.open = true;
    const vazio = document.getElementById('busca-vazio');
    if (vazio) vazio.style.display = (termos.length && !vistos) ? '' : 'none';
  }
  function fechar()   { _detalheId = null; _ctx?.onRebuild?.(); }
  function reset()    { _detalheId = null; }

  /* ── Dashboard principal ──────────────────────────────── */
  async function renderDashboard(el, sb, currentUser, onRebuild, options = {}) {
    const mes = options.mes || new Date().getMonth() + 1;
    const ano = options.ano || new Date().getFullYear();

    _ctx = { el, sb, currentUser, onRebuild };
    if (_detalheId) return renderColaborador(el, sb, currentUser, _detalheId, mes, ano);

    el.innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando gestão…</p></div>';
    const podeConsolidar = currentUser.role === 'admin' || currentUser.role === 'gestor';
    try {
      const todos = await sb.colaboradores.listTodos();
      const collabs = todos.filter(c => c.ativo !== false);
      const inativos = todos.filter(c => c.ativo === false);

      // busca o ANO inteiro (p/ a evolução); o mês é filtrado no cliente
      const [notasAno, repAno] = await Promise.all([
        sb.notas.list({ ano, fields: 'user_id,tipo,subtipo,valor,mes,ano,foto_path,deleted' }),
        sb.repasses.list({ ano }),
      ]);
      const nsAno = (notasAno || []).filter(n => !n.deleted);
      /* só o que foi RECEBIDO conta como repasse; pedido pendente (kind='requested') não é dinheiro na mão */
      const rsAno = (repAno   || []).filter(r => !r.deleted && (!r.kind || r.kind === 'received'));
      const ns = nsAno.filter(n => n.mes === mes);
      const rs = rsAno.filter(r => r.mes === mes);
      /* para o modal "CV da equipe": quem entra na lista e quem movimentou no ano */
      _cvEquipe = { collabs, mes, ano, comLancAno: new Set([...nsAno, ...rsAno].map(x => x.user_id)), comLancMes: new Set([...ns, ...rs].map(x => x.user_id)) };
      const soma = arr => arr.reduce((a, x) => a + Number(x.valor || 0), 0);

      // KPIs do mês
      const gRDA = soma(ns.filter(n => n.tipo === 'RDA'));
      const gRDM = soma(ns.filter(n => n.tipo === 'RDM'));
      const gasto = gRDA + gRDM;
      const recebido = soma(rs);
      const saldo = recebido - gasto;
      const pend = ns.filter(n => Number(n.valor || 0) <= 0).length;
      const semFoto = ns.filter(n => !n.foto_path).length;
      const ativos = new Set(ns.map(n => n.user_id)).size;

      // Evolução: gasto por mês no ano
      const evo = [];
      for (let m = 1; m <= 12; m++) evo.push(soma(nsAno.filter(n => n.mes === m)));
      const maxEvo = Math.max(1, ...evo);

      // ── Cabeçalho ──
      let html = `<div class="ini-ola" style="padding:4px 2px 6px"><h2>👥 Equipe / Baixar relatórios</h2><span>${collabs.length} colaborador${collabs.length===1?"":"es"} ativo${collabs.length===1?"":"s"}</span></div>
      <div class="page-hd">
        <div class="mes-nav">
          <button class="btn-mes-nav" onclick="mudarMesEquipe(-1)">‹</button>
          <span class="mes-label">${MESES[mes-1]} ${ano}</span>
          <button class="btn-mes-nav" onclick="mudarMesEquipe(1)">›</button>
        </div>
        <div class="export-btns">
          <button class="btn btn-sm btn-outline" onclick="Gestor.abrirExcelEquipe()" title="Resumo do mês em Excel: escolha os colaboradores">📗 Excel</button>
          <button class="btn btn-sm btn-primary" onclick="Gestor.abrirPdfEquipe()" title="Relatório do mês em PDF: escolha os colaboradores">📕 PDF</button>
          <button class="btn btn-sm btn-outline" onclick="Gestor.abrirCvEquipe()" title="Planilhas no modelo da empresa (CV ou RDM/RDA, conforme o regime de cada um)">📗 Planilhas ${ano}</button>

          ${podeConsolidar && window.GDrive?.isConfigured?.() ? `<button class="btn btn-sm btn-outline" onclick="enviarFotosEquipeDrive()" title="Enviar fotos ao Drive">☁️</button>` : ''}
          ${podeConsolidar ? `<button class="btn btn-sm btn-outline" onclick="Gestor.abrirConvite()" title="Convidar por link (Contabilidade, colaborador…)">✉️ Convidar</button>` : ''}
        </div>
      </div>`;

      /* 21/09/2026 (reunião): os 4 KPIs (Gasto no mês, Recebido, Saldo, Notas)
         saíram daqui — já aparecem no Painel, em RDM/RDA e Planilhas e no
         cartão de cada colaborador. A Equipe é "Equipe / Baixar relatórios". */

      // ── Evolução (ano) ──
      html += `<div class="dash-card">
        <div class="dash-card-title">Evolução do gasto · ${ano}</div>
        <div class="evo">
          ${evo.map((v, i) => `<div class="evo-col ${i + 1 === mes ? 'cur' : ''}" title="${MESES[i]}: ${brl(v)}">
            <div class="evo-bar" style="height:${Math.max(2, Math.round(v / maxEvo * 100))}%"></div>
          </div>`).join('')}
        </div>
        <div class="evo-labels">${MESES.map((m, i) => `<span class="${i + 1 === mes ? 'cur' : ''}">${m.slice(0,1)}</span>`).join('')}</div>
      </div>`;

      html += `<div class="section-hd">Detalhe por colaborador</div>
      <div class="busca-colab">
        <span class="busca-ico">🔍</span>
        <input class="inp" id="busca-colab" type="search" placeholder="Buscar colaborador por nome ou e-mail…" autocomplete="off" oninput="Gestor.filtrar(this.value)">
      </div>`;

      /* Lista única, sem recorte por núcleo — `collabs` já vem ordenada por
         nome do `.order('nome')` lá em cima. */
      {
        let mHtml = '';

        collabs.forEach(m => {
          const mns = ns.filter(n=>n.user_id===m.id);
          const mrs = rs.filter(r=>r.user_id===m.id);
          const rdmG = mns.filter(n=>n.tipo==='RDM').reduce((a,n)=>a+Number(n.valor||0),0);
          const rdmR = mrs.filter(r=>r.tipo==='RDM').reduce((a,r)=>a+Number(r.valor||0),0);
          const rdaG = mns.filter(n=>n.tipo==='RDA').reduce((a,n)=>a+Number(n.valor||0),0);
          const rdaR = mrs.filter(r=>r.tipo==='RDA').reduce((a,r)=>a+Number(r.valor||0),0);

          const canEdit = currentUser.role==='admin' || currentUser.role==='gestor';
          const semFotoM  = mns.filter(n => !n.foto_path).length;
          const semValorM = mns.filter(n => Number(n.valor || 0) <= 0).length;
          const resumo = mns.length
            ? `${mns.length} nota${mns.length === 1 ? '' : 's'} no mês`
              + (semFotoM  ? ` · <span class="alerta">${semFotoM} sem foto</span>` : '')
              + (semValorM ? ` · <span class="alerta">${semValorM} sem valor</span>` : '')
            : 'Nenhuma nota no mês';
          mHtml += `
          <div class="colab-card clicavel" data-busca="${esc(((m.nome||'')+' '+(m.email||'')).toLowerCase())}" onclick="Gestor.abrir('${m.id}')" title="Ver notas de ${esc(m.nome||m.email)}">
            <div class="colab-head">
              <div class="avatar ${m.foto_path ? 'clicavel' : ''}" data-foto="${esc(m.foto_path||'')}" data-nome="${esc(m.nome||m.email)}" data-sub="${esc(m.email)} · ${esc(m.role)}" title="Ver foto" onclick="if(this.dataset.foto){event.stopPropagation();Gestor.verFoto(this)}">${esc(ini(m.nome))}</div>
              <div class="colab-info">
                <div class="colab-nome">${esc(m.nome||m.email)}</div>
                <div class="colab-email">${esc(m.email)}</div>
              </div>
              <span class="role-pill role-${m.role}">${m.role}</span>${m.regime === 'cv' ? '<span class="role-pill" style="background:#0e7c86;color:#fff" title="Cartão corporativo">💳 CV</span>' : ''}
              ${m.exclusao_pedida_por ? `<span class="role-pill" style="background:#fde2e2;color:#9b1c1c" title="Exclusão pedida por ${esc(m.exclusao_pedida_por_nome||'')} — falta a 2ª confirmação">⏳ exclusão</span>` : ''}
              ${('confirmado_em' in m) && !m.confirmado_em ? '<span class="role-pill" style="background:#fef3c7;color:#92400e" title="Cadastro novo: confirme a entrada para liberar o app">🙋 aguardando liberação</span>' : ''}
              ${canEdit?`<button class="btn-icon-sm" data-eid="${m.id}" title="Editar">✏️</button>`:''}
              <span class="colab-seta">›</span>
            </div>
            <div class="colab-bal">
              <div class="bal-box ${rdmR-rdmG<0?'neg':'pos'}">
                <span class="bal-type">RDM</span>
                <span class="bal-val">${brl(rdmR-rdmG)}</span>
                <span class="bal-detail">Gasto ${brl(rdmG)}</span>
                <span class="bal-detail">Recebido ${brl(rdmR)}</span>
              </div>
              <div class="bal-box ${rdaR-rdaG<0?'neg':'pos'}">
                <span class="bal-type">RDA</span>
                <span class="bal-val">${brl(rdaR-rdaG)}</span>
                <span class="bal-detail">Gasto ${brl(rdaG)}</span>
                <span class="bal-detail">Recebido ${brl(rdaR)}</span>
              </div>
            </div>
            <div class="colab-resumo">${resumo}</div>
          </div>`;
        });

        html += `<div class="colab-list">${mHtml}</div>`;

        /* Desativados (20/09/2026): fora da equipe, mas com histórico.
           Ficam recolhidos; o admin/gestor abre para reativar ou excluir. */
        if (inativos.length) {
          html += `<details class="dash-card" style="margin-top:10px"><summary style="cursor:pointer;font-weight:800">🚫 Desativados (${inativos.length})</summary>
            <div class="colab-list" style="margin-top:8px;opacity:.85">${inativos.map(m => `
            <div class="colab-card" data-busca="${esc(((m.nome||'')+' '+(m.email||'')).toLowerCase())}">
              <div class="colab-head">
                <div class="avatar" data-foto="${esc(m.foto_path||'')}">${esc(ini(m.nome))}</div>
                <div class="colab-info">
                  <div class="colab-nome">${esc(m.nome||m.email)}</div>
                  <div class="colab-email">${esc(m.email)} · desativado${m.desativado_em ? ' em ' + new Date(m.desativado_em).toLocaleDateString('pt-BR') : ''}</div>
                </div>
                ${m.exclusao_pedida_por ? `<span class="role-pill" style="background:#fde2e2;color:#9b1c1c">⏳ exclusão</span>` : ''}
                <button class="btn-icon-sm" data-eid="${m.id}" title="Editar">✏️</button>
              </div>
            </div>`).join('')}</div></details>`;
        }
      }

      html += '<div class="empty-state" id="busca-vazio" style="display:none">Ninguém com esse nome.</div>';
      if (!collabs.length) {
        html += '<div class="empty-state">Nenhum colaborador encontrado.</div>';
      }

      el.innerHTML = html;

      el.querySelectorAll('[data-eid]').forEach(btn =>
        btn.addEventListener('click', e => {
          e.stopPropagation();                   // o cartão inteiro abre o detalhe
          const c = todos.find(x=>x.id===btn.dataset.eid);
          if (c) showEditModal(c, sb, onRebuild, currentUser);
        })
      );

      window._equipeCache = { collabs, notas: ns, repasses: rs, mes, ano };

    } catch(e) {
      el.innerHTML = `<div class="error-state">Erro ao carregar: ${esc(e.message)}</div>`;
    }
  }

  /* ── Detalhe de um colaborador ──────────────────────────
     Notas e repasses do mês, com o mesmo cartão da aba Notas (app.js:
     cardNotaHTML) — miniatura, ver anexo, editar, excluir — e os saldos. */
  async function renderColaborador(el, sb, currentUser, id, mes, ano) {
    el.innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando…</p></div>';
    try {
      const [colab, ns, rs, nsAno] = await Promise.all([
        sb.colaboradores.get(id).catch(() => null),
        sb.notas.list({ user_id: id, ano, mes, deleted: '0' }),
        sb.repasses.list({ user_id: id, ano, mes, deleted: '0' }),
        sb.notas.list({ user_id: id, ano, deleted: '0', fields: 'valor,mes,tipo,subtipo' }).catch(() => []),
      ]);
      if (!colab) { fechar(); return; }
      const notas = ns || [], reps = rs || [];
      const soma = arr => arr.reduce((a, x) => a + Number(x.valor || 0), 0);
      const recebido = r => !r.kind || r.kind === 'received';
      const g = t => soma(notas.filter(n => n.tipo === t));
      const r = t => soma(reps.filter(x => x.tipo === t && recebido(x)));
      const gasto = g('RDM') + g('RDA');
      const rec = r('RDM') + r('RDA');
      const saldo = rec - gasto;
      const semFoto = notas.filter(n => !n.foto_path).length;
      const semValor = notas.filter(n => Number(n.valor || 0) <= 0).length;
      const pendReps = reps.filter(x => !recebido(x) && !x.atendido_em).length;   // pedido já pago não é pendência (21/09/2026)

      /* RDM por categoria (barra proporcional) */
      const cats = [['abastecimento', '⛽ Abastecimento'], ['hospedagem', '🏨 Hospedagem'], ['outros', '🧰 Outros']];
      const porCat = cats.map(([k, rot]) => [rot, soma(notas.filter(n => n.tipo === 'RDM' && (String(n.subtipo || '').toLowerCase() === k || (k === 'outros' && !['abastecimento', 'hospedagem'].includes(String(n.subtipo || '').toLowerCase())))))]);
      const maxCat = Math.max(1, ...porCat.map(x => x[1]));

      /* evolução do ano (só deste colaborador) */
      const evo = [];
      for (let m = 1; m <= 12; m++) evo.push(soma((nsAno || []).filter(n => n.mes === m)));
      const maxEvo = Math.max(1, ...evo);
      const totalAno = soma(nsAno || []);

      const podeEditar = currentUser.role === 'admin' || currentUser.role === 'gestor';
      const bal = (t, ico, gasto, rec) => `
        <div class="cdet-bal ${rec - gasto < 0 ? 'neg' : 'pos'}">
          <span class="cdet-bal-ico">${ico}</span>
          <span class="cdet-bal-tipo">${t}</span>
          <span class="cdet-bal-val">${brl(rec - gasto)}</span>
          <span class="cdet-bal-det">Gasto <b>${brl(gasto)}</b> · Recebido <b>${brl(rec)}</b></span>
        </div>`;

      if (typeof _voltarRodape === 'function') _voltarRodape('Gestor.fechar()', '‹ Equipe');
      let html = `<div class="page-hd">
        <div class="mes-nav">
          <button class="btn-mes-nav" onclick="mudarMesEquipe(-1)">‹</button>
          <span class="mes-label">${MESES[mes-1]} ${ano}</span>
          <button class="btn-mes-nav" onclick="mudarMesEquipe(1)">›</button>
        </div>
      </div>

      <div class="cdet">
        <div class="cdet-hero">
          <div class="avatar cdet-avatar ${colab.foto_path ? 'clicavel' : ''}" data-foto="${esc(colab.foto_path||'')}" data-nome="${esc(colab.nome||colab.email)}" data-sub="${esc(colab.email)} · ${esc(colab.role)}" title="Ver foto" onclick="if(this.dataset.foto){event.stopPropagation();Gestor.verFoto(this)}">${esc(ini(colab.nome))}</div>
          <div class="cdet-nome">${esc(colab.nome||colab.email)}</div>
          <div class="cdet-email">${esc(colab.email)}</div>
          <div class="cdet-pills"><span class="role-pill role-${colab.role}">${colab.role}</span>${colab.regime === 'cv' ? '<span class="role-pill" style="background:#0e7c86;color:#fff">💳 CV · cartão corporativo</span>' : '<span class="role-pill" style="background:rgba(255,255,255,.14);color:#eef9f0">💰 RDM/RDA</span>'}${colab.nucleo ? `<span class="role-pill" style="background:rgba(255,255,255,.14);color:#eef9f0">📍 ${esc(colab.nucleo)}</span>` : ''}${colab.ativo === false ? '<span class="role-pill" style="background:#fde2e2;color:#9b1c1c">🚫 desativado</span>' : ''}${('confirmado_em' in colab) && !colab.confirmado_em ? '<span class="role-pill" style="background:#fef3c7;color:#92400e">🙋 aguardando liberação</span>' : ''}</div>
        </div>

        ${podeEditar && ('confirmado_em' in colab) && !colab.confirmado_em ? `
        <div class="cdet-pendente">
          <b>🙋 Cadastro novo aguardando liberação</b>
          <p>${esc(colab.nome || colab.email)} criou a conta ${({ convite: 'pelo link de convite', google: 'entrando com o Google', livre: 'pelo cadastro do app' })[colab.criado_via] || 'pelo app'}${colab.created_at ? ' em ' + new Date(colab.created_at).toLocaleDateString('pt-BR') : ''} e só usa o app depois que você confirmar.</p>
          <div class="cdet-pendente-btns">
            <button class="btn btn-sm btn-primary" onclick="confirmarEntrada('${colab.id}', true, this)">✅ Confirmar entrada</button>
            <button class="btn btn-sm btn-danger-outline" onclick="confirmarEntrada('${colab.id}', false, this)">🚫 Recusar</button>
          </div>
        </div>` : ''}

        <div class="cdet-acoes">
          ${colab.regime === 'cv' ? `
          <button class="cdet-acao" onclick="baixarRelatorioCv('xlsx','${colab.id}','${esc(colab.nome||'')}')"><span class="cdet-acao-ico">📗</span><span class="cdet-acao-lbl">Planilha CV</span><span class="cdet-acao-sub">Excel ${ano}</span></button>
          <button class="cdet-acao" onclick="baixarRelatorioCv('pdf','${colab.id}','${esc(colab.nome||'')}')"><span class="cdet-acao-ico">📕</span><span class="cdet-acao-lbl">Planilha CV</span><span class="cdet-acao-sub">PDF ${ano}</span></button>` : `
          <button class="cdet-acao" onclick="baixarRelatorioRdmRda('${colab.id}','${esc(colab.nome||'')}')"><span class="cdet-acao-ico">📗</span><span class="cdet-acao-lbl">Planilha RDM/RDA</span><span class="cdet-acao-sub">modelo · Excel ${ano}</span></button>
          <button class="cdet-acao" onclick="baixarRelatorioRdmRda('${colab.id}','${esc(colab.nome||'')}','pdf')"><span class="cdet-acao-ico">📕</span><span class="cdet-acao-lbl">Planilha RDM/RDA</span><span class="cdet-acao-sub">PDF ${ano}</span></button>
          <button class="cdet-acao" onclick="Gestor.excelAnualColab('${colab.id}')"><span class="cdet-acao-ico">📄</span><span class="cdet-acao-lbl">Excel resumo</span><span class="cdet-acao-sub">do app · ${ano}</span></button>`}
          <button class="cdet-acao" onclick="switchView('arquivos');setTimeout(()=>Arquivos.abrirColab('${colab.id}'),50)"><span class="cdet-acao-ico">📁</span><span class="cdet-acao-lbl">Arquivos</span><span class="cdet-acao-sub">fotos e ZIP</span></button>
          ${podeEditar ? `<button class="cdet-acao" id="cdet-editar"><span class="cdet-acao-ico">✏️</span><span class="cdet-acao-lbl">Editar</span><span class="cdet-acao-sub">papel, situação</span></button>` : ''}
        </div>

        <div class="cdet-kpis">
          <div class="cdet-kpi"><span class="cdet-kpi-ico">💸</span><span class="cdet-kpi-lbl">Gasto no mês</span><span class="cdet-kpi-val">${brl(gasto)}</span><span class="cdet-kpi-sub">${notas.length} nota${notas.length === 1 ? '' : 's'}</span></div>
          <div class="cdet-kpi"><span class="cdet-kpi-ico">💰</span><span class="cdet-kpi-lbl">Recebido</span><span class="cdet-kpi-val">${brl(rec)}</span><span class="cdet-kpi-sub">${pendReps ? pendReps + ' pedido' + (pendReps > 1 ? 's' : '') + ' pendente' + (pendReps > 1 ? 's' : '') : 'repasses do mês'}</span></div>
          <div class="cdet-kpi ${saldo < 0 ? 'neg' : ''}"><span class="cdet-kpi-ico">📊</span><span class="cdet-kpi-lbl">Saldo</span><span class="cdet-kpi-val">${brl(saldo)}</span><span class="cdet-kpi-sub">recebido − gasto</span></div>
          <div class="cdet-kpi ${semFoto || semValor ? 'warn' : ''}"><span class="cdet-kpi-ico">${semFoto || semValor ? '⚠️' : '✅'}</span><span class="cdet-kpi-lbl">Pendências</span><span class="cdet-kpi-val">${semFoto + semValor}</span><span class="cdet-kpi-sub">${semFoto} sem foto · ${semValor} sem valor</span></div>
        </div>

        <div class="cdet-bals">${bal('RDM · Despesas', '🧾', g('RDM'), r('RDM'))}${bal('RDA · Alimentação', '🍽️', g('RDA'), r('RDA'))}</div>

        <div class="dash-card">
          <div class="dash-card-title">RDM por categoria · ${MESES[mes-1]}</div>
          ${porCat.map(([rot, v]) => `
            <div class="cdet-cat">
              <span class="cdet-cat-rot">${rot}</span>
              <span class="cdet-cat-bar"><span style="width:${Math.round(v / maxCat * 100)}%"></span></span>
              <span class="cdet-cat-val">${brl(v)}</span>
            </div>`).join('')}
        </div>

        <div class="dash-card">
          <div class="dash-card-title">Gasto no ano · ${ano} <span style="float:right">${brl(totalAno)}</span></div>
          <div class="evo">
            ${evo.map((v, i) => `<div class="evo-col ${i + 1 === mes ? 'cur' : ''}" title="${MESES[i]}: ${brl(v)}">
              <div class="evo-bar" style="height:${Math.max(2, Math.round(v / maxEvo * 100))}%"></div>
            </div>`).join('')}
          </div>
          <div class="evo-labels">${MESES.map((m, i) => `<span class="${i + 1 === mes ? 'cur' : ''}">${m.slice(0,1)}</span>`).join('')}</div>
        </div>
      </div>`;

      html += `<div class="section-hd">🧾 Notas · ${notas.length}</div>`;
      if (!notas.length) {
        html += '<div class="empty-state" style="padding:24px 14px">Nenhuma nota neste mês.</div>';
      } else if (typeof cardNotaHTML === 'function') {
        if (typeof garantirNotasNaLista === 'function') garantirNotasNaLista(notas);
        html += `<div class="notas-list">${notas.map(n => cardNotaHTML(n, 'eqthumb-', { semDono: true })).join('')}</div>`;
      }

      html += `<div class="section-hd">💸 Repasses · ${reps.length}</div>`;
      if (!reps.length) {
        html += '<div class="empty-state" style="padding:24px 14px">Nenhum repasse neste mês.</div>';
      } else {
        html += `<div class="colab-list">${reps.map(x => `
          <div class="rep-item cdet-rep">
            <span class="cdet-rep-ico">${recebido(x) ? '✅' : x.atendido_em ? '💸' : '⏳'}</span>
            <span class="tipo-badge tipo-${x.tipo}">${x.tipo}</span>
            <div style="flex:1;min-width:0">
              <div class="rep-desc">${esc(x.descricao || (recebido(x) ? 'Repasse recebido' : 'Solicitação de repasse'))}</div>
              <div class="cdet-rep-sub">${fmtData(x.data)} · ${recebido(x) ? 'recebido' : x.atendido_em ? 'pedido pago ✅' : 'pedido pendente'}</div>
            </div>
            <span class="rep-val cdet-rep-val">${brl(x.valor)}</span>
          </div>`).join('')}</div>`;
      }

      el.innerHTML = html;
      const be = el.querySelector('#cdet-editar');
      if (be) be.onclick = () => showEditModal(colab, sb, () => _ctx?.onRebuild?.(), currentUser);
      if (typeof _carregarMiniaturas === 'function') _carregarMiniaturas(notas, 'eqthumb-').catch(() => {});
    } catch (e) {
      el.innerHTML = `<div class="error-state">Erro ao carregar: ${esc(e.message)}</div>
        <div style="padding:14px"><button class="btn btn-outline" onclick="Gestor.fechar()">‹ Voltar</button></div>`;
    }
  }

  async function renderForExcel(sb, currentUser, mes, ano) {
    const collabs = await sb.colaboradores.list();
    const [notas, repasses] = await Promise.all([
      sb.notas.list({ ano, mes, fields: 'user_id,tipo,subtipo,valor,data,cnpj,razao_social,mes,ano,deleted' }),
      sb.repasses.list({ ano, mes }),
    ]);
    return { collabs: collabs||[], notas: (notas||[]).filter(n=>!n.deleted), repasses: (repasses||[]).filter(r=>!r.deleted), mes, ano };
  }

  async function exportEquipeExcel(sb, currentUser, mes, ano, ids = []) {
    setLoading(true, 'Gerando a planilha da equipe…');
    try {
      let { collabs, notas, repasses, mes: m, ano: a } = await renderForExcel(sb, currentUser, mes, ano);
      if (ids.length) {   // só os marcados no seletor (21/09/2026)
        const sel = new Set(ids);
        collabs = collabs.filter(c => sel.has(c.id)); notas = notas.filter(n => sel.has(n.user_id)); repasses = repasses.filter(r => sel.has(r.user_id));
      }
      await Excel.exportarEquipe(notas, repasses, collabs, m, a, currentUser.nome);
      toast('Planilha gerada 📗');
    } catch (e) { toast('Erro ao exportar: ' + e.message, 'err'); }
    finally { setLoading(false); }
  }

  /* ── Seletor de colaboradores (21/09/2026) ─────────────────
     Antes de gerar Excel, PDF ou Planilha CV da equipe, o gestor marca quem
     entra. Quem não movimentou no período começa desmarcado (a saída ficaria
     vazia). botoes = [{ label, title, primario, modo }]; onGerar(ids, modo). */
  function abrirSelecaoColabs({ titulo, dica, comLanc, etiqueta, segundos, botoes, onGerar, apenas = null }) {
    if (!_cvEquipe) { toast('Abra a Equipe com internet primeiro', 'err'); return; }
    const collabs = apenas || _cvEquipe.collabs;
    const ov = document.createElement('div');
    ov.className = 'modal-overlay open';
    ov.innerHTML = `
      <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-hd">
          <h3>${esc(titulo)}</h3>
          <button class="btn-close-modal">✕</button>
        </div>
        <div class="modal-bd">
          <p style="font-size:15px;color:var(--text2);line-height:1.5;margin-bottom:8px">${dica}</p>
          <div style="display:flex;gap:10px;font-size:14px;margin-bottom:8px">
            <a href="#" id="sel-todos">marcar todos</a> · <a href="#" id="sel-nenhum">desmarcar todos</a>
          </div>
          <div style="max-height:46vh;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px 10px">
            ${collabs.map(c => `
              <label style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:15.5px;cursor:pointer">
                <input type="checkbox" class="sel-chk" value="${c.id}" ${comLanc.has(c.id) ? 'checked' : ''} style="width:18px;height:18px">
                <span style="flex:1">${esc(c.nome || c.email)} <span style="font-size:13px;color:var(--text2)">${c.regime === 'cv' ? '💳 CV' : '💰 RDM/RDA'}</span></span>
                ${comLanc.has(c.id) ? '' : `<span style="font-size:13px;color:var(--text2)">${esc(etiqueta)}</span>`}
              </label>`).join('')}
          </div>
          <p id="sel-qtd" style="font-size:14px;color:var(--text2);margin-top:8px"></p>
        </div>
        <div class="modal-ft" style="flex-wrap:wrap">
          ${botoes.map(b => `<button class="btn ${b.primario ? 'btn-primary' : 'btn-outline'}" data-modo="${b.modo}" title="${esc(b.title || '')}">${b.label}</button>`).join('')}
        </div>
      </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    ov.querySelector('.btn-close-modal').onclick = close;
    const chks = () => [...ov.querySelectorAll('.sel-chk')];
    const marcados = () => chks().filter(c => c.checked).map(c => c.value);
    const btns = [...ov.querySelectorAll('.modal-ft button')];
    const atualizar = () => {
      const n = marcados().length;
      const tempo = segundos ? ` · uns ${Math.max(segundos, n * segundos)} s para gerar` : '';
      ov.querySelector('#sel-qtd').textContent = n ? `${n} colaborador${n > 1 ? 'es' : ''} selecionado${n > 1 ? 's' : ''}${tempo}` : 'Ninguém selecionado';
      btns.forEach(b => b.disabled = !n);
    };
    chks().forEach(c => c.onchange = atualizar);
    ov.querySelector('#sel-todos').onclick  = e => { e.preventDefault(); chks().forEach(c => c.checked = true);  atualizar(); };
    ov.querySelector('#sel-nenhum').onclick = e => { e.preventDefault(); chks().forEach(c => c.checked = false); atualizar(); };
    atualizar();
    btns.forEach(b => b.onclick = () => { const ids = marcados(); close(); onGerar(ids, b.dataset.modo); });
  }

  /* Planilhas da equipe no modelo da empresa (21/09/2026): cada pessoa sai
     no modelo do SEU regime — CV → Planilha CV; RDM/RDA → Planilha de RDM e
     RDA. Excel único (aba RESUMO + abas de cada um) ou ZIP. Base: quem lançou no ANO. */
  function abrirCvEquipe() {
    if (!_cvEquipe) { toast('Abra a Equipe com internet primeiro', 'err'); return; }
    const { ano, comLancAno, collabs } = _cvEquipe;
    const nCV = collabs.filter(c => c.regime === 'cv').length;
    abrirSelecaoColabs({
      titulo: `Planilhas da equipe · ${ano}`,
      dica: `Cada pessoa sai no modelo do seu regime: <b>💳 CV</b> → Planilha de C.V. (${nCV}); <b>💰 RDM/RDA</b> → Planilha de RDM e RDA (${collabs.length - nCV}). Quem não lançou nada em ${ano} começa desmarcado.`,
      comLanc: comLancAno, etiqueta: 'sem lançamento no ano', segundos: 15,
      botoes: [
        { label: '🗜️ ZIP separado', title: 'Um arquivo .xlsx completo por pessoa (+ Resumo_Geral)', modo: 'zip' },
        { label: '📗 Excel único',  title: 'Um só .xlsx: aba RESUMO + abas de cada pessoa', modo: 'unico', primario: true },
      ],
      onGerar: (ids, modo) => window.baixarCvEquipe(ids, modo),
    });
  }

  /* Excel resumido e PDF do MÊS: base = quem lançou no mês escolhido. */
  function abrirExcelEquipe() {
    if (!_cvEquipe) { toast('Abra a Equipe com internet primeiro', 'err'); return; }
    const { mes, ano, comLancMes } = _cvEquipe;
    abrirSelecaoColabs({
      titulo: `Excel da equipe · ${MESES[mes - 1]} ${ano}`,
      dica: `Resumo do mês (gasto, repasse e saldo RDM/RDA por pessoa). Quem não lançou nada em ${MESES[mes - 1]} começa desmarcado.`,
      comLanc: comLancMes, etiqueta: 'sem lançamento no mês',
      botoes: [{ label: '📗 Gerar Excel', modo: 'xlsx', primario: true }],
      onGerar: ids => window.exportExcelEquipe(ids),
    });
  }
  function abrirPdfEquipe() {
    if (!_cvEquipe) { toast('Abra a Equipe com internet primeiro', 'err'); return; }
    const { mes, ano, comLancMes } = _cvEquipe;
    abrirSelecaoColabs({
      titulo: `Relatório da equipe (PDF) · ${MESES[mes - 1]} ${ano}`,
      dica: `Resumo do mês, quadro por colaborador e as notas e repasses de cada um. Quem não lançou nada em ${MESES[mes - 1]} começa desmarcado.`,
      comLanc: comLancMes, etiqueta: 'sem lançamento no mês',
      botoes: [{ label: '📕 Gerar PDF', modo: 'pdf', primario: true }],
      onGerar: ids => window.baixarRelatorioEquipe(ids),
    });
  }

  /* ── Convidar por link (21/09/2026, reunião) ─────────────────
     Gestor/admin gera um link com o papel já definido (Contabilidade, p.ex.)
     e manda pelo WhatsApp. Quem abre cria a conta com aquele papel. Uso
     único, vale 7 dias. Só o admin convida gestor. */
  const PAPEL_NOME = { colaborador: 'Colaborador', gestor: 'Gestor', admin: 'Administrador', contabilidade: 'Contabilidade' };
  async function abrirConvite() {
    const sb = _ctx?.sb, eu = _ctx?.currentUser || window.user || {};
    if (!sb) { toast('Abra a Equipe com internet primeiro', 'err'); return; }
    if (!(eu.role === 'admin' || eu.role === 'gestor')) { toast('Só gestor ou admin convida', 'err'); return; }
    const ov = document.createElement('div');
    ov.className = 'modal-overlay open';
    ov.innerHTML = `
      <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-hd">
          <h3>✉️ Convidar por link</h3>
          <button class="btn-close-modal">✕</button>
        </div>
        <div class="modal-bd">
          <p style="font-size:15px;color:var(--text2);line-height:1.5;margin-bottom:10px">
            Gere um link e mande pelo WhatsApp. Quem abrir cria a conta <b>já com o papel escolhido</b>. O link serve para <b>uma</b> pessoa e vale <b>7 dias</b>.
          </p>
          <label class="lbl">Papel</label>
          <select class="inp" id="cv-role">
            <option value="contabilidade" selected>Contabilidade — só vê e baixa relatórios</option>
            <option value="colaborador">Colaborador — lança as próprias notas</option>
            <option value="gestor">Gestor — vê e administra a equipe</option>
          </select>
          <label class="lbl">Nome de quem vai entrar (opcional)</label>
          <input class="inp" id="cv-nome" type="text" placeholder="Ex.: Maria da Contabilidade" autocapitalize="words">
          <button class="btn btn-primary btn-full" id="cv-gerar" style="margin-top:10px">🔗 Gerar link</button>
          <div id="cv-resultado" style="display:none;margin-top:12px;padding:10px;border:1px solid var(--border);border-radius:10px">
            <div style="font-size:14px;color:var(--text2);margin-bottom:6px">Link gerado (vale 7 dias):</div>
            <input class="inp" id="cv-url" readonly style="font-size:14px" onclick="this.select()">
            <div style="display:flex;gap:8px;margin-top:8px">
              <button class="btn btn-outline" id="cv-copiar" style="flex:1">📋 Copiar</button>
              <a class="btn btn-primary" id="cv-whats" style="flex:1;text-align:center;text-decoration:none" target="_blank" rel="noopener">💬 WhatsApp</a>
            </div>
          </div>
          <details style="margin-top:12px;font-size:15px">
            <summary style="cursor:pointer;color:var(--text2)">Convites recentes</summary>
            <div id="cv-lista" style="margin-top:8px;color:var(--text2)">Carregando…</div>
          </details>
        </div>
        <div class="modal-ft"><button class="btn btn-outline" id="cv-fechar">Fechar</button></div>
      </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    ov.querySelector('.btn-close-modal').onclick = close;
    ov.querySelector('#cv-fechar').onclick = close;

    const listar = async () => {
      const box = ov.querySelector('#cv-lista');
      try {
        const itens = await sb.convites.lista();
        if (!itens.length) { box.textContent = 'Nenhum convite ainda.'; return; }
        box.innerHTML = itens.map(c => {
          const st = c.usado_em ? `✅ usado por ${esc(c.usado_por || '—')} em ${fmtData(c.usado_em)}` : c.valido ? `⏳ aguardando · vence ${fmtData(c.expira_em)}` : '⌛ vencido';
          return `<div style="padding:6px 0;border-bottom:1px solid var(--border)"><b>${esc(PAPEL_NOME[c.role] || c.role)}</b>${c.nome ? ' · ' + esc(c.nome) : ''}<br><span style="font-size:13.5px">${st} · por ${esc(c.criado_por || '')}</span></div>`;
        }).join('');
      } catch (e) { box.textContent = 'Não carregou: ' + e.message; }
    };
    listar();

    ov.querySelector('#cv-gerar').onclick = async () => {
      const role = ov.querySelector('#cv-role').value, nome = ov.querySelector('#cv-nome').value.trim();
      const btn = ov.querySelector('#cv-gerar'); btn.disabled = true;
      try {
        const r = await sb.convites.criar(role, nome);
        ov.querySelector('#cv-url').value = r.url;
        const msg = `Olá${nome ? ', ' + nome : ''}! Este é o seu convite para entrar no PETERMANN - DESPESAS como ${PAPEL_NOME[role] || role}. Abra o link no celular e crie sua conta (vale 7 dias): ${r.url}`;
        ov.querySelector('#cv-whats').href = 'https://wa.me/?text=' + encodeURIComponent(msg);
        ov.querySelector('#cv-resultado').style.display = '';
        ov.querySelector('#cv-copiar').onclick = async () => {
          try { await navigator.clipboard.writeText(r.url); toast('Link copiado 📋'); }
          catch (_) { ov.querySelector('#cv-url').select(); toast('Selecione e copie o link', 'err'); }
        };
        listar();
      } catch (e) { toast('Não gerou: ' + e.message, 'err'); }
      finally { btn.disabled = false; }
    };
  }

  /* Excel anual RDM/RDA de outro colaborador (21/09/2026): usa as notas/repasses
     da equipe que já estão neste aparelho (notasEquipe / repassesEquipe). */
  async function excelAnualColab(id) {
    const colab = _cvEquipe?.collabs.find(c => c.id === id) || (typeof equipePorId !== "undefined" ? equipePorId[id] : null);
    if (!colab) { toast('Colaborador não encontrado', 'err'); return; }
    const ano = _cvEquipe?.ano || new Date().getFullYear();
    const ns = (typeof notasEquipe !== "undefined" ? notasEquipe : []).filter(n => n.user_id === id && !n.deleted);   // let global do app.js: visível aqui, mas não em window.*
    const rs = (typeof repassesEquipe !== "undefined" ? repassesEquipe : []).filter(r => r.user_id === id && !r.deleted);
    if (!ns.length && !rs.length) { toast(`Sem lançamentos de ${colab.nome || colab.email} neste aparelho`, 'err'); return; }
    setLoading(true, 'Gerando o Excel anual…');
    try { await Excel.exportarAnual(ano, ns, rs, colab); toast('Planilha gerada 📗'); }
    catch (e) { toast('Planilha: ' + e.message, 'err'); }
    finally { setLoading(false); }
  }

  /* ── Modal edição de colaborador (gestor e admin) ─────── */
  function showEditModal(colab, sb, onSaved, currentUser) {
    const eu = currentUser || window.user || {};
    const ehAdmin = eu.role === 'admin';
    const souEu = colab.id === eu.id;
    /* Gestor é o cargo maior da empresa; "admin" é o papel técnico de quem
       cuida do sistema (22/09/2026). Os dois editam nome, papel e regime de
       QUALQUER um — inclusive o gestor rebaixar um admin. Só não se mexe no
       próprio papel. O servidor repete a mesma regra. */
    const podeEditar = !souEu && (ehAdmin || eu.role === 'gestor');
    const podeRegime = podeEditar;
    const papeis = ROLES;
    const inativo = colab.ativo === false;
    const pedido = colab.exclusao_pedida_por;
    const pediEu = pedido && pedido === eu.id;
    const ov = document.createElement('div');
    ov.className = 'modal-overlay open';
    ov.innerHTML = `
      <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-hd">
          <h3>Editar Colaborador</h3>
          <button class="btn-close-modal">✕</button>
        </div>
        <div class="modal-bd">
          <label class="lbl">Nome</label>
          <input class="inp" id="g-nome" value="${esc(colab.nome||'')}" autocapitalize="words" ${podeEditar || (ehAdmin && souEu) ? '' : 'disabled'}>
          <label class="lbl">Papel</label>
          <select class="inp" id="g-role" ${podeEditar || (ehAdmin && souEu) ? '' : 'disabled'}>
            ${papeis.map(r=>`<option value="${r}"${r===colab.role?' selected':''}>${PAPEL_TXT[r] || r}</option>`).join('')}
          </select>
          ${souEu ? '<p style="font-size:14px;color:var(--text2);line-height:1.4;margin-top:4px">Você não muda o próprio papel — peça a outro gestor.</p>'
            : '<p style="font-size:14px;color:var(--text2);line-height:1.4;margin-top:4px"><b>Gestor</b> é o cargo maior: vê a equipe, edita papéis e cuida do sistema. <b>Administrador</b> é o papel técnico de quem mantém o app — faz o mesmo e ainda apaga lançamento em definitivo.</p>'}
          <label class="lbl">Regime de despesas</label>
          <select class="inp" id="g-regime" ${podeRegime ? '' : 'disabled'}>
            <option value="rdm_rda"${(colab.regime||'rdm_rda')==='rdm_rda'?' selected':''}>💰 RDM/RDA — recebe dinheiro em conta; gera Excel RDM/RDA</option>
            <option value="cv"${colab.regime==='cv'?' selected':''}>💳 CV — cartão corporativo; reembolso do que sai do bolso; gera Planilha CV</option>
          </select>
          <p style="font-size:14px;color:var(--text2);line-height:1.4;margin-top:4px">Mudar o regime troca as telas e os relatórios da pessoa. As notas já lançadas continuam como estão.</p>
          ${souEu ? '' : `
          <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:12px">
            <label class="lbl">Situação</label>
            <p style="font-size:15px;color:var(--text2);line-height:1.5;margin-bottom:8px">
              ${inativo
                ? `🚫 <b>Desativado</b>${colab.desativado_em ? ' em ' + new Date(colab.desativado_em).toLocaleDateString('pt-BR') : ''}. Não entra no app e não aparece na equipe; o histórico continua.`
                : '✅ <b>Ativo.</b> Desativar tira a pessoa do app e das listas, sem apagar nada — dá para reativar depois.'}
            </p>
            <button class="btn btn-outline btn-full" id="g-ativo">${inativo ? '↩️ Reativar colaborador' : '🚫 Desativar colaborador'}</button>
          </div>
          <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:12px">
            <label class="lbl" style="color:var(--danger)">Excluir de vez (limpeza do banco)</label>
            <p style="font-size:15px;color:var(--text2);line-height:1.5;margin-bottom:8px">
              Apaga o colaborador e <b>tudo</b> dele: notas, anexos, repasses, KM e ponto. Não tem volta.
              Precisa de <b>duas pessoas</b>: um gestor/admin pede e <b>outro</b> gestor/admin confirma. Não pede e-mail nem senha.
            </p>
            ${pedido
              ? `<p style="font-size:15px;color:#9b1c1c;font-weight:700;margin-bottom:8px">⏳ Exclusão pedida por ${esc(colab.exclusao_pedida_por_nome||'')}${colab.exclusao_pedida_em ? ' em ' + new Date(colab.exclusao_pedida_em).toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : ''}.
                 ${pediEu ? 'Falta outro gestor ou admin confirmar.' : 'Você pode dar a 2ª confirmação.'}</p>
                 ${pediEu ? '' : `<button class="btn btn-danger-outline btn-full" id="g-excluir" style="margin-bottom:8px">🗑️ Confirmar exclusão (2ª pessoa)</button>`}
                 <button class="btn btn-outline btn-full" id="g-cancelar-exclusao">Cancelar o pedido</button>`
              : `<button class="btn btn-danger-outline btn-full" id="g-excluir">🗑️ Pedir exclusão (1ª pessoa)</button>`}
          </div>`}
        </div>
        <div class="modal-ft">
          <button class="btn btn-outline" id="g-cancel">Fechar</button>
          ${podeEditar || (ehAdmin && souEu) ? '<button class="btn btn-primary" id="g-save">Salvar</button>' : ''}
        </div>
      </div>`;
    document.body.appendChild(ov);

    const close = () => ov.remove();
    ov.addEventListener('click', e => { if(e.target===ov) close(); });
    ov.querySelector('.btn-close-modal').onclick = close;
    ov.querySelector('#g-cancel').onclick        = close;

    const btnSave = ov.querySelector('#g-save');
    if (btnSave) btnSave.onclick = async () => {
      const nome   = ov.querySelector('#g-nome').value.trim();
      const role   = ov.querySelector('#g-role').value;
      const regime = ov.querySelector('#g-regime')?.value;
      const dados  = { nome, role, regime };   // o servidor filtra o que este papel pode gravar
      /* Entrar ou sair de "administrador" mexe em quem mantém o sistema:
         confirma antes, dos dois lados. */
      const quem = colab.nome || colab.email;
      if (role !== colab.role) {
        if (role === 'admin' && !confirm(`Tornar ${quem} ADMINISTRADOR?\n\nÉ o papel técnico de quem mantém o app: passa a editar qualquer perfil, mudar papéis e apagar lançamento em definitivo.`)) return;
        if (colab.role === 'admin' && !confirm(`Tirar o ADMINISTRADOR de ${quem}?\n\nEle deixa de manter o sistema e passa a ${PAPEL_TXT[role] ? PAPEL_TXT[role].split(' — ')[0].toLowerCase() : role}. Dá para devolver o papel depois.`)) return;
      }
      try { await sb.colaboradores.update(colab.id, dados); }
      catch (e) { alert('Erro: ' + e.message); return; }
      close(); onSaved();
    };

    const btnAtivo = ov.querySelector('#g-ativo');
    if (btnAtivo) btnAtivo.onclick = async () => {
      const msg = inativo
        ? `Reativar ${colab.nome || colab.email}? A pessoa volta a entrar no app.`
        : `Desativar ${colab.nome || colab.email}?\n\nEla não consegue mais entrar e sai das listas. Nada é apagado.`;
      if (!confirm(msg)) return;
      try { await sb.colaboradores.ativo(colab.id, inativo); }
      catch (e) { alert('Erro: ' + e.message); return; }
      toast(inativo ? 'Colaborador reativado' : 'Colaborador desativado');
      close(); onSaved();
    };

    const btnExcluir = ov.querySelector('#g-excluir');
    if (btnExcluir) btnExcluir.onclick = async () => {
      const etapa = pedido ? '2ª CONFIRMAÇÃO — isto APAGA TUDO agora' : '1ª de 2 confirmações';
      if (!confirm(`EXCLUIR COLABORADOR (${etapa})\n\n${colab.nome || ''}\n${colab.email}\n\nSerão apagados: todas as notas e anexos, repasses, KM e ponto. Não tem volta.\n\nConfirmar?`)) return;
      setLoading(true);
      try {
        const r = await sb.colaboradores.excluir(colab.id);
        if (r.status === 'excluido') {
          try { await DB.purgeNotasDeUsuario?.(colab.id); } catch (_) {}
          alert(`Colaborador excluído.\nNotas: ${r.notas} · Repasses: ${r.repasses} · KM: ${r.km} · Ponto: ${r.pontos}`);
        } else {
          alert(r.mensagem || 'Pedido registrado. Agora OUTRO gestor ou admin precisa abrir este colaborador e confirmar.');
        }
      } catch (e) { alert('Erro: ' + e.message); return; }
      finally { setLoading(false); }
      close(); onSaved();
    };

    const btnCanc = ov.querySelector('#g-cancelar-exclusao');
    if (btnCanc) btnCanc.onclick = async () => {
      if (!confirm('Cancelar o pedido de exclusão?')) return;
      try { await sb.colaboradores.cancelarExclusao(colab.id); }
      catch (e) { alert('Erro: ' + e.message); return; }
      close(); onSaved();
    };
  }

  /* Foto de perfil nos cartões (19/09/2026): os avatares saem com
     data-foto; aqui trocamos a inicial pela imagem (URL assinada, em lote).
     Observa o DOM, então vale para o painel e para o detalhe do colaborador. */
  const _avatarCache = {};
  async function _carregarAvatares() {
    const els = [...document.querySelectorAll('.avatar[data-foto]')].filter(e => e.dataset.foto && !e.querySelector('img'));
    if (!els.length || !sb) return;
    const paths = [...new Set(els.map(e => e.dataset.foto).filter(p => !_avatarCache[p]))];
    if (paths.length) {
      try { Object.assign(_avatarCache, await sb.fotos.urls(paths)); } catch (_) {}
    }
    els.forEach(e => { const u = _avatarCache[e.dataset.foto]; if (u) { e.innerHTML = `<img src="${u}" alt="">`; e.classList.add('com-foto'); } });
  }
  new MutationObserver(() => { if (document.querySelector('.avatar[data-foto]:not(.com-foto)')) _carregarAvatares(); })
    .observe(document.body, { childList: true, subtree: true });

  /* Toque na foto → visualizador em tela cheia, com nome e cargo, para
     identificar o colaborador (19/09/2026). */
  async function verFoto(el) {
    const path = el?.dataset?.foto;
    if (!path) return;
    let url = _avatarCache[path];
    if (!url) { try { url = (await sb.fotos.urls([path]))[path]; _avatarCache[path] = url; } catch (_) {} }
    if (!url) { toast('Foto não encontrada', 'err'); return; }
    $('foto-viewer-img').src = url;
    $('foto-viewer-info').innerHTML = `<b style="font-size:19.5px;color:#fff">${esc(el.dataset.nome||'')}</b><br>${esc(el.dataset.sub||'')}`;
    $('foto-viewer-overlay').style.display = 'flex';
  }

  return { renderDashboard, showEditModal, exportEquipeExcel, renderForExcel, abrir, fechar, reset, carregarAvatares: _carregarAvatares, verFoto, filtrar, abrirCvEquipe, abrirExcelEquipe, abrirPdfEquipe, abrirConvite, excelAnualColab };
})();
