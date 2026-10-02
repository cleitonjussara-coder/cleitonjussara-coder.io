<script lang="ts">
  let { title = '', children } = $props<{ title?: string; children?: any }>();
</script>

<!-- Equivalente ao .dash-card do app de produção — um componente reutilizável
     em vez de repetir a mesma string de HTML em cada tela (Equipe, Painel,
     Dashboard Equipe, Histórico...). -->
<div class="card">
  {#if title}
    <div class="card-title">{title}</div>
  {/if}
  {@render children?.()}
</div>

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 16px;
  }
  .card-title {
    font-size: 15.5px;
    font-weight: 700;
    color: var(--primary-d);
    margin-bottom: 10px;
  }
</style>
