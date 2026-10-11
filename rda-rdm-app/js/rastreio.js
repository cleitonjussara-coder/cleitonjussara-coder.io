'use strict';
/* ─────────────────────────────────────────────────────────────
   RASTREIO DA EQUIPE (11/10/2026) — gestor/admin.
   Um cartão por colaborador ativo: quando usou o app por último ("visto"),
   quando lançou a última nota, quantas lançou hoje / na semana / no mês e as
   últimas notas mexidas (lançou ✚, editou ✏️, apagou 🗑️). A bolinha diz se a
   pessoa está em dia: verde = lançou hoje; amarelo = há 1 a 3 dias; vermelho =
   mais de 3 dias; cinza = sem notas nos últimos 60 dias.
   Complementa o Histórico (lista cronológica de tudo): aqui a visão é POR pessoa.
   Dados: GET /colaboradores/atividade (RastreioController).
   Depende de globais do app.js: $, sb, esc, brl, toast, _ehGestorOuAdmin,
   switchView, PAPEL_NOME.
───────────────────────────────────────────────────────────── */
window.Rastreio = (() => {
  const TZ = 'America/Sao_Paulo';
  const LIMITE_AMARELO = 3;                 // dias sem lançar até virar vermelho
  let dados = null;                         // { gerado_em, equipe: [...] }
  let filtro = 'todos';                     // todos | ativos | parados
  let aberto = null;                        // id do cartão expandido
  let carregando = false;

  const diaBR = d => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });          // AAAA-MM-DD
  const hhmm = d => new Date(d).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const ddmm = d => new Date(d).toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' });
  const diasDeDiferenca = iso => Math.round((Date.parse(diaBR(Date.now())) - Date.parse(diaBR(iso))) / 86400000);

  /* "há 12 min", "há 3 h", "ontem 18:40", "há 6 dias", "03/09" */
  function quando(iso) {
    if (!iso) return '—';
    const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (min < 1) return 'agora';
    if (min < 60) return `há ${min} min`;
    const dias = diasDeDiferenca(iso);
    if (dias === 0) return `há ${Math.floor(min / 60)} h`;
    if (dias === 1) return `ontem ${hhmm(iso)}`;
    if (dias < 14) return `há ${dias} dias`;
    return ddmm(iso);
  }

  function situacao(p) {
    if (!p.ultimo_lancamento_em) return { cor: '#9aa5a0', txt: 'Sem notas nos últimos 60 dias', parado: true };
    const dias = diasDeDiferenca(p.ultimo_lancamento_em);
    if (dias <= 0) return { cor: '#4ade80', txt: '', parado: false };
    if (dias <= LIMITE_AMARELO) return { cor: '#fbbf24', txt: '', parado: false };
    return { cor: '#f87171', txt: `Sem lançar há ${dias} dias`, parado: true };
  }

  const ativoHoje = p => p.hoje > 0 || (p.visto_em && diaBR(p.visto_em) === diaBR(Date.now()));

  function _css() {
    if (document.getElementById('rastreio-css')) return;
    const s = document.createElement('style');
    s.id = 'rastreio-css';
    s.textContent = `
      .rs-sub{padding:0 14px;color:var(--text2);font-size:13.5px;margin-top:-6px}
      .rs-chips{display:flex;gap:8px;padding:12px 14px 4px;flex-wrap:wrap}
      .rs-chip{font-size:14px;padding:7px 13px;border-radius:16px;border:1px solid var(--border);background:transparent;color:var(--text2);cursor:pointer;font-weight:600}
      .rs-chip.on{background:var(--primary-l);color:#10311a;border-color:var(--primary-l)}
      .rs-lista{display:flex;flex-direction:column;gap:10px;padding:8px 14px 14px}
      .rs-card{cursor:pointer}
      .rs-top{display:flex;align-items:center;gap:10px}
      .rs-av{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.16);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;flex-shrink:0}
      .rs-nm{font-size:16px;font-weight:800;line-height:1.2;overflow-wrap:anywhere}
      .rs-pp{font-size:13px;color:var(--text2)}
      .rs-dot{width:11px;height:11px;border-radius:50%;margin-left:auto;flex-shrink:0;box-shadow:0 0 0 3px rgba(255,255,255,.12)}
      .rs-ln{font-size:14px;color:var(--text2);line-height:1.45}
      .rs-ln b{color:var(--text);font-weight:700}
      .rs-warn{font-size:13.5px;font-weight:700;padding:5px 10px;border-radius:8px;background:rgba(248,113,113,.18);color:#fecaca;align-self:flex-start}
      .rs-kp{display:flex;gap:6px;flex-wrap:wrap}
      .rs-k{font-size:12.5px;padding:3px 9px;border-radius:9px;background:rgba(255,255,255,.1);color:var(--text2)}
      .rs-rec{border-top:1px solid var(--border);margin-top:2px}
      .rs-it{display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.08);font-size:14px}
      .rs-it:last-child{border-bottom:0}
      .rs-it .t{margin-left:auto;color:var(--text2);white-space:nowrap;font-size:12.5px;padding-left:6px}
      .rs-it.ap{opacity:.62;text-decoration:line-through}
      .rs-leg{font-size:12.5px;color:var(--text2);text-align:center;padding:0 14px 18px}
    `;
    document.head.appendChild(s);
  }

  function _cartao(p) {
    const sit = situacao(p);
    const ini = String(p.nome || '?').trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();
    const abre = aberto === p.id;
    const papel = (typeof PAPEL_NOME !== 'undefined' && PAPEL_NOME[p.role]) || p.role;
    const regime = p.role === 'colaborador' ? (p.regime === 'cv' ? ' · C.V.' : ' · RDM/RDA') : '';
    const ult = p.recentes?.[0];
    const linhaUlt = ult
      ? `<div class="rs-ln">${esc(ult.fornecedor || 'sem fornecedor')} · <b>${ult.valor > 0 ? brl(ult.valor) : 'sem valor'}</b> · ${esc(ult.acao)}</div>`
      : '';
    const itens = (p.recentes || []).map(n => `
      <div class="rs-it${n.acao === 'apagou' ? ' ap' : ''}">
        <span>${n.acao === 'lançou' ? '✚' : n.acao === 'editou' ? '✏️' : '🗑️'}</span>
        <span>${esc(n.fornecedor || (n.cnpj ? n.cnpj : 'sem fornecedor'))} · ${n.valor > 0 ? brl(n.valor) : 'sem valor'} · ${esc(n.tipo)}${n.subtipo ? '/' + esc(n.subtipo) : ''}</span>
        <span class="t">${esc(quando(n.quando))}</span>
      </div>`).join('');
    return `
    <div class="db-card rs-card" onclick="Rastreio.abrir('${esc(p.id)}')">
      <div class="rs-top">
        <div class="rs-av">${esc(ini)}</div>
        <div><div class="rs-nm">${esc(p.nome)}</div><div class="rs-pp">${esc(papel)}${regime}</div></div>
        <span class="rs-dot" style="background:${sit.cor}" title="${esc(sit.txt || 'em dia')}"></span>
      </div>
      <div class="rs-ln">Visto no app <b>${p.visto_em ? esc(quando(p.visto_em)) : 'nunca'}</b> · última nota <b>${p.ultimo_lancamento_em ? esc(quando(p.ultimo_lancamento_em)) : '—'}</b></div>
      ${linhaUlt}
      ${sit.txt && sit.parado ? `<div class="rs-warn">${esc(sit.txt)}</div>` : ''}
      <div class="rs-kp"><span class="rs-k">Hoje: ${p.hoje}</span><span class="rs-k">Semana: ${p.semana}</span><span class="rs-k">Mês: ${p.mes}${p.mes_valor > 0 ? ' · ' + brl(p.mes_valor) : ''}</span></div>
      ${abre ? `<div class="rs-rec">${itens || '<div class="rs-ln" style="padding:8px 0">Nenhuma nota nos últimos 60 dias.</div>'}</div>` : ''}
    </div>`;
  }

  function _pintar() {
    const el = $('app-content');
    if (!el) return;
    const rolagem = el.scrollTop;                      // abrir/fechar cartão repinta a tela: mantém a posição
    const equipe = [...(dados?.equipe || [])].sort((a, b) =>
      String(b.ultima_atividade_em || '').localeCompare(String(a.ultima_atividade_em || '')) ||
      String(b.visto_em || '').localeCompare(String(a.visto_em || '')) ||
      String(a.nome).localeCompare(String(b.nome)));
    const mostra = equipe.filter(p => filtro === 'ativos' ? ativoHoje(p) : filtro === 'parados' ? situacao(p).parado : true);
    const chip = (k, rot) => `<button class="rs-chip${filtro === k ? ' on' : ''}" onclick="Rastreio.filtrar('${k}')">${rot}</button>`;
    el.innerHTML = `
      <div class="page-hd"><h2>Rastreio da equipe</h2><button class="rs-chip" onclick="Rastreio.atualizar()" aria-label="Atualizar">↻ Atualizar</button></div>
      <p class="rs-sub">Atualizado às ${dados ? hhmm(dados.gerado_em) : '—'} · toque num cartão para ver as últimas notas.</p>
      <div class="rs-chips">${chip('todos', 'Todos')}${chip('ativos', 'Ativos hoje')}${chip('parados', 'Parados')}</div>
      <div class="rs-lista">${mostra.length ? mostra.map(_cartao).join('') : '<div class="empty-state"><div class="empty-icon">🛰️</div><p>Ninguém neste filtro.</p></div>'}</div>
      <p class="rs-leg">Bolinha: verde lançou hoje · amarelo 1 a ${LIMITE_AMARELO} dias · vermelho mais de ${LIMITE_AMARELO} dias · cinza sem notas em 60 dias.<br>"Visto no app" é o último uso do aplicativo, mesmo sem lançar nota.</p>`;
    el.scrollTop = rolagem;
  }

  async function carregar() {
    if (carregando) return;
    const el = $('app-content');
    if (!sb || !navigator.onLine) {
      el.innerHTML = '<div class="page-hd"><h2>Rastreio da equipe</h2></div><div class="empty-state"><div class="empty-icon">📡</div><p>Precisa de internet — o rastreio sempre busca no servidor.</p></div>';
      return;
    }
    carregando = true;
    try {
      dados = await sb.colaboradores.atividade();
      _pintar();
    } catch (e) {
      el.innerHTML = `<div class="page-hd"><h2>Rastreio da equipe</h2></div><div class="empty-state"><div class="empty-icon">⚠️</div><p>Não deu para carregar: ${esc(e?.message || 'erro')}</p></div>`;
    } finally { carregando = false; }
  }

  function render() {
    if (typeof _ehGestorOuAdmin === 'function' && !_ehGestorOuAdmin()) { switchView('inicio'); return; }
    _css();
    $('app-content').innerHTML = '<div class="page-hd"><h2>Rastreio da equipe</h2></div><div class="empty-state"><div class="empty-icon">🛰️</div><p>Carregando…</p></div>';
    aberto = null; filtro = 'todos';
    carregar();
  }

  return {
    render,
    atualizar: () => carregar(),
    filtrar: k => { filtro = k; _pintar(); },
    abrir: id => { aberto = aberto === id ? null : id; _pintar(); },
  };
})();
