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
   Pedido de justificativa (19/10/2026): cada cartão de colaborador tem o botão 📨 que avisa a pessoa (sino, celular, e-mail)
   e mostra, no próprio cartão, o pedido aguardando ou a resposta. Dados vêm no mesmo GET /colaboradores/atividade.
   Depende de globais do app.js: $, sb, esc, brl, toast, _ehGestorOuAdmin,
   switchView, PAPEL_NOME, pedirCampos, pedirConfirmacao, mostrarAviso, setLoading.
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

  /* quando um novo pedido é liberado: "hoje 15:00" ou "20/10 12:00" */
  function quandoFuturo(iso) {
    const hora = hhmm(iso);
    return diaBR(iso) === diaBR(Date.now()) ? `hoje ${hora}` : `${ddmm(iso)} ${hora}`;
  }
  const resumir = (t, max) => { const x = String(t || '').trim(); return x.length > max ? x.slice(0, max - 1) + '…' : x; };

  /* Pedido de justificativa (19/10/2026): estado do último pedido + botão de ação do cartão (só colaborador). */
  function _blocoJustificativa(p, abre) {
    const j = p.justificativa;
    let estado = '';
    if (j?.status === 'pendente') {
      estado = `<div class="rs-just pend">📨 Justificativa pedida <b>${esc(quando(j.pedido_em))}</b>${j.pedido_por_nome ? ' por ' + esc(j.pedido_por_nome) : ''} — aguardando resposta.<br>${esc(j.motivo)}</div>`;
    } else if (j?.status === 'respondida') {
      estado = `<div class="rs-just ok">✅ <b>Justificou ${esc(quando(j.respondido_em))}</b> <span class="rs-nota">(pedido: ${esc(j.motivo)})</span><span class="tx"><q>${esc(resumir(j.resposta, abre ? 2000 : 160))}</q></span></div>`;
    }
    if (p.role !== 'colaborador') return estado;
    const livre = !p.justificativa_libera_em || Date.parse(p.justificativa_libera_em) <= Date.now();
    const botao = j?.status === 'pendente'
      ? `<button class="rs-bt suave" onclick="event.stopPropagation();Rastreio.cancelarJustificativa('${esc(p.id)}')">↩ Cancelar pedido</button>`
      : `<button class="rs-bt" ${livre ? '' : 'disabled'} onclick="event.stopPropagation();Rastreio.pedirJustificativa('${esc(p.id)}')">📨 Pedir justificativa</button>`;
    const nota = j?.status !== 'pendente' && !livre ? `<span class="rs-nota">Novo pedido liberado ${esc(quandoFuturo(p.justificativa_libera_em))}.</span>` : '';
    return `${estado}<div class="rs-ac">${botao}${nota}</div>`;
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
      .rs-just{font-size:14px;line-height:1.45;padding:8px 10px;border-radius:9px;background:rgba(255,255,255,.08);overflow-wrap:anywhere}
      .rs-just.pend{background:rgba(251,191,36,.16);color:#fde68a}
      .rs-just.ok{background:rgba(74,222,128,.14)}
      .rs-just q{quotes:none;font-style:italic;color:var(--text)}
      .rs-just .tx{display:block;white-space:pre-wrap;margin-top:2px}
      .rs-ac{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .rs-bt{font-size:14px;font-weight:700;min-height:40px;padding:8px 14px;border-radius:10px;border:1px solid #b9e24a;background:transparent;color:#d4f27a;cursor:pointer}
      .rs-bt:disabled{opacity:.5;border-color:var(--border);color:var(--text2);cursor:default}
      .rs-bt.suave{border-color:var(--border);color:var(--text2);font-weight:600}
      .rs-nota{font-size:12.5px;color:var(--text2)}
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
      ${_blocoJustificativa(p, abre)}
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
      <p class="rs-leg">Bolinha: verde lançou hoje · amarelo 1 a ${LIMITE_AMARELO} dias · vermelho mais de ${LIMITE_AMARELO} dias · cinza sem notas em 60 dias.<br>"Visto no app" é o último contato do aparelho com o servidor, mesmo sem lançar nota — inclui o envio em segundo plano de nota que ficou esperando.</p>`;
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

  /* Pedir justificativa (19/10/2026): motivo já vem preenchido com o que o cartão mostra ("Sem lançar há 4 dias");
     o gestor ajusta e pode somar uma mensagem. Se a rede falhar, a janela volta com o que ele escreveu. */
  function _motivoSugerido(p) {
    if (!p.ultimo_lancamento_em) return 'Sem lançar notas há mais de 60 dias';
    const dias = diasDeDiferenca(p.ultimo_lancamento_em);
    return dias > 0 ? `Sem lançar há ${dias} ${dias === 1 ? 'dia' : 'dias'}` : '';
  }

  async function pedirJustificativa(id) {
    const p = (dados?.equipe || []).find(x => x.id === id);
    if (!p) return;
    if (!sb || !navigator.onLine) { toast('Precisa de internet para pedir a justificativa', 'err'); return; }
    let motivo = _motivoSugerido(p), mensagem = '';
    for (;;) {
      const r = await pedirCampos({
        titulo: `Pedir justificativa a ${p.nome}`,
        dica: 'A pessoa recebe um aviso no celular, no sino do app e por e-mail, e responde pelo app. A resposta volta para você aqui.',
        confirmar: 'Enviar pedido',
        campos: [
          { id: 'motivo', rotulo: 'Motivo', valor: motivo, maxlength: 200, placeholder: 'Ex.: nota de combustível sem anexo',
            validar: t => (t.length < 3 ? 'Diga o motivo do pedido.' : '') },
          { id: 'mensagem', rotulo: 'Mensagem (opcional)', valor: mensagem, linhas: 3, maxlength: 1000, placeholder: 'Algo mais que a pessoa deva saber' },
        ],
      });
      if (!r) return;
      motivo = r.motivo; mensagem = r.mensagem;
      setLoading(true);
      try {
        const j = await sb.justificativas.pedir({ colaborador_id: id, motivo, mensagem });
        setLoading(false);
        toast(j?.email_enviado === false ? `Pedido enviado a ${p.nome} — aparece no sino dela (o e-mail não saiu) 📨` : `Pedido enviado a ${p.nome} 📨`, 'ok', 4500);
        carregar();
        return;
      } catch (e) {
        setLoading(false);
        if (e.status === 422 || e.status === 403 || e.status === 404) {        // regra do servidor (já há pedido aberto, intervalo mínimo…): explicar
          await mostrarAviso(`Não foi possível pedir${String.fromCharCode(10)}${e.message || 'O servidor recusou o pedido.'}`);
          carregar();
          return;
        }
        toast('Não enviou: ' + (e.message || 'erro') + ' — o texto foi mantido', 'err', 4500);
      }
    }
  }

  async function cancelarJustificativa(id) {
    const p = (dados?.equipe || []).find(x => x.id === id);
    const j = p?.justificativa;
    if (!j || j.status !== 'pendente') return;
    if (!sb || !navigator.onLine) { toast('Precisa de internet', 'err'); return; }
    if (!(await pedirConfirmacao({ titulo: `Cancelar o pedido a ${p.nome}?`, mensagem: `${p.nome} deixa de ver o pedido no sino. Depois você pode fazer outro na hora.`, confirmar: 'Cancelar pedido', cancelar: 'Voltar' }))) return;
    setLoading(true);
    try {
      await sb.justificativas.cancelar(j.id);
      toast('Pedido cancelado');
    } catch (e) { toast('Não deu: ' + (e.message || 'erro'), 'err'); }
    finally { setLoading(false); }
    carregar();
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
    pedirJustificativa,
    cancelarJustificativa,
  };
})();
