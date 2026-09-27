# svelte-historico

Segunda tela migrada pro modelo de componente (Svelte) — **Histórico de alterações**. Escolhida por ser só leitura: nenhum botão de ação, nenhuma escrita no servidor, mesmo mostrando valores em R$ (que já vêm prontos do servidor, sem cálculo nenhum aqui).

Mesma estrutura do `svelte-ajuda/`: `npm run build` gera `../rda-rdm-app/js/svelte-historico.js` (IIFE, CSS injetado via JS), carregado como script normal e empacotado automaticamente pelo `publicar.sh`.

## Rebuildar depois de mexer

```bash
cd svelte-historico
npm install   # só na primeira vez / quando as dependências mudarem
npm run build
```

Depois, bumpar o `?v=NNN` de `js/svelte-historico.js` em `index.html` junto com os outros marcadores de build.

## Onde está o quê

- `src/App.svelte` — busca as 4 fontes (notas, repasses, apagadas em definitivo, troca de papel/regime), junta e ordena — é o `renderHistorico()` de antes, só que como componente.
- `src/main.js` — expõe `window.SvelteHistorico.montar(el, props)` / `.desmontar()`.

## Um detalhe que mordeu na hora de integrar

`Svelte.mount()` **anexa** ao elemento alvo, não substitui o conteúdo — diferente de `el.innerHTML = '...'` que todo `renderX()` do app faz. `renderHistorico()` em `app.js` precisa esvaziar `#app-content` (`el.innerHTML = ''`) **antes** de chamar `montar()`, senão o conteúdo da tela anterior fica por baixo. Vale lembrar disso na próxima tela que for migrada direto para `#app-content` (em vez de um mount-point próprio, como foi o caso da Ajuda).
