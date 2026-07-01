'use strict';
/* ─────────────────────────────────────────────────────────────
   Gestor.js — dashboard de equipe (gestor / admin)
───────────────────────────────────────────────────────────── */
window.Gestor = (() => {
  const MESES  = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const NUCLEOS = ['Cristalina','Formosa','Paracatu','Uberlândia','Outro'];
  const ROLES   = ['colaborador','gestor','admin'];

  const brl = v => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v||0);
  const ini = nome => (nome||'?').split(' ').slice(0,2).map(n=>n[0]||'').join('').toUpperCase();
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  /* ── Dashboard principal ──────────────────────────────── */
  async function renderDashboard(el, sb, currentUser, onRebuild, options = {}) {
    const mes = options.mes || new Date().getMonth() + 1;
    const ano = options.ano || new Date().getFullYear();

    el.innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando gestão…</p></div>';
    const podeConsolidar = currentUser.role === 'admin' || currentUser.role === 'gestor';
    try {
      const { data: collabs, error: ce } = await sb.from('colaboradores').select('*').order('nome');
      if (ce) throw ce;

      // busca o ANO inteiro (p/ a evolução); o mês é filtrado no cliente
      const [{ data: notasAno }, { data: repAno }] = await Promise.all([
        sb.from('notas').select('user_id,tipo,subtipo,valor,mes,ano,foto_path,deleted').eq('ano', ano),
        sb.from('repasses').select('user_id,tipo,valor,mes,ano,deleted').eq('ano', ano),
      ]);
      const nsAno = (notasAno || []).filter(n => !n.deleted);
      const rsAno = (repAno   || []).filter(r => !r.deleted);
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

      // Gasto por núcleo (mês)
      const porNuc = {};
      ns.forEach(n => {
        const c = collabs.find(x => x.id === n.user_id);
        const nc = c?.nucleo || 'Outro';
        porNuc[nc] = (porNuc[nc] || 0) + Number(n.valor || 0);
      });
      const nucRank = Object.entries(porNuc).filter(e => e[1] > 0).sort((a, b) => b[1] - a[1]);
      const maxNuc = Math.max(1, ...nucRank.map(e => e[1]));

      // ── Cabeçalho ──
      let html = `<div class="page-hd">
        <div class="mes-nav">
          <button class="btn-mes-nav" onclick="mudarMesEquipe(-1)">‹</button>
          <span class="mes-label">${MESES[mes-1]} ${ano}</span>
          <button class="btn-mes-nav" onclick="mudarMesEquipe(1)">›</button>
        </div>
        <div class="export-btns">
          <button class="btn btn-sm btn-outline" onclick="exportExcelEquipe()">Excel</button>
          <button class="btn btn-sm btn-primary" onclick="exportSheetsEquipe()" title="Planilha da equipe">📊</button>
          ${podeConsolidar ? `<button class="btn btn-sm btn-outline" onclick="enviarFotosEquipeDrive()" title="Enviar fotos ao Drive">☁️</button>` : ''}
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

      // ── Gasto por núcleo (mês) ──
      html += `<div class="dash-card">
        <div class="dash-card-title">Gasto por núcleo · ${MESES[mes-1]}</div>
        ${nucRank.length ? nucRank.map(([nc, v]) => `
          <div class="nuc-row">
            <span class="nuc-name">${esc(nc)}</span>
            <div class="nuc-track"><div class="nuc-fill" style="width:${Math.max(4, Math.round(v / maxNuc * 100))}%"></div></div>
            <span class="nuc-val">${brl(v)}</span>
          </div>`).join('') : '<div class="kpi-sub">Sem gastos neste mês.</div>'}
      </div>`;

      html += `<div class="section-hd">Detalhe por colaborador</div>`;

      // agrupa por nucleo p/ o detalhe
      const nucs = {};
      collabs.forEach(c => { (nucs[c.nucleo] = nucs[c.nucleo]||[]).push(c); });
      NUCLEOS.forEach(nucleo => { if (!nucs[nucleo]) nucs[nucleo] = []; });
      for (const [nucleo, membros] of Object.entries(nucs).sort()) {
        if (!membros.length) continue;
        let tRDMg=0,tRDMr=0,tRDAg=0,tRDAr=0;
        let mHtml = '';

        membros.forEach(m => {
          const mns = ns.filter(n=>n.user_id===m.id);
          const mrs = rs.filter(r=>r.user_id===m.id);
          const rdmG = mns.filter(n=>n.tipo==='RDM').reduce((a,n)=>a+Number(n.valor||0),0);
          const rdmR = mrs.filter(r=>r.tipo==='RDM').reduce((a,r)=>a+Number(r.valor||0),0);
          const rdaG = mns.filter(n=>n.tipo==='RDA').reduce((a,n)=>a+Number(n.valor||0),0);
          const rdaR = mrs.filter(r=>r.tipo==='RDA').reduce((a,r)=>a+Number(r.valor||0),0);
          tRDMg+=rdmG; tRDMr+=rdmR; tRDAg+=rdaG; tRDAr+=rdaR;

          const canEdit = currentUser.role==='admin';
          mHtml += `
          <div class="colab-card">
            <div class="colab-head">
              <div class="avatar">${esc(ini(m.nome))}</div>
              <div class="colab-info">
                <div class="colab-nome">${esc(m.nome||m.email)}</div>
                <div class="colab-email">${esc(m.email)}</div>
              </div>
              <span class="role-pill role-${m.role}">${m.role}</span>
              ${canEdit?`<button class="btn-icon-sm" data-eid="${m.id}" title="Editar">✏️</button>`:''}
            </div>
            <div class="colab-bal">
              <div class="bal-box ${rdmR-rdmG<0?'neg':'pos'}">
                <span class="bal-type">RDM</span>
                <span class="bal-val">${brl(rdmR-rdmG)}</span>
                <span class="bal-detail">Gasto ${brl(rdmG)}</span>
              </div>
              <div class="bal-box ${rdaR-rdaG<0?'neg':'pos'}">
                <span class="bal-type">RDA</span>
                <span class="bal-val">${brl(rdaR-rdaG)}</span>
                <span class="bal-detail">Gasto ${brl(rdaG)}</span>
              </div>
            </div>
          </div>`;
        });

        html += `
        <div class="nucleo-block">
          <div class="nucleo-hd">
            <span class="nucleo-nome">${esc(nucleo)}</span>
            <div class="nucleo-tots">
              <span>RDM <b>${brl(tRDMr-tRDMg)}</b></span>
              <span>RDA <b>${brl(tRDAr-tRDAg)}</b></span>
            </div>
          </div>
          <div class="colab-list">${mHtml}</div>
        </div>`;
      }

      if (!Object.keys(nucs).length) {
        html += '<div class="empty-state">Nenhum colaborador encontrado.</div>';
      }

      el.innerHTML = html;

      el.querySelectorAll('[data-eid]').forEach(btn =>
        btn.addEventListener('click', () => {
          const c = collabs.find(x=>x.id===btn.dataset.eid);
          if (c) showEditModal(c, sb, onRebuild);
        })
      );

      window._equipeCache = { collabs, notas: ns, repasses: rs, mes, ano };

    } catch(e) {
      el.innerHTML = `<div class="error-state">Erro ao carregar: ${esc(e.message)}</div>`;
    }
  }

  async function renderForExcel(sb, currentUser, mes, ano) {
    const { data: collabs } = await sb.from('colaboradores').select('*').order('nome');
    const [{ data: notas }, { data: repasses }] = await Promise.all([
      sb.from('notas').select('user_id,tipo,subtipo,valor,data,cnpj,razao_social,mes,ano,deleted').eq('ano',ano).eq('mes',mes),
      sb.from('repasses').select('user_id,tipo,valor,data,descricao,mes,ano,deleted').eq('ano',ano).eq('mes',mes),
    ]);
    return { collabs: collabs||[], notas: (notas||[]).filter(n=>!n.deleted), repasses: (repasses||[]).filter(r=>!r.deleted), mes, ano };
  }

  function exportEquipeExcel(sb, currentUser, mes, ano) {
    renderForExcel(sb, currentUser, mes, ano).then(({collabs, notas, repasses, mes: m, ano: a}) => {
      Excel.exportarEquipe(notas, repasses, collabs, m, a, currentUser.nome);
    }).catch(e => alert('Erro ao exportar: ' + e.message));
  }

  /* ── Modal edição de colaborador (admin only) ─────────── */
  function showEditModal(colab, sb, onSaved) {
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
          <input class="inp" id="g-nome" value="${esc(colab.nome||'')}">
          <label class="lbl">Núcleo</label>
          <select class="inp" id="g-nucleo">
            ${NUCLEOS.map(n=>`<option value="${n}"${n===colab.nucleo?' selected':''}>${n}</option>`).join('')}
          </select>
          <label class="lbl">Papel</label>
          <select class="inp" id="g-role">
            ${ROLES.map(r=>`<option value="${r}"${r===colab.role?' selected':''}>${r}</option>`).join('')}
          </select>
        </div>
        <div class="modal-ft">
          <button class="btn btn-outline" id="g-cancel">Cancelar</button>
          <button class="btn btn-primary" id="g-save">Salvar</button>
        </div>
      </div>`;
    document.body.appendChild(ov);

    const close = () => ov.remove();
    ov.addEventListener('click', e => { if(e.target===ov) close(); });
    ov.querySelector('.btn-close-modal').onclick = close;
    ov.querySelector('#g-cancel').onclick        = close;

    ov.querySelector('#g-save').onclick = async () => {
      const nome   = ov.querySelector('#g-nome').value.trim();
      const nucleo = ov.querySelector('#g-nucleo').value;
      const role   = ov.querySelector('#g-role').value;
      const { error } = await sb.from('colaboradores').update({ nome, nucleo, role }).eq('id', colab.id);
      if (error) { alert('Erro: ' + error.message); return; }
      close(); onSaved();
    };
  }

  return { renderDashboard, showEditModal, exportEquipeExcel, renderForExcel };
})();
