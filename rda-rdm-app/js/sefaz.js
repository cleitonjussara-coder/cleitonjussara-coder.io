'use strict';
/* ─────────────────────────────────────────────────────────────
   SEFAZ.js — dados derivados da chave de acesso + link de consulta

   POR QUE NÃO EXISTE MAIS TABELA DE URL POR UF
   --------------------------------------------
   Até a v58 este arquivo montava um "pipe" a partir da chave
     p=cUF|AAMM|CNPJ|mod|série|nNF|tpEmis|cNF|cDV
   e mandava para o portal da UF. Isso nunca funcionou, e não é bug de
   URL desatualizada: o parâmetro 'p' do QR Code NFC-e (NT 2015/002,
   versão 2.00) é

     p=<chave 44>|<versãoQR>|<tpAmb>|<cIdToken>|<cHashQRCode>

   e o cHashQRCode é um HMAC-SHA1 assinado com o CSC (Código de Segurança
   do Contribuinte), segredo de quem emitiu a nota. Não dá para recalcular
   a partir da chave. Remontar o QR é impossível por construção.

   Verificado por requisição real no portal de GO (02/08/2026): tanto o
   pipe antigo quanto a chave crua em ?p= devolvem a mesma tela
   "Atenção — é necessário informar o parâmetro 'p' ... conforme o manual".
   E GO não tem página pública que aceite a chave por link: /nfce/,
   consultaNFCe, consultarNFCe e consultaCompleta responderam 404. O portal
   SVRS com a chave crua devolve a home, não a nota.

   O QUE FUNCIONA
   --------------
   1. A URL real lida do QR (o app guarda em notas.qr_url) — é a única
      forma de abrir a nota exata, porque ela já traz o hash válido.
   2. Sem ela, o portal nacional com a chave preenchida. Exige captcha
      resolvido pelo usuário e pode não ter NFC-e de todos os estados,
      mas é o melhor que se consegue por link.
───────────────────────────────────────────────────────────── */
window.SEFAZ = (() => {

  const UF_MAP = {
    '11':'RO','12':'AC','13':'AM','14':'RR','15':'PA','16':'AP','17':'TO',
    '21':'MA','22':'PI','23':'CE','24':'RN','25':'PB','26':'PE','27':'AL',
    '28':'SE','29':'BA','31':'MG','32':'ES','33':'RJ','35':'SP',
    '41':'PR','42':'SC','43':'RS','50':'MS','51':'MT','52':'GO','53':'DF'
  };

  const PORTAL_NACIONAL = 'https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx';

  function digits(s) { return String(s||'').replace(/\D/g,''); }

  /* ── Dados que a própria chave carrega ──────────────────────
     Não há rede aqui: a chave de 44 dígitos já contém UF, competência,
     CNPJ do emitente e modelo. Razão social vem da BrasilAPI e o valor,
     do OCR da foto — nenhum dos dois sai da chave. */
  /* Dígito verificador da chave (módulo 11, pesos 2→9 da direita p/ a
     esquerda sobre os 43 primeiros dígitos). Pega erro de digitação na
     hora, antes de gravar uma nota com chave que o SEFAZ nunca acharia. */
  function dvValido(c) {
    const d = digits(c);
    if (d.length !== 44) return false;
    let soma = 0, peso = 2;
    for (let i = 42; i >= 0; i--) {
      soma += Number(d[i]) * peso;
      peso = peso === 9 ? 2 : peso + 1;
    }
    const resto = soma % 11;
    return Number(d[43]) === (resto < 2 ? 0 : 11 - resto);
  }

  async function consultarChave(chave) {
    const c = digits(chave);
    if (c.length !== 44) throw new Error('Chave de acesso inválida — deve ter 44 dígitos');
    if (!dvValido(c)) throw new Error('Chave inválida — o dígito verificador não confere. Confira os 44 dígitos.');

    const ano = 2000 + parseInt(c.slice(2,4), 10);
    const mes = parseInt(c.slice(4,6), 10);

    return {
      chave : c,
      cnpj  : c.slice(6,20),
      uf    : UF_MAP[c.slice(0,2)] || '',
      mes   : mes,
      ano   : ano,
      data  : `${ano}-${String(mes).padStart(2,'0')}-01`,
      modelo: c.slice(20,22),      // 65 = NFC-e | 55 = NF-e
      razao_social : null,
      valor : null,
      fonte : 'chave',
    };
  }

  /* ── Link de consulta a partir da chave ─────────────────────
     Best-effort: leva ao portal nacional com a chave preenchida. Quem
     chama deve preferir a URL real do QR (notas.qr_url) quando existir —
     ver resolverLinkConsulta() no app.js. */
  function linkConsulta(chave) {
    const c = digits(chave);
    if (c.length !== 44) return null;
    return `${PORTAL_NACIONAL}?tipoConsulta=resumo&nfe=${c}`;
  }

  return { consultarChave, linkConsulta, dvValido, UF_MAP };
})();
