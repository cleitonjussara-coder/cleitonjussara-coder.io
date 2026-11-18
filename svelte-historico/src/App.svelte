<script>
  /* Porta renderHistorico() (app.js) para um componente — mesma lógica de
     busca/junção das 4 fontes (notas, repasses, apagadas em definitivo,
     troca de papel/regime), só a forma de montar na tela que muda. */
  let { sb, user, equipePorId, brl, esc, formatarCnpj, abrirHistoricoNota = null } = $props();

  const PAPEL_NOME = { colaborador: 'Colaborador', gestor: 'Gestor', admin: 'Administrador', contabilidade: 'Contador' };
  const REGIME_NOME = { rdm_rda: 'RDM/RDA', cv: 'C.V.' };
  const ICO = { lançou: '✚', editou: '✏️', apagou: '🗑️', 'apagou em definitivo': '⛔', 'excluiu o colaborador': '⛔', 'trocou o papel': '🎭', 'trocou o regime': '🔁', 'recusou': '🚫', 'conferiu': '✅', 'desmarcou o conferido de': '↩️', 'pediu justificativa': '📨', 'respondeu a justificativa': '💬', 'cancelou o pedido de justificativa': '↩️' };

  let estado = $state('carregando'); // 'carregando' | 'offline' | 'erro' | 'ok'
  let erroMsg = $state('');
  let entradas = $state([]);
  /* Lote 2 (17/11/2026): filtros por ação e por pessoa, e "ver mais" no lugar do corte calado em 200. Tocar numa linha de
     nota abre o histórico daquela nota (o que mudou, antes → depois). */
  const GRUPO = { 'lançou': 'lancou', 'editou': 'editou', 'apagou': 'apagou', 'apagou em definitivo': 'apagou', 'excluiu o colaborador': 'apagou', 'recusou': 'apagou',
    'pediu justificativa': 'just', 'respondeu a justificativa': 'just', 'cancelou o pedido de justificativa': 'just', 'trocou o papel': 'papel', 'trocou o regime': 'papel', 'conferiu': 'conf', 'desmarcou o conferido de': 'conf' };
  const CHIPS = [['todos', 'Todos'], ['lancou', 'Lançou'], ['editou', 'Editou'], ['apagou', 'Apagou'], ['just', 'Justificativa'], ['conf', 'Conferido'], ['papel', 'Papel/regime']];
  const PASSO = 200;
  let fAcao = $state('todos');
  let fPessoa = $state('');
  let limite = $state(PASSO);
  const filtradas = $derived(entradas.filter(e => (fAcao === 'todos' || GRUPO[e.acao] === fAcao)
    && (!fPessoa || e.donoId === fPessoa || e.quemId === fPessoa)));
  const visiveis = $derived(filtradas.slice(0, limite));
  const pessoas = $derived.by(() => {
    const m = new Map();
    entradas.forEach(e => { if (e.donoId) m.set(e.donoId, e.dono); if (e.quemId) m.set(e.quemId, e.quem.replace(/ \(Contador\)$/, '')); });
    return [...m.entries()].filter(([, n]) => n && n !== '—').sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  });
  const qtdAcao = k => (k === 'todos' ? entradas : entradas.filter(e => GRUPO[e.acao] === k)).filter(e => !fPessoa || e.donoId === fPessoa || e.quemId === fPessoa).length;
  const filtrar = (a, p) => { if (a != null) fAcao = a; if (p != null) fPessoa = p; limite = PASSO; };
  const podeAbrir = e => e.tipoItem === 'nota' && e.id && typeof abrirHistoricoNota === 'function';

  const nome = id => !id ? '—' : (id === user?.id ? (user?.nome || 'Você') : (equipePorId[id]?.nome || 'Colaborador'));
  /* Faturamento sem colaborador (28/09/2026): só a nota (dono = user_id)
     pode ser null de propósito — quem editou/lançou (quem = updated_by)
     nunca é, então continua usando nome() puro. */
  const nomeDono = id => id === null ? 'Faturamento geral (sem colaborador)' : nome(id);
  /* Quem editou/lançou: quando é o Contador (que corrige nota incorreta, 14/10/2026)
     o papel vai junto do nome, para o gestor ver de relance que não foi o colaborador. */
  const nomeAutor = id => nome(id) + (equipePorId[id]?.role === 'contabilidade' ? ' (Contador)' : '');
  const mesmoInstante = (a, b) => a && b && Math.abs(new Date(b).getTime() - new Date(a).getTime()) < 3000;
  /* 16/10/2026: normaliza o instante antes de mostrar e ordenar. A data crua do servidor ("2026-10-17 00:57:00") é UTC SEM fuso:
     o navegador a lê como horário local (3 h adiantada, caindo no dia seguinte) e, como texto, ela ordena fora de lugar —
     foi o "apagou em definitivo" do Paulo aparecendo em 17/10 00:57 no meio da lista. Com o "Z" vira o instante certo. O
     servidor já manda ISO; isto cobre resposta antiga e qualquer outra fonte sem fuso. */
  const instante = v => {
    if (!v) return '';
    const s = String(v);
    return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  };
  const fmtHora = d => {
    /* sempre o horário de Brasília (pedido do Cleiton, 16/10/2026), qualquer que seja o fuso do aparelho */
    try { return new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch { return '—'; }
  };

  async function carregar() {
    if (!sb || !navigator.onLine) { estado = 'offline'; return; }
    estado = 'carregando';
    const sinceIso = new Date(Date.now() - 60 * 86400_000).toISOString();
    let notasMudadas, repassesMudados, apagadasDet, papelRegime, justificativas, conferencias;
    try {
      [notasMudadas, repassesMudados, apagadasDet, papelRegime, justificativas, conferencias] = await Promise.all([
        sb.notas.list({ since: sinceIso, fields: 'id,user_id,tipo,subtipo,valor,data,razao_social,cnpj,deleted,created_at,updated_at,created_by,updated_by' }),
        sb.repasses.list({ since: sinceIso }),
        sb.notas.apagadasDetalhe(sinceIso),
        sb.colaboradores.historico(sinceIso),
        /* pedidos de justificativa (19/10/2026) — se a API ainda não tem a rota, o Histórico segue sem eles */
        (sb.justificativas ? sb.justificativas.list({ since: sinceIso }) : Promise.resolve([])).catch(() => []),
        /* "✓ conferido" (18/11/2026): quem conferiu ou desmarcou nota/repasse — sem a rota, segue sem eles */
        (sb.conferencias ? sb.conferencias.list({ since: sinceIso }) : Promise.resolve([])).catch(() => []),
      ]);
    } catch (e) {
      estado = 'erro'; erroMsg = e?.message || 'erro'; return;
    }

    const lista = [];
    (notasMudadas || []).forEach(n => lista.push({
      id: n.id, donoId: n.user_id, quemId: n.updated_by,
      quando: n.updated_at,
      acao: n.deleted ? 'apagou' : (mesmoInstante(n.created_at, n.updated_at) ? 'lançou' : 'editou'),
      tipoItem: 'nota',
      quem: nomeAutor(n.updated_by),
      dono: nomeDono(n.user_id),
      resumo: `${esc(n.tipo)}${n.subtipo ? ' · ' + esc(n.subtipo) : ''} · ${esc(n.razao_social || (n.cnpj ? formatarCnpj(n.cnpj) : 'sem empresa'))} · ${Number(n.valor) > 0 ? brl(n.valor) : 'sem valor'}`,
    }));
    /* 18/11/2026 (Lote 3): pedido recusado vira "recusou o pedido de", com o motivo, em vez de "apagou repasse" */
    (repassesMudados || []).forEach(r => {
      const recusou = r.deleted && r.recusado_em;
      lista.push({
        donoId: r.user_id, quemId: recusou ? (r.recusado_por || r.updated_by) : r.updated_by,
        quando: r.updated_at,
        acao: recusou ? 'recusou' : r.deleted ? 'apagou' : (mesmoInstante(r.created_at, r.updated_at) ? 'lançou' : 'editou'),
        tipoItem: recusou ? 'o pedido' : 'repasse',
        quem: nomeAutor(recusou ? (r.recusado_por || r.updated_by) : r.updated_by),
        dono: nome(r.user_id),
        resumo: `${esc(r.tipo)} · ${brl(r.valor)} · ${r.kind === 'requested' ? 'pedido' : 'recebido'}${r.destino === 'recarga' ? ' (recarga do cartão)' : ''}${recusou && r.motivo_recusa ? ` · motivo: ${esc(r.motivo_recusa)}` : ''}`,
      });
    });
    /* 04/11/2026: o servidor agrupa as lápides, e uma exclusão de colaborador vira uma linha só. "Não passou pela lixeira" saiu:
       era falso para as que estavam nela. Quem foi excluído já não está na equipe, então o nome costuma não existir. */
    (apagadasDet || []).forEach(a => {
      const qtd = Number(a.quantidade) || 1;
      const notas = `${qtd} ${qtd === 1 ? 'nota' : 'notas'}`;
      const base = { quando: instante(a.apagada_em), quem: nome(a.apagada_por), quemId: a.apagada_por, donoId: a.user_id };
      if (a.colaborador_excluido) {
        const alvo = equipePorId[a.user_id]?.nome;
        lista.push({ ...base, acao: 'excluiu o colaborador', frase: `excluiu o colaborador${alvo ? ' ' + alvo : ''}: ${notas}`, resumo: `${notas} apagada${qtd === 1 ? '' : 's'} em definitivo com a exclusão — sem volta` });
      } else {
        lista.push({ ...base, acao: 'apagou em definitivo', tipoItem: qtd === 1 ? 'nota' : notas, dono: nomeDono(a.user_id), resumo: `${notas} apagada${qtd === 1 ? '' : 's'} em definitivo — sem volta` });
      }
    });
    (papelRegime || []).forEach(h => {
      const ehPapel = h.campo === 'role';
      const rot = ehPapel ? PAPEL_NOME : REGIME_NOME;
      lista.push({
        quemId: h.alterado_por, donoId: h.colaborador_id,
        quando: instante(h.alterado_em),
        acao: ehPapel ? 'trocou o papel' : 'trocou o regime',
        tipoItem: '',
        quem: nome(h.alterado_por),
        dono: nome(h.colaborador_id),
        resumo: `de ${esc(rot[h.de] || h.de || '—')} para ${esc(rot[h.para] || h.para || '—')}`,
      });
    });
    /* Justificativa: cada pedido gera até três linhas — quando foi pedido, quando respondeu, ou que cancelaram. */
    const trecho = (t, max = 300) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return esc(x.length > max ? x.slice(0, max - 1) + '…' : x); };
    (justificativas || []).forEach(j => {
      const dono = j.colaborador_nome || nome(j.colaborador_id);
      lista.push({
        quemId: j.pedido_por, donoId: j.colaborador_id,
        quando: instante(j.pedido_em),
        acao: 'pediu justificativa', tipoItem: '', prep: 'a',
        quem: j.pedido_por_nome || nome(j.pedido_por), dono,
        resumo: `${esc(j.motivo)}${j.mensagem ? ' — ' + trecho(j.mensagem) : ''}`,
      });
      if (j.respondido_em) lista.push({
        quemId: j.colaborador_id, donoId: j.pedido_por,
        quando: instante(j.respondido_em),
        acao: 'respondeu a justificativa', tipoItem: '', prep: 'pedida por',
        quem: dono, dono: j.pedido_por_nome || nome(j.pedido_por),
        resumo: `“${trecho(j.resposta)}”`,
      });
      if (j.cancelada_em) lista.push({
        quemId: j.cancelada_por, donoId: j.colaborador_id,
        quando: instante(j.cancelada_em),
        acao: 'cancelou o pedido de justificativa', tipoItem: '',
        quem: nome(j.cancelada_por), dono,
        resumo: esc(j.motivo),
      });
    });
    const desde = Date.parse(sinceIso);
    (conferencias || []).forEach(c => {
      const item = c.tipo === 'nota' ? 'nota' : 'repasse';
      const base = { tipoItem: item, id: item === 'nota' ? c.registro_id : null, donoId: c.dono_id, dono: nome(c.dono_id), resumo: '' };
      if (c.conferido_em && Date.parse(c.conferido_em) >= desde) lista.push({ ...base, quando: instante(c.conferido_em), acao: 'conferiu', quem: c.conferido_por_nome || nome(c.conferido_por), quemId: c.conferido_por });
      if (c.desmarcado_em && Date.parse(c.desmarcado_em) >= desde) lista.push({ ...base, id: null, frase: `desmarcou o conferido ${item === 'nota' ? 'da nota' : 'do repasse'} de ${base.dono}`, quando: instante(c.desmarcado_em), acao: 'desmarcou o conferido de', quem: c.desmarcado_por_nome || nome(c.desmarcado_por), quemId: c.desmarcado_por });
    });
    lista.sort((a, b) => (new Date(b.quando).getTime() || 0) - (new Date(a.quando).getTime() || 0));   // pelo instante, não pelo texto
    entradas = lista;
    estado = 'ok';
  }

  carregar();
</script>

<div class="page-hd"><div class="mes-nav"><span class="mes-label">Histórico de alterações</span></div></div>
<p class="sub">Últimos 60 dias · notas, repasses, conferências e troca de papel/regime de toda a equipe.</p>

{#if estado === 'offline'}
  <div class="empty-state"><div class="empty-icon">📡</div><p>Precisa de internet para ver o histórico — é auditoria, então busca sempre no servidor.</p></div>
{:else if estado === 'erro'}
  <div class="empty-state"><div class="empty-icon">⚠️</div><p>Não deu para carregar: {erroMsg}</p></div>
{:else if estado === 'carregando'}
  <div class="empty-state"><div class="empty-icon">🕓</div><p>Carregando…</p></div>
{:else if !entradas.length}
  <div class="empty-state"><div class="empty-icon">🕓</div><p>Nada mudou nos últimos 60 dias.</p></div>
{:else}
  <div class="hist-filtros">
    <div class="hist-chips">
      {#each CHIPS as [k, rot]}
        <button type="button" class="hist-chip" class:on={fAcao === k} aria-pressed={fAcao === k} onclick={() => filtrar(k, null)}>{rot} {qtdAcao(k)}</button>
      {/each}
    </div>
    <select class="inp" aria-label="Pessoa" value={fPessoa} onchange={ev => filtrar(null, ev.currentTarget.value)}>
      <option value="">👤 Todas as pessoas</option>
      {#each pessoas as [id, n]}<option value={id}>{n}</option>{/each}
    </select>
  </div>
  {#if !filtradas.length}
    <div class="empty-state"><div class="empty-icon">🔎</div><p>Nada com esse filtro nos últimos 60 dias.</p></div>
  {:else}
  <div class="db-card">
    <div class="db-pend">
      {#each visiveis as e}
        {#if podeAbrir(e)}
          <button type="button" class="db-pend-item item abre" onclick={() => abrirHistoricoNota(e.id)} title="Ver o que mudou nesta nota">
            <span class="ico">{ICO[e.acao] || '•'}</span>
            <div class="corpo">
              <div class="db-pend-txt"><b>{e.quem}</b> {e.acao} {e.tipoItem} {e.prep || 'de'} <b>{e.dono}</b></div>
              <div class="resumo">{@html e.resumo}</div>
            </div>
            <span class="hora">{fmtHora(e.quando)}<span class="seta">›</span></span>
          </button>
        {:else}
        <div class="db-pend-item item">
          <span class="ico">{ICO[e.acao] || '•'}</span>
          <div class="corpo">
            <div class="db-pend-txt"><b>{e.quem}</b> {#if e.frase}{e.frase}{:else}{e.acao} {e.tipoItem} {e.prep || 'de'} <b>{e.dono}</b>{/if}</div>
            <div class="resumo">{@html e.resumo}</div>
          </div>
          <span class="hora">{fmtHora(e.quando)}</span>
        </div>
        {/if}
      {/each}
    </div>
  </div>
  {#if filtradas.length > visiveis.length}
    <div class="hist-mais">
      <span>Mostrando {visiveis.length} de {filtradas.length}</span>
      <button type="button" class="btn btn-sm btn-outline" onclick={() => (limite += PASSO)}>Ver mais</button>
    </div>
  {/if}
  {/if}
{/if}

<style>
  /* Reaproveita .page-hd, .mes-nav, .mes-label, .empty-state, .empty-icon,
     .db-card, .db-pend, .db-pend-item, .db-pend-txt já globais do app —
     só o miolo específico deste item precisa de estilo próprio. */
  .sub { padding: 0 14px; color: var(--text2); font-size: 13.5px; margin-top: -6px; }
  .item { gap: 10px; }
  .ico { font-size: 20px; flex-shrink: 0; }
  .corpo { flex: 1; min-width: 0; }
  .resumo { font-size: 13px; color: var(--text2); margin-top: 1px; }
  .hora { font-size: 12px; color: var(--text2); white-space: nowrap; flex-shrink: 0; }
  .abre { width: 100%; text-align: left; background: transparent; border: 0; color: inherit; font: inherit; cursor: pointer; }
  .seta { margin-left: 6px; font-size: 16px; color: var(--primary-l, #b8e986); }
  .hist-filtros { display: flex; flex-direction: column; gap: 8px; padding: 0 14px 10px; }
  .hist-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .hist-chip { font-size: 13.5px; padding: 6px 11px; border-radius: 16px; border: 1px solid var(--border); background: transparent; color: var(--text2); cursor: pointer; font-weight: 600; }
  .hist-chip.on { background: var(--primary-l, #b8e986); color: #10311a; border-color: var(--primary-l, #b8e986); }
  .hist-mais { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 14px 18px; color: var(--text2); font-size: 13.5px; }
</style>
