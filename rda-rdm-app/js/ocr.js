'use strict';
/* ─────────────────────────────────────────────────────────────
   OCR.js — Tesseract.js v5 + regex para cupom fiscal
───────────────────────────────────────────────────────────── */
window.OCR = (() => {
  let worker = null;
  let ready  = false;

  async function init() {
    if (ready) return;
    worker = await Tesseract.createWorker('por', 1, {
      logger(m) {
        if (m.status === 'recognizing text') {
          const pct = Math.round(m.progress * 100);
          window.dispatchEvent(new CustomEvent('ocr-progress', { detail: pct }));
        }
      },
    });
    ready = true;
  }

  /* ─── Regex para texto fiscal ─────────────────────────── */
  function parseFiscalText(text) {
    const t = text.replace(/\r?\n/g, ' ');
    const result = { cnpj: null, valor: null, data: null };

    // CNPJ — aceita com ou sem pontuação, tolera OCR trocando / por 1
    const mc = t.match(/\d{2}\.?\d{3}\.?\d{3}[\/1]\d{4}[-]?\d{2}/);
    if (mc) result.cnpj = mc[0].replace(/\D/g, '');

    // Valor total (vários formatos de cupom)
    const valorPats = [
      /(?:TOTAL|VALOR\s*TOTAL|A\s*PAGAR|TOTAL\s*GERAL)\s*[R$:]*\s*([0-9]{1,6}[.,][0-9]{2})/i,
      /TOTAL[^\d]{0,6}([0-9]{1,6}[.,][0-9]{2})/i,
      /R\$\s*([0-9]{1,6}[.,][0-9]{2})/,
    ];
    for (const p of valorPats) {
      const m = t.match(p);
      if (m) { result.valor = parseFloat(m[1].replace(',', '.')); break; }
    }

    // Data DD/MM/AAAA
    const md = t.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
    if (md) result.data = `${md[3]}-${md[2]}-${md[1]}`;

    return result;
  }

  /* Processa um Blob/File de imagem → texto + campos extraídos */
  async function processar(blob) {
    await init();
    const { data: { text } } = await worker.recognize(blob);
    return { text, ...parseFiscalText(text) };
  }

  async function terminate() {
    if (worker) { await worker.terminate(); worker = null; ready = false; }
  }

  return { init, processar, parseFiscalText, terminate };
})();
