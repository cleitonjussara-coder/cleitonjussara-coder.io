---
name: testar-celular
description: Testa o layout do app NOTAS PM em tela de celular (320/360 px) com detector de overflow e auditoria de CSS para iOS. Use depois de mexer em CSS, cartões, grades, modais ou telas novas, ou quando o usuário disser que algo está cortado, estourando ou ruim no celular.
---

# Testar o app no celular

O app é usado em campo, no celular. Defeitos já vistos: cartão cortado pela borda (grid `1fr` + texto sem quebra) e problemas em iOS/Safari. Teste sempre que a mudança tocar layout.

## 1. Subir e abrir

`preview_start` com `{name: "app-estatico"}` (serve `rda-rdm-app/` na porta 8778). O navegador interno cacheia o `index.html`: navegue com `?r=N` (N novo a cada vez) para pegar o CSS atual.

## 2. Larguras

`resize_window` em **320** e **360** (e 390 se a mudança for ampla). Ao terminar, volte com `preset: "desktop"`.

## 3. Montar estado de teste

Defina os globais necessários (`user`, `notas`, `repasses`, `filMes`, `filAno`) e chame o render da tela alterada: `renderHome()`, `renderSaldo()`, `renderInicio()`, `renderDespesas()`; para o gestor, `Gestor.renderDashboard` com um `sb` simulado. Teste **os dois regimes** (`rdm_rda` e `cv`) e com **valores grandes** (ex.: R$ 99.999,99; nomes longos).

## 4. Detector de overflow (javascript_tool)

```js
(() => {
  const root = document.querySelector('#app-content') || document.body;
  const W = document.documentElement.clientWidth;
  const out = [];
  root.querySelectorAll('*').forEach(el => {
    if (el.closest('.db-trim-wrap')) return;           // rola de propósito
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > W + 1 || r.left < -1))
      out.push((el.id ? '#'+el.id : '') + '.' + [...el.classList].join('.') + ' right=' + Math.round(r.right));
  });
  return { W, scrollW: document.documentElement.scrollWidth, overflow: out.slice(0, 30) };
})()
```
Passou = `scrollW <= W` e lista vazia. Depois tire `screenshot` de cada tela alterada e mostre ao usuário.

## 5. Causas comuns

- `grid-template-columns: repeat(2,1fr)` → use `minmax(0,1fr)` + `min-width:0` nos filhos.
- `white-space:nowrap` / `ellipsis` em dinheiro → use `overflow-wrap:anywhere`.
- Barra de ações sem `flex-wrap`.

## 6. Auditoria iOS (Safari não é testável aqui; revise o CSS)

- Altura de tela: `100dvh` (e fallback `100vh`), nunca só `100vh`.
- Modais rolam (`overflow-y:auto`, `-webkit-overflow-scrolling:touch`, `max-height` com `dvh`).
- Sem `transform`/`filter` em painéis com `position:fixed` dentro (quebra o fixed no iOS).
- Inputs com `font-size >= 16px` (senão o Safari dá zoom).
- Respeitar `env(safe-area-inset-*)` em barras fixas (rodapé).
- Nunca `prompt`/`confirm`/`alert` nativos (usar `pedirCampos`/`pedirConfirmacao`/`mostrarAviso`).

Se houver defeito real em iPhone que a auditoria não pega, peça um print ao usuário.

## 7. Relatório

Liste larguras testadas, telas, regimes, resultado do detector e o que foi corrigido. Item conhecido e aceito: `.db-trim` (quadro trimestral) passa ~15 px a 360 px e rola na horizontal de propósito.
