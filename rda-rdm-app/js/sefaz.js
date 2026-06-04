'use strict';
/* ─────────────────────────────────────────────────────────────
   SEFAZ.js — consulta NFC-e direto da Receita Federal
   Fluxo: chave 44 digitos → parse → fetch SEFAZ JSON → enriquece CNPJ
   Usa parâmetros pipe da URL QR + CORS proxy com fallback local
───────────────────────────────────────────────────────────── */
window.SEFAZ = (() => {

  const UF_MAP = {
    '11':'RO','12':'AC','13':'AM','14':'RR','15':'PA','16':'AP','17':'TO',
    '21':'MA','22':'PI','23':'CE','24':'RN','25':'PB','26':'PE','27':'AL',
    '28':'SE','29':'BA','31':'MG','32':'ES','33':'RJ','35':'SP',
    '41':'PR','42':'SC','43':'RS','50':'MS','51':'MT','52':'GO','53':'DF'
  };

  /* ── URLs de consulta por UF ──────────────────────────── */
  const SEFAZ_URLS = {
    'SP': 'https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx',
    'MG': 'https://www.fazenda.mg.gov.br/nfce/portal/ConsultaQRCode',
    'PR': 'https://dfeportal.fazenda.pr.gov.br/dfeportal/rest/consultarNFCe',
    'RS': 'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx',
    'SC': 'https://www.sefaz.sc.gov.br/nfce/consulta',
    'RJ': 'https://www4.fazenda.rj.gov.br/consultaNFCe/QRCode',
    'BA': 'https://www.sefaz.ba.gov.br/nfce/consulta',
    'GO': 'https://www.sefaz.go.gov.br/nfce/consulta',
    'DF': 'https://www.fazenda.df.gov.br/nfce/consulta',
  };

  function digits(s) { return String(s||'').replace(/\D/g,''); }

  /* ── Constrói parâmetro pipe a partir da chave ────────── */
  function buildPipe(chave) {
    if (chave.length !== 44) return null;
    const cUF   = chave.slice(0, 2);
    const AAMM  = chave.slice(2, 6);
    const cnpj  = chave.slice(6, 20);
    const mod   = chave.slice(20, 22);
    const serie = chave.slice(22, 25);
    const nNF   = chave.slice(25, 34);
    const tpEmis= chave.slice(34, 35);
    const cNF   = chave.slice(35, 43);
    const cDV   = chave.slice(43, 44);
    return `${cUF}|${AAMM}|${cnpj}|${mod}|${serie}|${nNF}|${tpEmis}|${cNF}|${cDV}`;
  }

  /* ── Parse dados do JSON de resposta SEFAZ ────────────── */
  function parseSefazJSON(data) {
    const r = {
      razao_social : null,
      nome_fantasia: null,
      cnpj         : null,
      valor        : null,
      data         : null,
      endereco     : null,
      uf           : null,
      chave        : null,
    };

    const d = data?.NFe?.infNFe || data?.nfeProc?.NFe?.infNFe || data?.nfce || data;

    // Emitente
    const emit = d?.emit || {};
    r.cnpj          = digits(emit?.CNPJ || data?.cnpj || '');
    r.razao_social  = emit?.xNome || data?.razao_social || data?.nome || null;
    r.nome_fantasia = emit?.xFant || data?.nome_fantasia || null;
    r.uf            = emit?.enderEmit?.UF || data?.uf || null;

    // Endereço
    if (emit?.enderEmit) {
      const e = emit.enderEmit;
      r.endereco = [e.xLgr, e.nro, e.xBairro, e.xMun, e.UF].filter(Boolean).join(', ');
    }

    // Total
    const tot = d?.total?.ICMSTot || data?.total || data?.valor;
    if (tot) {
      r.valor = parseFloat((tot?.vNF || tot?.valor || tot)?.toString().replace(',','.'));
    }

    // Data
    const dh = d?.ide?.dhEmi || data?.data || data?.dhEmi;
    if (dh) {
      r.data = String(dh).slice(0, 10);
    }

    // Chave
    r.chave = digits(d?.Id || d?.ide?.cNF ? (d?.chave || data?.chave || '') : (data?.chave || ''));
    if (r.chave.length < 44) r.chave = null;

    return r;
  }

  /* ── Parse HTML da página de consulta SEFAZ ───────────── */
  function parseSefazHTML(html) {
    const r = { razao_social:null, cnpj:null, valor:null, data:null, endereco:null };

    const cnpjM = html.match(/CNPJ[:\s]*(\d{2}\.?\d{3}\.?\d{3}[\/1]\d{4}[-]?\d{2})/i);
    if (cnpjM) r.cnpj = digits(cnpjM[1]);

    const nomeM = html.match(/(?:Nome|Raz[ãa]o\s*Social|Emitente)[:\s]+([^<]{4,80})/i);
    if (nomeM) r.razao_social = nomeM[1].trim();

    const valM = html.match(/(?:Valor\s*Total|Total\s*da\s*Nota|A\s*Pagar)[:\s]*R?\$?\s*([0-9]{1,7}[.,][0-9]{2})/i);
    if (valM) r.valor = parseFloat(valM[1].replace(',','.'));

    const dataM = html.match(/(?:Emiss[ãa]o|Data)[:\s]*(\d{2}[\/\-.]\d{2}[\/\-.]\d{4})/i);
    if (dataM) {
      const parts = dataM[1].split(/[\/\-.]/);
      r.data = `${parts[2]}-${parts[1]}-${parts[0]}`;
    }

    return r;
  }

  /* ── Tenta fetch via CORS proxy público ──────────────── */
  async function fetchViaProxy(url) {
    // Múltiplas pontes CORS — tenta em cascata, para na 1ª que responder.
    // (corsproxy.io virou pago; mantemos várias alternativas como fallback)
    const proxies = [
      { build: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, wrap: false },
      { build: u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, wrap: true  },
      { build: u => `https://corsproxy.org/?url=${encodeURIComponent(u)}`,         wrap: false },
      { build: u => `https://thingproxy.freeboard.io/fetch/${u}`,                  wrap: false },
    ];

    for (const px of proxies) {
      try {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 5000);
        const resp = await fetch(px.build(url), {
          signal: ctrl.signal,
          headers: { 'Accept': 'application/json, text/html' },
        });
        clearTimeout(tid);
        if (!resp.ok) continue;

        let text = await resp.text();
        // allorigins /get embrulha o conteúdo em { contents: "..." }
        if (px.wrap) { try { text = JSON.parse(text).contents || text; } catch (_) {} }
        if (!text || !text.trim()) continue;

        if (text.trim().startsWith('{')) {
          try { return { type:'json', data: JSON.parse(text) }; } catch (_) {}
        }
        return { type:'html', data: text };
      } catch (_) { continue; }
    }
    return null;
  }

  /* ── Consulta principal: chave 44 dígitos → dados da nota ── */
  async function consultarChave(chave) {
    const c = digits(chave);
    if (c.length !== 44) throw new Error('Chave de acesso inválida — deve ter 44 dígitos');

    // Dados imediatos da estrutura da chave (sempre disponíveis)
    const uf = UF_MAP[c.slice(0,2)] || '';
    const ano = 2000 + parseInt(c.slice(2,4), 10);
    const mes = parseInt(c.slice(4,6), 10);
    const cnpj = c.slice(6,20);
    const modelo = c.slice(20,22);
    const dataBase = `${ano}-${String(mes).padStart(2,'0')}-01`;

    const result = {
      chave  : c,
      cnpj  : cnpj,
      uf    : uf,
      mes   : mes,
      ano   : ano,
      data  : dataBase,
      modelo: modelo,
      razao_social : null,
      valor : null,
      fonte : 'chave',
    };

    // Tenta buscar dados completos do SEFAZ
    const pipe = buildPipe(c);
    if (pipe && uf) {
      const baseUrl = SEFAZ_URLS[uf];
      if (baseUrl) {
        // PR tem endpoint REST JSON
        if (uf === 'PR') {
          try {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), 6000);
            const resp = await fetch(`${baseUrl}?chave=${c}`, {
              signal: ctrl.signal,
              headers: { 'Accept': 'application/json' },
            });
            clearTimeout(tid);
            if (resp.ok) {
              const j = await resp.json();
              const parsed = parseSefazJSON(j);
              if (parsed.razao_social) result.razao_social = parsed.razao_social;
              if (parsed.valor)        result.valor        = parsed.valor;
              if (parsed.data)         result.data         = parsed.data;
              if (parsed.razao_social || parsed.valor) result.fonte = 'sefaz_json';
            }
          } catch (_) {}
        }

        // Demais estados: tenta via proxy
        if (!result.razao_social || !result.valor) {
          const proxyRes = await fetchViaProxy(`${baseUrl}?p=${pipe}`);
          if (proxyRes?.type === 'json') {
            const parsed = parseSefazJSON(proxyRes.data);
            if (parsed.razao_social) result.razao_social = parsed.razao_social;
            if (parsed.valor)        result.valor        = parsed.valor;
            if (parsed.data)         result.data         = parsed.data;
            if (parsed.razao_social || parsed.valor) result.fonte = 'sefaz_proxy';
          } else if (proxyRes?.type === 'html') {
            const parsed = parseSefazHTML(proxyRes.data);
            if (parsed.razao_social) result.razao_social = parsed.razao_social;
            if (parsed.valor)        result.valor        = parsed.valor;
            if (parsed.data)         result.data         = parsed.data;
            if (parsed.razao_social || parsed.valor) result.fonte = 'sefaz_html';
          }
        }
      }
    }

    return result;
  }

  return { consultarChave, buildPipe, UF_MAP };
})();
