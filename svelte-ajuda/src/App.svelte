<script>
  // Conteúdo extraído byte a byte do #ajuda-overlay .form-body original
  // (index.html) — nada foi retigitado à mão, pra não arriscar perder ou
  // errar um parágrafo de ajuda real da equipe.
  import conteudo from './ajuda-conteudo.html?raw';

  let { vejoEquipe = false, ehContador = false, veFrota = false, onFechar = () => {} } = $props();
</script>

<!-- Reaproveita as MESMAS classes globais do app (full-overlay, form-hdr,
     btn-voltar, form-body, ajuda-sec...) já definidas no <style> do
     index.html — não duplica nada de CSS aqui, só o necessário pra
     reatividade do papel gestor/admin. -->
<div class="full-overlay" style="display:flex">
  <div class="form-hdr">
    <button class="btn-voltar" aria-label="Voltar" onclick={onFechar}>‹ Voltar</button>
    <h3>Como usar o app</h3>
  </div>
  <div class="form-body" class:ve-equipe={vejoEquipe} class:ve-frota={veFrota} class:eh-contador={ehContador}>
    {@html conteudo}
  </div>
</div>

<style>
  /* Antes: app.js fazia
       document.querySelectorAll('.ajuda-gestor').forEach(e => e.style.display = ...)
     toda vez que a Ajuda abria — uma varredura imperativa do DOM. Aqui é
     reativo: o prop `vejoEquipe` muda a classe do container, e o CSS decide. */
  .form-body :global(.ajuda-gestor) { display: none; }
  .form-body.ve-equipe :global(.ajuda-gestor) { display: block; }
  /* Frota / KM (21/10/2026): todos usam o módulo, menos o Contador (veFrota = _veFrota() do app); os parágrafos
     marcados ajuda-gestor dentro da seção (ranking, cadastro de veículos) continuam só do gestor. */
  .form-body :global(.ajuda-frota) { display: none; }
  .form-body.ve-equipe :global(.ajuda-frota),
  .form-body.ve-frota :global(.ajuda-frota) { display: block; }
  /* Contador (14/10/2026): não lança nem gerencia — vê só o que é dele (seções marcadas
     ajuda-contador) e a seção própria; o guia de lançar nota e repasse some. */
  .form-body :global(.ajuda-so-contador) { display: none; }
  .form-body.eh-contador :global(.ajuda-sec) { display: none; }
  .form-body.eh-contador :global(.ajuda-sec.ajuda-contador),
  .form-body.eh-contador :global(.ajuda-sec.ajuda-so-contador),
  .form-body.eh-contador :global(p.ajuda-contador) { display: block; }
</style>
