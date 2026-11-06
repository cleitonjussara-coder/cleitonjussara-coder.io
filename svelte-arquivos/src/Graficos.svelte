<script>
  /* Gráficos da pasta (06/11/2026). Os filtros da tela são a única seleção: tocar numa barra muda o mesmo filtro da busca,
     então gráfico, caixas de filtro e lista de notas sempre concordam. Cada gráfico ignora o próprio filtro, para a barra
     escolhida continuar à vista ao lado das outras. */
  let {
    modo, grupos, filtro, padrao, ano, mes = null, nomesCurtos = [], nomesLongos = [],
    brl = v => v, norm = s => s, onFiltrar = () => {}, onVerNotas = () => {}, onAbrirMes = () => {},
  } = $props();

  const emAno = $derived(modo === 'ano');
  const notas = $derived(grupos.flatMap(g => g.itens.map(n => ({ ...n, cat: g.nome }))));
  const termo = $derived(norm(filtro.busca));
  const porTermo = n => !termo || n.busca.includes(termo);
  const porData = n => (!filtro.de || n.dataIso >= filtro.de) && (!filtro.ate || n.dataIso <= filtro.ate);
  const porCat = n => !filtro.cat || n.cat === filtro.cat;
  const soma = ns => ns.reduce((s, n) => s + n.valor, 0);
  const pct = (v, total) => (total > 0 ? (v / total * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%' : '—');
  const notasTxt = q => `${q} nota${q === 1 ? '' : 's'}`;
  const semPrefixo = nome => nome.replace('RDM · ', '');
  const dois = n => String(n).padStart(2, '0');
  const dataBr = iso => iso.slice(0, 10).split('-').reverse().join('/');

  /* Um balde por mês do ano, ou por dia do mês */
  const baldes = $derived.by(() => {
    const ns = notas.filter(n => porCat(n) && porTermo(n));
    const lista = [];
    if (emAno) {
      for (let m = 1; m <= 12; m++) {
        const de = `${ano}-${dois(m)}-01`;
        lista.push({ chave: de.slice(0, 7), mes: m, rotulo: nomesCurtos[m - 1], longo: nomesLongos[m - 1], de, ate: `${ano}-${dois(m)}-${dois(new Date(ano, m, 0).getDate())}`, eixo: true });
      }
    } else {
      const dias = new Date(ano, mes, 0).getDate();
      for (let d = 1; d <= dias; d++) {
        const dia = `${ano}-${dois(mes)}-${dois(d)}`;
        lista.push({ chave: dia, rotulo: String(d), longo: dataBr(dia), de: dia, ate: dia, eixo: d === 1 || d % 5 === 0 });
      }
    }
    const tam = emAno ? 7 : 10;
    return lista.map(b => {
      const dentro = ns.filter(n => n.dataIso.slice(0, tam) === b.chave);
      return { ...b, valor: soma(dentro), qtd: dentro.length };
    });
  });
  const totalBaldes = $derived(baldes.reduce((s, b) => s + b.valor, 0));
  const comGasto = $derived(baldes.filter(b => b.valor > 0));
  const media = $derived(comGasto.length ? totalBaldes / comGasto.length : 0);
  const maiorBalde = $derived(comGasto.length ? comGasto.reduce((a, b) => (b.valor > a.valor ? b : a)) : null);

  /* Eixo em números redondos: três degraus de 1, 2, 2,5 ou 5 vezes uma potência de dez */
  const escala = $derived.by(() => {
    const max = maiorBalde?.valor || 0;
    if (!max) return { topo: 1, marcas: [] };
    const bruto = max / 3;
    const base = 10 ** Math.floor(Math.log10(bruto));
    const passo = [1, 2, 2.5, 5, 10].map(f => f * base).find(p => p >= bruto);
    const topo = Math.ceil(max / passo) * passo;
    const marcas = [];
    for (let v = passo; v <= topo + passo / 2; v += passo) marcas.push(v);
    return { topo, marcas };
  });
  const curto = v => (v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : v.toLocaleString('pt-BR', { maximumFractionDigits: 0 }));
  const alturaPct = v => v / escala.topo * 100;

  const temData = $derived(filtro.de !== padrao.de || filtro.ate !== padrao.ate);
  const baldeExato = $derived(baldes.find(b => b.de === filtro.de && b.ate === filtro.ate) || null);
  const noPeriodo = b => !temData || ((!filtro.ate || b.de <= filtro.ate) && (!filtro.de || b.ate >= filtro.de));
  const escolherBalde = b => onFiltrar(baldeExato?.chave === b.chave ? { de: padrao.de, ate: padrao.ate } : { de: b.de, ate: b.ate });

  const categorias = $derived.by(() => {
    const ns = notas.filter(n => porData(n) && porTermo(n));
    const mapa = new Map();
    ns.forEach(n => {
      const c = mapa.get(n.cat) || { chave: n.cat, nome: semPrefixo(n.cat), valor: 0, qtd: 0 };
      c.valor += n.valor; c.qtd += 1;
      mapa.set(n.cat, c);
    });
    return [...mapa.values()].sort((a, b) => b.valor - a.valor);
  });

  const LIMITE = 6;
  const comercios = $derived.by(() => {
    const mapa = new Map();
    notas.filter(n => porData(n) && porCat(n) && n.razao).forEach(n => {
      const chave = norm(n.razao);
      const c = mapa.get(chave) || { chave, nome: n.razao, valor: 0, qtd: 0 };
      c.valor += n.valor; c.qtd += 1;
      mapa.set(chave, c);
    });
    return [...mapa.values()].sort((a, b) => b.valor - a.valor);
  });
  const topComercios = $derived(comercios.slice(0, LIMITE));

  /* Soma do que está selecionado, com todos os filtros juntos */
  const selecao = $derived(notas.filter(n => porData(n) && porCat(n) && porTermo(n)));
  const totalGeral = $derived(soma(notas));
  const temFiltro = $derived(temData || !!filtro.cat || !!termo);
  const seloPartes = $derived([
    baldeExato ? baldeExato.longo : temData ? `${filtro.de ? dataBr(filtro.de) : 'início'} a ${filtro.ate ? dataBr(filtro.ate) : 'fim'}` : '',
    filtro.cat ? semPrefixo(filtro.cat) : '',
    termo ? filtro.busca.trim() : '',
  ].filter(Boolean).join(' · '));
  /* Variação sobre o mês anterior, na mesma categoria e comércio. Só informa: gastar mais não é bom nem ruim por si. */
  const variacao = $derived.by(() => {
    if (!emAno || !baldeExato || baldeExato.mes === 1) return '';
    const antes = baldes[baldeExato.mes - 2];
    if (!antes.valor) return '';
    const d = (baldeExato.valor - antes.valor) / antes.valor * 100;
    return `${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% sobre ${antes.rotulo}`;
  });

  /* Dica só para mouse e teclado. No toque, o quadro de cima já mostra o valor da barra tocada. */
  let plot = $state(null);
  let dica = $state(null);
  const mostrarDica = (b, el) => {
    const meio = el.offsetLeft + el.offsetWidth / 2;
    dica = { b, x: Math.min(Math.max(meio, 84), plot.clientWidth - 84) };
  };
  const aoEntrar = (e, b) => { if (e.pointerType === 'mouse') mostrarDica(b, e.currentTarget); };
  const aoFocar = (e, b) => { if (e.currentTarget.matches(':focus-visible')) mostrarDica(b, e.currentTarget); };
  const esconderDica = () => { dica = null; };

  let verTabela = $state(false);
</script>

{#snippet ranking(linhas, total, ativo, escolher)}
  {@const maior = linhas[0]?.valor || 0}
  <div class="arq-g-lista">
    {#each linhas as l (l.chave)}
      <button type="button" class="arq-g-lin {ativo(l) ? 'on' : ''} {linhas.some(ativo) && !ativo(l) ? 'apagada' : ''}" aria-pressed={ativo(l)} onclick={() => escolher(l)}>
        <span class="arq-g-nome">{ativo(l) ? '✓ ' : ''}{l.nome}</span>
        <span class="arq-g-val">{brl(l.valor)}</span>
        <span class="arq-g-trilho"><span class="arq-g-barra" style="width:{maior > 0 ? Math.max(l.valor / maior * 100, 1) : 0}%"></span></span>
        <span class="arq-g-pct">{pct(l.valor, total)}</span>
      </button>
    {/each}
  </div>
{/snippet}

<div class="arq-graficos">
  <div class="arq-g-selecao" aria-live="polite">
    {#if temFiltro}
      <div class="arq-g-sel-txt">
        <small>{seloPartes}</small>
        <b>{brl(soma(selecao))}</b>
        <span>{notasTxt(selecao.length)} · {pct(soma(selecao), totalGeral)} do {emAno ? 'ano' : 'mês'}{variacao ? ` · ${variacao}` : ''}</span>
      </div>
      <div class="arq-g-sel-bts">
        {#if selecao.length}<button type="button" class="arq-limpar" onclick={onVerNotas}>Ver as notas ↓</button>{/if}
        {#if emAno && baldeExato}<button type="button" class="arq-limpar" onclick={() => onAbrirMes(baldeExato.mes)}>Abrir {baldeExato.longo}</button>{/if}
        <button type="button" class="arq-limpar" onclick={() => onFiltrar({ ...padrao })}>Limpar</button>
      </div>
    {:else}
      <span class="arq-g-dica">Toque numa barra para filtrar. As notas aparecem abaixo.</span>
    {/if}
  </div>

  <section class="arq-g-card">
    <div class="arq-g-hd">
      <h3>{emAno ? 'Gasto por mês' : 'Gasto por dia'}</h3>
      <button type="button" class="arq-g-link" aria-expanded={verTabela} onclick={() => (verTabela = !verTabela)}>{verTabela ? 'Ver gráfico' : 'Ver tabela'}</button>
    </div>
    {#if verTabela}
      <table class="arq-g-tabela">
        <thead><tr><th>{emAno ? 'Mês' : 'Dia'}</th><th>Notas</th><th>Valor</th><th>%</th></tr></thead>
        <tbody>
          {#each comGasto as b (b.chave)}
            <tr><td>{b.longo}</td><td>{b.qtd}</td><td>{brl(b.valor)}</td><td>{pct(b.valor, totalBaldes)}</td></tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <div class="arq-g-plot" bind:this={plot} onpointerleave={esconderDica}>
        <div class="arq-g-eixo" style="bottom:0"><span>0</span></div>
        {#each escala.marcas as v}
          <div class="arq-g-eixo" style="bottom:{alturaPct(v)}%"><span>{curto(v)}</span></div>
        {/each}
        {#each baldes as b (b.chave)}
          <button
            type="button"
            class="arq-g-col {noPeriodo(b) ? '' : 'apagada'}"
            disabled={!b.qtd}
            aria-pressed={!!baldeExato && baldeExato.chave === b.chave}
            aria-label="{b.longo}: {brl(b.valor)}, {notasTxt(b.qtd)}"
            onclick={() => escolherBalde(b)}
            onpointerenter={e => aoEntrar(e, b)}
            onfocus={e => aoFocar(e, b)}
            onblur={esconderDica}
          >
            <span class="arq-g-coluna" style="height:{b.valor > 0 ? `max(${alturaPct(b.valor)}%, 2px)` : '0'}"></span>
            {#if b.eixo}<span class="arq-g-rot">{b.rotulo}</span>{/if}
          </button>
        {/each}
        {#if comGasto.length > 1}<div class="arq-g-media" style="bottom:{alturaPct(media)}%"></div>{/if}
        {#if dica}
          <div class="arq-g-dica-flut" style="left:{dica.x}px">
            <b>{brl(dica.b.valor)}</b>
            <span>{dica.b.longo} · {notasTxt(dica.b.qtd)}</span>
            <span>{pct(dica.b.valor, totalBaldes)} do {emAno ? 'ano' : 'mês'}</span>
          </div>
        {/if}
      </div>
      {#if comGasto.length}
        <div class="arq-g-pe">
          {#if comGasto.length > 1}<span><i class="arq-g-traco"></i>Média {brl(media)} por {emAno ? 'mês' : 'dia'} com gasto</span>{/if}
          {#if maiorBalde}<span>Maior: {maiorBalde.longo}, {brl(maiorBalde.valor)}</span>{/if}
        </div>
      {:else}
        <div class="arq-g-pe"><span>Nada neste filtro.</span></div>
      {/if}
    {/if}
  </section>

  <div class="arq-g-duplo">
    {#if emAno}
      <section class="arq-g-card">
        <div class="arq-g-hd"><h3>Por categoria</h3></div>
        {#if categorias.length}
          {@render ranking(categorias, soma(notas.filter(n => porData(n) && porTermo(n))), l => l.chave === filtro.cat, l => onFiltrar({ cat: l.chave === filtro.cat ? '' : l.chave }))}
        {:else}<div class="arq-g-pe"><span>Nada neste filtro.</span></div>{/if}
      </section>
    {/if}
    <section class="arq-g-card">
      <div class="arq-g-hd">
        <h3>Maiores comércios</h3>
        {#if comercios.length > LIMITE}<span class="arq-g-conta">{LIMITE} de {comercios.length}</span>{/if}
      </div>
      {#if topComercios.length}
        {@render ranking(topComercios, soma(notas.filter(n => porData(n) && porCat(n))), l => l.chave === termo, l => onFiltrar({ busca: l.chave === termo ? '' : l.nome }))}
      {:else}<div class="arq-g-pe"><span>Nada neste filtro.</span></div>{/if}
    </section>
  </div>
</div>
