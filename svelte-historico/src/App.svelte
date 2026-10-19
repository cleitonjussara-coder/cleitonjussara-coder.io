<script>
  /* Porta renderHistorico() (app.js) para um componente — mesma lógica de
     busca/junção das 4 fontes (notas, repasses, apagadas em definitivo,
     troca de papel/regime), só a forma de montar na tela que muda. */
  let { sb, user, equipePorId, brl, esc, formatarCnpj } = $props();

  const PAPEL_NOME = { colaborador: 'Colaborador', gestor: 'Gestor', admin: 'Administrador', contabilidade: 'Contador' };
  const REGIME_NOME = { rdm_rda: 'RDM/RDA', cv: 'C.V.' };
  const ICO = { lançou: '✚', editou: '✏️', apagou: '🗑️', 'apagou em definitivo': '⛔', 'trocou o papel': '🎭', 'trocou o regime': '🔁', 'pediu justificativa': '📨', 'respondeu a justificativa': '💬', 'cancelou o pedido de justificativa': '↩️' };

  let estado = $state('carregando'); // 'carregando' | 'offline' | 'erro' | 'ok'
  let erroMsg = $state('');
  let entradas = $state([]);

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
    let notasMudadas, repassesMudados, apagadasDet, papelRegime, justificativas;
    try {
      [notasMudadas, repassesMudados, apagadasDet, papelRegime, justificativas] = await Promise.all([
        sb.notas.list({ since: sinceIso, fields: 'id,user_id,tipo,subtipo,valor,data,razao_social,cnpj,deleted,created_at,updated_at,created_by,updated_by' }),
        sb.repasses.list({ since: sinceIso }),
        sb.notas.apagadasDetalhe(sinceIso),
        sb.colaboradores.historico(sinceIso),
        /* pedidos de justificativa (19/10/2026) — se a API ainda não tem a rota, o Histórico segue sem eles */
        (sb.justificativas ? sb.justificativas.list({ since: sinceIso }) : Promise.resolve([])).catch(() => []),
      ]);
    } catch (e) {
      estado = 'erro'; erroMsg = e?.message || 'erro'; return;
    }

    const lista = [];
    (notasMudadas || []).forEach(n => lista.push({
      quando: n.updated_at,
      acao: n.deleted ? 'apagou' : (mesmoInstante(n.created_at, n.updated_at) ? 'lançou' : 'editou'),
      tipoItem: 'nota',
      quem: nomeAutor(n.updated_by),
      dono: nomeDono(n.user_id),
      resumo: `${esc(n.tipo)}${n.subtipo ? ' · ' + esc(n.subtipo) : ''} · ${esc(n.razao_social || (n.cnpj ? formatarCnpj(n.cnpj) : 'sem empresa'))} · ${Number(n.valor) > 0 ? brl(n.valor) : 'sem valor'}`,
    }));
    (repassesMudados || []).forEach(r => lista.push({
      quando: r.updated_at,
      acao: r.deleted ? 'apagou' : (mesmoInstante(r.created_at, r.updated_at) ? 'lançou' : 'editou'),
      tipoItem: 'repasse',
      quem: nomeAutor(r.updated_by),
      dono: nome(r.user_id),
      resumo: `${esc(r.tipo)} · ${brl(r.valor)} · ${r.kind === 'requested' ? 'pedido' : 'recebido'}${r.destino === 'recarga' ? ' (recarga do cartão)' : ''}`,
    }));
    (apagadasDet || []).forEach(a => lista.push({
      quando: instante(a.apagada_em),
      acao: 'apagou em definitivo',
      tipoItem: 'nota',
      quem: nome(a.apagada_por),
      dono: nomeDono(a.user_id),
      resumo: 'nota apagada em definitivo — sem volta, não passou pela lixeira',
    }));
    (papelRegime || []).forEach(h => {
      const ehPapel = h.campo === 'role';
      const rot = ehPapel ? PAPEL_NOME : REGIME_NOME;
      lista.push({
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
        quando: instante(j.pedido_em),
        acao: 'pediu justificativa', tipoItem: '', prep: 'a',
        quem: j.pedido_por_nome || nome(j.pedido_por), dono,
        resumo: `${esc(j.motivo)}${j.mensagem ? ' — ' + trecho(j.mensagem) : ''}`,
      });
      if (j.respondido_em) lista.push({
        quando: instante(j.respondido_em),
        acao: 'respondeu a justificativa', tipoItem: '', prep: 'pedida por',
        quem: dono, dono: j.pedido_por_nome || nome(j.pedido_por),
        resumo: `“${trecho(j.resposta)}”`,
      });
      if (j.cancelada_em) lista.push({
        quando: instante(j.cancelada_em),
        acao: 'cancelou o pedido de justificativa', tipoItem: '',
        quem: nome(j.cancelada_por), dono,
        resumo: esc(j.motivo),
      });
    });
    lista.sort((a, b) => (new Date(b.quando).getTime() || 0) - (new Date(a.quando).getTime() || 0));   // pelo instante, não pelo texto
    entradas = lista.slice(0, 200);
    estado = 'ok';
  }

  carregar();
</script>

<div class="page-hd"><div class="mes-nav"><span class="mes-label">Histórico de alterações</span></div></div>
<p class="sub">Últimos 60 dias · notas, repasses e troca de papel/regime de toda a equipe.</p>

{#if estado === 'offline'}
  <div class="empty-state"><div class="empty-icon">📡</div><p>Precisa de internet para ver o histórico — é auditoria, então busca sempre no servidor.</p></div>
{:else if estado === 'erro'}
  <div class="empty-state"><div class="empty-icon">⚠️</div><p>Não deu para carregar: {erroMsg}</p></div>
{:else if estado === 'carregando'}
  <div class="empty-state"><div class="empty-icon">🕓</div><p>Carregando…</p></div>
{:else if !entradas.length}
  <div class="empty-state"><div class="empty-icon">🕓</div><p>Nada mudou nos últimos 60 dias.</p></div>
{:else}
  <div class="db-card">
    <div class="db-pend">
      {#each entradas as e}
        <div class="db-pend-item item">
          <span class="ico">{ICO[e.acao] || '•'}</span>
          <div class="corpo">
            <div class="db-pend-txt"><b>{e.quem}</b> {e.acao} {e.tipoItem} {e.prep || 'de'} <b>{e.dono}</b></div>
            <div class="resumo">{@html e.resumo}</div>
          </div>
          <span class="hora">{fmtHora(e.quando)}</span>
        </div>
      {/each}
    </div>
  </div>
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
</style>
