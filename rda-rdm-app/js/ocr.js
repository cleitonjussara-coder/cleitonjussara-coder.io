'use strict';
/* ─────────────────────────────────────────────────────────────
   OCR.js — Tesseract.js v5 + pré-processamento IA + parser fiscal
   Melhorias de performance:
     • Redimensionamento automático (max 1200px) — reduz em 60-80% o tempo
     • Grayscale + contraste adaptativo via canvas
     • PSM 6 (bloco único) — mais rápido que o padrão PSM 3
     • Worker pré-carregado em background
   Extrai: CNPJ, valor, data, razão social, chave NFCe, UF
───────────────────────────────────────────────────────────── */
window.OCR = (() => {
  let worker = null;
  let ready  = false;

  const _d = s => String(s||'').replace(/\D/g,'');
  const _pf = v => { const n = parseFloat(String(v||'').replace(/\.(?=\d{3}(?!\d))/g,'').replace(',','.')); return isNaN(n)?null:n; };

  /* ── Pré-processamento de imagem (canvas) ────────────── */
  function preprocessImage(blob, maxW = 1200) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.width, h = img.height;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        const c  = document.createElement('canvas');
        c.width  = w;
        c.height = h;
        const ctx = c.getContext('2d');
        // redimensiona
        ctx.drawImage(img, 0, 0, w, h);
        // grayscale + contraste
        const idata = ctx.getImageData(0, 0, w, h);
        const d = idata.data;
        for (let i = 0; i < d.length; i += 4) {
          const gray = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
          // contraste adaptativo: estica histograma simples
          const boosted = Math.min(255, Math.max(0, (gray - 40) * 1.4));
          d[i] = d[i+1] = d[i+2] = boosted;
        }
        ctx.putImageData(idata, 0, 0);
        c.toBlob(resolve, 'image/jpeg', 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Falha ao carregar imagem')); };
      img.src = url;
    });
  }

  /* ── Inicialização do worker Tesseract ────────────────── */
  let _tesseractLoaded = false;

  async function _ensureTesseract() {
    if (typeof Tesseract !== 'undefined') { _tesseractLoaded = true; return; }
    if (_tesseractLoaded) return;
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      /* versão FIXA (era @5): o jsDelivr serve versão exata com cache de 1 ano, então o que foi
         baixado uma vez sobrevive offline — importa agora que a IA lê primeiro e o Tesseract é reserva */
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      const tid = setTimeout(() => { s.remove(); rej(new Error('Tesseract.js demorou demais para carregar')); }, 25000);
      s.onload  = () => { clearTimeout(tid); _tesseractLoaded = true; res(); };
      s.onerror = () => { clearTimeout(tid); rej(new Error('Falha ao carregar Tesseract.js')); };
      document.head.appendChild(s);
    });
  }

  /* Uma Promise compartilhada: quem chama init() enquanto outro já está iniciando espera a MESMA
     inicialização — e, se ela falhar, todos recebem o erro (antes, o 2º chamador ficava girando para sempre). */
  let _initP = null;
  function init() {
    if (ready) return Promise.resolve();
    return _initP || (_initP = (async () => {
      try {
        await _ensureTesseract();
        worker = await Tesseract.createWorker('por', 1, {
          logger(m) {
            if (m.status === 'recognizing text') {
              const pct = Math.round(m.progress * 100);
              window.dispatchEvent(new CustomEvent('ocr-progress', { detail: pct }));
            }
          },
          errorHandler(e) { console.warn('OCR warn:', e); },
        });
        // PSM 6 = bloco uniforme de texto (cupom fiscal) — mais rápido que PSM 3
        await worker.setParameters({
          tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
          // desabilita dicionários para acelerar (cupons têm muitos números)
          load_system_dawg: 'F',
          load_freq_dawg: 'F',
        });
        ready = true;
      } finally { _initP = null; }
    })());
  }

  /* ── Parser principal ────────────────────────────────── */
  function parseFiscalText(text) {
    const raw = text || '';
    const oneLine = raw.replace(/\r?\n/g, ' ');
    const lines   = raw.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);

    const r = { cnpj:null, valor:null, data:null, razao_social:null, chave:null, uf:null, numero:null, serie:null };

    /* 0. Número e série impressos — cupom ("Nº 123456 Série 1", "NFC-e nº"),
       DANFE ("Nº 000.001.234  SÉRIE 001") e NFS-e ("Número da NFS-e: 2026123").
       Quando há chave de 44 dígitos o app prefere o que está nela. */
    const numPats = [
      /N[úu]mero\s+da\s+NFS-?e[:\s]*([0-9.]{1,14})/i,
      /NFS-?e\s*n[º°o.]?\s*[:\s]*([0-9.]{1,14})/i,
      /(?<!Lei\s)N[º°]\s*[:.]?\s*([0-9]{1,3}(?:\.[0-9]{3}){1,2}|[0-9]{3,9})\b/i,   // "Lei n° 12.741/2012" (tributos, rodapé de DANFSe/cupom) não é número de nota
      /N[úu]mero\s*[:.]?\s*([0-9]{3,9})\b/i,
      /NFC-?e\s*n[º°o.]?\s*[:\s]*([0-9]{3,9})\b/i,
    ];
    /* Chave de NFS-e nacional (50 dígitos) impressa: o número da nota está nela (posições 24-36) e vale mais que qualquer "nº" solto. */
    /* O OCR costuma separar os dígitos em grupos ("3170 2062 …"): aceita 50 dígitos com espaço simples entre eles e confere a estrutura. */
    const k50 = (() => {
      for (const m of oneLine.matchAll(/(?<!\d)((?:\d ?){49}\d)(?!\d)/g)) {
        const c = m[1].replace(/\D/g, '');
        const uf = c.slice(0, 2), mes = +c.slice(38, 40);
        if (c.length === 50 && /^[12]$/.test(c.slice(8, 9)) && /^(1[1-7]|2[1-9]|3[1-3]|35|4[1-3]|5[0-3])$/.test(uf) && mes >= 1 && mes <= 12) return [m[0], c];
      }
      return null;
    })();
    if (k50) { r.chaveNfse = k50[1]; const n = String(parseInt(k50[1].slice(23, 36), 10)); if (n !== 'NaN' && n !== '0') r.numero = n; }
    for (const p of r.numero ? [] : numPats) {
      const m = oneLine.match(p);
      if (m) { const n = _d(m[1]).replace(/^0+/, ''); if (n) { r.numero = n; break; } }
    }
    const ms = oneLine.match(/S[ée]rie\s*[:.]?\s*([0-9]{1,3})\b/i);
    if (ms) r.serie = ms[1].replace(/^0+/, '') || '0';

    // 1. Chave NFCe (44 dígitos)
    const chaveM = oneLine.match(/\b(\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4})\b/);
    if (chaveM) {
      r.chave = _d(chaveM[1]);
      if (r.chave.length === 44) {
        r.uf   = UF_MAP_44[r.chave.slice(0,2)] || null;
        r.data = `20${r.chave.slice(2,4)}-${r.chave.slice(4,6)}-01`;
      }
    } else {
      const chaveRaw = oneLine.match(/\b(\d{44})\b/);
      if (chaveRaw) {
        r.chave = chaveRaw[1];
        r.uf    = UF_MAP_44[r.chave.slice(0,2)] || null;
      }
    }

    /* chave de NFS-e (50) com espaços: os 44 primeiros dígitos NÃO são chave de NF-e (inventariam CNPJ/UF/mês falsos) */
    if (r.chaveNfse) { r.chave = null; r.uf = null; r.data = null; }

    // 2. CNPJ
    const cnpjPats = [
      /\d{2}\.?\d{3}\.?\d{3}[/1]\d{4}[-]?\d{2}/,
      /CNPJ[:\s]*(\d{2}\.?\d{3}\.?\d{3}[/1]\d{4}[-]?\d{2})/i,
      /\b(\d{2}\s?\d{3}\s?\d{3}\s?[/1]\s?\d{4}\s?[-]?\s?\d{2})\b/,
    ];
    for (const p of cnpjPats) {
      const g = new RegExp(p.source, p.flags.replace('g','') + 'g');
      for (const m of oneLine.matchAll(g)) {
        const c = _d(m[1]||m[0]);
        if (c.length===14) { r.cnpj=c; break; }
      }
      if (r.cnpj) break;
    }

    // 3. Razão Social
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      const rsM = l.match(/(?:RAZ[AÃ]O\s*SOCIAL|NOME\s*(?:FANTASIA)?)[:\s]+(.{4,60})/i);
      if (rsM) { r.razao_social = rsM[1].trim(); break; }
      if (i > 0 && _d(lines[i-1]).length === 14 && l.length > 4 && l.length < 60
          && !/\d{10,}/.test(l) && !/N[ÚU]MERO|CHAVE|DATA|COMPET|S[ÉE]RIE/.test(l) && l.toUpperCase() === l) {
        r.razao_social = l;
        break;
      }
    }

    // 4. Valor — cascata
    const valorPats = [
      /VALOR\s+DA\s+OPERA\S*\s*\/?\s*SERVI\S*[\s\S]{0,160}?R\$\s*(\d{1,3}(?:\.\d{3})+,\d{2}|[0-9]{1,7}[.,][0-9]{2})/i,   // NFS-e: o valor do serviço
      /(?:TOTAL\s*(?:GERAL|DA\s*NOTA|A\s*PAGAR)?|VALOR\s*TOTAL|A\s*PAGAR)\s*[R$:\s]*(\d{1,3}(?:\.\d{3})+,\d{2}|[0-9]{1,7}[.,][0-9]{2})/i,
      /(?:DINHEIRO|PIX|CART[AÃ]O|D[ÉE]BITO|CR[ÉE]DITO)\s*[R$:\s]*(\d{1,3}(?:\.\d{3})+,\d{2}|[0-9]{1,7}[.,][0-9]{2})/i,
      /TOTAL[^\d]{0,10}(\d{1,3}(?:\.\d{3})+,\d{2}|[0-9]{1,7}[.,][0-9]{2})/i,
      /R\$\s*(\d{1,3}(?:\.\d{3})+,\d{2}|[0-9]{1,7}[.,][0-9]{2})/,
      /\b([0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2})\b/,
    ];
    for (const p of valorPats) {
      const m = oneLine.match(p);
      if (m) { const v = _pf(m[1]); if(v!==null && v>0){r.valor=v;break;} }
    }
    if (!r.valor) {
      const allVals = [...oneLine.matchAll(/([0-9]{1,7}[.,][0-9]{2})/g)]
        .map(m => _pf(m[1])).filter(v => v !== null && v > 0 && v < 1000000);
      if (allVals.length) r.valor = Math.max(...allVals);
    }

    // 5. Data
    const dataPats = [
      /(?:EMISS[AÃ]O|DATA|DH\s*EMISS[AÃ]O)[:\s]*(\d{2})[/\-.](\d{2})[/\-.](\d{4})/i,
      /(\d{2})[/\-.](\d{2})[/\-.](\d{4})\s+(\d{2}):(\d{2})/,
      /(\d{2})[/\-.](\d{2})[/\-.](\d{4})/,
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

  /* Processa Blob → imagem pré-processada → OCR rápido → parsing */
  async function processar(blob) {
    await init();
    const processed = await preprocessImage(blob);
    const { data: { text } } = await worker.recognize(processed);
    const parsed = parseFiscalText(text);
    return { text, ...parsed };
  }

  /* Pontua quanto texto LEGÍVEL há na imagem (08/10/2026): soma as letras
     e números das palavras que o Tesseract leu com confiança. A mesma foto
     de cabeça para baixo ou de lado dá quase zero — é assim que o app
     descobre a posição certa de uma nota sem QR Code. */
  async function pontuarLeitura(blob) {
    await init();
    const processed = await preprocessImage(blob, 1000);
    const { data } = await worker.recognize(processed, {}, { text: true, blocks: true });
    let palavras = Array.isArray(data?.words) ? data.words : null;
    if (!palavras && Array.isArray(data?.blocks)) {            // v6+: palavras dentro dos blocos
      palavras = [];
      for (const b of data.blocks) for (const p of b.paragraphs || []) for (const l of p.lines || []) palavras.push(...(l.words || []));
    }
    if (palavras) {
      let s = 0;
      for (const w of palavras) {
        if ((w.confidence || 0) >= 60) s += (String(w.text || '').match(/[0-9A-Za-zÀ-ÿ]/g) || []).length;
      }
      return s;
    }
    return ((data?.confidence || 0) / 100) * String(data?.text || '').replace(/[^0-9A-Za-zÀ-ÿ]/g, '').length;
  }

  /* ── Odômetro (09/10/2026) ─────────────────────────────────
     Recebe o recorte só do número do painel. Painel de carro tem dígito de
     LCD claro sobre fundo escuro (ou o contrário), então o recorte vai ao
     Tesseract em quatro versões — tons de cinza esticados, binarizada, e as
     duas invertidas — só com dígitos permitidos e uma linha de texto. O
     resultado é sempre SUGESTÃO: quem chama preenche o campo e pede conferência.
     `ref` = última leitura do veículo, para escolher entre candidatos. */
  async function _variantesOdometro(blob) {
    const img = await new Promise((res, rej) => {
      const i = new Image(), url = URL.createObjectURL(blob);
      i.onload = () => { URL.revokeObjectURL(url); res(i); };
      i.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Falha ao carregar imagem')); };
      i.src = url;
    });
    const W = 900, k = Math.min(4, W / img.width), w = Math.round(img.width * k), h = Math.round(img.height * k);
    const borda = Math.round(h * 0.25);
    const c = document.createElement('canvas');
    c.width = w + 2 * borda; c.height = h + 2 * borda;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, borda, borda, w, h);
    const id = ctx.getImageData(borda, borda, w, h);
    const d = id.data, n = w * h;
    const g = new Uint8Array(n), hist = new Uint32Array(256);
    for (let p = 0, i = 0; p < n; p++, i += 4) { g[p] = (d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114) | 0; hist[g[p]]++; }
    const pct = q => { let a = 0; for (let v = 0; v < 256; v++) { a += hist[v]; if (a >= n * q) return v; } return 255; };
    const lo = pct(0.02), hi = Math.max(lo + 1, pct(0.98)), meio = (lo + hi) / 2;
    const gerar = (binario, inverso) => {
      const o = ctx.createImageData(w, h), od = o.data;
      for (let p = 0, i = 0; p < n; p++, i += 4) {
        let v = Math.min(255, Math.max(0, (g[p] - lo) * 255 / (hi - lo)));
        if (binario) v = g[p] > meio ? 255 : 0;
        if (inverso) v = 255 - v;
        od[i] = od[i+1] = od[i+2] = v; od[i+3] = 255;
      }
      const cv = document.createElement('canvas');
      cv.width = w + 2 * borda; cv.height = h + 2 * borda;
      const cx = cv.getContext('2d');
      cx.fillStyle = inverso ? '#000' : '#fff'; cx.fillRect(0, 0, cv.width, cv.height);   // margem clara em volta (dígito escuro), como o Tesseract prefere
      cx.putImageData(o, borda, borda);
      return new Promise(res => cv.toBlob(res, 'image/png'));
    };
    return Promise.all([gerar(false, false), gerar(false, true), gerar(true, false), gerar(true, true)]);
  }

  async function lerOdometro(blob, ref) {
    await init();
    const variantes = await _variantesOdometro(blob);
    const votos = new Map();                       // valor → { n, conf }
    try {
      await worker.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE });
      for (const v of variantes) {
        if (!v) continue;
        const { data } = await worker.recognize(v);
        const conf = data?.confidence || 0;
        const achados = new Set();
        for (const linha of String(data?.text || '').split(/\r?\n/)) {
          const junto = linha.replace(/\D/g, '');                       // "0 8 5 4 2 0" → "085420"
          if (junto.length >= 3 && junto.length <= 7) achados.add(junto);
          for (const m of linha.matchAll(/\d{3,7}/g)) achados.add(m[0]);
        }
        for (const t of achados) {
          const num = parseInt(t, 10);
          const x = votos.get(num) || { n: 0, conf: 0 };
          x.n++; x.conf = Math.max(x.conf, conf);
          votos.set(num, x);
        }
        /* leitura confiante e plausível: não gasta as variantes que sobram (cada uma custa segundos no celular) */
        const bom = [...votos.entries()].find(([valor, x]) => x.conf >= 80 && (!Number.isFinite(ref) || (valor >= ref && valor - ref <= 5000)));
        if (bom) break;
      }
    } finally {
      try { await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK }); } catch (_) {}   // devolve o leitor ao modo das notas
    }
    let lista = [...votos.entries()].map(([valor, x]) => ({ valor, n: x.n, conf: x.conf }));
    if (!lista.length) return { valor: null, candidatos: [] };
    /* com a última leitura do veículo, o plausível (igual ou até 5.000 km acima) ganha */
    const plaus = Number.isFinite(ref) ? lista.filter(c => c.valor >= ref && c.valor - ref <= 5000) : [];
    const base = plaus.length ? plaus : lista;
    base.sort((a, b) => b.n - a.n || b.conf - a.conf || String(b.valor).length - String(a.valor).length);
    return { valor: base[0].valor, candidatos: lista.map(c => c.valor), plausivel: plaus.length > 0 || !Number.isFinite(ref) };
  }

  async function terminate() {
    if (worker) { await worker.terminate(); worker = null; ready = false; }
  }

  return { init, processar, parseFiscalText, pontuarLeitura, lerOdometro, terminate };
})();
