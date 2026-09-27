# svelte-ajuda

Primeira tela do app migrada para um componente (Svelte) — a tela **Como usar o app**, escolhida por não envolver dinheiro nem lógica financeira.

Este projeto **não é servido sozinho**: `npm run build` compila tudo num único arquivo `../rda-rdm-app/js/svelte-ajuda.js` (IIFE, CSS injetado via JS), que o app carrega como qualquer outro `<script>`. O `scripts/publicar.sh`/`empacotar.js` na raiz do repo empacota esse arquivo automaticamente, junto com o resto de `rda-rdm-app/js/` — não precisa mexer no script de deploy.

## Rebuildar depois de mexer

```bash
cd svelte-ajuda
npm install   # só na primeira vez / quando as dependências mudarem
npm run build
```

Depois, bumpar o `?v=NNN` do `<script src="js/svelte-ajuda.js?v=NNN">` em `index.html` junto com os outros marcadores de build (`APP_BUILD` em `app.js`, `CACHE` em `sw.js`), do jeito de sempre.

## Onde está o quê

- `src/App.svelte` — o componente: reaproveita as classes CSS globais do app (`.full-overlay`, `.form-hdr`, `.ajuda-sec`...), não duplica estilo.
- `src/ajuda-conteudo.html` — o texto de ajuda em si, extraído **byte a byte** do `#ajuda-overlay` original em `index.html` (nunca foi retigitado à mão).
- `src/main.js` — expõe `window.SvelteAjuda.montar(el, props)` / `.desmontar()`, a ponte com `abrirAjuda()`/`fecharAjuda()` do `app.js`.
