'use strict';
/* ─────────────────────────────────────────────────────────────
   OCR.js — Tesseract.js v5 + parser fiscal multi-estratégia
   Extrai: CNPJ, valor, data, razão social, chave NFCe, UF
───────────────────────────────────────────────────────────── */
window.OCR = (() => {
  let worker = null;
  let ready  = false;

  const _d = s => String(s||'').replace(/\D/g,'');
  const _pf = v => { const n = parseFloat(String(v||'').replace(',','.')); return isNaN(n)?null:n; };
  const UF = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB',
              'PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

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

  /* ── Parser principal ────────────────────────────────── */
  function parseFiscalText(text) {
    const raw = text || '';
    const oneLine = raw.replace(/\r?\n/g, ' ');
    const lines   = raw.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);

    const r = { cnpj:null, valor:null, data:null, razao_social:null, chave:null, uf:null };

    // 1. Chave NFCe (44 dígitos) — comum em cupons recentes
    const chaveM = oneLine.match(/\b(\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4})\b/);
    if (chaveM) {
      r.chave = _d(chaveM[1]);
      if (r.chave.length === 44) {
        r.uf   = UF_MAP_44[r.chave.slice(0,2)] || null;
        r.data = `20${r.chave.slice(2,4)}-${r.chave.slice(4,6)}-01`; // mes/ano da chave
      }
    } else {
      const chaveRaw = oneLine.match(/\b(\d{44})\b/);
      if (chaveRaw) {
        r.chave = chaveRaw[1];
        r.uf    = UF_MAP_44[r.chave.slice(0,2)] || null;
      }
    }

    // 2. CNPJ — múltiplos formatos que o OCR pode produzir
    const cnpjPats = [
      /\d{2}\.?\d{3}\.?\d{3}[\/1]\d{4}[-]?\d{2}/,     // 00.000.000/0001-00
      /CNPJ[:\s]*(\d{2}\.?\d{3}\.?\d{3}[\/1]\d{4}[-]?\d{2})/i,
      /\b(\d{2}\s?\d{3}\s?\d{3}\s?[\/1]\s?\d{4}\s?[-]?\s?\d{2})\b/,
    ];
    for (const p of cnpjPats) {
      const m = oneLine.match(p);
      if (m) { const c = _d(m[1]||m[0]); if(c.length===14){r.cnpj=c;break;} }
    }

    // 3. Razão Social — captura nome do estabelecimento
    // Padrão comum: linha antes do CNPJ, ou após "RAZAO SOCIAL",
    // ou linha com nome em maiúsculas seguido do endereço
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      // Padrão: NOME FANTASIA: ou RAZAO SOCIAL:
      const rsM = l.match(/(?:RAZ[AÃ]O\s*SOCIAL|NOME\s*(?:FANTASIA)?)[:\s]+(.{4,60})/i);
      if (rsM) { r.razao_social = rsM[1].trim(); break; }

      // Se a linha anterior tem o CNPJ, a linha 1-2 posições acima pode ser o nome
      if (i > 0 && _d(lines[i-1]).length === 14 && l.length > 4 && l.length < 60
          && !/\d{10,}/.test(l) && l.toUpperCase() === l) {
        r.razao_social = l;
        break;
      }
    }

    // 4. Valor — estratégia em cascata: TOTAL > DINHEIRO > maior valor monetário
    const valorPats = [
      /(?:TOTAL\s*(?:GERAL|DA\s*NOTA|A\s*PAGAR)?|VALOR\s*TOTAL|A\s*PAGAR)\s*[R$:\s]*([0-9]{1,7}[.,][0-9]{2})/i,
      /(?:DINHEIRO|PIX|CART[AÃ]O|D[ÉE]BITO|CR[ÉE]DITO)\s*[R$:\s]*([0-9]{1,7}[.,][0-9]{2})/i,
      /TOTAL[^\d]{0,10}([0-9]{1,7}[.,][0-9]{2})/i,
      /R\$\s*([0-9]{1,7}[.,][0-9]{2})/,
      /\b([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})\b/,
    ];
    for (const p of valorPats) {
      const m = oneLine.match(p);
      if (m) { const v = _pf(m[1]); if(v!==null && v>0){r.valor=v;break;} }
    }

    // fallback: procura maior valor monetário no texto (última ocorrência perto de TOTAL)
    if (!r.valor) {
      const allVals = [...oneLine.matchAll(/([0-9]{1,7}[.,][0-9]{2})/g)]
        .map(m => _pf(m[1])).filter(v => v !== null && v > 0 && v < 1000000);
      if (allVals.length) r.valor = Math.max(...allVals);
    }

    // 5. Data — múltiplos formatos DD/MM/AAAA, DD-MM-AAAA, DD.MM.AAAA
    const dataPats = [
      /(?:EMISS[AÃ]O|DATA|DH\s*EMISS[AÃ]O)[:\s]*(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})/i,
      /(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})\s+(\d{2}):(\d{2})/, // com hora
      /(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})/,
    ];
    for (const p of dataPats) {
      const m = oneLine.match(p);
      if (m) { r.data = `${m[3]}-${m[2]}-${m[1]}`; break; }
    }

    return r;
  }

  const UF_MAP_44 = {
    '11':'RO','12':'AC','13':'AM','14':'RR','15':'PA','16':'AP','17':'TO',
    '21':'MA','22':'PI','23':'CE','24':'RN','25':'PB','26':'PE','27':'AL',
    '28':'SE','29':'BA','31':'MG','32':'ES','33':'RJ','35':'SP',
    '41':'PR','42':'SC','43':'RS','50':'MS','51':'MT','52':'GO','53':'DF'
  };

  /* Processa um Blob/File de imagem → texto + campos extraídos */
  async function processar(blob) {
    await init();
    const { data: { text } } = await worker.recognize(blob);
    const parsed = parseFiscalText(text);
    return { text, ...parsed };
  }

  async function terminate() {
    if (worker) { await worker.terminate(); worker = null; ready = false; }
  }

  return { init, processar, parseFiscalText, terminate };
})();
