import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import path from 'path'

const dirname = import.meta.dirname

/* Só o TOPO do Perfil (foto + nome) — a parte de baixo (Drive, backup,
   CPF, "Atualizar estrutura do banco") continua vanilla JS de propósito:
   mexe com infraestrutura de verdade (migração de banco, desconectar
   Drive), decisão de 27/09/2026 de deixar essa parte pra depois. */
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
      name: 'SveltePerfil',
      formats: ['iife'],
      fileName: () => 'svelte-perfil.js',
    },
    rollupOptions: {
      output: { assetFileNames: 'svelte-perfil.[ext]' },
    },
  },
})
