<script lang="ts">
  let { icon = '', label = '', value = '', sub = '', negative = false } = $props<{
    icon?: string; label?: string; value?: string; sub?: string; negative?: boolean;
  }>();
</script>

<!-- Equivalente ao .db-kpi / .cdet-kpi — hoje esse mesmo bloco de HTML está
     copiado em pelo menos 3 telas (Dashboard Equipe, ficha do colaborador,
     Painel). Aqui é UM componente; mudar o visual muda em todo lugar de uma
     vez, sem risco de esquecer uma tela (foi exatamente isso que aconteceu
     com o Faturamento em 26/09/2026). -->
<div class="kpi" class:negative>
  <div class="kpi-top">
    {#if icon}<span class="ico">{icon}</span>{/if}
    <span class="lbl">{label}</span>
  </div>
  <span class="val">{value}</span>
  {#if sub}<span class="sub">{sub}</span>{/if}
</div>

<style>
  .kpi {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .kpi-top { display: flex; align-items: center; gap: 6px; }
  .ico { font-size: 16px; }
  .lbl { font-size: 13px; font-weight: 700; color: var(--text2); text-transform: uppercase; letter-spacing: .02em; }
  .val { font-size: 22px; font-weight: 800; color: var(--primary-d); }
  .negative .val { color: var(--danger); }
  .sub { font-size: 12.5px; color: var(--text2); }
</style>
