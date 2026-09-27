import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import path from 'path'

const dirname = import.meta.dirname

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
      name: 'SvelteArquivos',
      formats: ['iife'],
      fileName: () => 'svelte-arquivos.js',
    },
    rollupOptions: {
      output: { assetFileNames: 'svelte-arquivos.[ext]' },
    },
  },
})
