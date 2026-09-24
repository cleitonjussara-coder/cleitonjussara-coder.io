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
    /* 24/09/2026: uma NFS-e de MG (numeração municipal) entrou aqui como se
       fosse chave de NF-e: os dígitos 3 a 6 eram "4500", e o app gravou a
       nota em 00/2045 — ela sumiu de toda lista filtrada por mês. Agora, se
       o ano/mês da chave não fizerem sentido, ele devolve null nos dois
       campos e a data digitada é que vale. */
    const anoChave = 2000 + parseInt(c.slice(2, 4), 10);
    const mesChave = parseInt(c.slice(4, 6), 10);
    const agora = new Date();
    const dataPlausivel = mesChave >= 1 && mesChave <= 12
      && anoChave >= 2006 && anoChave <= agora.getFullYear() + 1;
    return {
      chave  : c,
      cUF    : c.slice(0, 2),
      uf     : UF_MAP[c.slice(0, 2)] || c.slice(0, 2),
      ano    : dataPlausivel ? anoChave : null,
      mes    : dataPlausivel ? mesChave : null,
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
    let chave = null, valor = null, cnpj = null, data = null, consumidor = null;
    try {
      const safe = url.startsWith('http') ? url : 'https://' + url.replace(/^\/\//, '');
      const u = new URL(safe);

      // estados usam nomes diferentes p/ o parâmetro da chave: chave, chNFe, chaveAcesso...
      chave = u.searchParams.get('chave')
           || u.searchParams.get('chNFe')
           || u.searchParams.get('chaveAcesso')
           || u.searchParams.get('chamada')
           || null;
      if (chave) { const cc = digits(chave); chave = cc.length >= 44 ? cc.slice(0,44) : null; }

      /* Consumidor da nota (24/09/2026): quando a venda identifica quem
         comprou, o QR carrega o cDest — CPF (11) ou CNPJ (14). Não havendo,
         o campo simplesmente não existe, que é o caso comum e permitido.
         Alguns estados passam como parâmetro; no formato de pipe ele é o
         4º campo, logo depois da chave, versão e ambiente. */
      const cDestParam = u.searchParams.get('cDest') || u.searchParams.get('cpf') || u.searchParams.get('CPF');
      if (cDestParam) {
        const d = digits(cDestParam);
        if (d.length === 11 || d.length === 14) consumidor = d;
      }

      const p = u.searchParams.get('p');
      if (p) {
        const parts = p.split('|');
        if (parts.length === 1) {
          const raw = digits(parts[0]);
          if (raw.length === 44 && !chave) chave = raw;
        } else {
          // formato pipe: parts[0]=cUF, parts[1]=AAMM, parts[2]=CNPJ, parts[3]=mod, ...
          // extrai CNPJ e data diretamente como fallback
          if (parts.length >= 3) {
            const cnpjRaw = digits(parts[2] || '');
            if (cnpjRaw.length === 14) cnpj = cnpjRaw;

            const aamm = digits(parts[1] || '');
            if (aamm.length === 4) {
              const aa = 2000 + parseInt(aamm.slice(0,2), 10);
              const mm = parseInt(aamm.slice(2), 10);
              if (mm >= 1 && mm <= 12) data = `${aa}-${String(mm).padStart(2,'0')}-01`;
            }
          }

          // reconstrói chave dos primeiros 9 campos
          if (!chave) {
            const raw = digits(parts.slice(0, 9).join(''));
            if (raw.length >= 44) chave = raw.slice(0, 44);
          }

          /* cDest no formato de pipe: 4º campo, quando a chave abre a lista.
             Exige 11 ou 14 dígitos exatos — o cIdToken que costuma ocupar
             posição parecida tem 6, e o "mod" do outro formato tem 2. */
          if (!consumidor && digits(parts[0]).length === 44 && parts.length >= 4) {
            const d = digits(parts[3] || '');
            if (d.length === 11 || d.length === 14) consumidor = d;
          }

          /* QR versão 2/3 (chave|versão|tpAmb|cIdToken|vNF|…): o valor vem
             no 5º campo — visto em GO em 19/09/2026 ("…|3|1|18|124.36|||hash") */
          if (digits(parts[0]).length === 44 && parts.length >= 5) {
            const v5 = parseFloat(String(parts[4] || '').replace(',', '.'));
            if (!isNaN(v5) && v5 > 0) valor = v5;
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

    // último recurso: procura 44 dígitos seguidos em qualquer parte da URL
    if (!chave) {
      const m = String(url).replace(/[^\d]/g, '').match(/\d{44}/);
      if (m) chave = m[0];
    }

    const parsed = chave ? parseChave44(chave) : null;
    const result = parsed
      ? { ...parsed, valor: valor || parsed.valor || null }
      : { valor: valor || null };

    // enriquece com fallbacks do pipe (CNPJ e data que nao vieram da chave)
    if (cnpj && !result.cnpj) result.cnpj = cnpj;
    if (data && !result.data) result.data = data;
    if (consumidor) result.consumidor = consumidor;

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
