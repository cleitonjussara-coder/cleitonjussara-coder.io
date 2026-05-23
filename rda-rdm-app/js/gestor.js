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
  async function renderDashboard(el, sb, currentUser, onRebuild) {
    el.innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando equipe…</p></div>';
    try {
      // colaboradores visíveis (RLS já filtra por nucleo para gestor)
      const { data: collabs, error: ce } = await sb.from('colaboradores').select('*').order('nome');
      if (ce) throw ce;

      const ano = new Date().getFullYear();
      const mes = new Date().getMonth() + 1;

      const [{ data: notas }, { data: repasses }] = await Promise.all([
        sb.from('notas').select('user_id,tipo,subtipo,valor,mes,ano,deleted').eq('ano',ano).eq('mes',mes),
        sb.from('repasses').select('user_id,tipo,valor,mes,ano,deleted').eq('ano',ano).eq('mes',mes),
      ]);

      const ns = (notas   ||[]).filter(n=>!n.deleted);
      const rs = (repasses||[]).filter(r=>!r.deleted);

      // agrupa por nucleo
      const nucs = {};
      collabs.forEach(c => { (nucs[c.nucleo] = nucs[c.nucleo]||[]).push(c); });

      let html = `<div class="page-hd">
        <h2>Equipe</h2>
        <span class="pill-mes">${MESES[mes-1]}/${ano}</span>
      </div>`;

      for (const [nucleo, membros] of Object.entries(nucs).sort()) {
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

      // bind botões de edição
      el.querySelectorAll('[data-eid]').forEach(btn =>
        btn.addEventListener('click', () => {
          const c = collabs.find(x=>x.id===btn.dataset.eid);
          if (c) showEditModal(c, sb, onRebuild);
        })
      );

    } catch(e) {
      el.innerHTML = `<div class="error-state">Erro ao carregar: ${esc(e.message)}</div>`;
    }
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

  return { renderDashboard, showEditModal };
})();
