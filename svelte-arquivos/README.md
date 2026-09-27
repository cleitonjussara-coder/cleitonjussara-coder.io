# svelte-arquivos

Terceira tela migrada — **Arquivos** (Colaborador → Ano → Mês → notas do servidor, com ZIP e visualizador de foto). Substitui `rda-rdm-app/js/arquivos.js` (apagado); o objeto público continua se chamando `window.Arquivos`, com as mesmas funções (`abrirColab`, `mudarAno`, `baixarZip`...), porque `gestor.js` chama `Arquivos.abrirColab(id)` direto e `_voltarRodape()` guarda strings como `'Arquivos.voltarColabs()'` pra avaliar depois.

Mesmo modelo de build dos outros (`svelte-ajuda/`, `svelte-historico/`): `npm run build` gera `../rda-rdm-app/js/svelte-arquivos.js`.

## Diferença de arquitetura em relação às duas primeiras telas

Ajuda e Histórico não tinham estado de navegação — Arquivos tem (colaborador/ano/mês escolhidos, cache do resumo do ano). Por isso a divisão é diferente:

- **`src/main.js`** guarda o estado (igual às variáveis de módulo do `arquivos.js` original) e faz TODA a busca/formatação — inclusive as strings com HTML embutido (`"3 sem anexo"` em laranja, legenda com `<br>/<b>`). É baixo risco de regressão porque é praticamente um copiar/colar do arquivo antigo, só trocando "monta uma string HTML gigante" por "monta um objeto de dados".
- **`src/App.svelte`** é burro de propósito: só recebe `{ nivel, dados }` prontos e desenha — 6 níveis (`offline`, `erro`, `carregando`, `colabs`, `meses`, `mes`), cada clique chama uma função `onXxx` que volta pro `main.js`, que reage e REMONTA o componente do zero (não tenta atualização parcial).

## Pegadinha nova (além do `innerHTML=''` antes de montar, já achada no Histórico)

`ver()` (abrir foto/PDF) usa o **visualizador compartilhado** do resto do app (`#foto-viewer-overlay`, em `index.html`) — não é dessa tela, é global. O componente não mexe nele diretamente: chama `onVer(id)` → `main.js` → `dep.verFotoCompartilhado(n)` → uma função nova em `app.js` (`_verArquivoCompartilhado`) que tem exatamente a lógica que estava dentro do `Arquivos.ver()` original. Se uma próxima tela também abrir fotos, é essa mesma função que ela deve chamar — não duplicar.

## Rebuildar depois de mexer

```bash
cd svelte-arquivos
npm install   # só na primeira vez
npm run build
```

Depois, bumpar o `?v=NNN` de `js/svelte-arquivos.js` em `index.html` junto com os outros marcadores.
