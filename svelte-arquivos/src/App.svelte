<script>
  /* Puramente apresentacional: recebe `nivel` + `dados` já prontos do
     main.js (que faz toda a busca/formatação, igual ao arquivos.js
     original) e só desenha. As strings com HTML embutido (alerta "sem
     anexo" em laranja, legenda com <br>/<b>) vêm prontas — {@html} nelas,
     não em dado de usuário solto. */
  let {
    nivel, dados, ano,
    onMudarAno, onAbrirColab, onAbrirFaturamento, onAbrirMes, onVoltarMeses, onVoltarColabs,
    onVer, onMoverNota = () => {}, onExcluirNota = () => {}, onBaixarZip, onTentarDeNovo, onBaixarEquipe, onBaixarPlanilhas, onBaixarPlanilhaFat, meses = [],
    onFiltro = () => {}, onCarregarAno = null, brl = v => v, onAbertas = () => {}, onBaixarRelatorio = () => {}, onMesesAbertos = () => {},
  } = $props();
  let mesEquipe = $state('');
  let busca = $state('');
  /* sem acento e sem caixa: "joao" acha "João" */
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const termo = $derived(norm(busca));
  const visiveis = $derived(dados?.colaboradores ? dados.colaboradores.filter(c => !termo || c.busca.includes(termo)) : []);
  const mostraFat = $derived(!termo || 'faturamento'.includes(termo));

  /* Lista de notas com busca, categoria e período (05/11/2026). O filtro roda aqui, sem ir ao servidor. O componente
     remonta a cada ação, então o filtro nasce do que o main.js guardou e devolve cada mudança para ele. */
  const padrao = dados?.filtroPadrao || { busca: '', cat: '', de: '', ate: '' };
  let filtro = $state({ ...padrao, ...(dados?.filtro || {}) });
  let gruposAno = $state(null);
  let erroAno = $state(false);
  const qtdTxt = q => `${q} nota${q === 1 ? '' : 's'}`;
  const soma = itens => itens.reduce((s, n) => s + n.valor, 0);
  const fTermo = $derived(norm(filtro.busca));
  const filtrando = $derived(!!fTermo || !!filtro.cat || filtro.de !== padrao.de || filtro.ate !== padrao.ate);
  const fonte = $derived(nivel === 'mes' ? dados?.grupos || [] : gruposAno || []);
  const passa = n => (!fTermo || n.busca.includes(fTermo)) && (!filtro.de || n.dataIso >= filtro.de) && (!filtro.ate || n.dataIso <= filtro.ate);
  const gruposVis = $derived.by(() => {
    const gs = fonte
      .filter(g => !filtro.cat || g.nome === filtro.cat)
      .map(g => {
        const itens = g.itens.filter(passa);
        return { nome: g.nome, itens, soma: soma(itens), resumoTxt: `${qtdTxt(itens.length)} · ${brl(soma(itens))}` };
      })
      .filter(g => g.itens.length);
    return nivel === 'mes' && dados?.recolher ? gs.sort((a, b) => b.soma - a.soma) : gs;
  });
  const achadas = $derived(gruposVis.flatMap(g => g.itens));
  const somaVis = $derived(soma(achadas));
  const pctDe = g => (somaVis > 0 ? g.soma / somaVis * 100 : 0);
  const pctTxt = g => pctDe(g).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
  /* A categoria abre pelo clique; com filtro ligado, abre sozinha para a nota não ficar escondida */
  let abertas = $state({ ...(dados?.abertas || {}) });
  let fechadasNoFiltro = $state({});   // separado: fechar antes de buscar não pode esconder a nota achada
  const estaAberta = g => (filtrando ? !fechadasNoFiltro[g.nome] : !!abertas[g.nome]);
  /* Faturamento com notas: os meses ficam atrás de um botão. Ele é o caminho para o mês, então recolhe, não some. */
  const recolheMeses = !!(nivel === 'meses' && dados?.filtro && dados.temNotas);
  let mesesAbertos = $state(!!dados?.mesesAbertos);
  const alternarMeses = () => { mesesAbertos = !mesesAbertos; onMesesAbertos(mesesAbertos); };
  const alternar = g => {
    if (filtrando) { fechadasNoFiltro = { ...fechadasNoFiltro, [g.nome]: !fechadasNoFiltro[g.nome] }; return; }
    abertas = { ...abertas, [g.nome]: !abertas[g.nome] };
    onAbertas({ ...abertas });
  };
  const totalFonte = $derived(fonte.reduce((s, g) => s + g.itens.length, 0));
  const limparFiltro = () => { filtro = { ...padrao }; fechadasNoFiltro = {}; };

  $effect(() => { if (dados?.filtro) onFiltro({ busca: filtro.busca, cat: filtro.cat, de: filtro.de, ate: filtro.ate }); });
  $effect(() => {
    if (nivel !== 'meses' || !dados?.filtro || !dados.temNotas || !onCarregarAno) return;
    onCarregarAno().then(r => { gruposAno = r.grupos; }).catch(() => { erroAno = true; });
  });
</script>

{#snippet filtros(rotulo)}
  <div class="arq-busca">
    <input type="search" bind:value={filtro.busca} placeholder="🔍 Buscar por nome do comércio" autocomplete="off" aria-label={rotulo}>
    {#if filtro.busca}<button type="button" class="arq-busca-x" onclick={() => (filtro.busca = '')} aria-label="Limpar busca">✕</button>{/if}
  </div>
  <div class="arq-filtros">
    <label class="arq-f arq-f-cat"><small>Categoria</small>
      <select bind:value={filtro.cat}>
        <option value="">Todas</option>
        {#each fonte as g}<option value={g.nome}>{g.nome}</option>{/each}
      </select>
    </label>
    <label class="arq-f"><small>De</small><input type="date" bind:value={filtro.de} min={dados.dataMin} max={dados.dataMax}></label>
    <label class="arq-f"><small>Até</small><input type="date" bind:value={filtro.ate} min={dados.dataMin} max={dados.dataMax}></label>
  </div>
{/snippet}

{#snippet achados()}
  <div class="arq-achados">
    <span>{achadas.length} de {qtdTxt(totalFonte)} · {brl(soma(achadas))}</span>
    <button type="button" class="arq-limpar" onclick={limparFiltro}>Limpar filtros</button>
  </div>
{/snippet}

{#snippet celulas(n)}
  <span class="arq-lin-data">{n.dataTxt}</span>
  <span class="arq-lin-nome">{n.nome}</span>
  <span class="arq-lin-valor">{brl(n.valor)}</span>
  <span class="arq-lin-tipo">{n.tipoTxt}</span>
{/snippet}

{#snippet linhas(g)}
      {#each g.itens as n}
        <div class="arq-lin">
          {#if n.temAnexo}
            <button class="arq-lin-abrir" onclick={() => onVer(n.id)} title={n.titulo}>{@render celulas(n)}</button>
          {:else}
            <div class="arq-lin-abrir arq-lin-sem" title="Sem anexo no servidor">{@render celulas(n)}</div>
          {/if}
          {#if dados.acoes}
            <div class="arq-acoes">
              <button class="arq-acao" onclick={() => onMoverNota(n.id)} title="Mudar a categoria desta nota" aria-label="Mudar a categoria desta nota">🔀<span class="arq-acao-txt"> Categoria</span></button>
              {#if dados.podeExcluir}<button class="arq-acao arq-acao-del" onclick={() => onExcluirNota(n.id)} title="Mandar para a lixeira" aria-label="Mandar para a lixeira">🗑</button>{/if}
            </div>
          {/if}
        </div>
      {/each}
{/snippet}

{#snippet lista(grupos)}
  {#each grupos as g}
    <div class="arq-grupo">
      <div class="arq-grupo-hd"><span>{g.nome}</span><span>{g.resumoTxt}</span></div>
      {@render linhas(g)}
    </div>
  {/each}
{/snippet}

{#snippet categorias(grupos)}
  {#each grupos as g}
    <div class="arq-grupo arq-cat">
      <button type="button" class="arq-cat-hd" aria-expanded={estaAberta(g)} onclick={() => alternar(g)}>
        <span class="arq-cat-nome">{g.nome}<span class="arq-cat-qtd">{qtdTxt(g.itens.length)}</span></span>
        <span class="arq-cat-val">{brl(g.soma)}</span>
        <span class="arq-abrir">{estaAberta(g) ? 'Fechar ▲' : 'Abrir ▼'}</span>
        <span class="arq-medida"><span class="arq-trilho"><span class="arq-barra" style="width:{Math.max(pctDe(g), 1)}%"></span></span><span class="arq-pct">{pctTxt(g)}</span></span>
      </button>
      {#if estaAberta(g)}{@render linhas(g)}{/if}
    </div>
  {/each}
{/snippet}

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
    {#if dados.colaboradores.length}
      <div class="arq-busca">
        <input type="search" bind:value={busca} placeholder="🔍 Buscar colaborador" autocomplete="off" aria-label="Buscar colaborador">
        {#if busca}<button type="button" class="arq-busca-x" onclick={() => (busca = '')} aria-label="Limpar busca">✕</button>{/if}
      </div>
    {/if}
    {#if !dados.colaboradores.length}
      <div class="db-card" style="text-align:center;color:var(--text2)">Nenhum colaborador.</div>
    {:else if termo && !visiveis.length && !(dados.faturamento && mostraFat)}
      <div class="db-card" style="text-align:center;color:var(--text2)">Nenhum colaborador com “{busca.trim()}”.</div>
    {/if}
    {#if dados.faturamento && mostraFat}
      <button class="arq-colab" onclick={onAbrirFaturamento}>
        <div class="avatar">🏢</div>
        <div class="arq-colab-txt">
          <div class="arq-colab-nome">Faturamento</div>
          <div class="arq-colab-sub">{@html dados.faturamento.sub}</div>
        </div>
        <span class="arq-seta">›</span>
      </button>
    {/if}
    {#each visiveis as c (c.userId)}
      <button class="arq-colab {c.vazio && !c.saldo ? 'arq-vazio' : ''} {c.saldo ? `arq-com-saldo sv-${c.saldo.nivel}` : ''}" onclick={() => onAbrirColab(c.userId)}>
        <div class="avatar" data-foto={c.fotoPath}>{c.iniciais}</div>
        <div class="arq-colab-txt">
          <div class="arq-colab-nome">{@html c.nomeHtml}</div>
          <div class="arq-colab-sub">{@html c.subHtml}</div>
        </div>
        {#if c.saldo}
          <div class="arq-selo"><small>{c.saldo.rotulo}</small><b>{c.saldo.valor}</b>
            <em>{#each c.saldo.partes as p, i}{i ? ' · ' : ''}{p.rotulo} {p.valor}{/each}</em>
          </div>
        {/if}
        <span class="arq-seta">›</span>
        {#if c.saldo}
          <div class="arq-saldo">
            {#each c.saldo.itens as it}
              <div><span>{it.rotulo}</span><b>{it.valor}</b></div>
            {/each}
            <div style="grid-column:1/-1"><span>Saldo do ano anterior</span><b style="white-space:normal;overflow-wrap:anywhere">{c.saldo.anterior}</b></div>
          </div>
        {/if}
      </button>
    {/each}
  </div>

{:else if nivel === 'meses'}
  <div class="db-container">
    {@render cabecalho(dados.cabecalhoTitulo, dados.cabecalhoSub)}
    {#if dados.temNotas}
      <button class="btn btn-primary btn-full" style="min-height:50px" onclick={() => onBaixarZip(null)}>⬇️ Baixar ZIP do ano {ano} ({dados.comAnexo} anexo{dados.comAnexo === 1 ? '' : 's'} + planilha)</button>
      {#if dados.ehFaturamento}
        <button class="btn btn-outline btn-full" style="min-height:50px;margin-top:8px" onclick={onBaixarPlanilhaFat}>📊 Planilha de Faturamento {ano} (Excel)</button>
      {/if}
    {/if}
    {#if recolheMeses}
      <button type="button" class="arq-ver-meses" aria-expanded={mesesAbertos} onclick={alternarMeses}>
        <span>📅 Meses de {ano}</span>
        <span class="arq-abrir">{mesesAbertos ? 'Fechar ▲' : 'Abrir ▼'}</span>
      </button>
    {/if}
    {#if !recolheMeses || mesesAbertos}
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
    {/if}
    {#if dados.filtro && dados.temNotas}
      <div class="arq-ano">
        <div class="arq-ano-tit">🔎 Buscar no ano todo</div>
        {@render filtros(`Buscar nas notas de ${ano}`)}
      </div>
      {#if erroAno}
        <div class="db-card" style="text-align:center;color:var(--danger)">Não consegui carregar as notas do ano.</div>
      {:else if filtrando && gruposAno === null}
        <div class="db-card" style="text-align:center;color:var(--text2)">Carregando as notas do ano…</div>
      {:else if filtrando}
        {@render achados()}
        {@render lista(gruposVis)}
      {/if}
    {/if}
  </div>

{:else if nivel === 'mes'}
  <div class="db-container">
    {@render cabecalho(dados.cabecalhoTitulo, dados.cabecalhoSub)}
    {#if dados.temNotas}
      {#if dados.resumo}
        <div class="arq-kpis">
          <div class="arq-kpi arq-kpi-total"><small>Total do mês</small><b>{dados.resumo.totalTxt}</b></div>
          <div class="arq-kpi"><small>Notas</small><b>{dados.resumo.qtd}</b><span class={dados.resumo.temAlerta ? 'arq-kpi-alerta' : ''}>{dados.resumo.anexoTxt}</span></div>
          <div class="arq-kpi"><small>Maior gasto</small><b>{dados.resumo.maiorPct}</b><span>{dados.resumo.maiorNome}</span></div>
        </div>
      {/if}
      {@render filtros('Buscar nas notas do mês')}
      <div class="arq-bts">
        <button class="btn btn-primary btn-full arq-bt-zip" style="min-height:50px" onclick={() => onBaixarZip(dados.mes)}>⬇️ Baixar ZIP ({dados.comAnexo} anexo{dados.comAnexo === 1 ? '' : 's'} + planilha)</button>
        {#if dados.relatorios}
          <button class="btn btn-outline btn-full" style="min-height:50px" onclick={() => onBaixarRelatorio('pdf')}>📄 Relatório PDF</button>
          <button class="btn btn-outline btn-full" style="min-height:50px" onclick={() => onBaixarRelatorio('xlsx')}>📊 Relatório Excel</button>
        {/if}
      </div>
    {:else}
      <div class="db-card" style="text-align:center;color:var(--text2)">Nenhuma nota neste mês.</div>
    {/if}
    {#if filtrando}{@render achados()}{/if}
    {#if dados.recolher}{@render categorias(gruposVis)}{:else}{@render lista(gruposVis)}{/if}
  </div>
{/if}
