import globals from "globals";
import js from "@eslint/js";

/* 04/11/2026: os js/*.js são scripts comuns que dividem o mesmo escopo global (index.html carrega todos).
   Sem declarar o que um arquivo usa do outro, o no-undef dava mais de 600 erros falsos e escondia os reais.
   Nome novo só entra aqui se existir de verdade em outro arquivo; o que faltar aqui é bug, não ruído. */

// Definidos no topo do app.js e usados nos outros arquivos.
const doApp = [
  "$", "MESES", "PAPEL_NOME", "_at", "_selNotas", "brl", "esc", "fmtData",
  "_carregarMiniaturas", "_comprimirImagem", "_ehGestorOuAdmin", "_imagemParaIa", "_normalizarOrientacao",
  "_repasseEhRecebido", "_selNotasAtualizar", "_voltarRodape", "abrirCameraNota", "cardNotaHTML",
  "excluirRepassesDeOutro", "fmtDataBR", "garantirNotasNaLista", "irParaMesAtualEquipe", "irParaMesEquipe",
  "mostrarAviso", "mudarMesEquipe", "pedirCampos", "pedirConfirmacao", "pedirPalavra", "renderInicio",
  "selNotasBarraHTML", "setLoading", "switchView", "toast",
];
// Também do app.js, mas são `let`: os outros arquivos podem reatribuir.
const estadoDoApp = ["equipePorId", "filAno", "filMes", "notasEquipe", "repassesEquipe", "sb", "user", "viewAtual"];

const nomes = (lista, modo) => Object.fromEntries(lista.map(n => [n, modo]));

export default [
  // Bundles gerados pelo Vite a partir de svelte-*/ na raiz: não são código escrito à mão.
  { ignores: ["js/svelte-*.js"] },
  js.configs.recommended,
  {
    files: ["js/*.js", "sw.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.es2022,
        jsQR: "readonly",
        Tesseract: "readonly",
        Quagga: "readonly",
        XLSX: "readonly",
        google: "readonly",
        gapi: "readonly",
        SEFAZ: "readonly",
        NFCe: "readonly",
        NFCE: "readonly",
        OCR: "readonly",
        Recorte: "readonly",
        FotoBranca: "readonly",
        BrasilAPI: "readonly",
        GDrive: "readonly",
        DB: "readonly",
        Excel: "readonly",
        Gestor: "readonly",
        BarcodeDetector: "readonly",
        pdfjsLib: "readonly",
        // window.X publicados por api.js, frota.js e scanner.js
        API: "readonly",
        FusoBR: "readonly",
        Frota: "readonly",
        Scanner: "readonly",
        ...nomes(doApp, "readonly"),
        ...nomes(estadoDoApp, "writable"),
      }
    },
    rules: {
      // Função de topo é chamada por onclick no HTML ou por outro arquivo: só vale olhar variável local.
      "no-unused-vars": ["warn", { vars: "local", args: "none", caughtErrors: "none" }],
      "no-undef": "error",
      // builtinGlobals desligado: a declaração de verdade no app.js não pode acusar a lista acima.
      "no-redeclare": ["error", { builtinGlobals: false }],
      "no-inner-declarations": "warn",
      // Função sobe (hoisting) e variável de topo é lida depois da carga: só acusa o uso antes da hora no mesmo escopo.
      "no-use-before-define": ["warn", { functions: false, classes: true, variables: false }],
      "no-extra-semi": "warn",
      "no-unreachable": "error",
      // catch vazio é escolha do app (best-effort em cache, IndexedDB etc.).
      "no-empty": ["warn", { allowEmptyCatch: true }],
    }
  },
  {
    // O service worker roda sem window: importScripts, clients e cia. vêm do escopo dele.
    files: ["sw.js"],
    languageOptions: { globals: { ...globals.serviceworker } },
  }
];
