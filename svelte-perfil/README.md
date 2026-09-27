# svelte-perfil

Quarta tela migrada — só o **topo do Perfil** (avatar/foto + nome). Decisão de 27/09/2026: a parte de baixo (Google Drive, armazenamento do servidor, backup, CPF, "Atualizar estrutura do banco") **continua vanilla JS**, de propósito — mexe com infraestrutura de verdade (roda migração no servidor, desconecta o Drive do backup), e o Cleiton preferiu deixar essa parte pra quando o padrão de migração estiver ainda mais maduro.

Mesmo modelo de build dos outros (`svelte-ajuda/`, `svelte-historico/`, `svelte-arquivos/`): `npm run build` gera `../rda-rdm-app/js/svelte-perfil.js`.

## A pegadinha desta vez: filho direto de `#app-content`

Existe uma regra de CSS em `index.html`:
```css
#app-content>.perfil-card, #app-content>.perfil-form { max-width:1040px; margin:auto }
```
Ela exige que `.perfil-card`/`.perfil-form` sejam **filhos diretos** de `#app-content` — é o que centraliza a tela no desktop. Se eu montasse o componente dentro de um `<div id="perfil-topo-mount">` (como fiz nas telas anteriores), `.perfil-card` viraria NETO de `#app-content`, e a regra pararia de bater.

Solução: `renderPerfil()` em `app.js` monta o Svelte **direto em `#app-content`** (que começa só com o `.page-hd`), e SÓ DEPOIS insere o HTML vanilla de baixo com `el.insertAdjacentHTML('beforeend', ...)` — preserva a ordem e o nível de aninhamento originais. `Svelte.mount()` sempre *anexa*, nunca substitui, então isso funciona sem conflito.

## Onde está o quê

- `src/App.svelte` — avatar (com `id="perfil-avatar"`, que `_mostrarAvatar()` em `app.js` continua preenchendo com a foto de verdade depois, por fora do Svelte — é busca assíncrona de URL assinada, não precisa ser reativa aqui), botões de foto, nome, e-mail, papel, campo de nome + Salvar.
- `src/main.js` — só `montar`/`desmontar`; sem estado de navegação (diferente do `svelte-arquivos/`), porque esta tela não tem níveis — é montar uma vez e pronto.
- As funções que os botões chamam (`enviarFotoPerfil`, `removerFotoPerfil`, `salvarPerfil`) **já eram globais** em `app.js` antes da migração — não precisaram de nenhuma ponte nova, só virar props (`onEnviarFoto`, `onRemoverFoto`, `onSalvarPerfil`).

## Rebuildar depois de mexer

```bash
cd svelte-perfil
npm install   # só na primeira vez
npm run build
```

Depois, bumpar o `?v=NNN` de `js/svelte-perfil.js` em `index.html` junto com os outros marcadores.

## Achado à parte (não mexi nisso)

O campo "Seu CPF" só aparece pra gestor/admin (fica dentro do mesmo bloco condicional do backup) — mas o texto de ajuda do app diz que é **qualquer colaborador** que devia poder cadastrar o próprio CPF (é uma exceção pessoal, pra nota que sai no CPF de quem lançou). Parece um descompasso antigo, de antes desta migração — mantive o comportamento exatamente como estava, só sinalizando aqui.
