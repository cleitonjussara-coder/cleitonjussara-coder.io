import { mount, unmount } from 'svelte';
import App from './App.svelte';

/* Quarta tela migrada (27/09/2026) — só o TOPO do Perfil. Diferente das
   outras, o componente monta DIRETO em #app-content (não num mount-point
   próprio): existe uma regra de CSS (#app-content>.perfil-card, no
   index.html) que exige `.perfil-card` como FILHO DIRETO de #app-content
   pro centro de 1040px no desktop funcionar. Um <div> por baixo quebraria
   isso. app.js monta aqui primeiro (contentúdo entra na ordem certa) e só
   DEPOIS insere o HTML vanilla de baixo (perfil-actions) — ver README. */
let instancia = null;

function montar(elementoAlvo, props) {
  if (instancia) unmount(instancia);
  instancia = mount(App, { target: elementoAlvo, props });
}

function desmontar() {
  if (!instancia) return;
  unmount(instancia);
  instancia = null;
}

window.SveltePerfil = { montar, desmontar };
