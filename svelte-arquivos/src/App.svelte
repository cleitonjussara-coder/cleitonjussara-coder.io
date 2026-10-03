<script>
  /* Puramente apresentacional: recebe `nivel` + `dados` já prontos do
     main.js (que faz toda a busca/formatação, igual ao arquivos.js
     original) e só desenha. As strings com HTML embutido (alerta "sem
     anexo" em laranja, legenda com <br>/<b>) vêm prontas — {@html} nelas,
     não em dado de usuário solto. */
  let {
    nivel, dados, ano,
    onMudarAno, onAbrirColab, onAbrirMes, onVoltarMeses, onVoltarColabs,
    onVer, onBaixarZip, onTentarDeNovo, onBaixarEquipe, onBaixarPlanilhas, meses = [],
  } = $props();
  let mesEquipe = $state('');
</script>

{#snippet cabecalho(titulo, sub)}
  <div class="arq-hd">
    <div class="mes-nav" style="margin-left:auto">
      <button class="btn-mes-nav" onclick={() => onMudarAno(-1)}>‹</button>
      <span class="mes-label">{ano}</span>
      <button class="btn-mes-nav" onclick={() => onMudarAno(1)}>›</button>
    </div>
  </div>
  <div class="arq-titulo">{@html titulo}</div>
  {#if sub}<div class="arq-sub">{@html sub}</div>{/if}
{/snippet}

{#if nivel === 'offline'}
  <div class="db-container"><div class="db-card" style="text-align:center;padding:24px">
    <div style="font-size:31px">📁</div>
    <p style="margin-top:8px;color:var(--text2)">Os arquivos ficam no servidor: precisa de internet para abrir esta tela.</p>
    <button class="btn btn-outline" style="margin-top:12px" onclick={onTentarDeNovo}>Tentar de novo</button>
  </div></div>

{:else if nivel === 'erro'}
  <div class="db-container"><div class="db-card" style="text-align:center;padding:24px">
    <p style="color:var(--danger)">Não consegui carregar: {dados.mensagem}</p>
    <button class="btn btn-outline" style="margin-top:12px" onclick={onTentarDeNovo}>Tentar de novo</button>
  </div></div>

{:else if nivel === 'carregando'}
  <div class="loading-state"><div class="spin"></div><p>Carregando…</p></div>

{:else if nivel === 'colabs'}
  <div class="db-container">
    {@render cabecalho('📁 Arquivos no servidor', dados.cabecalhoSub)}
    <div class="ini-dica">Toque no colaborador para ver os meses; de cada mês dá para baixar um ZIP já nas pastas do modelo da empresa (com a Planilha CV dentro). Não depende do Google Drive.</div>
    {#if dados.colaboradores.length}
      <div class="db-card arq-todos">
        <div class="arq-colab-nome">📦 Baixar de todos de uma vez</div>
        <select bind:value={mesEquipe} style="width:100%;min-height:44px;margin:8px 0">
          <option value="">Ano {ano} inteiro</option>
          {#each meses as nome, i}<option value={i + 1}>{nome}</option>{/each}
        </select>
        <button class="btn btn-primary btn-full" style="min-height:50px" onclick={() => onBaixarEquipe(mesEquipe ? Number(mesEquipe) : null)}>⬇️ Notas de todos (ZIP)</button>
        <button class="btn btn-outline btn-full" style="min-height:50px;margin-top:8px" onclick={onBaixarPlanilhas}>📊 Planilhas de todos (ZIP)</button>
        <div class="ini-dica" style="margin-top:8px">As planilhas são do ano inteiro; RDM/RDA leva uns 20 s por pessoa.</div>
      </div>
    {/if}
    {#if !dados.colaboradores.length}
      <div class="db-card" style="text-align:center;color:var(--text2)">Nenhum colaborador.</div>
    {/if}
    {#each dados.colaboradores as c}
      <button class="arq-colab {c.vazio ? 'arq-vazio' : ''}" onclick={() => onAbrirColab(c.userId)}>
        <div class="avatar" data-foto={c.fotoPath}>{c.iniciais}</div>
        <div class="arq-colab-txt">
          <div class="arq-colab-nome">{@html c.nomeHtml}</div>
          <div class="arq-colab-sub">{@html c.subHtml}</div>
        </div>
        <span class="arq-seta">›</span>
      </button>
    {/each}
  </div>

{:else if nivel === 'meses'}
  <div class="db-container">
    {@render cabecalho(dados.cabecalhoTitulo, dados.cabecalhoSub)}
    {#if dados.temNotas}
      <button class="btn btn-primary btn-full" style="min-height:50px" onclick={() => onBaixarZip(null)}>⬇️ Baixar ZIP do ano {ano} ({dados.comAnexo} anexo{dados.comAnexo === 1 ? '' : 's'} + Planilha CV)</button>
    {/if}
    <div class="arq-meses">
      {#each dados.meses as m}
        <button class="arq-mes {m.vazio ? 'arq-vazio' : ''}" disabled={m.vazio} onclick={() => onAbrirMes(m.mes)}>
          <span class="arq-mes-nome">{m.nome}</span>
          <span class="arq-mes-qtd">{m.qtdTxt}</span>
          <span class="arq-mes-val">{m.valTxt}</span>
          {#if m.alertaTxt}<span class="arq-mes-alerta">{m.alertaTxt}</span>{/if}
        </button>
      {/each}
    </div>
  </div>

{:else if nivel === 'mes'}
  <div class="db-container">
    {@render cabecalho(dados.cabecalhoTitulo, dados.cabecalhoSub)}
    {#if dados.temNotas}
      <button class="btn btn-primary btn-full" style="min-height:50px" onclick={() => onBaixarZip(dados.mes)}>⬇️ Baixar ZIP ({dados.comAnexo} anexo{dados.comAnexo === 1 ? '' : 's'} + Planilha CV)</button>
    {:else}
      <div class="db-card" style="text-align:center;color:var(--text2)">Nenhuma nota neste mês.</div>
    {/if}
    {#each dados.grupos as g}
      <div class="arq-grupo">
        <div class="arq-grupo-hd"><span>{g.nome}</span><span>{g.resumoTxt}</span></div>
        <div class="arq-grade">
          {#each g.itens as n}
            {#if n.temMini}
              <button class="arq-item" onclick={() => onVer(n.id)} title={n.titulo}>
                <img src={n.miniUrl} alt="" decoding="async">
                <span class="arq-leg">{@html n.legendaHtml}</span>
                {#if n.fornHtml}<span class="arq-forn">{@html n.fornHtml}</span>{/if}
              </button>
            {:else if n.temAnexo}
              <button class="arq-item" onclick={() => onVer(n.id)} title={n.titulo}>
                <span class="arq-ico">{n.icoTxt}</span>
                <span class="arq-leg">{@html n.legendaHtml}</span>
                {#if n.fornHtml}<span class="arq-forn">{@html n.fornHtml}</span>{/if}
              </button>
            {:else}
              <div class="arq-item arq-sem" title="Sem anexo no servidor">
                <span class="arq-ico">⚠️<br><small>sem anexo</small></span>
                <span class="arq-leg">{@html n.legendaHtml}</span>
                {#if n.fornHtml}<span class="arq-forn">{@html n.fornHtml}</span>{/if}
              </div>
            {/if}
          {/each}
        </div>
      </div>
    {/each}
  </div>
{/if}
