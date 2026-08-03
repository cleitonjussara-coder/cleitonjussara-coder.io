import globals from "globals";
import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["js/*.js", "sw.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.es2022,
        supabase: "readonly",
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
        BrasilAPI: "readonly",
        GDrive: "readonly",
        DB: "readonly",
        Excel: "readonly",
        Gestor: "readonly",
        GSheets: "readonly",
        BarcodeDetector: "readonly",
        pdfjsLib: "readonly",
      }
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "no-redeclare": "error",
      "no-inner-declarations": "warn",
      "no-use-before-define": "warn",
      "no-extra-semi": "warn",
      "no-unreachable": "error",
      "no-empty": "warn",
    }
  }
];
