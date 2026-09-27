import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import path from 'path'

const dirname = import.meta.dirname

/* Build de biblioteca, igual ao svelte-ajuda/ — vira um IIFE só, direto em
   rda-rdm-app/js/, sem precisar de Node na Locaweb nem mexer no publicar.sh. */
export default defineConfig({
  plugins: [
    svelte({
      compilerOptions: { css: 'injected' },
    }),
  ],
  build: {
    outDir: path.resolve(dirname, '../rda-rdm-app/js'),
    emptyOutDir: false,
    lib: {
      entry: path.resolve(dirname, 'src/main.js'),
      name: 'SvelteHistorico',
      formats: ['iife'],
      fileName: () => 'svelte-historico.js',
    },
    rollupOptions: {
      output: { assetFileNames: 'svelte-historico.[ext]' },
    },
  },
})
