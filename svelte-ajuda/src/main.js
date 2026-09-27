import { mount, unmount } from 'svelte';
import App from './App.svelte';

/* Ponte com o app vanilla (26/09/2026, primeira tela migrada sem dinheiro
   envolvido — Como usar o app). O resto do app continua chamando
   abrirAjuda()/fecharAjuda() como sempre; só o miolo dessas duas funções
   passa a falar com o Svelte em vez de fazer display:flex/none na mão. */
let instancia = null;

function montarAjuda(elementoAlvo, props) {
  if (instancia) desmontarAjuda();
  instancia = mount(App, { target: elementoAlvo, props });
}

function desmontarAjuda() {
  if (!instancia) return;
  unmount(instancia);
  instancia = null;
}

window.SvelteAjuda = { montar: montarAjuda, desmontar: desmontarAjuda };
