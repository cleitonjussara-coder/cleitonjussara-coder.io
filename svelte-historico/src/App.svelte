<script>
  /* Porta renderHistorico() (app.js) para um componente — mesma lógica de
     busca/junção das 4 fontes (notas, repasses, apagadas em definitivo,
     troca de papel/regime), só a forma de montar na tela que muda. */
  let { sb, user, equipePorId, brl, esc, formatarCnpj } = $props();

  const PAPEL_NOME = { colaborador: 'Colaborador', gestor: 'Gestor', admin: 'Administrador', contabilidade: 'Contador' };
  const REGIME_NOME = { rdm_rda: 'RDM/RDA', cv: 'C.V.' };
  const ICO = { lançou: '✚', editou: '✏️', apagou: '🗑️', 'apagou em definitivo': '⛔', 'trocou o papel': '🎭', 'trocou o regime': '🔁' };

  let estado = $state('carregando'); // 'carregando' | 'offline' | 'erro' | 'ok'
  let erroMsg = $state('');
  let entradas = $state([]);

  const nome = id => !id ? '—' : (id === user?.id ? (user?.nome || 'Você') : (equipePorId[id]?.nome || 'Colaborador'));
  const mesmoInstante = (a, b) => a && b && Math.abs(new Date(b).getTime() - new Date(a).getTime()) < 3000;
  const fmtHora = d => {
    try { return new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch { return '—'; }
  };

  async function carregar() {
    if (!sb || !navigator.onLine) { estado = 'offline'; return; }
    estado = 'carregando';
    const sinceIso = new Date(Date.now() - 60 * 86400_000).toISOString();
    let notasMudadas, repassesMudados, apagadasDet, papelRegime;
    try {
      [notasMudadas, repassesMudados, apagadasDet, papelRegime] = await Promise.all([
        sb.notas.list({ since: sinceIso, fields: 'id,user_id,tipo,subtipo,valor,data,razao_social,cnpj,deleted,created_at,updated_at,created_by,updated_by' }),
        sb.repasses.list({ since: sinceIso }),
        sb.notas.apagadasDetalhe(sinceIso),
        sb.colaboradores.historico(sinceIso),
      ]);
    } catch (e) {
      estado = 'erro'; erroMsg = e?.message || 'erro'; return;
    }

    const lista = [];
    (notasMudadas || []).forEach(n => lista.push({
      quando: n.updated_at,
      acao: n.deleted ? 'apagou' : (mesmoInstante(n.created_at, n.updated_at) ? 'lançou' : 'editou'),
      tipoItem: 'nota',
      quem: nome(n.updated_by),
      dono: nome(n.user_id),
      resumo: `${esc(n.tipo)}${n.subtipo ? ' · ' + esc(n.subtipo) : ''} · ${esc(n.razao_social || (n.cnpj ? formatarCnpj(n.cnpj) : 'sem empresa'))} · ${Number(n.valor) > 0 ? brl(n.valor) : 'sem valor'}`,
    }));
    (repassesMudados || []).forEach(r => lista.push({
      quando: r.updated_at,
      acao: r.deleted ? 'apagou' : (mesmoInstante(r.created_at, r.updated_at) ? 'lançou' : 'editou'),
      tipoItem: 'repasse',
      quem: nome(r.updated_by),
      dono: nome(r.user_id),
      resumo: `${esc(r.tipo)} · ${brl(r.valor)} · ${r.kind === 'requested' ? 'pedido' : 'recebido'}${r.destino === 'recarga' ? ' (recarga do cartão)' : ''}`,
    }));
    (apagadasDet || []).forEach(a => lista.push({
      quando: a.apagada_em,
      acao: 'apagou em definitivo',
      tipoItem: 'nota',
      quem: nome(a.apagada_por),
      dono: nome(a.user_id),
      resumo: 'nota apagada em definitivo — sem volta, não passou pela lixeira',
    }));
    (papelRegime || []).forEach(h => {
      const ehPapel = h.campo === 'role';
      const rot = ehPapel ? PAPEL_NOME : REGIME_NOME;
      lista.push({
        quando: h.alterado_em,
        acao: ehPapel ? 'trocou o papel' : 'trocou o regime',
        tipoItem: '',
        quem: nome(h.alterado_por),
        dono: nome(h.colaborador_id),
        resumo: `de ${esc(rot[h.de] || h.de || '—')} para ${esc(rot[h.para] || h.para || '—')}`,
      });
    });
    lista.sort((a, b) => String(b.quando || '').localeCompare(String(a.quando || '')));
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
            <div class="db-pend-txt"><b>{e.quem}</b> {e.acao} {e.tipoItem} de <b>{e.dono}</b></div>
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
