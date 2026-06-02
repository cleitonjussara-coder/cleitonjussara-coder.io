'use strict';
/* ─────────────────────────────────────────────────────────────
   NFCE.js — parser da chave de acesso de 44 dígitos
   + extração de valor da URL QR (parâmetro vNF / formato pipe)
───────────────────────────────────────────────────────────── */
window.NFCE = (() => {

  const UF_MAP = {
    '11':'RO','12':'AC','13':'AM','14':'RR','15':'PA','16':'AP','17':'TO',
    '21':'MA','22':'PI','23':'CE','24':'RN','25':'PB','26':'PE','27':'AL',
    '28':'SE','29':'BA','31':'MG','32':'ES','33':'RJ','35':'SP',
    '41':'PR','42':'SC','43':'RS','50':'MS','51':'MT','52':'GO','53':'DF'
  };

  function digits(s) { return String(s || '').replace(/\D/g, ''); }

  /* Chave de 44 dígitos → objeto com todos os campos */
  function parseChave44(raw) {
    const c = digits(raw);
    if (c.length !== 44) return null;
    return {
      chave  : c,
      cUF    : c.slice(0, 2),
      uf     : UF_MAP[c.slice(0, 2)] || c.slice(0, 2),
      ano    : 2000 + parseInt(c.slice(2, 4), 10),
      mes    : parseInt(c.slice(4, 6), 10),
      cnpj   : c.slice(6, 20),
      modelo : c.slice(20, 22),   // 65 = NFCe  |  55 = NF-e
      serie  : c.slice(22, 25),
      numero : c.slice(25, 34),
      tpEmis : c.slice(34, 35),   // 1 = normal
      cNF    : c.slice(35, 43),
      dv     : c.slice(43),
    };
  }

  /*
   * URL do QR da NFCe → { ...camposChave, valor }
   *
   * Formatos conhecidos:
   *  ?chave=44digits&cHashQRCode=...
   *  ?p=cUF|AAMM|CNPJ|mod|serie|nNF|tpEmis|cNF|cDV|dhEmi|vNF|digVal|url
   *  (GO) ?chave=44digits&p=...
   */
  function parseQRUrl(url) {
    let chave = null, valor = null, cnpj = null, data = null;
    try {
      const safe = url.startsWith('http') ? url : 'https://' + url.replace(/^\/\//, '');
      const u = new URL(safe);

      chave = u.searchParams.get('chave') || null;

      const p = u.searchParams.get('p');
      if (p) {
        const parts = p.split('|');
        if (parts.length === 1) {
          const raw = digits(parts[0]);
          if (raw.length === 44 && !chave) chave = raw;
        } else if (parts.length >= 3) {
          // formato pipe: parts[0]=cUF, parts[1]=AAMM, parts[2]=CNPJ, parts[3]=mod, ...
          // extrai CNPJ e data diretamente como fallback
          const cnpjRaw = digits(parts[2] || '');
          if (cnpjRaw.length === 14) cnpj = cnpjRaw;

          const aamm = digits(parts[1] || '');
          if (aamm.length === 4) {
            const aa = 2000 + parseInt(aamm.slice(0,2), 10);
            const mm = parseInt(aamm.slice(2), 10);
            if (mm >= 1 && mm <= 12) data = `${aa}-${String(mm).padStart(2,'0')}-01`;
          }

          // reconstrói chave dos primeiros 9 campos
          if (!chave) {
            const raw = digits(parts.slice(0, 9).join(''));
            if (raw.length === 44) chave = raw;
          }

          // vNF = índice 10
          const candidate = parts[10];
          if (candidate) {
            const v = parseFloat(digits(candidate).replace(',', '.'));
            if (!isNaN(v) && v > 0) valor = v > 99999 ? v / 100 : v;
          }
          // fallback: qualquer valor monetário no pipe
          if (!valor) {
            parts.forEach(pt => {
              const m = pt.match(/^([0-9]{1,6})[.,]([0-9]{2})$/);
              if (m) valor = parseFloat(m[1] + '.' + m[2]);
            });
          }
        }
      }

      if (!valor) {
        const vNF = u.searchParams.get('vNF') || u.searchParams.get('valor');
        if (vNF) valor = parseFloat(vNF.replace(',', '.'));
      }
    } catch (_) {
      const raw = digits(url);
      if (raw.length === 44) chave = raw;
    }

    const parsed = chave ? parseChave44(chave) : null;
    const result = parsed
      ? { ...parsed, valor: valor || parsed.valor || null }
      : { valor: valor || null };

    // enriquece com fallbacks do pipe (CNPJ e data que nao vieram da chave)
    if (cnpj && !result.cnpj) result.cnpj = cnpj;
    if (data && !result.data) result.data = data;

    return result;
  }

  /* Entrada genérica do scanner: URL ou chave pura */
  function fromScan(text) {
    if (!text) return null;
    if (text.startsWith('http') || text.includes('?') || text.includes('chave=')) {
      return parseQRUrl(text);
    }
    const raw = digits(text);
    if (raw.length === 44) return parseChave44(raw);
    // pode ser URL sem protocolo
    if (text.includes('nfce') || text.includes('sefaz')) {
      return parseQRUrl('https://' + text);
    }
    return null;
  }

  return { parseChave44, parseQRUrl, fromScan, digits };
})();
