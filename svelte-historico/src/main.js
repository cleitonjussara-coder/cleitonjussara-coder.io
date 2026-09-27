import { mount, unmount } from 'svelte';
import App from './App.svelte';

/* Ponte com o app vanilla — igual ao svelte-ajuda/. renderHistorico() em
   app.js vira só: checar o papel, checar internet, e chamar montar(). */
let instancia = null;

function montarHistorico(elementoAlvo, props) {
  if (instancia) desmontarHistorico();
  instancia = mount(App, { target: elementoAlvo, props });
}

function desmontarHistorico() {
  if (!instancia) return;
  unmount(instancia);
  instancia = null;
}

window.SvelteHistorico = { montar: montarHistorico, desmontar: desmontarHistorico };
