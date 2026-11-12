'use strict';
/* ─────────────────────────────────────────────────────────────
   Excel.js — exportação gerencial Petermann via SheetJS
   Estilo profissional: cabeçalho verde, zebrado, merge, filtro,
   células R$, negativos em vermelho, bordas, painel congelado.
───────────────────────────────────────────────────────────── */
window.Excel = (() => {
  const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const brl  = v => Number(v||0).toFixed(2);
  const cur  = v => parseFloat(Number(v||0).toFixed(2));
  const brlTxt = v => 'R$ ' + Number(v||0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const COR = {
    verde       : '2D6A4F',
    verdeClaro  : '40916C',
    verdeFundo  : 'D1FAE5',
    laranja     : 'F4A261',
    laranjaClaro: 'FEF3C7',
    vermelho    : 'D62828',
    cinza       : 'F0F4F1',
    branco      : 'FFFFFF',
    texto       : '1C2B20',
    texto2      : '5A6E60',
  };

  /* ── Helpers de estilo ───────────────────────────────── */
  const FONT_TIT  = { bold:true, sz:16, color:{rgb:COR.verde}, name:'Calibri' };
  const FONT_SUB  = { bold:false, sz:10, color:{rgb:COR.texto2}, name:'Calibri' };
  const FONT_HDR  = { bold:true, sz:10, color:{rgb:COR.branco}, name:'Calibri' };
  const FONT_BODY = { sz:10, color:{rgb:COR.texto}, name:'Calibri' };
  const FONT_TOT  = { bold:true, sz:11, color:{rgb:COR.verde}, name:'Calibri' };
  const FONT_NEG  = { sz:10, color:{rgb:COR.vermelho}, name:'Calibri' };
  const FILL_HDR  = { fgColor:{rgb:COR.verde}, patternType:'solid' };
  const FILL_GRAY = { fgColor:{rgb:COR.cinza}, patternType:'solid' };
  const FILL_RDM  = { fgColor:{rgb:COR.laranjaClaro}, patternType:'solid' };
  const FILL_RDA  = { fgColor:{rgb:COR.verdeFundo}, patternType:'solid' };
  const BORDER_THIN = {
    top:{style:'thin',color:{rgb:COR.texto2}},
    bottom:{style:'thin',color:{rgb:COR.texto2}},
    left:{style:'thin',color:{rgb:COR.texto2}},
    right:{style:'thin',color:{rgb:COR.texto2}},
  };
  const BORDER_BOTTOM = { bottom:{style:'medium',color:{rgb:COR.verde}} };
  const ALIGN_C  = { horizontal:'center', vertical:'center', wrapText:false };
  const ALIGN_L  = { horizontal:'left',   vertical:'center' };
  const ALIGN_R  = { horizontal:'right',  vertical:'center' };

  const STYLE_HDR = { font:FONT_HDR, fill:FILL_HDR, alignment:ALIGN_C, border:BORDER_THIN };
  const STYLE_TIT = { font:FONT_TIT, alignment:ALIGN_L };
  const STYLE_SUB = { font:FONT_SUB, alignment:ALIGN_L };

  function numCell(v)  { return { t:'n', v:cur(v), s:{ font:FONT_BODY, border:BORDER_THIN, alignment:ALIGN_R, numFmt:'R$ #,##0.00' } }; }
  function numNeg(v)   { return { t:'n', v:cur(v), s:{ font:FONT_NEG, border:BORDER_THIN, alignment:ALIGN_R, numFmt:'R$ #,##0.00' } }; }
  function strCell(v)  { return { t:'s', v:String(v||''), s:{ font:FONT_BODY, border:BORDER_THIN, alignment:ALIGN_L } }; }
  function strCenter(v){ return { t:'s', v:String(v||''), s:{ font:FONT_BODY, border:BORDER_THIN, alignment:ALIGN_C } }; }
  function totCell(v)  { return { t:'n', v:cur(v), s:{ font:FONT_TOT, border:BORDER_BOTTOM, alignment:ALIGN_R, numFmt:'R$ #,##0.00' } }; }
  function totNeg(v)   { return { t:'n', v:cur(v), s:{ font:{...FONT_TOT,color:{rgb:COR.vermelho}}, border:BORDER_BOTTOM, alignment:ALIGN_R, numFmt:'R$ #,##0.00' } }; }
  function titCell(v)  { return { t:'s', v:String(v), s:STYLE_TIT }; }
  function subCell(v)  { return { t:'s', v:String(v), s:STYLE_SUB }; }
  /* 06/11/2026: nota que aguarda conferência ficou de fora (Fechamento.avisos); o arquivo diz isso em destaque */
  function avisoCell(v) { return { t:'s', v:String(v), s:{ font:{ bold:true, sz:10, color:{rgb:COR.vermelho}, name:'Calibri' }, fill:{ fgColor:{rgb:COR.laranjaClaro}, patternType:'solid' }, alignment:ALIGN_L } }; }

  /* aplica estilo a um range (linha×coluna base-0) */
  function styleRange(ws, r0, c0, r1, c1, style) {
    for (let R = r0; R <= r1; R++) {
      for (let C = c0; C <= c1; C++) {
        const ref = XLSX.utils.encode_cell({r:R, c:C});
        if (ws[ref]) continue; // não sobrescreve células já definidas
      }
    }
  }

  function hdrRow(ws, rowIdx, headers) {
    headers.forEach((h, i) => {
      ws[XLSX.utils.encode_cell({r:rowIdx, c:i})] = { t:'s', v:h, s:STYLE_HDR };
    });
  }

  function merge(ws, r0, c0, r1, c1) {
    if (!ws['!merges']) ws['!merges'] = [];
    ws['!merges'].push(XLSX.utils.decode_range(
      XLSX.utils.encode_range({s:{r:r0,c:c0},e:{r:r1,c:c1}})
    ));
  }

  /* ── RESUMO Gerencial ───────────────────────────────── */
  function buildResumo(notas, repasses, ano, colab, abertura, avisos = []) {
    const ws = {};
    ws['!cols'] = [{wch:8},{wch:14},{wch:14},{wch:14},{wch:14},{wch:14},{wch:14},{wch:16},{wch:16}];
    ws['!merges'] = [];

    let r = 0;

    // Título principal
    merge(ws, r, 0, r, 8);
    ws[XLSX.utils.encode_cell({r, c:0})] = titCell('PETERMANN — RELATÓRIO FINANCEIRO');
    r++;

    // Subtítulo
    merge(ws, r, 0, r, 8);
    ws[XLSX.utils.encode_cell({r, c:0})] = subCell(`Colaborador: ${colab.nome||''}    Núcleo: ${colab.nucleo||''}    Ano: ${ano}`);
    r++;
    /* "sempre somar os saldos acumulados dos meses anteriores" (01/10/2026): janeiro parte do que
       sobrou (ou faltou) ate dezembro do ano anterior, em vez de zero. */
    const abRDM = abertura ? Number(abertura.RDM) || 0 : 0, abRDA = abertura ? Number(abertura.RDA) || 0 : 0;
    merge(ws, r, 0, r, 8);
    ws[XLSX.utils.encode_cell({r, c:0})] = subCell(abertura
      ? `Saldo do ano anterior: RDM ${brlTxt(abRDM)} · RDA ${brlTxt(abRDA)} (já somado em Pend. Anterior e Saldo Acum.)`
      : 'Saldo de anos anteriores não incluído (histórico indisponível).');
    r++;
    avisos.forEach(a => { merge(ws, r, 0, r, 8); ws[XLSX.utils.encode_cell({r, c:0})] = avisoCell(a); r++; });

    // Cabeçalho
    const linhaCab = r;
    hdrRow(ws, r, ['Mês','RDM Gasto','RDM Repasse','RDM Saldo','RDA Gasto','RDA Repasse','RDA Saldo','Pend. Anterior','Saldo Acum.']);
    r++;

    let tRDMg=0,tRDMr=0,tRDAg=0,tRDAr=0;
    let acumRDM=abRDM, acumRDA=abRDA;
    for (let m = 1; m <= 12; m++) {
      const ns = notas.filter(n => n.mes===m && n.ano===ano && !n.deleted);
      const rs = repasses.filter(r => r.mes===m && r.ano===ano && !r.deleted);
      const rdmG = ns.filter(n=>n.tipo==='RDM').reduce((a,n)=>a+cur(n.valor),0);
      const rdmR = rs.filter(r=>r.tipo==='RDM').reduce((a,r)=>a+cur(r.valor),0);
      const rdaG = ns.filter(n=>n.tipo==='RDA').reduce((a,n)=>a+cur(n.valor),0);
      const rdaR = rs.filter(r=>r.tipo==='RDA').reduce((a,r)=>a+cur(r.valor),0);
      tRDMg+=rdmG; tRDMr+=rdmR; tRDAg+=rdaG; tRDAr+=rdaR;
      const sRDM = rdmR-rdmG, sRDA = rdaR-rdaG;

      const pendAnterior = acumRDM + acumRDA;  // antes de adicionar este mês
      acumRDM = cur(acumRDM + sRDM); acumRDA = cur(acumRDA + sRDA);
      const saldoAcum = acumRDM + acumRDA;

      ws[XLSX.utils.encode_cell({r,c:0})] = strCenter(MESES[m-1]);
      ws[XLSX.utils.encode_cell({r,c:1})] = numCell(rdmG);
      ws[XLSX.utils.encode_cell({r,c:2})] = numCell(rdmR);
      ws[XLSX.utils.encode_cell({r,c:3})] = sRDM < 0 ? numNeg(sRDM) : numCell(sRDM);
      ws[XLSX.utils.encode_cell({r,c:4})] = numCell(rdaG);
      ws[XLSX.utils.encode_cell({r,c:5})] = numCell(rdaR);
      ws[XLSX.utils.encode_cell({r,c:6})] = sRDA < 0 ? numNeg(sRDA) : numCell(sRDA);
      ws[XLSX.utils.encode_cell({r,c:7})] = pendAnterior < 0 ? numNeg(pendAnterior) : numCell(pendAnterior || 0);
      ws[XLSX.utils.encode_cell({r,c:8})] = saldoAcum < 0 ? numNeg(saldoAcum) : numCell(saldoAcum);
      r++;
    }

    r++; // linha em branco
    const sTDMr = tRDMr-tRDMg, sTDAr = tRDAr-tRDAg;   // soma das colunas do ano; o ACUMULADO (abertura + ano) fica em Pend. Anterior + Saldo Acum.
    ws[XLSX.utils.encode_cell({r,c:0})] = { t:'s', v:'TOTAL', s:{ font:{...FONT_TOT,color:{rgb:COR.branco}}, fill:FILL_HDR, border:BORDER_THIN, alignment:ALIGN_C } };
    ws[XLSX.utils.encode_cell({r,c:1})] = totCell(tRDMg);
    ws[XLSX.utils.encode_cell({r,c:2})] = totCell(tRDMr);
    ws[XLSX.utils.encode_cell({r,c:3})] = sTDMr < 0 ? totNeg(sTDMr) : totCell(sTDMr);
    ws[XLSX.utils.encode_cell({r,c:4})] = totCell(tRDAg);
    ws[XLSX.utils.encode_cell({r,c:5})] = totCell(tRDAr);
    ws[XLSX.utils.encode_cell({r,c:6})] = sTDAr < 0 ? totNeg(sTDAr) : totCell(sTDAr);
    ws[XLSX.utils.encode_cell({r,c:7})] = abertura ? ((abRDM+abRDA) < 0 ? totNeg(abRDM+abRDA) : totCell(abRDM+abRDA)) : { t:'s', v:'', s:{ border:BORDER_THIN } };
    ws[XLSX.utils.encode_cell({r,c:8})] = (acumRDM+acumRDA) < 0 ? totNeg(acumRDM+acumRDA) : totCell(acumRDM+acumRDA);
    r += 2;

    // Geração
    merge(ws, r, 0, r, 8);
    ws[XLSX.utils.encode_cell({r, c:0})] = subCell(`Gerado em ${FusoBR.data(new Date())} às ${FusoBR.hora(new Date(), {hour:'2-digit',minute:'2-digit'})} — Petermann App`);
    r++;

    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r:r-1,c:8}});
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:linhaCab,c:0},e:{r:linhaCab+11,c:8}}) };
    return ws;
  }

  /* ── RDM Detalhado ──────────────────────────────────── */
  function buildRDM(notas, repasses, ano, abertura) {
    const ws = {};
    ws['!cols'] = [{wch:8},{wch:16},{wch:14},{wch:12},{wch:14},{wch:4},{wch:14},{wch:14}];
    ws['!merges'] = [];
    let r = 0;

    merge(ws, r, 0, r, 7);
    ws[XLSX.utils.encode_cell({r, c:0})] = titCell(`RDM DETALHADO — ${ano}`);
    r += 2;

    hdrRow(ws, r, ['Mês','Abastecimento','Hospedagem','Outros','Total Gasto','','Repasses','Saldo Acum.']);
    r++;

    /* saldo ACUMULADO (01/10/2026): parte do que veio de anos anteriores e soma mes a mes */
    let acum = abertura ? Number(abertura.RDM) || 0 : 0;
    for (let m = 1; m <= 12; m++) {
      const ns = notas.filter(n => n.mes===m && n.ano===ano && n.tipo==='RDM' && !n.deleted);
      const rs = repasses.filter(r => r.mes===m && r.ano===ano && r.tipo==='RDM' && !r.deleted);
      /* 'Outros' pega tudo que nao e Abastecimento nem Hospedagem - senao a nota sem subtipo sumia do total e do saldo */
      const ehSub = (n, sb) => sb === 'Outros' ? (n.subtipo !== 'Abastecimento' && n.subtipo !== 'Hospedagem') : n.subtipo === sb;
      const vals = ['Abastecimento','Hospedagem','Outros'].map(sb => ns.filter(n=>ehSub(n, sb)).reduce((a,n)=>a+cur(n.valor),0));
      const tot  = vals.reduce((a,v)=>a+v, 0);
      const rep  = rs.reduce((a,r)=>a+cur(r.valor), 0);
      acum = cur(acum + rep - tot);
      const saldo = acum;
      ws[XLSX.utils.encode_cell({r,c:0})] = strCenter(MESES[m-1]);
      for (let i=0;i<3;i++) ws[XLSX.utils.encode_cell({r,c:1+i})] = numCell(vals[i]);
      ws[XLSX.utils.encode_cell({r,c:4})] = numCell(tot);
      ws[XLSX.utils.encode_cell({r,c:6})] = numCell(rep);
      ws[XLSX.utils.encode_cell({r,c:7})] = saldo < 0 ? numNeg(saldo) : numCell(saldo);
      r++;
    }

    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r:r-1,c:7}});
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:2,c:0},e:{r:2+11,c:7}}) };
    return ws;
  }

  /* ── RDA Detalhado ──────────────────────────────────── */
  function buildRDA(notas, repasses, ano) {
    const ws = {};
    ws['!cols'] = [{wch:6},{wch:12},{wch:20},{wch:36},{wch:14},{wch:10}];
    ws['!merges'] = [];
    let r = 0;

    merge(ws, r, 0, r, 5);
    ws[XLSX.utils.encode_cell({r, c:0})] = titCell(`RDA DETALHADO — ${ano}`);
    r += 2;

    hdrRow(ws, r, ['Mês','Data','CNPJ','Razão Social','Valor (R$)','Captura']);
    r++;

    const ns = notas.filter(n => n.tipo==='RDA' && n.ano===ano && !n.deleted)
      .sort((a,b) => a.mes-b.mes || a.data.localeCompare(b.data));

    ns.forEach(n => {
      ws[XLSX.utils.encode_cell({r,c:0})] = strCenter(MESES[n.mes-1]);
      ws[XLSX.utils.encode_cell({r,c:1})] = strCenter(n.data);
      ws[XLSX.utils.encode_cell({r,c:2})] = strCell(BrasilAPI.paraPlanilha(n.cnpj));   // sem CNPJ: vazio; zeros não viram CNPJ (21/10/2026)
      ws[XLSX.utils.encode_cell({r,c:3})] = strCell(n.razao_social||'');
      ws[XLSX.utils.encode_cell({r,c:4})] = numCell(n.valor);
      ws[XLSX.utils.encode_cell({r,c:5})] = strCenter(n.metodo_captura||'manual');
      r++;
    });

    r++;
    for (let m = 1; m <= 12; m++) {
      const tot = ns.filter(n=>n.mes===m).reduce((a,n)=>a+cur(n.valor),0);
      if (tot > 0) {
        merge(ws, r, 0, r, 3);
        ws[XLSX.utils.encode_cell({r,c:0})] = { t:'s', v:`Subtotal ${MESES[m-1]}`, s:{ font:{...FONT_TOT,sz:10}, fill:FILL_GRAY, border:BORDER_THIN, alignment:ALIGN_R } };
        ws[XLSX.utils.encode_cell({r,c:4})] = totCell(tot);
        r++;
      }
    }

    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r:r-1,c:5}});
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:2,c:0},e:{r:2+ns.length,c:5}}) };
    return ws;
  }

  /* ── Repasses ─────────────────────────────────────────── */
  function buildRepasses(repasses, ano) {
    const ws = {};
    ws['!cols'] = [{wch:6},{wch:12},{wch:8},{wch:14},{wch:36}];
    ws['!merges'] = [];
    let r = 0;

    merge(ws, r, 0, r, 4);
    ws[XLSX.utils.encode_cell({r, c:0})] = titCell(`REPASSES RECEBIDOS — ${ano}`);
    r += 2;

    hdrRow(ws, r, ['Mês','Data','Tipo','Valor (R$)','Descrição']);
    r++;

    const rs = repasses.filter(rp => rp.ano===ano && !rp.deleted)
      .sort((a,b) => a.mes-b.mes || a.data.localeCompare(b.data));
    rs.forEach(rp => {
      ws[XLSX.utils.encode_cell({r,c:0})] = strCenter(MESES[rp.mes-1]);
      ws[XLSX.utils.encode_cell({r,c:1})] = strCenter(rp.data);
      ws[XLSX.utils.encode_cell({r,c:2})] = strCenter(rp.tipo);
      ws[XLSX.utils.encode_cell({r,c:3})] = numCell(rp.valor);
      ws[XLSX.utils.encode_cell({r,c:4})] = strCell(rp.descricao||'');
      r++;
    });

    r++;
    ['RDM','RDA'].forEach(t => {
      const tot = rs.filter(r=>r.tipo===t).reduce((a,r)=>a+cur(r.valor),0);
      merge(ws, r, 0, r, 2);
      ws[XLSX.utils.encode_cell({r,c:0})] = { t:'s', v:`TOTAL ${t}`, s:{ font:FONT_TOT, border:BORDER_BOTTOM, alignment:ALIGN_R } };
      ws[XLSX.utils.encode_cell({r,c:3})] = totCell(tot);
      r++;
    });

    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r:r-1,c:4}});
    return ws;
  }

  /* ── Equipe (dashboard gestor) ───────────────────────── */
  function buildEquipe(notas, repasses, collabs, mes, ano, anterior, cv, avisos = []) {
    /* C.V. (04/11/2026, decisão do dono): quadro próprio, cartão e reembolso até o fim do mês, igual ao PDF da equipe. Na tabela de
       baixo o gasto do cartão entraria como dívida; somar os dois regimes num total daria um número sem sentido. */
    const cvs = collabs.filter(c => c.regime === 'cv' && c.role !== 'contabilidade');
    const idsCv = new Set(cvs.map(c => c.id));
    collabs = collabs.filter(c => !idsCv.has(c.id));
    const ws = {};
    ws['!cols'] = [{wch:16},{wch:24},{wch:14},{wch:14},{wch:14},{wch:16},{wch:14},{wch:14},{wch:14},{wch:16}];
    ws['!merges'] = [];
    let r = 0;

    merge(ws, r, 0, r, 9);
    ws[XLSX.utils.encode_cell({r, c:0})] = titCell(`PETERMANN — RELATÓRIO DA EQUIPE`);
    r++;
    merge(ws, r, 0, r, 9);
    ws[XLSX.utils.encode_cell({r, c:0})] = subCell(`Mês: ${MESES[mes-1]}/${ano}      Gerado em ${FusoBR.data(new Date())}      `
      + (anterior ? 'Saldo Acum. = Anterior (todos os meses antes deste) + Repasse − Gasto' : 'Saldo anterior NÃO incluído (histórico indisponível): saldo só do mês'));
    r++;
    avisos.forEach(a => { merge(ws, r, 0, r, 9); ws[XLSX.utils.encode_cell({r, c:0})] = avisoCell(a); r++; });
    if (!avisos.length) r++;   // sem aviso, a linha em branco de sempre

    hdrRow(ws, r, ['Núcleo','Colaborador','RDM Anterior','RDM Gasto','RDM Repasse','RDM Saldo Acum.','RDA Anterior','RDA Gasto','RDA Repasse','RDA Saldo Acum.']);
    r++;

    let tRDMa=0,tRDMg=0,tRDMr=0,tRDAa=0,tRDAg=0,tRDAr=0;
    const nucs = {};
    collabs.forEach(c => { (nucs[c.nucleo] = nucs[c.nucleo]||[]).push(c); });

    for (const [nucleo, membros] of Object.entries(nucs).sort()) {
      const sorted = membros.sort((a,b)=>(a.nome||'').localeCompare(b.nome||''));
      sorted.forEach(c => {
        const cns = notas.filter(n=>n.user_id===c.id);
        const crs = repasses.filter(r=>r.user_id===c.id);
        const ant = (anterior && anterior[c.id]) || { RDM: 0, RDA: 0 };
        const rdmG = cns.filter(n=>n.tipo==='RDM').reduce((s,n)=>s+Number(n.valor||0),0);
        const rdmR = crs.filter(r=>r.tipo==='RDM').reduce((s,r)=>s+Number(r.valor||0),0);
        const rdaG = cns.filter(n=>n.tipo==='RDA').reduce((s,n)=>s+Number(n.valor||0),0);
        const rdaR = crs.filter(r=>r.tipo==='RDA').reduce((s,r)=>s+Number(r.valor||0),0);
        tRDMa+=ant.RDM; tRDMg+=rdmG; tRDMr+=rdmR; tRDAa+=ant.RDA; tRDAg+=rdaG; tRDAr+=rdaR;
        const sRDM=cur(ant.RDM+rdmR-rdmG), sRDA=cur(ant.RDA+rdaR-rdaG);
        ws[XLSX.utils.encode_cell({r,c:0})] = strCell(nucleo);
        ws[XLSX.utils.encode_cell({r,c:1})] = strCell(c.nome||c.email);
        ws[XLSX.utils.encode_cell({r,c:2})] = ant.RDM<0?numNeg(ant.RDM):numCell(ant.RDM);
        ws[XLSX.utils.encode_cell({r,c:3})] = numCell(rdmG);
        ws[XLSX.utils.encode_cell({r,c:4})] = numCell(rdmR);
        ws[XLSX.utils.encode_cell({r,c:5})] = sRDM<0?numNeg(sRDM):numCell(sRDM);
        ws[XLSX.utils.encode_cell({r,c:6})] = ant.RDA<0?numNeg(ant.RDA):numCell(ant.RDA);
        ws[XLSX.utils.encode_cell({r,c:7})] = numCell(rdaG);
        ws[XLSX.utils.encode_cell({r,c:8})] = numCell(rdaR);
        ws[XLSX.utils.encode_cell({r,c:9})] = sRDA<0?numNeg(sRDA):numCell(sRDA);
        r++;
      });
    }

    r++;
    const sTRDM=cur(tRDMa+tRDMr-tRDMg), sTRDA=cur(tRDAa+tRDAr-tRDAg);
    merge(ws, r, 0, r, 1);
    const celTotal = v => ({ t:'s', v, s:{ font:{...FONT_TOT,color:{rgb:COR.branco}}, fill:FILL_HDR, border:BORDER_THIN, alignment:ALIGN_C } });
    ws[XLSX.utils.encode_cell({r,c:0})] = celTotal(cvs.length ? 'TOTAL DO REGIME RDM/RDA' : 'TOTAL GERAL');
    ws[XLSX.utils.encode_cell({r,c:2})] = tRDMa<0?totNeg(tRDMa):totCell(tRDMa);
    ws[XLSX.utils.encode_cell({r,c:3})] = totCell(tRDMg);
    ws[XLSX.utils.encode_cell({r,c:4})] = totCell(tRDMr);
    ws[XLSX.utils.encode_cell({r,c:5})] = sTRDM<0?totNeg(sTRDM):totCell(sTRDM);
    ws[XLSX.utils.encode_cell({r,c:6})] = tRDAa<0?totNeg(tRDAa):totCell(tRDAa);
    ws[XLSX.utils.encode_cell({r,c:7})] = totCell(tRDAg);
    ws[XLSX.utils.encode_cell({r,c:8})] = totCell(tRDAr);
    ws[XLSX.utils.encode_cell({r,c:9})] = sTRDA<0?totNeg(sTRDA):totCell(sTRDA);

    let ultCol = 9;
    if (cvs.length) {
      ws['!cols'].push({wch:14},{wch:14},{wch:14});
      r += 2;
      merge(ws, r, 0, r, 12);
      ws[XLSX.utils.encode_cell({r,c:0})] = subCell(`REGIME C.V. — até o fim de ${MESES[mes-1]}/${ano}, como o PDF da equipe: Saldo = Saldo do ano anterior + Recebido − Gasto, de janeiro até o mês do relatório; negativo = a empresa deve. Cartão e reembolso são contas separadas, não se somam.`);
      r++;
      if (!cv) {
        merge(ws, r, 0, r, 12);
        ws[XLSX.utils.encode_cell({r,c:0})] = subCell(`Saldo do C.V. não calculado (histórico indisponível): ${cvs.map(c => c.nome||c.email).join(', ')}`);
      } else {
        const m = MESES[mes-1];
        const titulos = ['Núcleo','Colaborador','Cartão Ano Anterior',`Cartão Recargas até ${m}`,`Cartão Gasto até ${m}`,`Cartão Saldo fim ${m}`,'Reemb. Ano Anterior',`Reemb. Gasto até ${m}`,`Reemb. Recebido até ${m}`,`Reemb. Saldo fim ${m}`,`Saldo RDM fim ${m}`,`Saldo RDA fim ${m}`,`Gasto em ${m}`];
        hdrRow(ws, r, titulos);
        /* 04/11/2026: com o período o título passa da coluna e cortaria; alarga, porque o SheetJS gratuito ignora a quebra de linha do estilo */
        titulos.forEach((t,i) => { ws['!cols'][i].wch = Math.max(ws['!cols'][i].wch, t.length + 1); });
        r++;
        const din = v => v<0?numNeg(v):numCell(v), tot = v => v<0?totNeg(v):totCell(v);
        const colunas = x => [x.cartao.ant, x.cartao.rec, x.cartao.gasto, x.cartao.saldo, x.reemb.ant, x.reemb.gasto, x.reemb.rec, x.reemb.saldo, x.RDM.saldo, x.RDA.saldo];
        const zero = { ant:0, rec:0, gasto:0, saldo:0 };
        const somas = Array(11).fill(0);
        [...cvs].sort((a,b)=>String(a.nucleo||'').localeCompare(String(b.nucleo||''))||(a.nome||'').localeCompare(b.nome||'')).forEach(c => {
          const x = cv[c.id] || { cartao:zero, reemb:zero, RDM:zero, RDA:zero };
          const vals = [...colunas(x), notas.filter(n=>n.user_id===c.id).reduce((s,n)=>s+Number(n.valor||0),0)];
          ws[XLSX.utils.encode_cell({r,c:0})] = strCell(c.nucleo);
          ws[XLSX.utils.encode_cell({r,c:1})] = strCell(c.nome||c.email);
          vals.forEach((v,i) => { somas[i] += v; ws[XLSX.utils.encode_cell({r,c:i+2})] = din(v); });
          r++;
        });
        merge(ws, r, 0, r, 1);
        ws[XLSX.utils.encode_cell({r,c:0})] = celTotal('TOTAL DO REGIME C.V.');
        somas.forEach((v,i) => { ws[XLSX.utils.encode_cell({r,c:i+2})] = tot(cur(v)); });
      }
      ultCol = 12;
    }

    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r,c:ultCol}});
    return ws;
  }

  /* ── Exportar Excel anual ─────────────────────────────── */
  /* Faturamento (pagamento='empresa', 25/09/2026): a empresa pagou direto,
     não é gasto DO colaborador — sai de toda planilha/CSV individual. */
  const _semFaturamento = notas => notas.filter(n => n.pagamento !== 'empresa');

  /* Repasse que CONTA no saldo (01/10/2026): sem apagado, sem pedido pendente
     (o pedido atendido continua na lista ao lado do recebido que o gestor cria
     ao pagar - somar os dois contava o repasse em dobro) e sem recarga do cartao
     (CV). Mesma definicao do app (_repasseEhRecebido + _repasseEhCarteira). */
  const _PEDIDO = ['requested', 'request', 'pedido', 'solicitado'];
  const _soRecebidos = repasses => repasses.filter(r => !r.deleted
    && !_PEDIDO.includes(String(r.kind || '').toLowerCase()) && r.destino !== 'recarga');

  /* abertura = { RDM, RDA } - saldo que o colaborador trazia de anos anteriores (null se o
     historico nao carregou). Janeiro e o saldo acumulado partem dele (01/10/2026). */
  function exportarAnual(ano, notas, repasses, colab, abertura, avisos = []) {
    notas = _semFaturamento(notas);
    repasses = _soRecebidos(repasses);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildResumo(notas,repasses,ano,colab,abertura,avisos), 'RESUMO');
    XLSX.utils.book_append_sheet(wb, buildRDM(notas,repasses,ano,abertura), 'RDM Detalhado');
    XLSX.utils.book_append_sheet(wb, buildRDA(notas,repasses,ano),          'RDA Detalhado');
    XLSX.utils.book_append_sheet(wb, buildRepasses(repasses,ano),           'Repasses');
    const nome = (colab.nome||'colab').replace(/\s+/g,'_');
    XLSX.writeFile(wb, `Petermann_${nome}_${ano}.xlsx`);
  }

  /* ── Exportar Equipe (gestor) ─────────────────────────── */
  function exportarEquipe(notas, repasses, collabs, mes, ano, gestorNome, anterior, cv, avisos = []) {
    notas = _semFaturamento(notas);
    repasses = _soRecebidos(repasses);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildEquipe(notas,repasses,collabs,mes,ano,anterior,cv,avisos), 'EQUIPE');
    const nome = (gestorNome||'equipe').replace(/\s+/g,'_');
    XLSX.writeFile(wb, `Petermann_${nome}_Equipe_${MESES[mes-1]}${ano}.xlsx`);
  }

  /* ── Exportar CSV mensal ──────────────────────────────── */
  function exportarCSV(mes, ano, notas, repasses, colab, avisos = []) {
    notas = _semFaturamento(notas);
    const mesNome = MESES[mes-1];
    const rows = [
      ['PETERMANN', `${mesNome}/${ano}`, '', '', colab.nome||''], ...avisos.map(a => [a]), [''],
      ['Tipo','Subtipo','Data','CNPJ','Razão Social','Valor (R$)','Captura'],
    ];
    notas.filter(n=>n.mes===mes && n.ano===ano && !n.deleted)
      .sort((a,b)=>a.data.localeCompare(b.data))
      .forEach(n => rows.push([n.tipo, n.subtipo||'', n.data,
        BrasilAPI.paraPlanilha(n.cnpj), n.razao_social||'', brl(n.valor), n.metodo_captura||'']));
    const rs = _soRecebidos(repasses).filter(r=>r.mes===mes && r.ano===ano);
    if (rs.length) {
      rows.push(['']); rows.push(['── REPASSES ──']);
      rs.forEach(r => rows.push([r.tipo,'repasse',r.data,'',r.descricao||'',brl(r.valor),'']));
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{wch:8},{wch:14},{wch:12},{wch:20},{wch:34},{wch:14},{wch:10}];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, mesNome);
    const nome = (colab.nome||'notas').replace(/\s+/g,'_');
    XLSX.writeFile(wb, `Petermann_${nome}_${mesNome}${ano}.csv`);
  }

  /* ── Frota / KM (16/09/2026) ─────────────────────────────
     anual = resposta de GET /frota/anual: veículo × mês, motorista × mês e
     todas as leituras do ano com o km rodado de cada uma. */
  function intCell(v, bold = false) {
    return { t:'n', v:Math.round(Number(v||0)), s:{ font: bold ? FONT_TOT : FONT_BODY, border:BORDER_THIN, alignment:ALIGN_R, numFmt:'#,##0' } };
  }
  function _abaMeses(titulo, linhas, rotulo, extras) {
    const ws = {}; ws['!merges'] = []; let r = 0;
    const nCols = 1 + 12 + 1 + (extras?.length || 0);
    ws['!cols'] = [{wch:22}, ...Array(12).fill({wch:8}), {wch:11}, ...(extras || []).map(() => ({wch:14}))];
    merge(ws, r, 0, r, nCols - 1);
    ws[XLSX.utils.encode_cell({r, c:0})] = titCell(titulo); r += 2;
    hdrRow(ws, r, [rotulo, ...MESES, 'TOTAL', ...(extras || []).map(e => e.titulo)]); r++;
    const tot = Array(12).fill(0);
    linhas.forEach(l => {
      ws[XLSX.utils.encode_cell({r,c:0})] = strCell(l.nome);
      l.meses.forEach((v, i) => { ws[XLSX.utils.encode_cell({r,c:1+i})] = intCell(v); tot[i] += Number(v||0); });
      ws[XLSX.utils.encode_cell({r,c:13})] = intCell(l.total, true);
      (extras || []).forEach((e, j) => { ws[XLSX.utils.encode_cell({r,c:14+j})] = e.num ? intCell(l[e.campo]) : strCell(l[e.campo]); });
      r++;
    });
    ws[XLSX.utils.encode_cell({r,c:0})] = { t:'s', v:'TOTAL', s:{ font:FONT_TOT, border:BORDER_BOTTOM, alignment:ALIGN_L } };
    tot.forEach((v, i) => { ws[XLSX.utils.encode_cell({r,c:1+i})] = intCell(v, true); });
    ws[XLSX.utils.encode_cell({r,c:13})] = intCell(tot.reduce((a,b)=>a+b,0), true);
    ws['!freeze'] = { xSplit:1, ySplit:3 };
    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r, c:nCols-1}});
    return ws;
  }
  function buildFrotaLeituras(anual) {
    const ws = {}; ws['!merges'] = []; let r = 0;
    ws['!cols'] = [{wch:12},{wch:6},{wch:10},{wch:16},{wch:22},{wch:12},{wch:11},{wch:36},{wch:6}];
    merge(ws, r, 0, r, 8);
    ws[XLSX.utils.encode_cell({r,c:0})] = titCell(`LEITURAS DE ODÔMETRO — ${anual.ano}`); r += 2;
    hdrRow(ws, r, ['Data','Mês','Placa','Modelo','Motorista','Odômetro','Km rodado','Observação','Foto']); r++;
    [...(anual.leituras||[])].sort((a,b) => a.data.localeCompare(b.data) || a.odometro - b.odometro).forEach(l => {
      ws[XLSX.utils.encode_cell({r,c:0})] = strCenter(l.data.split('-').reverse().join('/'));
      ws[XLSX.utils.encode_cell({r,c:1})] = strCenter(MESES[l.mes-1]);
      ws[XLSX.utils.encode_cell({r,c:2})] = strCenter(l.placa);
      ws[XLSX.utils.encode_cell({r,c:3})] = strCell(l.modelo||'');
      ws[XLSX.utils.encode_cell({r,c:4})] = strCell(l.motorista||'');
      ws[XLSX.utils.encode_cell({r,c:5})] = intCell(l.odometro);
      ws[XLSX.utils.encode_cell({r,c:6})] = intCell(l.km_rodado);
      ws[XLSX.utils.encode_cell({r,c:7})] = strCell(l.observacao||'');
      ws[XLSX.utils.encode_cell({r,c:8})] = strCenter(l.foto ? 'sim' : '');
      r++;
    });
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:2,c:0},e:{r:Math.max(3,r-1),c:8}}) };
    ws['!freeze'] = { xSplit:0, ySplit:3 };
    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(3,r-1),c:8}});
    return ws;
  }
  function exportarFrota(anual) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, _abaMeses(`FROTA — KM POR VEÍCULO — ${anual.ano}`,
      (anual.veiculos||[]).map(v => ({ nome: `${v.placa}${v.modelo ? ' · ' + v.modelo : ''}`, meses: v.meses, total: v.total, leituras: v.leituras, odo_ini: v.odometro_inicial ?? '', odo_fim: v.odometro_final ?? '', resp: v.responsavel_nome || '' })),
      'Veículo', [{titulo:'Leituras',campo:'leituras',num:true},{titulo:'Odômetro inicial',campo:'odo_ini',num:true},{titulo:'Odômetro final',campo:'odo_fim',num:true},{titulo:'Responsável',campo:'resp'}]), 'VEÍCULOS');
    XLSX.utils.book_append_sheet(wb, _abaMeses(`FROTA — KM POR MOTORISTA — ${anual.ano}`,
      (anual.motoristas||[]).map(m => ({ nome: m.nome, meses: m.meses, total: m.total, leituras: m.leituras })),
      'Motorista', [{titulo:'Leituras',campo:'leituras',num:true}]), 'MOTORISTAS');
    XLSX.utils.book_append_sheet(wb, buildFrotaLeituras(anual), 'LEITURAS');
    XLSX.writeFile(wb, `Petermann_Frota_${anual.ano}.xlsx`);
  }
  function exportarFrotaCSV(anual, mes) {
    const rows = [['PETERMANN — FROTA', `${MESES[mes-1]}/${anual.ano}`], [''], ['Data','Placa','Modelo','Motorista','Odômetro','Km rodado','Observação']];
    (anual.leituras||[]).filter(l => l.mes === mes).sort((a,b) => a.data.localeCompare(b.data) || a.odometro - b.odometro)
      .forEach(l => rows.push([l.data, l.placa, l.modelo||'', l.motorista||'', l.odometro, l.km_rodado, l.observacao||'']));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, MESES[mes-1]);
    XLSX.writeFile(wb, `Petermann_Frota_${MESES[mes-1]}${anual.ano}.csv`);
  }

  /* ── Planilha de KM por colaborador (31/10/2026) ─────────
     Mesma base de GET /frota/anual (leituras com user_id). `pessoas` = [{user_id, nome}] escolhidas na tela;
     junto = um arquivo com RESUMO (pessoa × mês), DIA A DIA do mês e uma aba por pessoa;
     separado = um arquivo por pessoa (RESUMO + DIA A DIA + LEITURAS dela). */
  const _nomeAba = (nome, usados) => {
    let b = String(nome || 'Colaborador').replace(/[\\\/?*\[\]:]/g, ' ').trim().slice(0, 28) || 'Colaborador', n = b, i = 2;
    while (usados.has(n.toLowerCase())) n = `${b.slice(0, 26)} ${i++}`;
    usados.add(n.toLowerCase());
    return n;
  };
  /* Visual da planilha de KM: mesmo padrão do modelo de notas (título verde, subtítulo, cabeçalho verde,
     zebrado, TOTAL em faixa verde) + mapa de calor no km e filtro em todas as abas. O TOTAL usa SUBTOTAL,
     então acompanha o filtro (filtrou um colaborador/veículo, o total é só dele). */
  const KM_FMT = '#,##0;-#,##0;"–"';
  const FILL_ZEBRA = { fgColor:{rgb:'F0F4F1'}, patternType:'solid' };
  const FILL_FDS   = { fgColor:{rgb:'FEF3C7'}, patternType:'solid' };
  const FILL_TOTKM = { fgColor:{rgb:'D1FAE5'}, patternType:'solid' };
  const BORDER_TOT = { top:{style:'medium',color:{rgb:COR.verde}}, bottom:{style:'medium',color:{rgb:COR.verde}}, left:{style:'thin',color:{rgb:COR.texto2}}, right:{style:'thin',color:{rgb:COR.texto2}} };
  const calor = (v, max) => {
    if (!v || !max) return null;
    const p = v / max;
    return { fgColor:{rgb: p > 0.66 ? '95D5B2' : p > 0.33 ? 'B7E4C7' : 'D8F3DC'}, patternType:'solid' };
  };
  const kmNum = (v, { bold = false, fill = null } = {}) => ({ t:'n', v:Math.round(Number(v || 0)), s:{ font: bold ? { ...FONT_BODY, bold:true } : FONT_BODY, border:BORDER_THIN, alignment:ALIGN_R, numFmt:KM_FMT, ...(fill ? { fill } : {}) } });
  const kmTxt = (v, centro, fill) => { const c = centro ? strCenter(v) : strCell(v); if (fill) c.s = { ...c.s, fill }; return c; };
  const kmTot = (v, formula) => { const c = { t:'n', v:Math.round(Number(v || 0)), s:{ font:FONT_TOT, fill:FILL_TOTKM, border:BORDER_TOT, alignment:ALIGN_R, numFmt:'#,##0' } }; if (formula) c.f = formula; return c; };
  const kmTotRot = (v, centro) => ({ t:'s', v, s:{ font:{ ...FONT_TOT, color:{rgb:COR.branco} }, fill:FILL_HDR, border:BORDER_TOT, alignment: centro ? ALIGN_C : ALIGN_L } });
  const colL = c => XLSX.utils.encode_col(c);
  const SEMANA = ['dom','seg','ter','qua','qui','sex','sáb'];

  function _cabecalhoKm(ws, titulo, sub, nCols) {
    merge(ws, 0, 0, 0, nCols - 1);
    ws[XLSX.utils.encode_cell({r:0,c:0})] = titCell(titulo);
    merge(ws, 1, 0, 1, nCols - 1);
    ws[XLSX.utils.encode_cell({r:1,c:0})] = subCell(sub);
    ws['!rows'] = [{ hpt:26 }, { hpt:16 }, { hpt:22 }];
  }

  function _abaDiaADia(anual, pessoas, mes) {
    const ws = {}; ws['!merges'] = [];
    const varias = pessoas.length > 1;
    const dias = new Date(anual.ano, mes, 0).getDate(), nC = 2 + pessoas.length + (varias ? 1 : 0);
    const largura = Math.max(14, Math.min(24, Math.max(...pessoas.map(p => String(p.nome).length)) + 2));
    ws['!cols'] = [{wch:12}, {wch:7}, ...pessoas.map(() => ({wch:largura})), ...(varias ? [{wch:14}] : [])];
    _cabecalhoKm(ws, `KM POR DIA — ${MESES[mes-1].toUpperCase()}/${anual.ano}`, 'Km rodado por dia, por colaborador. Sábados e domingos em amarelo; quanto mais km, mais forte o verde. Use as setas do cabeçalho para filtrar.', nC);
    hdrRow(ws, 2, ['Data', 'Dia', ...pessoas.map(p => p.nome), ...(varias ? ['TOTAL DO DIA'] : [])]);
    const porPD = {};
    (anual.leituras || []).filter(l => l.mes === mes).forEach(l => { const k = `${l.user_id}|${Number(l.data.slice(8))}`; porPD[k] = (porPD[k] || 0) + (l.km_rodado || 0); });
    const max = Math.max(0, ...Object.values(porPD));
    const tot = pessoas.map(() => 0); let r = 3; const r0 = r;
    for (let d = 1; d <= dias; d++, r++) {
      const dow = new Date(Date.UTC(anual.ano, mes - 1, d)).getUTCDay(), fds = dow === 0 || dow === 6;
      const base = fds ? FILL_FDS : (d % 2 === 0 ? FILL_ZEBRA : null);
      ws[XLSX.utils.encode_cell({r,c:0})] = kmTxt(`${String(d).padStart(2,'0')}/${String(mes).padStart(2,'0')}/${anual.ano}`, true, base);
      ws[XLSX.utils.encode_cell({r,c:1})] = kmTxt(SEMANA[dow], true, base);
      let soma = 0;
      pessoas.forEach((p, j) => { const v = porPD[`${p.user_id}|${d}`] || 0; soma += v; tot[j] += v; ws[XLSX.utils.encode_cell({r,c:2+j})] = kmNum(v, { fill: calor(v, max) || base }); });
      if (varias) ws[XLSX.utils.encode_cell({r,c:2+pessoas.length})] = kmNum(soma, { bold:true, fill: base });
    }
    const rl = r - 1;
    ws[XLSX.utils.encode_cell({r,c:0})] = kmTotRot('TOTAL', true);
    ws[XLSX.utils.encode_cell({r,c:1})] = kmTotRot('', true);
    pessoas.forEach((p, j) => { ws[XLSX.utils.encode_cell({r,c:2+j})] = kmTot(tot[j], `SUBTOTAL(109,${colL(2+j)}${r0+1}:${colL(2+j)}${rl+1})`); });
    if (varias) ws[XLSX.utils.encode_cell({r,c:2+pessoas.length})] = kmTot(tot.reduce((a,b)=>a+b,0), `SUBTOTAL(109,${colL(2+pessoas.length)}${r0+1}:${colL(2+pessoas.length)}${rl+1})`);
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:2,c:0},e:{r:rl,c:nC-1}}) };
    ws['!freeze'] = { xSplit:2, ySplit:3 };
    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r,c:nC-1}});
    return ws;
  }

  function _abaLeiturasPessoa(anual, p) {
    const ws = {}; ws['!merges'] = [];
    ws['!cols'] = [{wch:12},{wch:7},{wch:7},{wch:11},{wch:16},{wch:14},{wch:12},{wch:12},{wch:40}];
    _cabecalhoKm(ws, `${p.nome} — LEITURAS DE ${anual.ano}`, 'Km rodado = leitura menos a leitura anterior do mesmo veículo (que pode ser de outra pessoa). Filtre por mês, placa ou dia da semana nas setas do cabeçalho.', 9);
    hdrRow(ws, 2, ['Data', 'Dia', 'Mês', 'Placa', 'Modelo', 'Leitura anterior', 'Leitura', 'Km rodado', 'Observação']);
    const ls = (anual.leituras || []).filter(l => l.user_id === p.user_id).sort((a,b) => a.data.localeCompare(b.data) || a.odometro - b.odometro);
    const max = Math.max(0, ...ls.map(l => l.km_rodado || 0));
    let r = 3, soma = 0;
    ls.forEach((l, i) => {
      const dow = new Date(l.data + 'T00:00:00Z').getUTCDay();
      const base = (dow === 0 || dow === 6) ? FILL_FDS : (i % 2 ? FILL_ZEBRA : null);
      ws[XLSX.utils.encode_cell({r,c:0})] = kmTxt(l.data.split('-').reverse().join('/'), true, base);
      ws[XLSX.utils.encode_cell({r,c:1})] = kmTxt(SEMANA[dow], true, base);
      ws[XLSX.utils.encode_cell({r,c:2})] = kmTxt(MESES[l.mes-1], true, base);
      ws[XLSX.utils.encode_cell({r,c:3})] = kmTxt(l.placa, true, base);
      ws[XLSX.utils.encode_cell({r,c:4})] = kmTxt(l.modelo || '', false, base);
      ws[XLSX.utils.encode_cell({r,c:5})] = l.odometro_anterior != null ? kmNum(l.odometro_anterior, { fill: base }) : kmTxt('', false, base);
      ws[XLSX.utils.encode_cell({r,c:6})] = kmNum(l.odometro, { fill: base });
      ws[XLSX.utils.encode_cell({r,c:7})] = kmNum(l.km_rodado, { bold:true, fill: calor(l.km_rodado, max) || base });
      ws[XLSX.utils.encode_cell({r,c:8})] = kmTxt(l.observacao || '', false, base);
      soma += l.km_rodado || 0; r++;
    });
    const rl = Math.max(3, r - 1);
    ws[XLSX.utils.encode_cell({r,c:0})] = kmTotRot('TOTAL', true);
    for (let c = 1; c <= 8; c++) if (c !== 7) ws[XLSX.utils.encode_cell({r,c})] = kmTotRot('', true);
    ws[XLSX.utils.encode_cell({r,c:7})] = kmTot(soma, `SUBTOTAL(109,H4:H${rl+1})`);
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:2,c:0},e:{r:rl,c:8}}) };
    ws['!freeze'] = { xSplit:0, ySplit:3 };
    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r,c:8}});
    return ws;
  }

  function _resumoPessoas(anual, pessoas) {
    const ws = {}; ws['!merges'] = [];
    const nC = 15;
    const linhas = pessoas.map(p => {
      const m = (anual.motoristas || []).find(x => x.user_id === p.user_id);
      return { nome: p.nome, meses: m?.meses || Array(12).fill(0), total: m?.total || 0, leituras: m?.leituras || 0 };
    });
    ws['!cols'] = [{wch:Math.max(22, Math.min(32, Math.max(...linhas.map(l => String(l.nome).length)) + 2))}, ...Array(12).fill({wch:8}), {wch:11}, {wch:10}];
    _cabecalhoKm(ws, `KM POR COLABORADOR — ${anual.ano}`, 'Km rodado por mês. Quanto mais km, mais forte o verde. Use as setas do cabeçalho para ordenar ou filtrar.', nC);
    hdrRow(ws, 2, ['Colaborador', ...MESES, 'TOTAL', 'Leituras']);
    const max = Math.max(0, ...linhas.flatMap(l => l.meses.map(Number)));
    let r = 3; const tot = Array(12).fill(0); let tl = 0;
    linhas.forEach((l, i) => {
      const base = i % 2 ? FILL_ZEBRA : null;
      ws[XLSX.utils.encode_cell({r,c:0})] = kmTxt(l.nome, false, base);
      l.meses.forEach((v, j) => { tot[j] += Number(v || 0); ws[XLSX.utils.encode_cell({r,c:1+j})] = kmNum(v, { fill: calor(Number(v), max) || base }); });
      ws[XLSX.utils.encode_cell({r,c:13})] = kmNum(l.total, { bold:true, fill: base });
      ws[XLSX.utils.encode_cell({r,c:14})] = kmNum(l.leituras, { fill: base });
      tl += l.leituras; r++;
    });
    const rl = Math.max(3, r - 1);
    ws[XLSX.utils.encode_cell({r,c:0})] = kmTotRot('TOTAL', false);
    for (let c = 1; c <= 14; c++) {
      const v = c <= 12 ? tot[c-1] : c === 13 ? tot.reduce((a,b)=>a+b,0) : tl;
      ws[XLSX.utils.encode_cell({r,c})] = kmTot(v, `SUBTOTAL(109,${colL(c)}4:${colL(c)}${rl+1})`);
    }
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:2,c:0},e:{r:rl,c:nC-1}}) };
    ws['!freeze'] = { xSplit:1, ySplit:3 };
    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r,c:nC-1}});
    return ws;
  }

  function exportarFrotaPlanilha(anual, pessoas, { mes, separado = false } = {}) {
    if (!pessoas?.length) throw new Error('Escolha ao menos um colaborador');
    const mesX = Math.min(12, Math.max(1, Number(mes) || 1));
    const montar = lista => {
      const wb = XLSX.utils.book_new(), usados = new Set(['resumo', 'dia a dia']);
      XLSX.utils.book_append_sheet(wb, _resumoPessoas(anual, lista), 'RESUMO');
      XLSX.utils.book_append_sheet(wb, _abaDiaADia(anual, lista, mesX), 'DIA A DIA');
      lista.forEach(p => XLSX.utils.book_append_sheet(wb, _abaLeiturasPessoa(anual, p), _nomeAba(p.nome, usados)));
      return wb;
    };
    const slug = s => String(s || 'colab').trim().replace(/\s+/g, '_').replace(/[^\w\-.À-ÿ]/g, '');
    if (!separado) {
      XLSX.writeFile(montar(pessoas), pessoas.length === 1 ? `Petermann_KM_${slug(pessoas[0].nome)}_${anual.ano}.xlsx` : `Petermann_KM_Selecionados_${anual.ano}.xlsx`);
      return pessoas.length;
    }
    pessoas.forEach((p, i) => setTimeout(() => XLSX.writeFile(montar([p]), `Petermann_KM_${slug(p.nome)}_${anual.ano}.xlsx`), i * 700));   // um por vez: o navegador barra vários downloads de uma vez
    return pessoas.length;
  }

  /* ── Ponto (18/09/2026) ──────────────────────────────────
     resumo = GET /ponto/resumo: pessoas (totais + por_dia), dias (espelho). */
  const hmx = min => { min = Math.max(0, Math.round(Number(min) || 0)); return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`; };
  function horaCell(min, bold = false) {
    return { t:'s', v: hmx(min), s:{ font: bold ? FONT_TOT : FONT_BODY, border:BORDER_THIN, alignment:ALIGN_R } };
  }
  function buildPontoResumo(resumo, feriados) {
    const ws = {}; ws['!merges'] = []; let r = 0;
    ws['!cols'] = [{wch:26},{wch:8},{wch:12},{wch:12},{wch:12},{wch:12},{wch:10},{wch:10},{wch:9},{wch:9},{wch:9}];
    merge(ws, r, 0, r, 10);
    ws[XLSX.utils.encode_cell({r,c:0})] = titCell(`PETERMANN — PONTO — ${MESES[resumo.mes-1]}/${resumo.ano}`); r++;
    merge(ws, r, 0, r, 10);
    ws[XLSX.utils.encode_cell({r,c:0})] = subCell(`Jornada: seg–sex 8h, sáb 4h. Extra 50% = além da jornada em dia útil. Extra 100% = domingos e feriados. Feriados do mês: ${(feriados||[]).filter(f => f.data.slice(0,7) === `${resumo.ano}-${String(resumo.mes).padStart(2,'0')}`).map(f => f.data.slice(8) + ' ' + f.nome).join('; ') || 'nenhum'}`); r += 2;
    hdrRow(ws, r, ['Colaborador','Dias','Trabalhadas','Normais','Extra 50%','Extra 100%','Domingos','Feriados','Folgas','Atestados','Faltas']); r++;
    (resumo.pessoas||[]).forEach(p => {
      ws[XLSX.utils.encode_cell({r,c:0})] = strCell(p.nome);
      ws[XLSX.utils.encode_cell({r,c:1})] = intCell(p.dias);
      ws[XLSX.utils.encode_cell({r,c:2})] = horaCell(p.minutos, true);
      ws[XLSX.utils.encode_cell({r,c:3})] = horaCell(p.normal);
      ws[XLSX.utils.encode_cell({r,c:4})] = horaCell(p.extra50);
      ws[XLSX.utils.encode_cell({r,c:5})] = horaCell(p.extra100);
      ws[XLSX.utils.encode_cell({r,c:6})] = intCell(p.domingos);
      ws[XLSX.utils.encode_cell({r,c:7})] = intCell(p.feriados);
      ws[XLSX.utils.encode_cell({r,c:8})] = intCell(p.folgas);
      ws[XLSX.utils.encode_cell({r,c:9})] = intCell(p.atestados);
      ws[XLSX.utils.encode_cell({r,c:10})] = intCell(p.faltas);
      r++;
    });
    const T = resumo.total || {};
    ws[XLSX.utils.encode_cell({r,c:0})] = { t:'s', v:'TOTAL', s:{ font:FONT_TOT, border:BORDER_BOTTOM, alignment:ALIGN_L } };
    ws[XLSX.utils.encode_cell({r,c:1})] = intCell(T.dias, true);
    ws[XLSX.utils.encode_cell({r,c:2})] = horaCell(T.minutos, true);
    ws[XLSX.utils.encode_cell({r,c:3})] = horaCell(T.normal, true);
    ws[XLSX.utils.encode_cell({r,c:4})] = horaCell(T.extra50, true);
    ws[XLSX.utils.encode_cell({r,c:5})] = horaCell(T.extra100, true);
    ws[XLSX.utils.encode_cell({r,c:6})] = intCell(T.domingos, true);
    ws[XLSX.utils.encode_cell({r,c:7})] = intCell(T.feriados, true);
    ws['!freeze'] = { xSplit:1, ySplit:4 };
    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r, c:10}});
    return ws;
  }
  function buildPontoEspelho(resumo) {
    const DIAS = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    const ws = {}; ws['!merges'] = []; let r = 0;
    ws['!cols'] = [{wch:12},{wch:5},{wch:24},{wch:9},{wch:9},{wch:9},{wch:9},{wch:11},{wch:10},{wch:11},{wch:12},{wch:14},{wch:36}];
    merge(ws, r, 0, r, 12);
    ws[XLSX.utils.encode_cell({r,c:0})] = titCell(`ESPELHO DE PONTO — ${MESES[resumo.mes-1]}/${resumo.ano}`); r += 2;
    hdrRow(ws, r, ['Data','Dia','Colaborador','Entrada','Saída int.','Volta int.','Saída','Trabalhadas','Extra 50%','Extra 100%','Tipo do dia','Domingo/Feriado','Observação']); r++;
    [...(resumo.dias||[])].sort((a,b) => a.data.localeCompare(b.data) || String(a.user_nome).localeCompare(String(b.user_nome))).forEach(d => {
      const esp = d.feriado ? `Feriado: ${d.feriado}` : (d.domingo ? 'Domingo' : '');
      const fill = d.feriado || d.domingo ? FILL_RDM : null;
      const c = (cell) => fill ? { ...cell, s:{ ...cell.s, fill } } : cell;
      ws[XLSX.utils.encode_cell({r,c:0})] = c(strCenter(d.data.split('-').reverse().join('/')));
      ws[XLSX.utils.encode_cell({r,c:1})] = c(strCenter(DIAS[d.dia_semana]));
      ws[XLSX.utils.encode_cell({r,c:2})] = c(strCell(d.user_nome||''));
      ws[XLSX.utils.encode_cell({r,c:3})] = c(strCenter(d.entrada||''));
      ws[XLSX.utils.encode_cell({r,c:4})] = c(strCenter(d.saida_intervalo||''));
      ws[XLSX.utils.encode_cell({r,c:5})] = c(strCenter(d.volta_intervalo||''));
      ws[XLSX.utils.encode_cell({r,c:6})] = c(strCenter(d.saida||''));
      ws[XLSX.utils.encode_cell({r,c:7})] = c(horaCell(d.minutos));
      ws[XLSX.utils.encode_cell({r,c:8})] = c(horaCell(d.extra50));
      ws[XLSX.utils.encode_cell({r,c:9})] = c(horaCell(d.extra100));
      ws[XLSX.utils.encode_cell({r,c:10})] = c(strCenter(d.tipo_dia + (d.aberto ? ' (em aberto)' : '')));
      ws[XLSX.utils.encode_cell({r,c:11})] = c(strCell(esp));
      ws[XLSX.utils.encode_cell({r,c:12})] = c(strCell(d.observacao||''));
      r++;
    });
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:2,c:0},e:{r:Math.max(3,r-1),c:12}}) };
    ws['!freeze'] = { xSplit:0, ySplit:3 };
    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(3,r-1),c:12}});
    return ws;
  }
  function buildPontoCalendario(resumo) {
    const nd = new Date(resumo.ano, resumo.mes, 0).getDate();
    const ws = {}; ws['!merges'] = []; let r = 0;
    ws['!cols'] = [{wch:24}, ...Array(nd).fill({wch:6}), {wch:10}];
    merge(ws, r, 0, r, nd + 1);
    ws[XLSX.utils.encode_cell({r,c:0})] = titCell(`HORAS POR DIA — ${MESES[resumo.mes-1]}/${resumo.ano}`); r += 2;
    hdrRow(ws, r, ['Colaborador', ...Array.from({length: nd}, (_, i) => String(i+1)), 'Total']); r++;
    (resumo.pessoas||[]).forEach(p => {
      ws[XLSX.utils.encode_cell({r,c:0})] = strCell(p.nome);
      for (let i = 0; i < nd; i++) {
        const m = p.por_dia?.[i];
        ws[XLSX.utils.encode_cell({r,c:1+i})] = m == null ? strCenter('') : horaCell(m);
      }
      ws[XLSX.utils.encode_cell({r,c:1+nd})] = horaCell(p.minutos, true);
      r++;
    });
    ws['!freeze'] = { xSplit:1, ySplit:3 };
    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(3,r-1),c:nd+1}});
    return ws;
  }
  function exportarPonto(resumo, feriados) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildPontoResumo(resumo, feriados), 'RESUMO');
    XLSX.utils.book_append_sheet(wb, buildPontoEspelho(resumo), 'ESPELHO');
    XLSX.utils.book_append_sheet(wb, buildPontoCalendario(resumo), 'DIAS');
    XLSX.writeFile(wb, `Petermann_Ponto_${MESES[resumo.mes-1]}${resumo.ano}.xlsx`);
  }
  function exportarPontoCSV(resumo) {
    const rows = [['PETERMANN — PONTO', `${MESES[resumo.mes-1]}/${resumo.ano}`], [''], ['Data','Colaborador','Entrada','Saída int.','Volta int.','Saída','Trabalhadas','Extra 50%','Extra 100%','Tipo','Observação']];
    [...(resumo.dias||[])].sort((a,b) => a.data.localeCompare(b.data)).forEach(d => rows.push([d.data, d.user_nome||'', d.entrada||'', d.saida_intervalo||'', d.volta_intervalo||'', d.saida||'', hmx(d.minutos), hmx(d.extra50), hmx(d.extra100), d.tipo_dia, d.observacao||'']));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, MESES[resumo.mes-1]);
    XLSX.writeFile(wb, `Petermann_Ponto_${MESES[resumo.mes-1]}${resumo.ano}.csv`);
  }

  /* ── Atividade em campo (08/11/2026) ─────────────────────
     Só gestor/admin. A = Campo.agregar(lista): mesmos números do Painel da tela.
     RESUMO (dashboard) · DIAS (colaborador × dia) · REGISTROS (uma linha por atividade, com links do mapa). */
  const _campoTZ = () => FusoBR.TZ;
  const _campoData = iso => iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: _campoTZ() }) : '';
  const _campoHora = iso => iso ? new Date(iso).toLocaleTimeString('pt-BR', { timeZone: _campoTZ(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
  const _campoMapa = (la, lo) => (la != null && lo != null) ? `https://www.google.com/maps?q=${Number(la).toFixed(6)},${Number(lo).toFixed(6)}` : '';
  const _campoFaz = f => { f = String(f || '').trim(); return /^faz/i.test(f) ? f : `Faz. ${f}`; };
  const _c = (ws, r, c, cell) => { ws[XLSX.utils.encode_cell({ r, c })] = cell; };
  const _rotTot = v => ({ t:'s', v, s:{ font:FONT_TOT, border:BORDER_BOTTOM, alignment:ALIGN_L } });
  const _secao = v => ({ t:'s', v, s:{ font:{ bold:true, sz:12, color:{rgb:COR.verde}, name:'Calibri' }, border:BORDER_BOTTOM, alignment:ALIGN_L } });

  function buildCampoResumo(A, filtro) {
    const ws = {}; ws['!merges'] = []; let r = 0;
    ws['!cols'] = [{wch:30},{wch:14},{wch:12},{wch:12},{wch:14},{wch:14},{wch:16}];
    merge(ws, r, 0, r, 6); _c(ws, r, 0, titCell(`PETERMANN — ATIVIDADE EM CAMPO / ACOMPANHAMENTO SOLIDÁRIO — ${MESES[A.mes-1]}/${A.ano}`)); r++;
    merge(ws, r, 0, r, 6); _c(ws, r, 0, subCell(`${filtro} · horas contam só atividades com início e fim; a que está em andamento aparece em Pendências.`)); r += 2;

    /* indicadores */
    const nPend = A.pend.abertas.length + A.pend.auto.length + A.pend.semloc.length;
    hdrRow(ws, r, ['Indicador', 'Valor']); r++;
    [['Horas em campo', horaCell(A.min, true)], ['Atividades', intCell(A.visitas)], ['Dias em campo (soma por pessoa)', intCell(A.diasPessoa)],
     ['Colaboradores', intCell(A.pessoas.length)], ['Fazendas', intCell(A.fazendas.length)], ['Campos', intCell(A.campos)], ['Pendências', intCell(nPend, nPend > 0)]]
      .forEach(([k, cell]) => { _c(ws, r, 0, strCell(k)); _c(ws, r, 1, cell); r++; });
    r++;

    /* por colaborador */
    _c(ws, r, 0, _secao('POR COLABORADOR')); r++;
    hdrRow(ws, r, ['Colaborador', 'Horas', 'Dias', 'Atividades', 'Em campo agora', 'Fim automático', 'Sem localização']); r++;
    A.pessoas.forEach(p => {
      _c(ws, r, 0, strCell(p.nome)); _c(ws, r, 1, horaCell(p.min)); _c(ws, r, 2, intCell(p.dias)); _c(ws, r, 3, intCell(p.visitas));
      _c(ws, r, 4, intCell(p.abertas)); _c(ws, r, 5, intCell(p.auto)); _c(ws, r, 6, intCell(p.semloc)); r++;
    });
    _c(ws, r, 0, _rotTot('TOTAL')); _c(ws, r, 1, horaCell(A.min, true)); _c(ws, r, 2, intCell(A.diasPessoa, true)); _c(ws, r, 3, intCell(A.visitas, true));
    _c(ws, r, 4, intCell(A.pend.abertas.length, true)); _c(ws, r, 5, intCell(A.pend.auto.length, true)); _c(ws, r, 6, intCell(A.pend.semloc.length, true)); r += 2;

    /* por fazenda e campo */
    _c(ws, r, 0, _secao('POR FAZENDA E CAMPO')); r++;
    hdrRow(ws, r, ['Fazenda / campo', 'Horas', 'Visitas', 'Pessoas']); r++;
    A.fazendas.forEach(f => {
      const fill = { fgColor:{rgb:COR.verdeFundo}, patternType:'solid' };
      const comFundo = cell => ({ ...cell, s:{ ...cell.s, fill, font:{ ...cell.s.font, bold:true } } });
      _c(ws, r, 0, comFundo(strCell(f.fazenda))); _c(ws, r, 1, comFundo(horaCell(f.min))); _c(ws, r, 2, comFundo(intCell(f.visitas))); _c(ws, r, 3, comFundo(intCell(f.pessoas))); r++;
      f.campos.forEach(c => { _c(ws, r, 0, strCell('    ' + c.campo)); _c(ws, r, 1, horaCell(c.min)); _c(ws, r, 2, intCell(c.visitas)); _c(ws, r, 3, strCell('')); r++; });
    });
    r++;

    /* pendências */
    _c(ws, r, 0, _secao('PENDÊNCIAS')); r++;
    hdrRow(ws, r, ['Tipo', 'Colaborador', 'Data', 'Fazenda', 'Campo', 'Início', 'Fim']); r++;
    const tipos = [['abertas', 'Em campo, sem fim'], ['auto', 'Fim automático'], ['semloc', 'Sem localização']];
    let algum = false;
    tipos.forEach(([k, rot]) => A.pend[k].forEach(a => {
      algum = true;
      _c(ws, r, 0, { ...strCell(rot), s:{ ...strCell(rot).s, fill:FILL_RDM } }); _c(ws, r, 1, strCell(a.user_nome || '')); _c(ws, r, 2, strCenter(_campoData(a.inicio)));
      _c(ws, r, 3, strCell(_campoFaz(a.fazenda))); _c(ws, r, 4, strCell(a.campo)); _c(ws, r, 5, strCenter(_campoHora(a.inicio))); _c(ws, r, 6, strCenter(a.fim ? _campoHora(a.fim) : 'em campo')); r++;
    }));
    if (!algum) { _c(ws, r, 0, strCell('Nenhuma pendência no mês')); r++; }

    ws['!freeze'] = { xSplit:0, ySplit:2 };
    ws['!ref'] = XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:Math.max(r - 1, 3), c:6} });
    return ws;
  }

  function buildCampoDias(A) {
    const nd = A.nd, ws = {}; ws['!merges'] = []; let r = 0;
    const DIAS = ['D','S','T','Q','Q','S','S'];
    ws['!cols'] = [{wch:26}, ...Array(nd).fill({wch:6}), {wch:9}, {wch:7}];
    merge(ws, r, 0, r, nd + 2); _c(ws, r, 0, titCell(`HORAS EM CAMPO POR DIA — ${MESES[A.mes-1]}/${A.ano}`)); r += 2;
    hdrRow(ws, r, ['Colaborador', ...Array.from({ length: nd }, (_, i) => `${i + 1} ${DIAS[new Date(A.ano, A.mes - 1, i + 1).getDay()]}`), 'Total', 'Dias']); r++;
    A.pessoas.forEach(p => {
      _c(ws, r, 0, strCell(p.nome));
      for (let i = 0; i < nd; i++) {
        const m = p.porDia[i];
        _c(ws, r, 1 + i, m == null ? strCenter('') : { ...horaCell(m), s:{ ...horaCell(m).s, fill:FILL_RDA, alignment:ALIGN_C } });
      }
      _c(ws, r, 1 + nd, horaCell(p.min, true)); _c(ws, r, 2 + nd, intCell(p.dias, true)); r++;
    });
    _c(ws, r, 0, _rotTot('TOTAL'));
    for (let i = 0; i < nd; i++) _c(ws, r, 1 + i, A.porDia[i] ? horaCell(A.porDia[i], true) : strCenter(''));
    _c(ws, r, 1 + nd, horaCell(A.min, true)); _c(ws, r, 2 + nd, intCell(A.diasPessoa, true));
    ws['!freeze'] = { xSplit:1, ySplit:3 };
    ws['!ref'] = XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r, c:nd + 2} });
    return ws;
  }

  function buildCampoRegistros(lista, A) {
    const ws = {}; ws['!merges'] = []; let r = 0;
    const H = ['Data','Colaborador','Fazenda','Campo','Início','Fim','Duração','Situação','Lat. início','Long. início','Precisão início (m)','Mapa início','Lat. fim','Long. fim','Precisão fim (m)','Mapa fim'];
    ws['!cols'] = [12,24,26,14,8,10,9,16,12,12,10,42,12,12,10,42].map(w => ({ wch: w }));
    merge(ws, r, 0, r, H.length - 1); _c(ws, r, 0, titCell(`REGISTROS — ATIVIDADE EM CAMPO — ${MESES[A.mes-1]}/${A.ano}`)); r += 2;
    hdrRow(ws, r, H); r++;
    const ini = r;
    const num = v => (v == null || v === '') ? strCenter('') : { t:'n', v:Number(v), s:{ font:FONT_BODY, border:BORDER_THIN, alignment:ALIGN_R, numFmt:'0.000000' } };
    const link = u => u ? { t:'s', v:u, l:{ Target:u }, s:{ font:{ ...FONT_BODY, color:{rgb:'1D4ED8'}, underline:true }, border:BORDER_THIN, alignment:ALIGN_L } } : strCell('');
    [...lista].sort((a, b) => a.inicio.localeCompare(b.inicio) || String(a.user_nome).localeCompare(String(b.user_nome))).forEach(a => {
      const sit = a.em_campo ? 'em campo' : a.fim_automatico ? 'fim automático' : 'finalizada';
      const fill = a.em_campo || a.fim_automatico ? FILL_RDM : null;
      const f = cell => fill ? { ...cell, s:{ ...cell.s, fill } } : cell;
      _c(ws, r, 0, f(strCenter(_campoData(a.inicio)))); _c(ws, r, 1, f(strCell(a.user_nome || ''))); _c(ws, r, 2, f(strCell(_campoFaz(a.fazenda))));
      _c(ws, r, 3, f(strCell(a.campo))); _c(ws, r, 4, f(strCenter(_campoHora(a.inicio)))); _c(ws, r, 5, f(strCenter(a.fim ? _campoHora(a.fim) : '—')));
      _c(ws, r, 6, f(a.minutos != null ? horaCell(a.minutos) : strCenter(''))); _c(ws, r, 7, f(strCenter(sit)));
      _c(ws, r, 8, num(a.lat_inicio)); _c(ws, r, 9, num(a.lng_inicio)); _c(ws, r, 10, a.precisao_inicio != null ? intCell(a.precisao_inicio) : strCenter(''));
      _c(ws, r, 11, link(_campoMapa(a.lat_inicio, a.lng_inicio)));
      _c(ws, r, 12, num(a.lat_fim)); _c(ws, r, 13, num(a.lng_fim)); _c(ws, r, 14, a.precisao_fim != null ? intCell(a.precisao_fim) : strCenter(''));
      _c(ws, r, 15, link(_campoMapa(a.lat_fim, a.lng_fim)));
      r++;
    });
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s:{r:ini - 1,c:0}, e:{r:Math.max(ini, r - 1), c:H.length - 1} }) };
    ws['!freeze'] = { xSplit:0, ySplit:3 };
    ws['!ref'] = XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:Math.max(ini, r - 1), c:H.length - 1} });
    return ws;
  }

  function exportarCampo(lista, mes, ano, A, filtro = 'Todos os colaboradores · todas as fazendas') {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildCampoResumo(A, filtro), 'RESUMO');
    XLSX.utils.book_append_sheet(wb, buildCampoDias(A), 'DIAS');
    XLSX.utils.book_append_sheet(wb, buildCampoRegistros(lista, A), 'REGISTROS');
    XLSX.writeFile(wb, `Petermann_AtividadeCampo_${MESES[mes-1]}${ano}.xlsx`);
  }

  /* ── SheetJS sob demanda (21/09/2026) ────────────────────
     A lib (~900 kB) não vem no index.html: baixa na primeira exportação.
     Antes só os botões da aba Saldo garantiam isso; Equipe, Frota e Ponto
     chamavam o Excel direto e, sem a lib, não geravam nada. Agora todo
     exportar* passa por carregar() — quem chama precisa de await. */
  let _carregando = null;
  function carregar() {
    if (typeof XLSX !== 'undefined') return Promise.resolve();
    if (_carregando) return _carregando;
    _carregando = new Promise((res, rej) => {
      const s = document.createElement('script');
      _scriptCdn(s, 'https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js');
      s.onload  = () => res();
      s.onerror = () => { _carregando = null; rej(new Error('Sem internet para baixar o gerador de planilha')); };
      document.head.appendChild(s);
    });
    return _carregando;
  }
  const comLib = fn => async (...args) => { await carregar(); return fn(...args); };

  return {
    carregar,
    exportarAnual:    comLib(exportarAnual),
    exportarCSV:      comLib(exportarCSV),
    exportarEquipe:   comLib(exportarEquipe),
    exportarFrota:    comLib(exportarFrota),
    exportarFrotaCSV: comLib(exportarFrotaCSV),
    exportarFrotaPlanilha: comLib(exportarFrotaPlanilha),
    exportarPonto:   comLib(exportarPonto),
    exportarPontoCSV: comLib(exportarPontoCSV),
    exportarCampo:   comLib(exportarCampo),
    buildResumo, buildRDM, buildRDA, buildRepasses, buildEquipe,
  };
})();
