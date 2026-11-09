<script>
  // Conteúdo extraído byte a byte do #ajuda-overlay .form-body original
  // (index.html) — nada foi retigitado à mão, pra não arriscar perder ou
  // errar um parágrafo de ajuda real da equipe.
  import conteudo from './ajuda-conteudo.html?raw';

  let { vejoEquipe = false, ehContador = false, veFrota = false, onFechar = () => {}, perguntar = null,
        secao = '', focar = false, atalhos = [] } = $props();

  /* Botão ❓ Ajuda do cabeçalho (09/11/2026): a ajuda abre no assunto da tela em que a pessoa está (`secao` = começo do
     título <h4>) ou, sem assunto, com a pergunta pronta para digitar. Os atalhos levam aos tópicos mais procurados. */
  let corpo;
  function irPara(trecho) {
    const t = String(trecho || '').toLowerCase();
    if (!t || !corpo) return false;
    const h = [...corpo.querySelectorAll('.ajuda-sec h4')]
      .find(x => x.offsetParent && x.textContent.toLowerCase().includes(t));
    if (!h) return false;
    h.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const sec = h.closest('.ajuda-sec') || h;
    sec.classList.remove('ajuda-destaque'); void sec.offsetWidth; sec.classList.add('ajuda-destaque');
    return true;
  }
  $effect(() => {
    const achou = secao && irPara(secao);
    if (!achou && focar) corpo?.querySelector('#ajuda-pergunta')?.focus({ preventScroll: true });
  });

  // Assistente (01/11/2026): pergunta em linguagem comum; o servidor busca na PRÓPRIA ajuda (respeitando o papel)
  // e a IA só redige a resposta. Nenhum dado de nota ou pessoa vai junto.
  let pergunta = $state('');
  let carregando = $state(false);
  let resposta = $state(null);   // { texto, fontes } | { erro }

  async function enviar(e) {
    e?.preventDefault();
    const p = pergunta.trim();
    if (p.length < 3 || carregando || !perguntar) return;
    carregando = true;
    resposta = null;
    try {
      const r = await perguntar(p);
      if (r?.resposta) resposta = { texto: r.resposta, fontes: r.fontes || [] };
      else if (r?.motivo === 'limite') resposta = { erro: 'Você chegou ao limite de perguntas de hoje. Leia a ajuda abaixo ou tente amanhã.' };
      else if (r?.motivo === 'sem_trecho') resposta = { erro: 'Não encontrei isso na ajuda. Tente outras palavras ou fale com o gestor.' };
      else resposta = { erro: 'O assistente está indisponível agora. Procure nos tópicos abaixo.', fontes: r?.fontes || [] };
    } catch (_) {
      resposta = { erro: 'Sem conexão com o servidor. Procure nos tópicos abaixo.' };
    } finally {
      carregando = false;
    }
  }
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
  <div class="form-body" bind:this={corpo} class:ve-equipe={vejoEquipe} class:ve-frota={veFrota} class:eh-contador={ehContador}>
    {#if perguntar}
      <form class="ajuda-assist" onsubmit={enviar}>
        <label for="ajuda-pergunta"><b>🤖 Pergunte ao assistente</b></label>
        <div class="ajuda-assist-linha">
          <input id="ajuda-pergunta" type="text" maxlength="400" placeholder="Escreva sua dúvida" bind:value={pergunta} autocomplete="off" />
          <button type="submit" class="btn btn-primary" disabled={carregando || pergunta.trim().length < 3}>{carregando ? '…' : 'Perguntar'}</button>
        </div>
        {#if resposta?.texto}
          <div class="ajuda-assist-resp">{resposta.texto}</div>
          {#if resposta.fontes?.length}<div class="ajuda-assist-fontes">Baseado em: {resposta.fontes.join(' · ')}</div>{/if}
        {:else if resposta?.erro}
          <div class="ajuda-assist-resp ajuda-assist-erro">{resposta.erro}</div>
        {/if}
        <div class="ajuda-assist-fontes">Respostas geradas por IA a partir deste texto de ajuda. Confira nos tópicos abaixo.</div>
      </form>
    {/if}
    {#if atalhos.length}
      <div class="ajuda-atalhos">
        <span class="ajuda-atalhos-tit">Mais procurados:</span>
        {#each atalhos as a}
          <button type="button" class="ajuda-atalho" onclick={() => irPara(a.alvo)}>{a.rot}</button>
        {/each}
      </div>
    {/if}
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
  .ajuda-assist { margin: 0 0 16px; padding: 12px; border: 1px solid var(--border, #d9d9d9); border-radius: 12px; background: var(--card, transparent); }
  .ajuda-assist-linha { display: flex; gap: 8px; margin-top: 8px; }
  .ajuda-assist-linha input { flex: 1; min-width: 0; font-size: 16px; padding: 10px; border: 1px solid var(--border, #ccc); border-radius: 10px; background: transparent; color: inherit; }
  .ajuda-assist-resp { margin-top: 10px; white-space: pre-wrap; line-height: 1.45; }
  .ajuda-assist-erro { opacity: .8; }
  .ajuda-assist-fontes { margin-top: 6px; font-size: 12px; opacity: .65; }
  .ajuda-atalhos { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: -4px 0 16px; }
  .ajuda-atalhos-tit { font-size: 14px; font-weight: 700; opacity: .75; }
  .ajuda-atalho { border: 2px solid var(--primary, #1f6b3a); background: transparent; color: var(--primary, #1f6b3a); border-radius: 999px;
    padding: 6px 14px; font: inherit; font-size: 15px; font-weight: 700; cursor: pointer; min-height: 38px; }
  .ajuda-atalho:active { transform: scale(.96); }
  .form-body :global(.ajuda-sec h4) { scroll-margin-top: 12px; }
  .form-body :global(.ajuda-destaque) { animation: ajuda-pisca 2.4s ease-out; border-radius: 12px; }
  @keyframes ajuda-pisca { 0%, 40% { box-shadow: 0 0 0 3px #b9e24a; background: rgba(185, 226, 74, .18); } 100% { box-shadow: 0 0 0 3px transparent; background: transparent; } }
</style>
