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

  /* ── URLs de consulta do QR Code por UF ───────────────────
     Cada UF tem seu próprio portal e nenhum padrão comum: a maioria
     recebe o "pipe" em ?p=, o AC leva no caminho e o MS quer a chave
     crua em ?chNFe=. Daí o template com marcadores:
       {P} = parâmetro pipe montado da chave    {C} = chave de 44 dígitos

     Conferido uma a uma por requisição real em 26/07/2026. A tabela
     anterior seguia um padrão genérico (sefaz.XX.gov.br/nfce/consulta)
     que não existe de fato — MG, DF e SC respondiam 404 e PR estava fora
     do ar. Ao mexer aqui, teste a URL antes: essas listas "prontas" que
     circulam na internet estão erradas para vários estados.

     PI, RR e TO ficam de fora — em jul/2026 não achei endpoint deles que
     aceite a chave por link; caem no portal SVRS abaixo. */
  const SEFAZ_URLS = {
    AC:'https://dfe.sefaz.ac.gov.br/consulta-documento-fiscal-eletronico/nfce/{P}/consulta-publica?tpAmb=1',
    AL:'https://nfce.sefaz.al.gov.br/consultaNFCe.htm?p={P}',
    AM:'https://sistemas.sefaz.am.gov.br/nfceweb/consultarNFCe.jsp?p={P}',
    AP:'https://www.sefaz.ap.gov.br/nfce/nfcep.php?p={P}',
    BA:'https://nfe.sefaz.ba.gov.br/servicos/nfce/qrcode.aspx?p={P}',
    CE:'http://nfce.sefaz.ce.gov.br/pages/ShowNFCe.html?p={P}',   // sem https
    DF:'http://dec.fazenda.df.gov.br/ConsultarNFCe.aspx?p={P}',
    ES:'https://app.sefaz.es.gov.br/ConsultaNFCe/QRCode.aspx?p={P}',
    GO:'http://nfe.sefaz.go.gov.br/nfeweb/sites/nfce/danfeNFCe?p={P}',   // sem https
    MA:'http://www.nfce.sefaz.ma.gov.br/portal/consultarnfce.jsp?p={P}', // sem https
    MG:'https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p={P}',
    MS:'https://www.dfe.ms.gov.br/nfce/consulta/?chNFe={C}',
    MT:'https://www.sefaz.mt.gov.br/nfce/consultanfce?p={P}',
    PA:'https://www.sefa.pa.gov.br/nfce/consulta?p={P}',
    PB:'https://www.sefaz.pb.gov.br/nfce?p={P}',
    PE:'https://nfce.sefaz.pe.gov.br:444/nfce/consulta?p={P}',           // porta 444
    PR:'https://www.fazenda.pr.gov.br/nfce/qrcode?p={P}',
    RJ:'https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode?p={P}',
    RN:'https://nfce.sefaz.rn.gov.br/consultarNFCe.aspx?p={P}',  // era set.rn.gov.br
    RO:'https://www.nfce.sefin.ro.gov.br/consultanfce/consulta.jsp?p={P}',
    RS:'https://dfe-portal.svrs.rs.gov.br/Dfe/QrCodeNFce?p={P}',
    SC:'https://sat.sef.sc.gov.br/nfce/consulta?p={P}',
    SE:'https://nfce.sefaz.se.gov.br/portal/consultarNFCe.jsp?p={P}',
    SP:'https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p={P}',
  };
  // Portal SVRS — atende NFC-e de boa parte dos estados; usado quando a UF
  // não está na tabela acima.
  const SVRS_NFCE = 'https://dfe-portal.svrs.rs.gov.br/Nfce/QrCode?p={P}';

  function digits(s) { return String(s||'').replace(/\D/g,''); }

  /* Monta a URL de consulta da UF a partir do template. */
  function urlConsultaUF(uf, chave) {
    const c = digits(chave);
    const pipe = buildPipe(c);
    if (!pipe) return null;
    return (SEFAZ_URLS[uf] || SVRS_NFCE)
      .replace('{P}', encodeURIComponent(pipe))
      .replace('{C}', c);
  }

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

    const cnpjM = html.match(/CNPJ[:\s]*(\d{2}\.?\d{3}\.?\d{3}[/1]\d{4}[-]?\d{2})/i);
    if (cnpjM) r.cnpj = digits(cnpjM[1]);

    const nomeM = html.match(/(?:Nome|Raz[ãa]o\s*Social|Emitente)[:\s]+([^<]{4,80})/i);
    if (nomeM) r.razao_social = nomeM[1].trim();

    const valM = html.match(/(?:Valor\s*Total|Total\s*da\s*Nota|A\s*Pagar)[:\s]*R?\$?\s*([0-9]{1,7}[.,][0-9]{2})/i);
    if (valM) r.valor = parseFloat(valM[1].replace(',','.'));

    const dataM = html.match(/(?:Emiss[ãa]o|Data)[:\s]*(\d{2}[/\-.]\d{2}[/\-.]\d{4})/i);
    if (dataM) {
      const parts = dataM[1].split(/[/\-.]/);
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

    // Raspagem só faz sentido p/ NFC-e (modelo 65). NF-e (55) usa portal nacional.
    // Sem o hash do CSC o portal costuma recusar o QR remontado, então isso é
    // best-effort: o valor confiável vem da foto (OCR) ou do XML.
    if (modelo === '65' && uf) {
      const url = urlConsultaUF(uf, c);
      if (url) {
        const proxyRes = await fetchViaProxy(url);
        const parsed = proxyRes?.type === 'json' ? parseSefazJSON(proxyRes.data)
                     : proxyRes?.type === 'html' ? parseSefazHTML(proxyRes.data)
                     : null;
        if (parsed) {
          if (parsed.razao_social) result.razao_social = parsed.razao_social;
          if (parsed.valor)        result.valor        = parsed.valor;
          if (parsed.data)         result.data         = parsed.data;
          if (parsed.razao_social || parsed.valor) {
            result.fonte = proxyRes.type === 'json' ? 'sefaz_proxy' : 'sefaz_html';
          }
        }
      }
    }

    return result;
  }

  /* ── Link de consulta da nota (abre direto no navegador) ──
     Sem o hash do CSC não dá p/ recriar o QR completo de qualquer nota,
     mas levamos ao portal do estado certo com o pipe da chave.
     Para notas lidas por QR, o app usa a URL real salva (tem prioridade). */
  function linkConsulta(chave) {
    const c = digits(chave);
    if (c.length !== 44) return null;
    const modelo = c.slice(20, 22);
    // NF-e (modelo 55) → Portal Nacional da NF-e.
    // O portal trocou a página de consulta: consultaResumo.aspx?chNFe= virou
    // consultaRecaptcha.aspx e o parâmetro da chave passou a ser "nfe".
    // A URL antiga não dá erro — cai na home do portal, sem a nota —, por isso
    // o sintoma era "não acha a nota". O reCAPTCHA da página é resolvido pelo
    // usuário; o que dá pra fazer por link é chegar com a chave preenchida.
    if (modelo === '55') {
      return `https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx?tipoConsulta=resumo&nfe=${c}`;
    }
    // NFC-e (modelo 65) → portal do estado (ou SVRS, se a UF não estiver na tabela)
    return urlConsultaUF(UF_MAP[c.slice(0,2)] || '', c);
  }

  return { consultarChave, buildPipe, linkConsulta, urlConsultaUF, SEFAZ_URLS, UF_MAP };
})();
