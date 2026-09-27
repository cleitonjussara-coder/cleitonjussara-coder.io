import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import path from 'path'

const dirname = import.meta.dirname

/* Build de BIBLIOTECA (não é um app com index.html próprio): o resultado é
   um único IIFE que o rda-rdm-app carrega como qualquer outro <script>
   (js/svelte-ajuda.js?v=NNN), igual ao resto do app.js/gestor.js/etc. Vai
   direto pra pasta js/ do app de verdade — o publicar.sh empacota tudo que
   estiver lá dentro, sem precisar mexer no script de deploy. */
export default defineConfig({
  plugins: [
    svelte({
      compilerOptions: {
        // injeta o CSS de cada componente via JS, em vez de gerar um .css
        // separado — assim um script só resolve tudo (HTML/CSS/JS).
        css: 'injected',
      },
    }),
  ],
  build: {
    outDir: path.resolve(dirname, '../rda-rdm-app/js'),
    emptyOutDir: false,   // não pode apagar o resto de js/ do app de verdade
    lib: {
      entry: path.resolve(dirname, 'src/main.js'),
      name: 'SvelteAjuda',
      formats: ['iife'],
      fileName: () => 'svelte-ajuda.js',
    },
    rollupOptions: {
      output: {
        // um arquivo só, sem hash no nome — o app versiona com ?v=NNN
        assetFileNames: 'svelte-ajuda.[ext]',
      },
    },
  },
})
