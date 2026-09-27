<script>
  // Conteúdo extraído byte a byte do #ajuda-overlay .form-body original
  // (index.html) — nada foi retigitado à mão, pra não arriscar perder ou
  // errar um parágrafo de ajuda real da equipe.
  import conteudo from './ajuda-conteudo.html?raw';

  let { vejoEquipe = false, onFechar = () => {} } = $props();
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
  <div class="form-body" class:ve-equipe={vejoEquipe}>
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
</style>
