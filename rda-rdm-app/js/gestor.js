'use strict';
/* ─────────────────────────────────────────────────────────────
   Gestor.js — dashboard de equipe (gestor / admin)
───────────────────────────────────────────────────────────── */
window.Gestor = (() => {
  const MESES  = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const ROLES   = ['colaborador','gestor','admin'];

  const brl = v => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v||0);
  const ini = nome => (nome||'?').split(' ').slice(0,2).map(n=>n[0]||'').join('').toUpperCase();
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fmtData = d => { const s = String(d || '').slice(0, 10); const [a, m, dd] = s.split('-'); return dd ? `${dd}/${m}/${a}` : s; };

  /* Detalhe de um colaborador: id aberto e o contexto do último render, para
     abrir/fechar sem o app.js precisar saber de nada além de re-renderizar. */
  let _detalheId = null;
  let _ctx = null;
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
      let html = `<div class="page-hd">
        <div class="mes-nav">
          <button class="btn-mes-nav" onclick="mudarMesEquipe(-1)">‹</button>
          <span class="mes-label">${MESES[mes-1]} ${ano}</span>
          <button class="btn-mes-nav" onclick="mudarMesEquipe(1)">›</button>
        </div>
        <div class="export-btns">
          <button class="btn btn-sm btn-outline" onclick="exportExcelEquipe()">📗 Excel</button>
          <button class="btn btn-sm btn-primary" onclick="baixarRelatorioEquipe()">📕 PDF</button>
          <button class="btn btn-sm btn-outline" onclick="baixarCvEquipe()" title="Planilha de C.V. no modelo da empresa, uma por colaborador (ZIP)">📗 CV da equipe ${ano}</button>

          ${podeConsolidar && window.GDrive?.isConfigured?.() ? `<button class="btn btn-sm btn-outline" onclick="enviarFotosEquipeDrive()" title="Enviar fotos ao Drive">☁️</button>` : ''}
        </div>
      </div>`;

      // ── KPIs ──
      html += `<div class="dash-kpis">
        <div class="kpi warn">
          <div class="kpi-label">💸 Gasto no mês</div>
          <div class="kpi-val">${brl(gasto)}</div>
          <div class="kpi-sub">RDA ${brl(gRDA)} · RDM ${brl(gRDM)}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">💰 Recebido</div>
          <div class="kpi-val">${brl(recebido)}</div>
          <div class="kpi-sub">repasses do mês</div>
        </div>
        <div class="kpi ${saldo < 0 ? 'neg' : ''}">
          <div class="kpi-label">📊 Saldo</div>
          <div class="kpi-val">${brl(saldo)}</div>
          <div class="kpi-sub">recebido − gasto</div>
        </div>
        <div class="kpi ${pend ? 'warn' : ''}">
          <div class="kpi-label">🧾 Notas (${ns.length})</div>
          <div class="kpi-val">${ativos}<span style="font-size:12px;font-weight:600;color:var(--text2)"> ativos</span></div>
          <div class="kpi-sub">${pend} s/ valor · ${semFoto} s/ foto</div>
        </div>
      </div>`;

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
              <span class="role-pill role-${m.role}">${m.role}</span>
              ${m.exclusao_pedida_por ? `<span class="role-pill" style="background:#fde2e2;color:#9b1c1c" title="Exclusão pedida por ${esc(m.exclusao_pedida_por_nome||'')} — falta a 2ª confirmação">⏳ exclusão</span>` : ''}
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
      const pendReps = reps.filter(x => !recebido(x)).length;

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

      let html = `<div class="page-hd">
        <button class="btn-voltar" onclick="Gestor.fechar()">‹ Equipe</button>
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
          <div class="cdet-pills"><span class="role-pill role-${colab.role}">${colab.role}</span>${colab.nucleo ? `<span class="role-pill" style="background:rgba(255,255,255,.14);color:#eef9f0">📍 ${esc(colab.nucleo)}</span>` : ''}${colab.ativo === false ? '<span class="role-pill" style="background:#fde2e2;color:#9b1c1c">🚫 desativado</span>' : ''}</div>
        </div>

        <div class="cdet-acoes">
          <button class="cdet-acao" onclick="baixarRelatorioCv('xlsx','${colab.id}','${esc(colab.nome||'')}')"><span class="cdet-acao-ico">📗</span><span class="cdet-acao-lbl">Planilha CV</span><span class="cdet-acao-sub">Excel ${ano}</span></button>
          <button class="cdet-acao" onclick="baixarRelatorioCv('pdf','${colab.id}','${esc(colab.nome||'')}')"><span class="cdet-acao-ico">📕</span><span class="cdet-acao-lbl">Planilha CV</span><span class="cdet-acao-sub">PDF ${ano}</span></button>
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
            <span class="cdet-rep-ico">${recebido(x) ? '✅' : '⏳'}</span>
            <span class="tipo-badge tipo-${x.tipo}">${x.tipo}</span>
            <div style="flex:1;min-width:0">
              <div class="rep-desc">${esc(x.descricao || (recebido(x) ? 'Repasse recebido' : 'Solicitação de repasse'))}</div>
              <div class="cdet-rep-sub">${fmtData(x.data)} · ${recebido(x) ? 'recebido' : 'pedido pendente'}</div>
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

  async function exportEquipeExcel(sb, currentUser, mes, ano) {
    setLoading(true, 'Gerando a planilha da equipe…');
    try {
      const { collabs, notas, repasses, mes: m, ano: a } = await renderForExcel(sb, currentUser, mes, ano);
      await Excel.exportarEquipe(notas, repasses, collabs, m, a, currentUser.nome);
      toast('Planilha gerada 📗');
    } catch (e) { toast('Erro ao exportar: ' + e.message, 'err'); }
    finally { setLoading(false); }
  }

  /* ── Modal edição de colaborador (admin only) ─────────── */
  function showEditModal(colab, sb, onSaved, currentUser) {
    const eu = currentUser || window.user || {};
    const ehAdmin = eu.role === 'admin';
    const souEu = colab.id === eu.id;
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
          <input class="inp" id="g-nome" value="${esc(colab.nome||'')}" ${ehAdmin ? '' : 'disabled'}>
          <label class="lbl">Papel</label>
          <select class="inp" id="g-role" ${ehAdmin ? '' : 'disabled'}>
            ${ROLES.map(r=>`<option value="${r}"${r===colab.role?' selected':''}>${r}</option>`).join('')}
          </select>
          ${souEu ? '' : `
          <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:12px">
            <label class="lbl">Situação</label>
            <p style="font-size:12.5px;color:var(--text2);line-height:1.5;margin-bottom:8px">
              ${inativo
                ? `🚫 <b>Desativado</b>${colab.desativado_em ? ' em ' + new Date(colab.desativado_em).toLocaleDateString('pt-BR') : ''}. Não entra no app e não aparece na equipe; o histórico continua.`
                : '✅ <b>Ativo.</b> Desativar tira a pessoa do app e das listas, sem apagar nada — dá para reativar depois.'}
            </p>
            <button class="btn btn-outline btn-full" id="g-ativo">${inativo ? '↩️ Reativar colaborador' : '🚫 Desativar colaborador'}</button>
          </div>
          <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:12px">
            <label class="lbl" style="color:var(--danger)">Excluir de vez (limpeza do banco)</label>
            <p style="font-size:12.5px;color:var(--text2);line-height:1.5;margin-bottom:8px">
              Apaga o colaborador e <b>tudo</b> dele: notas, anexos, repasses, KM e ponto. Não tem volta.
              Precisa de <b>duas pessoas</b>: um gestor/admin pede e <b>outro</b> gestor/admin confirma. Não pede e-mail nem senha.
            </p>
            ${pedido
              ? `<p style="font-size:12.5px;color:#9b1c1c;font-weight:700;margin-bottom:8px">⏳ Exclusão pedida por ${esc(colab.exclusao_pedida_por_nome||'')}${colab.exclusao_pedida_em ? ' em ' + new Date(colab.exclusao_pedida_em).toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : ''}.
                 ${pediEu ? 'Falta outro gestor ou admin confirmar.' : 'Você pode dar a 2ª confirmação.'}</p>
                 ${pediEu ? '' : `<button class="btn btn-danger-outline btn-full" id="g-excluir" style="margin-bottom:8px">🗑️ Confirmar exclusão (2ª pessoa)</button>`}
                 <button class="btn btn-outline btn-full" id="g-cancelar-exclusao">Cancelar o pedido</button>`
              : `<button class="btn btn-danger-outline btn-full" id="g-excluir">🗑️ Pedir exclusão (1ª pessoa)</button>`}
          </div>`}
        </div>
        <div class="modal-ft">
          <button class="btn btn-outline" id="g-cancel">Fechar</button>
          ${ehAdmin ? '<button class="btn btn-primary" id="g-save">Salvar</button>' : ''}
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
      try { await sb.colaboradores.update(colab.id, { nome, role }); }
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
    $('foto-viewer-info').innerHTML = `<b style="font-size:18px;color:#fff">${esc(el.dataset.nome||'')}</b><br>${esc(el.dataset.sub||'')}`;
    $('foto-viewer-overlay').style.display = 'flex';
  }

  return { renderDashboard, showEditModal, exportEquipeExcel, renderForExcel, abrir, fechar, reset, carregarAvatares: _carregarAvatares, verFoto, filtrar };
})();
