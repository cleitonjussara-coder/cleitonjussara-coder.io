'use strict';
/* ─────────────────────────────────────────────────────────────
   FROTA-PAINEL.js — histórico, painel de acompanhamento e detalhe do
   registro de KM (pedido do Cleiton, 21/10/2026)

   Três peças da tela Frota / KM; o esqueleto da tela, o formulário de
   registro e a fila offline continuam em frota.js:
   • Painel    — km por dia / semana / mês, comparação com o período anterior,
     gráfico e ranking (gestor/admin: pessoas e veículos; colaborador: só os
     números dele). GET /frota/painel.
   • Histórico — leituras em cartões, da mais nova para a mais antiga, com o km
     rodado desde a leitura anterior do mesmo veículo e filtros de período,
     colaborador e veículo. GET /frota/historico.
   • Detalhe   — tocar no cartão abre a foto, os valores, quem registrou e
     quando, e as ações que o papel permite (corrigir/excluir).

   Datas são aaaa-mm-dd; "hoje" vem de sb.hojeDoServidor() (Brasília) e as horas
   passam por FusoBR. Semana de segunda a domingo, igual ao servidor.
   Sem internet mostra a última resposta guardada — por conta e por aparelho
   (chave com o id de quem está logado).

   SEGURANÇA (revisão de 21/10/2026): id de registro/veículo/pessoa NUNCA entra em código de
   onclick — vai em data-id (com aspas escapadas por `at`) e o handler lê `this.dataset.id`.
   O servidor também só aceita UUID como id novo, mas o app não confia nisso.

   Depende de globais do app.js: $, sb, user, esc, toast, setLoading, DB,
   FusoBR, fmtData, _ehGestorOuAdmin, filMes, filAno — e de window.Frota.
───────────────────────────────────────────────────────────── */
window.FrotaPainel = (() => {
  const MESES_L = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const LIMITE_PAGINA = 50;
  const LIMITE_MAXIMO = 200;          // o servidor não devolve mais que isso de uma vez
  const ALTURA_BARRA = 113;           // gráfico de 126 px menos o número (11) e o espaço (2) em cima da barra

  const kmFmt = n => Number(n || 0).toLocaleString('pt-BR');
  /* texto seguro em ATRIBUTO HTML (esc do app só troca & < >) */
  const at = s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const hoje = () => (sb?.hojeDoServidor ? sb.hojeDoServidor() : FusoBR.hojeISO());
  const _dt = iso => { const [a, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d)); };
  const _iso = dt => dt.toISOString().slice(0, 10);
  const somarDias = (iso, n) => { const d = _dt(iso); d.setUTCDate(d.getUTCDate() + n); return _iso(d); };
  const dm = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const dsem = iso => _dt(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short' }).replace('.', '');
  const hhmm = iso => FusoBR.hora(iso, { hour: '2-digit', minute: '2-digit' });
  const dmhm = iso => `${FusoBR.data(iso, { day: '2-digit', month: '2-digit', year: 'numeric' })} às ${hhmm(iso)}`;
  const primeiroNome = n => String(n || '').trim().split(/\s+/)[0] || '';
  const gestor = () => _ehGestorOuAdmin();
  const abaAtiva = () => window.Frota?.abaAtiva?.();

  /* ── Estado ─────────────────────────────────────────────── */
  const estadoInicial = () => ({
    modo: 'semana', ref: null, ate: null, painel: null,                     // painel
    h: { periodo: 'semana', de: null, ate: null, user_id: '', veiculo_id: '' },   // filtros do histórico
    hd: null,                                                               // histórico carregado
  });
  let S = estadoInicial();
  const porId = new Map();            // registro do histórico por id (detalhe e edição)
  let _detalheId = null;
  let _gen = 0;                       // descarta resposta de uma consulta que já foi substituída (ou de aba que já saiu da tela)

  /* ── Cópia guardada para o modo sem internet ─────────────
     Cada resultado diz de onde veio (`_off`/`_em`): o painel e o histórico podem estar em situações diferentes. */
  async function _buscar(chave, buscar) {
    try {
      const d = await buscar();
      try { await DB.setMeta(chave, { d, em: new Date().toISOString() }); } catch (_) {}
      d._off = false; d._em = null;
      return d;
    } catch (e) {
      if (e?.status) throw e;                         // o servidor respondeu (403, 422…): não é falta de rede
      const c = await DB.getMeta(chave).catch(() => null);
      if (!c?.d) throw e;
      c.d._off = true; c.d._em = c.em;
      return c.d;
    }
  }
  const _chavePainel = () => `frota_painel_${user?.id}_${S.modo}`;
  const _chaveHist = () => `frota_hist_${user?.id}`;
  const _avisoOff = d => (d?._off ? `<div class="ini-dica fq-aviso" style="border-left:3px solid var(--warning)">📴 <b>Sem internet</b> — mostrando o que foi baixado${d._em ? ' em ' + dmhm(d._em) : ''}.</div>` : '');

  function _css() {
    if (document.getElementById('frota-painel-css')) return;
    const s = document.createElement('style');
    s.id = 'frota-painel-css';
    s.textContent = `
      .fq-abas{display:flex;gap:6px;padding:8px 14px 2px}
      .fq-abas .chip{flex:1;min-width:0;text-align:center;font-weight:800;padding:8px 4px}
      .fq-aviso{margin:8px 14px 0}
      .fq-nav{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 14px 4px}
      .fq-nav .mes-label{flex:1;min-width:0;font-size:16px}
      .fq-nav .btn-mes-nav:disabled{opacity:.3;cursor:default}
      .fq-seg{display:flex;justify-content:center;padding:8px 14px 2px}
      .fq-seg .seg-btn{min-height:36px;padding:7px 14px}
      .fq-hoje{display:flex;justify-content:center;padding:0 14px 2px}
      .fq-kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:2px 14px 0}
      .fq-kpis .ini-kpi{min-width:0;overflow-wrap:anywhere;cursor:default}
      .fq-kpis .ini-kpi-val{white-space:normal;overflow-wrap:anywhere}
      @media (max-width:359px){.fq-kpis .ini-kpi-val{font-size:22px}}
      .fq-var{font-weight:700}
      .fq-var.up{color:#9be58a}
      .fq-var.dn{color:#f5c27a}
      .fq-card{margin:10px 14px 0}
      .fq-evo{display:flex;align-items:flex-end;gap:0;height:126px}
      .fq-col{flex:1 1 0;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:2px;
              padding:0;border:0;background:none;font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
      .fq-col .v{font-size:11px;font-weight:800;color:#d9f5a0;line-height:1;white-space:nowrap;min-height:11px;pointer-events:none}
      .fq-col .b{width:68%;max-width:22px;flex-shrink:0;border-radius:4px 4px 0 0;background:rgba(185,226,74,.55);min-height:2px}
      .fq-col.sel .b{background:#d9f5a0}
      .fq-lab{display:flex;gap:0;margin-top:5px}
      .fq-lab span{flex:1 1 0;min-width:0;text-align:center;font-size:10.5px;color:var(--text2);text-transform:uppercase;white-space:nowrap}
      .fq-lab span.sel{color:#d9f5a0;font-weight:800}
      .fq-rank-item{cursor:pointer}
      .fq-rank-item .db-rank-meta{flex-wrap:nowrap}
      .fq-delta{flex-shrink:0;font-size:12px;font-weight:700;text-align:right}
      .fq-delta.up{color:#9be58a}
      .fq-delta.dn{color:#f5c27a}
      .fq-sub{font-size:12.5px;color:var(--text2)}
      .fq-dica{font-size:13px;color:var(--text2);line-height:1.4}
      .fq-exp{display:flex;gap:8px;flex-wrap:wrap}
      .fq-filtros{display:flex;gap:8px;flex-wrap:wrap;padding:8px 14px 0}
      .fq-sel{flex:1 1 130px;min-width:0;max-width:100%;padding:7px 12px;border-radius:20px;border:1.5px solid rgba(185,226,74,.4);
              background:rgba(255,255,255,.08);color:#eef9f0;font:inherit;font-size:16px;font-weight:600;cursor:pointer;
              text-overflow:ellipsis;overflow:hidden;white-space:nowrap}   /* 16 px: abaixo disso o Safari dá zoom ao tocar */
      .fq-sel.larga{flex-basis:100%}
      .fq-sel.on{background:#b9e24a;color:#0a3a1c;border-color:#b9e24a}
      .fq-sel option{color:#1C2B20;background:#fff}
      .fq-datas{display:flex;gap:8px;padding:8px 14px 0}
      .fq-datas .inp{flex:1;min-width:0}
      .fq-resumo{padding:8px 14px 2px;font-size:14.5px;color:var(--text2)}
      .fq-resumo b{color:#fff}
      .fq-dia{display:flex;justify-content:space-between;gap:8px;color:#d9f5a0;font-weight:700;font-size:14px;padding:8px 2px 0;letter-spacing:.3px}
      .fq-lista{display:flex;flex-direction:column;gap:10px;padding:4px 14px 16px}
      .nota-card.fq-item{cursor:pointer;content-visibility:visible}   /* sem content-visibility: com ele a lista muda de altura ao ser refeita e a rolagem pula */
      .fq-item .nota-foot{padding:6px 12px 8px}
      .fq-seta{font-size:20px;color:var(--text2);line-height:1;vertical-align:-1px}
      .fq-item .nota-body{padding-bottom:10px}
      .fq-alerta{font-size:13.5px;font-weight:700;color:#fbbf24}
      .fq-mais{display:flex;justify-content:center;padding:4px 14px 18px}
      .kd-foto{width:100%;max-height:36vh;object-fit:contain;background:#14171a;border-radius:12px;display:block;cursor:zoom-in}
      .kd-sem-foto{border:1.5px dashed var(--border);border-radius:12px;padding:18px 12px;text-align:center;color:var(--text2);font-size:14.5px}
      .kd-dica{text-align:center;font-size:12.5px;color:var(--text2);margin-top:-6px}
      .kd-odo{text-align:center;font-size:34px;font-weight:800;color:var(--primary-d);font-variant-numeric:tabular-nums;line-height:1.1}
      .kd-delta{text-align:center;font-size:16px;font-weight:700;color:var(--primary);margin-top:2px}
      .kd-alerta{background:#fff3cd;color:#7a4b00;border-radius:10px;padding:10px 12px;font-size:14.5px;font-weight:600;line-height:1.4}
      .kd-lista{background:var(--surface);border-radius:12px;padding:2px 14px;box-shadow:var(--shadow)}
      .kd-l{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--border);font-size:15px}
      .kd-l:last-child{border-bottom:0}
      .kd-l > span{color:var(--text2);flex-shrink:0}
      .kd-l > b{text-align:right;min-width:0;overflow-wrap:anywhere}
      .kd-l small{display:block;font-weight:500;color:var(--text2);font-size:13px}
      .kd-acoes{display:flex;gap:8px}
      .kd-acoes .btn{flex:1;min-width:0}
      .kd-nota{font-size:13.5px;color:var(--text2);text-align:center;line-height:1.4}
    `;
    document.head.appendChild(s);
  }

  /* ═══════════════ PAINEL ═══════════════ */
  async function painel(el) {
    _css();
    const gen = ++_gen;
    /* Já está no painel (tocou numa barra, mudou de período)? Deixa o que está na tela até o novo chegar e mantém a
       rolagem — senão a tela pula para o topo toda vez que se toca no gráfico, que fica no meio dela. */
    const jaNoPainel = !!el.querySelector('.fq-kpis');
    const rolagem = $('app-content')?.scrollTop || 0;
    if (!jaNoPainel) el.innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando painel…</p></div>';
    try {
      const q = { modo: S.modo, ref: S.ref || hoje(), ate: S.ate || undefined };
      const r = await _buscar(_chavePainel(), () => sb.frota.painel(q));
      if (gen !== _gen || !el.isConnected || abaAtiva() !== 'painel') return;
      S.painel = r; S.ref = r.ref; S.ate = r.serie[r.serie.length - 1].ini;
      el.innerHTML = _painelHTML();
      if (jaNoPainel && $('app-content')) $('app-content').scrollTop = rolagem;
    } catch (e) {
      if (gen !== _gen || !el.isConnected || abaAtiva() !== 'painel') return;
      el.innerHTML = `<div class="ini-dica fq-aviso">⚠️ Não deu para carregar o painel: ${esc(e?.message || 'erro')}. <a class="link" onclick="Frota.trocarAba('painel')">Tentar de novo</a></div>`;
    }
  }

  const _rotuloPeriodo = p => {
    const { ini, fim, atual } = p.periodo;
    if (p.modo === 'dia') return `${atual ? 'Hoje · ' : ''}${dsem(ini)} ${dm(ini)}${ini.slice(0, 4) !== hoje().slice(0, 4) ? '/' + ini.slice(0, 4) : ''}`;
    if (p.modo === 'semana') return `${dm(ini)} a ${dm(fim)}${atual ? ' · esta semana' : ''}`;
    return `${MESES_L[+ini.slice(5, 7) - 1]} ${ini.slice(0, 4)}`;
  };
  const _rotuloAnterior = p => p.modo === 'dia' ? 'ontem' : p.modo === 'semana' ? 'sem. anterior' : 'mês anterior';

  function _variacao(p) {
    if (p.variacao_pct === null) return p.total_anterior ? '' : `<span>sem km ${p.modo === 'dia' ? 'ontem' : 'no período anterior'}</span>`;
    const sobe = p.total >= p.total_anterior;
    /* semana/mês em andamento: o servidor compara com os mesmos dias do período anterior, e o texto diz isso */
    const contra = p.comparacao_parcial ? `${_rotuloAnterior(p)} (mesmos ${p.dias_decorridos} dia${p.dias_decorridos === 1 ? '' : 's'})` : _rotuloAnterior(p);
    return `<span class="fq-var ${sobe ? 'up' : 'dn'}">${sobe ? '▲' : '▼'} ${Math.abs(p.variacao_pct)}%</span> vs ${kmFmt(p.total_anterior)} ${contra}`;
  }

  function _kpisHTML(p, g) {
    const media = p.dias_decorridos > 0 ? Math.round(p.total / p.dias_decorridos) : 0;
    const veiculosComLeitura = (p.veiculos || []).filter(v => v.leituras > 0).length;
    const k = (lbl, val, sub) => `<div class="ini-kpi"><div class="ini-kpi-lbl">${lbl}</div><div class="ini-kpi-val">${val}</div><div class="ini-kpi-sub">${sub}</div></div>`;
    const terceiro = p.modo === 'dia'
      ? k('Dia anterior', kmFmt(p.total_anterior), `km · ${dsem(somarDias(p.periodo.ini, -1))} ${dm(somarDias(p.periodo.ini, -1))}`)
      : k('Média por dia', kmFmt(media), `km · ${p.dias_decorridos} dia${p.dias_decorridos === 1 ? '' : 's'}`);
    /* "No mês": o servidor diz de qual mês tirou o número (contexto.mes.ini) e é por ele que se rotula */
    const quarto = g
      ? k('Veículos que rodaram', `${p.veiculos_rodaram} de ${p.veiculos_ativos}`, p.veiculos_ativos - p.veiculos_rodaram > 0 ? `${p.veiculos_ativos - p.veiculos_rodaram} sem km no período` : 'todos rodaram')
      : (p.modo === 'mes'
        ? k('Veículos usados', String(p.veiculos_rodaram), 'com km no mês')
        : k('No mês', kmFmt(p.contexto.mes.km), MESES_L[+p.contexto.mes.ini.slice(5, 7) - 1].toLowerCase()));
    return `<div class="fq-kpis">
      ${k(g ? 'Km rodados' : 'Meus km', kmFmt(p.total), _variacao(p))}
      ${k('Leituras', String(p.leituras), `em ${veiculosComLeitura} veículo${veiculosComLeitura === 1 ? '' : 's'}`)}
      ${terceiro}${quarto}
    </div>`;
  }

  function _serieHTML(p) {
    const mx = Math.max(1, ...p.serie.map(s => s.km));
    /* 12 meses não cabem com 3 letras em 320 px: a inicial no eixo; o nome inteiro está no rótulo do período e no aria-label */
    const rot = s => p.modo === 'dia' ? s.ini.slice(8) : p.modo === 'semana' ? dm(s.ini) : MESES_L[+s.ini.slice(5, 7) - 1].slice(0, 1);
    const nomeBarra = s => p.modo === 'dia' ? `${dsem(s.ini)} ${dm(s.ini)}` : p.modo === 'semana' ? `semana de ${dm(s.ini)} a ${dm(s.fim)}` : `${MESES_L[+s.ini.slice(5, 7) - 1]} ${s.ini.slice(0, 4)}`;
    const titulo = (gestor()
      ? { dia: 'Últimos 14 dias', semana: 'Últimas 8 semanas', mes: 'Últimos 12 meses' }
      : { dia: 'Meus últimos 14 dias', semana: 'Minhas últimas 8 semanas', mes: 'Meus últimos 12 meses' })[p.modo];
    return `
      <div class="db-card fq-card">
        <div class="db-card-title"><span>${titulo}</span><span class="fq-dica">toque numa barra</span></div>
        <div class="fq-evo">${p.serie.map(s => {
          const sel = s.ini === p.periodo.ini;
          return `<button type="button" class="fq-col${sel ? ' sel' : ''}" data-ini="${at(s.ini)}" onclick="FrotaPainel.escolher(this.dataset.ini)" aria-label="${at(nomeBarra(s))}: ${kmFmt(s.km)} km"><span class="v">${sel ? kmFmt(s.km) : ''}</span><span class="b" style="height:${Math.max(2, Math.round(s.km / mx * ALTURA_BARRA))}px"></span></button>`;
        }).join('')}</div>
        <div class="fq-lab">${p.serie.map(s => `<span class="${s.ini === p.periodo.ini ? 'sel' : ''}">${rot(s)}</span>`).join('')}</div>
      </div>`;
  }

  /* linha de ranking: posição, nome, km e quanto subiu/desceu sobre o período anterior; tocar abre o histórico (`acao`) */
  function _rank(lista, nome, sub, id, acao) {
    if (!lista.length) return '<p class="muted-p">Nenhuma leitura neste período.</p>';
    const mx = Math.max(1, ...lista.map(x => x.km));
    return `<div class="db-rank">${lista.map((x, i) => {
      const d = x.km - x.km_anterior;
      return `<div class="db-rank-item fq-rank-item" data-id="${at(id(x))}" onclick="${acao}">
        <div class="db-rank-meta"><span class="db-rank-pos">${i + 1}º</span><span class="db-rank-name">${esc(nome(x))}</span><span class="db-rank-val">${kmFmt(x.km)} km</span>${d !== 0 ? `<span class="fq-delta ${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'} ${kmFmt(Math.abs(d))}</span>` : ''}</div>
        <div class="db-rank-track"><div class="db-rank-fill" style="width:${Math.max(3, Math.round(x.km / mx * 100))}%"></div></div>
        ${sub ? `<div class="fq-sub">${sub(x)}</div>` : ''}
      </div>`;
    }).join('')}</div>`;
  }

  /* quadro das planilhas (CSV do mês / Excel do ano): repintado sozinho quando o mês muda, sem refazer a tela */
  function _planilhasInner() {
    return `
        <div class="db-card-title"><span>📗 Planilhas de controle</span></div>
        <div class="fq-nav" style="padding:0">
          <button class="btn-mes-nav" onclick="Frota.mudarMes(-1)" aria-label="Mês anterior">‹</button>
          <span class="mes-label">${MESES_L[filMes - 1]} ${filAno}</span>
          <button class="btn-mes-nav" onclick="Frota.mudarMes(1)" aria-label="Próximo mês">›</button>
        </div>
        <div class="fq-exp">
          <button class="btn btn-outline btn-sm" onclick="Frota.exportarCSV()">CSV ${esc(MESES_L[filMes - 1])}</button>
          <button class="btn btn-primary btn-sm" onclick="Frota.exportarExcel()">Excel ${filAno}</button>
        </div>`;
  }
  function repintarPlanilhas() { const c = $('fq-planilhas'); if (c) c.innerHTML = _planilhasInner(); }

  function _painelHTML() {
    const p = S.painel, g = gestor();
    const noFim = p.periodo.fim >= hoje();
    const seg = (k, t) => `<button class="seg-btn ${p.modo === k ? 'active' : ''}" onclick="FrotaPainel.modo('${k}')">${t}</button>`;
    const comparacao = _rotuloAnterior(p);

    let html = `
      ${_avisoOff(p)}
      <div class="fq-seg"><div class="seg">${seg('dia', 'Dia')}${seg('semana', 'Semana')}${seg('mes', 'Mês')}</div></div>
      <div class="fq-nav">
        <button class="btn-mes-nav" onclick="FrotaPainel.andar(-1)" aria-label="Período anterior">‹</button>
        <span class="mes-label">${esc(_rotuloPeriodo(p))}</span>
        <button class="btn-mes-nav" onclick="FrotaPainel.andar(1)" aria-label="Próximo período" ${noFim ? 'disabled' : ''}>›</button>
      </div>
      ${p.periodo.atual ? '' : `<div class="fq-hoje"><button class="btn btn-outline btn-sm" onclick="FrotaPainel.irParaHoje()">Voltar para hoje</button></div>`}
      ${_kpisHTML(p, g)}
      ${_serieHTML(p)}`;

    if (g) {
      html += `
      <div class="db-card fq-card">
        <div class="db-card-title"><span>🏁 Quem está andando mais</span><span class="fq-dica">km · vs ${comparacao}</span></div>
        ${_rank(p.colaboradores || [], x => x.nome,
          x => x.leituras ? `${x.leituras} leitura${x.leituras === 1 ? '' : 's'}` : `última leitura em ${x.ultima_data ? fmtData(x.ultima_data) : '—'}`,
          x => x.user_id, 'FrotaPainel.verHistorico({user_id:this.dataset.id,doPainel:true})')}
      </div>`;
    }
    html += `
      <div class="db-card fq-card">
        <div class="db-card-title"><span>🚗 ${g ? 'Km por veículo' : 'Meus km por veículo'}</span><span class="fq-dica">toque para ver o histórico</span></div>
        ${_rank(p.veiculos || [], x => `${x.placa}${x.modelo ? ' · ' + x.modelo : ''}`,
          x => x.ultimo_odometro != null ? `última leitura: ${kmFmt(x.ultimo_odometro)} km em ${fmtData(x.ultima_data)}` : '',
          x => x.veiculo_id, 'FrotaPainel.verHistorico({veiculo_id:this.dataset.id,doPainel:true})')}
      </div>`;
    if (!g) html += `<p class="fq-dica" style="padding:10px 14px 0">Você vê só os seus números. O ranking da frota é do gestor.</p>`;

    html += `
      <div class="db-card fq-card" id="fq-planilhas">${_planilhasInner()}</div>
      <div style="height:18px"></div>`;
    return html;
  }

  function modo(k) {
    if (S.modo === k) return;
    S.modo = k; S.ate = null;                       // o gráfico passa a terminar no período escolhido
    Frota.trocarAba('painel');
  }
  function escolher(ini) { if (/^\d{4}-\d{2}-\d{2}$/.test(ini || '')) { S.ref = ini; Frota.trocarAba('painel'); } }
  function andar(n) {
    const p = S.painel; if (!p) return;
    S.ref = n < 0 ? somarDias(p.periodo.ini, -1) : somarDias(p.periodo.fim, 1);
    const serie = p.serie;
    if (S.ref < serie[0].ini || S.ref > serie[serie.length - 1].fim) S.ate = S.ref;   // saiu do gráfico: ele anda junto
    Frota.trocarAba('painel');
  }
  function irParaHoje() { S.ref = hoje(); S.ate = null; Frota.trocarAba('painel'); }

  /* Abre o histórico filtrado por pessoa ou veículo. Vindo do PAINEL, no mesmo período dele; vindo de outro lugar
     (aba Veículos, detalhe), o período do histórico fica como está. */
  function verHistorico({ user_id = '', veiculo_id = '', doPainel = false }) {
    const p = S.painel;
    if (doPainel && p) { S.h.de = p.periodo.ini; S.h.ate = p.periodo.fim; S.h.periodo = _chaveDoIntervalo(S.h.de, S.h.ate); }
    S.h.user_id = user_id; S.h.veiculo_id = veiculo_id;
    S.hd = null;
    Frota.trocarAba('hist');
  }

  /* ═══════════════ HISTÓRICO ═══════════════ */
  const PERIODOS = [['hoje', 'Hoje'], ['semana', 'Esta semana'], ['mes', 'Este mês'], ['mes-ant', 'Mês passado'], ['30d', 'Últimos 30 dias'], ['custom', 'Escolher datas…']];

  function _intervalo(chave, h = hoje()) {
    const fimMes = iso => { const d = _dt(iso.slice(0, 8) + '01'); d.setUTCMonth(d.getUTCMonth() + 1, 0); return _iso(d); };
    const ini = somarDias(h, -((_dt(h).getUTCDay() + 6) % 7));        // segunda-feira
    const mesIni = h.slice(0, 8) + '01';
    if (chave === 'hoje') return [h, h];
    if (chave === 'semana') return [ini, somarDias(ini, 6)];
    if (chave === 'mes') return [mesIni, fimMes(h)];
    if (chave === 'mes-ant') { const d = _dt(mesIni); d.setUTCMonth(d.getUTCMonth() - 1); const i = _iso(d); return [i, fimMes(i)]; }
    if (chave === '30d') return [somarDias(h, -29), h];
    return null;
  }
  function _chaveDoIntervalo(de, ate) {
    const k = PERIODOS.map(p => p[0]).find(c => { const r = _intervalo(c); return r && r[0] === de && r[1] === ate; });
    return k || 'custom';
  }
  function _garantirIntervalo() {
    if (S.h.periodo !== 'custom' || !S.h.de || !S.h.ate) {
      const r = _intervalo(S.h.periodo === 'custom' ? 'semana' : S.h.periodo);
      S.h.de = r[0]; S.h.ate = r[1];
    }
  }

  async function historico(el) {
    _css();
    if (!gestor()) S.h.user_id = '';                // colaborador comum não filtra por pessoa (o servidor ignora de qualquer jeito)
    _garantirIntervalo();
    /* a lista em memória só vale se veio do servidor; cópia guardada (sem internet) é refeita quando o sinal volta */
    if (S.hd && !(S.hd._off && navigator.onLine)) { _pintarHist(); return; }
    el.innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando histórico…</p></div>';
    await _carregarHist(0);
  }

  /* offset 0 = primeira página (ou a lista toda de novo: `limite` maior que a página, ao atualizar depois de uma correção) */
  async function _carregarHist(offset, limite = LIMITE_PAGINA) {
    const gen = ++_gen;
    const g = gestor();
    const q = { de: S.h.de, ate: S.h.ate, veiculo_id: S.h.veiculo_id || undefined, user_id: g ? (S.h.user_id || undefined) : undefined, limite, offset: offset || undefined };
    if (offset) {                                    // "carregar mais": sem cópia guardada; se falhar, a lista que já está na tela fica
      try {
        const r = await sb.frota.historico(q);
        if (gen !== _gen || !S.hd) return;
        r.itens = [...S.hd.itens, ...r.itens];
        r.itens.forEach(i => porId.set(i.id, i));
        S.hd = r;
        _pintarHist();
      } catch (e) { toast('Não deu para carregar mais: ' + (e?.message || 'erro'), 'err'); }
      return;
    }
    try {
      const filtros = { user_id: S.h.user_id, veiculo_id: S.h.veiculo_id };
      const r = await _buscar(_chaveHist(), () => sb.frota.historico(q).then(x => ({ ...x, _f: filtros })));
      if (gen !== _gen) return;
      if (r._off) {                                      // a cópia guardada vale com os filtros dela
        S.h.de = r.de; S.h.ate = r.ate; S.h.periodo = _chaveDoIntervalo(r.de, r.ate);
        S.h.user_id = g ? (r._f?.user_id || '') : ''; S.h.veiculo_id = r._f?.veiculo_id || '';
      }
      r.itens.forEach(i => porId.set(i.id, i));
      S.hd = r;
      _pintarHist();
    } catch (e) {
      if (gen !== _gen) return;
      const c = abaAtiva() === 'hist' ? $('fq-corpo') : null;
      if (c) c.innerHTML = `<div class="ini-dica fq-aviso">⚠️ Não deu para carregar o histórico: ${esc(e?.message || 'erro')}. <a class="link" onclick="Frota.trocarAba('hist')">Tentar de novo</a></div>`;
    }
  }

  function _opcoes(lista, atual, valor, rotulo, todos) {
    const ids = new Set(lista.map(valor));
    const extra = atual && !ids.has(atual) ? `<option value="${at(atual)}" selected>${esc(rotulo(lista.find(x => valor(x) === atual) || { nome: '…', placa: '…' }))}</option>` : '';
    return `<option value="">${todos}</option>${lista.map(x => `<option value="${at(valor(x))}" ${valor(x) === atual ? 'selected' : ''}>${esc(rotulo(x))}</option>`).join('')}${extra}`;
  }

  function _pintarHist() {
    const corpo = $('fq-corpo'), d = S.hd;
    if (!corpo || !d || abaAtiva() !== 'hist') return;
    const rolagem = $('app-content')?.scrollTop || 0;
    const g = gestor();
    const mais = d.itens.length;
    const pend = (window.Frota?.pendentes?.() || []).filter(p => (!S.h.veiculo_id || p.veiculo_id === S.h.veiculo_id) && (!g || !S.h.user_id || p.user_id === S.h.user_id));

    /* itens agrupados por dia (o total do dia vem do servidor, do filtro inteiro) */
    const dias = [];
    d.itens.forEach(i => { const u = dias[dias.length - 1]; if (u && u.data === i.data) u.itens.push(i); else dias.push({ data: i.data, itens: [i] }); });
    const h = hoje();
    const tituloDia = x => x === h ? `Hoje · ${dsem(x)} ${dm(x)}` : x === somarDias(h, -1) ? `Ontem · ${dsem(x)} ${dm(x)}` : `${dsem(x)} ${dm(x)}${x.slice(0, 4) !== h.slice(0, 4) ? '/' + x.slice(0, 4) : ''}`;

    corpo.innerHTML = `
      ${_avisoOff(d)}
      <div class="fq-filtros">
        <select class="fq-sel ${g ? 'larga ' : ''}${S.h.periodo !== 'semana' ? 'on' : ''}" onchange="FrotaPainel.periodo(this.value)" aria-label="Período">
          ${PERIODOS.map(([k, t]) => `<option value="${k}" ${S.h.periodo === k ? 'selected' : ''}>📅 ${t}</option>`).join('')}
        </select>
        ${g ? `<select class="fq-sel ${S.h.user_id ? 'on' : ''}" onchange="FrotaPainel.filtrar('user_id', this.value)" aria-label="Colaborador">
          ${_opcoes(d.colaboradores || [], S.h.user_id, x => x.id, x => '👤 ' + x.nome, '👤 Todos')}
        </select>` : ''}
        <select class="fq-sel ${S.h.veiculo_id ? 'on' : ''}" onchange="FrotaPainel.filtrar('veiculo_id', this.value)" aria-label="Veículo">
          ${_opcoes(d.veiculos || [], S.h.veiculo_id, x => x.id, x => '🚗 ' + x.placa, '🚗 Todos')}
        </select>
      </div>
      ${S.h.periodo === 'custom' ? `<div class="fq-datas">
        <input class="inp" type="date" value="${at(S.h.de)}" max="${at(S.h.ate)}" onchange="FrotaPainel.datas('de', this.value)" aria-label="De">
        <input class="inp" type="date" value="${at(S.h.ate)}" min="${at(S.h.de)}" onchange="FrotaPainel.datas('ate', this.value)" aria-label="Até">
      </div>` : ''}
      <div class="fq-resumo">${d.total} registro${d.total === 1 ? '' : 's'} · <b>${kmFmt(d.total_km)} km</b> no período${S.h.periodo !== 'custom' ? ` <span class="fq-dica">(${dm(S.h.de)}${S.h.de !== S.h.ate ? ' a ' + dm(S.h.ate) : ''})</span>` : ''}</div>
      <div class="fq-lista">
        ${pend.length ? `<div class="fq-dia"><span>⏳ Aguardando envio</span><span></span></div>${pend.map(_cartaoPendente).join('')}` : ''}
        ${dias.length ? dias.map(x => `
          <div class="fq-dia"><span>${esc(tituloDia(x.data))}</span><span>${kmFmt(d.por_dia?.[x.data] || 0)} km</span></div>
          ${x.itens.map(_cartao).join('')}`).join('') : `<p class="muted-p">Nenhum registro neste período${(g && S.h.user_id) || S.h.veiculo_id ? ' com esses filtros' : ''}.</p>`}
      </div>
      ${d.tem_mais ? `<div class="fq-mais"><button class="btn btn-outline" onclick="FrotaPainel.maisHist()">Carregar mais (${mais} de ${d.total})</button></div>` : ''}`;
    const el = $('app-content'); if (el) el.scrollTop = rolagem;
    _miniaturas(d.itens);
  }

  function _cartao(r) {
    const g = gestor();
    const info = r.anterior_odometro == null
      ? '<span class="fq-sub">primeira leitura deste veículo</span>'
      : `<b style="color:var(--primary-d)">+${kmFmt(r.km_rodado)} km</b> <span class="fq-sub">desde ${dm(r.anterior_data)} · ${kmFmt(r.anterior_odometro)} km</span>`;
    const rodape = r.alerta ? `<span class="fq-alerta">⚠️ ${r.alerta === 'salto' ? 'salto grande — confira' : 'menor que a anterior — confira'}</span>`
      : r.editado_por ? `<span class="fq-sub">✏️ corrigido por ${esc(primeiroNome(r.editado_por))}</span>`
      : r.editado_em ? '<span class="fq-sub">✏️ editado</span>' : '';
    return `
      <div class="nota-card ${r.foto_path ? 'com-thumb' : ''} fq-item" role="button" tabindex="0" data-id="${at(r.id)}" onclick="FrotaPainel.abrir(this.dataset.id)" onkeydown="if(event.key==='Enter')FrotaPainel.abrir(this.dataset.id)">
        ${r.foto_path ? `<span class="nota-thumb" data-thumb="${at(r.id)}"><span class="nota-thumb-ph">📷</span></span>` : ''}
        <div class="nota-head">
          <span class="tipo-badge tipo-RDM">🚗 ${esc(r.placa || '?')}</span>
          ${g ? `<span class="subtipo-tag">👤 ${esc(r.user_nome)}</span>` : ''}
          <span class="nota-data">${r.registrado_em ? esc(hhmm(r.registrado_em)) : ''} <span class="fq-seta">›</span></span>
        </div>
        <div class="nota-body">
          <div class="nota-empresa">${kmFmt(r.odometro)} km</div>
          <div class="nota-obs">${info}</div>
          ${r.observacao ? `<div class="nota-obs">${esc(r.observacao)}</div>` : ''}
        </div>
        ${rodape ? `<div class="nota-foot">${rodape}</div>` : ''}
      </div>`;
  }

  /* leitura que ainda não subiu (fila do aparelho): abre direto o formulário */
  function _cartaoPendente(r) {
    return `
      <div class="nota-card fq-item" style="border-left:3px solid var(--warning)" role="button" tabindex="0" data-id="${at(r.id)}" onclick="Frota.abrirForm(this.dataset.id)" onkeydown="if(event.key==='Enter')Frota.abrirForm(this.dataset.id)">
        <div class="nota-head">
          <span class="tipo-badge tipo-RDM">🚗 ${esc(r.placa || '?')}</span>
          ${r._erro ? `<span class="doc-tag dup" title="${at(r._erro)}">⚠️ recusado</span>` : '<span class="sync-pill pending">⏳ pendente</span>'}
          <span class="nota-data">${fmtData(r.data)}</span>
        </div>
        <div class="nota-body">
          <div class="nota-empresa">${kmFmt(r.odometro)} km</div>
          ${r._erro ? `<div class="nota-obs" style="color:#ffb4a8">${esc(r._erro)}</div>` : ''}
          ${r.observacao ? `<div class="nota-obs">${esc(r.observacao)}</div>` : ''}
        </div>
        <div class="nota-foot"><span class="fq-sub">${r._erro ? 'toque para corrigir' : 'sobe sozinho quando houver sinal'}</span><span class="fq-seta">›</span></div>
      </div>`;
  }

  /* Miniaturas das fotos: uma chamada assinada para a página inteira; a URL (vale 5 min) fica guardada no item, então
     repintar a lista (carregar mais, atualizar) não pede tudo de novo. */
  const _poeMiniatura = (slot, url) => {
    if (!slot || !url) return;
    const img = new Image();
    img.alt = 'Foto do odômetro';
    img.onload = () => { slot.innerHTML = ''; slot.appendChild(img); };
    img.src = url;
  };
  const _slots = () => new Map([...document.querySelectorAll('[data-thumb]')].map(s => [s.dataset.thumb, s]));
  async function _miniaturas(itens) {
    const slots = _slots();
    const faltam = [];
    itens.forEach(i => {
      if (!i.foto_path || !slots.has(i.id)) return;
      if (i._url && Date.now() - i._urlEm < 240000) _poeMiniatura(slots.get(i.id), i._url); else faltam.push(i);
    });
    if (!faltam.length || !sb || !navigator.onLine) return;
    const urls = await sb.fotos.urls(faltam.map(i => i.foto_path)).catch(() => ({}));
    const agora = _slots();                                     // a lista pode ter sido repintada enquanto a resposta vinha
    faltam.forEach(i => {
      const url = urls[i.foto_path]; if (!url) return;
      i._url = url; i._urlEm = Date.now();
      _poeMiniatura(agora.get(i.id), url);
    });
  }

  function periodo(chave) {
    S.h.periodo = chave;
    if (chave !== 'custom') { const r = _intervalo(chave); S.h.de = r[0]; S.h.ate = r[1]; }
    S.hd = null; Frota.trocarAba('hist');
  }
  function datas(campo, valor) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return;
    S.h[campo] = valor;
    if (S.h.de > S.h.ate) { if (campo === 'de') S.h.ate = valor; else S.h.de = valor; }
    S.hd = null; Frota.trocarAba('hist');
  }
  function filtrar(campo, valor) { S.h[campo] = valor; S.hd = null; Frota.trocarAba('hist'); }
  function maisHist() { if (S.hd?.tem_mais) _carregarHist(S.hd.itens.length); }

  /* Depois de corrigir/excluir uma leitura: refaz o que está na tela SEM voltar ao topo e sem perder as páginas já
     carregadas do histórico (a ficha da Equipe faz o mesmo). */
  async function atualizar() {
    fecharDetalhe();
    const aba = abaAtiva();
    if (aba === 'hist') {
      if (!S.hd) return;
      await _carregarHist(0, Math.min(LIMITE_MAXIMO, Math.max(LIMITE_PAGINA, S.hd.itens.length)));
    } else if (aba === 'painel') {
      const c = $('fq-corpo'); if (c) await painel(c);
    } else if (aba) {
      await Frota.trocarAba(aba);
    }
  }

  /* ═══════════════ DETALHE ═══════════════ */
  function _detalheHTML(r) {
    const g = gestor();
    const delta = r.anterior_odometro == null ? 'Primeira leitura deste veículo' : `+${kmFmt(r.km_rodado)} km desde a leitura anterior`;
    const alerta = r.alerta === 'salto'
      ? `⚠️ Salto de ${kmFmt(r.km_rodado)} km desde a leitura anterior. Confira se o número está certo${r.pode_editar ? ' — dá para corrigir abaixo' : ''}.`
      : r.alerta === 'menor'
        ? `⚠️ O odômetro (${kmFmt(r.odometro)} km) é menor que o da leitura anterior (${kmFmt(r.anterior_odometro)} km). Pode ser erro de digitação${r.pode_editar ? ' — dá para corrigir abaixo' : ''}.`
        : '';
    const linha = (rot, val) => val ? `<div class="kd-l"><span>${rot}</span><b>${val}</b></div>` : '';
    const anterior = r.anterior_odometro == null ? '' :
      `${kmFmt(r.anterior_odometro)} km · ${fmtData(r.anterior_data)}${r.anterior_em ? ' ' + esc(hhmm(r.anterior_em)) : ''}${r.anterior_por ? `<small>por ${esc(r.anterior_por)}</small>` : ''}`;
    const corrigido = r.editado_por ? `${esc(r.editado_por)}<small>${esc(dmhm(r.editado_em))}</small>` : '';
    const editado = !r.editado_por && r.editado_em ? esc(dmhm(r.editado_em)) : '';
    const id = at(r.id);
    return `
      ${r.foto_path ? `<img id="kd-foto" class="kd-foto" alt="Foto do odômetro" style="display:none" data-id="${id}" onclick="Frota.verFoto(this.dataset.id)"><div id="kd-foto-ph" class="kd-sem-foto">Carregando a foto…</div><div class="kd-dica" id="kd-foto-dica" style="display:none">toque na foto para ampliar</div>`
        : '<div class="kd-sem-foto">📷 Sem foto do odômetro neste registro</div>'}
      <div><div class="kd-odo">${kmFmt(r.odometro)} km</div><div class="kd-delta">${esc(delta)}</div></div>
      ${alerta ? `<div class="kd-alerta">${esc(alerta)}</div>` : ''}
      <div class="kd-lista">
        ${linha('Veículo', esc(r.placa || '?') + (r.modelo ? ' · ' + esc(r.modelo) : ''))}
        ${linha('Colaborador', esc(r.user_nome))}
        ${linha('Data da leitura', fmtData(r.data))}
        ${linha('Registrado em', r.registrado_em ? esc(dmhm(r.registrado_em)) + ' (Brasília)' : '—')}
        ${linha('Leitura anterior', anterior)}
        ${linha('Observação', esc(r.observacao || ''))}
        ${linha('Corrigido por', corrigido)}
        ${linha('Editado em', editado)}
      </div>
      ${r.pode_editar
        ? `<div class="kd-acoes"><button class="btn btn-primary" data-id="${id}" onclick="FrotaPainel.editar(this.dataset.id)">✏️ Editar</button><button class="btn btn-outline" style="color:#D62828;border-color:#D62828" data-id="${id}" onclick="FrotaPainel.excluir(this.dataset.id)">🗑 Excluir</button></div>`
        : '<p class="kd-nota">Só quem registrou, o gestor ou o admin podem alterar esta leitura.</p>'}
      <div class="kd-acoes">
        <button class="btn btn-outline btn-sm" onclick="FrotaPainel.doDetalhe('veiculo')">🕓 Histórico do veículo</button>
        ${g ? `<button class="btn btn-outline btn-sm" onclick="FrotaPainel.doDetalhe('pessoa')">👤 Histórico de ${esc(primeiroNome(r.user_nome))}</button>` : ''}
      </div>`;
  }

  function abrir(id) {
    const r = porId.get(id);
    if (!r) return;
    _detalheId = id;
    $('km-det-corpo').innerHTML = _detalheHTML(r);
    $('km-det-overlay').style.display = 'flex';
    if (r.foto_path) _fotoDoDetalhe(r);
  }
  async function _fotoDoDetalhe(r) {
    const ph = $('kd-foto-ph');
    try {
      if (!sb || !navigator.onLine) throw new Error('Sem internet para abrir a foto.');
      const url = await sb.fotos.url(r.foto_path);
      if (!url) throw new Error('Foto não encontrada.');
      if (_detalheId !== r.id) return;
      const img = $('kd-foto');
      img.onload = () => { img.style.display = ''; if (ph) ph.style.display = 'none'; const d = $('kd-foto-dica'); if (d) d.style.display = ''; };
      img.onerror = () => { if (ph) ph.textContent = 'Não foi possível abrir a foto.'; };
      img.src = url;
    } catch (e) { if (ph && _detalheId === r.id) ph.textContent = e.message || 'Não foi possível abrir a foto.'; }
  }
  function fecharDetalhe() {
    const o = $('km-det-overlay');
    if (o) o.style.display = 'none';
    _detalheId = null;
  }
  const editar = id => Frota.abrirForm(id);
  const excluir = id => Frota.excluir(id);

  /* atalhos do detalhe: o histórico filtrado pelo veículo ou pela pessoa daquela leitura */
  function doDetalhe(quem) {
    const r = porId.get(_detalheId);
    if (!r) return;
    fecharDetalhe();
    S.h.veiculo_id = quem === 'veiculo' ? r.veiculo_id : '';
    S.h.user_id = quem === 'pessoa' ? r.user_id : '';
    S.hd = null;
    Frota.trocarAba('hist');
  }

  return {
    painel, historico, abrir, fecharDetalhe, atualizar,
    modo, escolher, andar, irParaHoje, verHistorico, repintarPlanilhas,
    periodo, datas, filtrar, maisHist, editar, excluir, doDetalhe,
    registro: id => porId.get(id) || null,
    cancelar() { _gen++; },                                           // trocou de aba: resposta em voo não pinta mais nada
    invalidar() { S.hd = null; S.painel = null; },                    // algo mudou (salvou, excluiu): a próxima abertura busca de novo
    esquecer() { _gen++; S = estadoInicial(); porId.clear(); _detalheId = null; },   // logout: nada de uma conta fica na memória da próxima
  };
})();
