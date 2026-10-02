<script lang="ts">
  import Card from '$lib/components/Card.svelte';
  import KpiTile from '$lib/components/KpiTile.svelte';

  // Dados fictícios — mesmo cenário de teste usado nas telas reais (Ana,
  // Paulo, Carlos), só pra ilustrar a reatividade. Nenhuma lógica financeira
  // de verdade mora aqui.
  const notas = [
    { colaborador: 'Ana Souza',    valor: 300, categoria: 'Abastecimento' },
    { colaborador: 'Ana Souza',    valor: 900, categoria: 'Hospedagem' },
    { colaborador: 'Paulo Morais', valor: 1000, categoria: 'Abastecimento' },
    { colaborador: 'Paulo Morais', valor: 150, categoria: 'Alimentação' },
    { colaborador: 'Carlos Gestor', valor: 300, categoria: 'Outros' },
  ];
  const colaboradores = ['Todos', ...new Set(notas.map(n => n.colaborador))];

  let filtro = $state('Todos');

  // Isso substitui o renderDashEquipe() de hoje: no app atual, trocar o
  // filtro chama uma função que reconstrói o HTML inteiro em string. Aqui
  // é só um valor derivado — o Svelte recalcula e redesenha sozinho só o
  // que mudou, sem precisar chamar nada manualmente.
  const filtradas = $derived(filtro === 'Todos' ? notas : notas.filter(n => n.colaborador === filtro));
  const total = $derived(filtradas.reduce((a, n) => a + n.valor, 0));
  const porPessoa = $derived(() => {
    const m = new Map<string, number>();
    filtradas.forEach(n => m.set(n.colaborador, (m.get(n.colaborador) || 0) + n.valor));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  });
  const maior = $derived(porPessoa()[0] ?? null);
  const brl = (v: number) => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
</script>

<svelte:head><title>Piloto Svelte — Petermann</title></svelte:head>

<div class="wrap">
  <header>
    <div class="eyebrow">PILOTO · NÃO É O APP DE VERDADE</div>
    <h1>Dashboard Equipe (recriado em Svelte)</h1>
    <p class="lede">Mesmos dados de teste que usei pra validar o Faturamento — só pra você ver como fica a experiência com um framework, antes de decidir se vale migrar de verdade.</p>
  </header>

  <Card title="Filtro">
    <select bind:value={filtro}>
      {#each colaboradores as c}<option value={c}>{c}</option>{/each}
    </select>
  </Card>

  <div class="grid">
    <KpiTile icon="🧮" label="Faturamento" value={brl(total)} sub="{filtradas.length} nota(s) no filtro" />
    <KpiTile icon="🏆" label="Maior gasto individual" value={maior ? brl(maior[1]) : brl(0)} sub={maior ? maior[0] : 'sem dados'} />
  </div>

  <Card title="Por colaborador">
    {#each porPessoa() as [nome, valor]}
      <div class="linha">
        <span>{nome}</span>
        <b>{brl(valor)}</b>
      </div>
    {/each}
  </Card>

  <div class="nota-tecnica">
    <b>O que este piloto mostra:</b> troque o filtro acima — os dois cartões e a lista mudam sozinhos,
    sem nenhuma função "renderDashEquipe()" pra chamar de novo. <code>Card</code> e <code>KpiTile</code>
    são componentes reutilizáveis: o mesmo bloco que aparece aqui é o que apareceria em Equipe, Painel e
    Histórico, só passando dados diferentes — mudar o visual de um KPI muda em todo lugar de uma vez.
  </div>
</div>

<style>
  .wrap { max-width: 480px; margin: 0 auto; padding: 24px 16px 60px; }
  header { margin-bottom: 18px; }
  .eyebrow { font-size: 11.5px; font-weight: 800; letter-spacing: .06em; color: var(--accent-d); text-transform: uppercase; }
  h1 { font-size: 24px; margin: 6px 0 8px; color: var(--primary-d); }
  .lede { color: var(--text2); font-size: 14.5px; margin: 0; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 14px 0; }
  select { font-size: 15px; padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); width: 100%; background: var(--surface); color: var(--text); }
  .linha { display: flex; justify-content: space-between; padding: 6px 0; border-top: 1px solid var(--border); font-size: 14.5px; }
  .linha:first-child { border-top: none; }
  .nota-tecnica { margin-top: 18px; background: var(--surface2); border: 1px dashed var(--border); border-radius: var(--radius); padding: 14px 16px; font-size: 13.5px; color: var(--text2); line-height: 1.5; }
  .nota-tecnica code { background: var(--surface); padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
</style>
