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
  function buildResumo(notas, repasses, ano, colab) {
    const ws = {};
    ws['!cols'] = [{wch:8},{wch:16},{wch:16},{wch:16},{wch:16},{wch:16},{wch:16}];
    ws['!merges'] = [];

    let r = 0;

    // Título principal
    merge(ws, r, 0, r, 6);
    ws[XLSX.utils.encode_cell({r, c:0})] = titCell('PETERMANN — RELATÓRIO FINANCEIRO');
    r++;

    // Subtítulo
    merge(ws, r, 0, r, 6);
    ws[XLSX.utils.encode_cell({r, c:0})] = subCell(`Colaborador: ${colab.nome||''}    Núcleo: ${colab.nucleo||''}    Ano: ${ano}`);
    r++; r++; // pula linha

    // Cabeçalho
    hdrRow(ws, r, ['Mês','RDM Gasto','RDM Repasse','RDM Saldo','RDA Gasto','RDA Repasse','RDA Saldo']);
    r++;

    let tRDMg=0,tRDMr=0,tRDAg=0,tRDAr=0;
    for (let m = 1; m <= 12; m++) {
      const ns = notas.filter(n => n.mes===m && n.ano===ano && !n.deleted);
      const rs = repasses.filter(r => r.mes===m && r.ano===ano && !r.deleted);
      const rdmG = ns.filter(n=>n.tipo==='RDM').reduce((a,n)=>a+cur(n.valor),0);
      const rdmR = rs.filter(r=>r.tipo==='RDM').reduce((a,r)=>a+cur(r.valor),0);
      const rdaG = ns.filter(n=>n.tipo==='RDA').reduce((a,n)=>a+cur(n.valor),0);
      const rdaR = rs.filter(r=>r.tipo==='RDA').reduce((a,r)=>a+cur(r.valor),0);
      tRDMg+=rdmG; tRDMr+=rdmR; tRDAg+=rdaG; tRDAr+=rdaR;
      const sRDM = rdmR-rdmG, sRDA = rdaR-rdaG;
      ws[XLSX.utils.encode_cell({r,c:0})] = strCenter(MESES[m-1]);
      ws[XLSX.utils.encode_cell({r,c:1})] = numCell(rdmG);
      ws[XLSX.utils.encode_cell({r,c:2})] = numCell(rdmR);
      ws[XLSX.utils.encode_cell({r,c:3})] = sRDM < 0 ? numNeg(sRDM) : numCell(sRDM);
      ws[XLSX.utils.encode_cell({r,c:4})] = numCell(rdaG);
      ws[XLSX.utils.encode_cell({r,c:5})] = numCell(rdaR);
      ws[XLSX.utils.encode_cell({r,c:6})] = sRDA < 0 ? numNeg(sRDA) : numCell(sRDA);
      r++;
    }

    r++; // linha em branco
    const sTDMr = tRDMr-tRDMg, sTDAr = tRDAr-tRDAg;
    ws[XLSX.utils.encode_cell({r,c:0})] = { t:'s', v:'TOTAL', s:{ font:{...FONT_TOT,color:{rgb:COR.branco}}, fill:FILL_HDR, border:BORDER_THIN, alignment:ALIGN_C } };
    ws[XLSX.utils.encode_cell({r,c:1})] = totCell(tRDMg);
    ws[XLSX.utils.encode_cell({r,c:2})] = totCell(tRDMr);
    ws[XLSX.utils.encode_cell({r,c:3})] = sTDMr < 0 ? totNeg(sTDMr) : totCell(sTDMr);
    ws[XLSX.utils.encode_cell({r,c:4})] = totCell(tRDAg);
    ws[XLSX.utils.encode_cell({r,c:5})] = totCell(tRDAr);
    ws[XLSX.utils.encode_cell({r,c:6})] = sTDAr < 0 ? totNeg(sTDAr) : totCell(sTDAr);
    r += 2;

    // Geração
    merge(ws, r, 0, r, 6);
    ws[XLSX.utils.encode_cell({r, c:0})] = subCell(`Gerado em ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})} — Petermann App`);
    r++;

    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r:r-1,c:6}});
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:3,c:0},e:{r:3+11,c:6}}) };
    return ws;
  }

  /* ── RDM Detalhado ──────────────────────────────────── */
  function buildRDM(notas, repasses, ano) {
    const ws = {};
    ws['!cols'] = [{wch:8},{wch:16},{wch:14},{wch:12},{wch:14},{wch:4},{wch:14},{wch:14}];
    ws['!merges'] = [];
    let r = 0;

    merge(ws, r, 0, r, 7);
    ws[XLSX.utils.encode_cell({r, c:0})] = titCell(`RDM DETALHADO — ${ano}`);
    r += 2;

    hdrRow(ws, r, ['Mês','Abastecimento','Hospedagem','Outros','Total Gasto','','Repasses','Saldo']);
    r++;

    const subs = ['Abastecimento','Hospedagem','Outros'];
    for (let m = 1; m <= 12; m++) {
      const ns = notas.filter(n => n.mes===m && n.ano===ano && n.tipo==='RDM' && !n.deleted);
      const rs = repasses.filter(r => r.mes===m && r.ano===ano && r.tipo==='RDM' && !r.deleted);
      const vals = subs.map(s => ns.filter(n=>n.subtipo===s).reduce((a,n)=>a+cur(n.valor),0));
      const tot  = vals.reduce((a,v)=>a+v, 0);
      const rep  = rs.reduce((a,r)=>a+cur(r.valor), 0);
      const saldo= rep-tot;
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
      ws[XLSX.utils.encode_cell({r,c:2})] = strCell(n.cnpj?BrasilAPI.formatar(n.cnpj):'');
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

    const rs = repasses.filter(r => r.ano===ano && !r.deleted)
      .sort((a,b) => a.mes-b.mes || a.data.localeCompare(b.data));
    rs.forEach(r => {
      ws[XLSX.utils.encode_cell({r,c:0})] = strCenter(MESES[r.mes-1]);
      ws[XLSX.utils.encode_cell({r,c:1})] = strCenter(r.data);
      ws[XLSX.utils.encode_cell({r,c:2})] = strCenter(r.tipo);
      ws[XLSX.utils.encode_cell({r,c:3})] = numCell(r.valor);
      ws[XLSX.utils.encode_cell({r,c:4})] = strCell(r.descricao||'');
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
  function buildEquipe(notas, repasses, collabs, mes, ano) {
    const ws = {};
    ws['!cols'] = [{wch:16},{wch:24},{wch:14},{wch:14},{wch:14},{wch:14},{wch:14},{wch:14}];
    ws['!merges'] = [];
    let r = 0;

    merge(ws, r, 0, r, 7);
    ws[XLSX.utils.encode_cell({r, c:0})] = titCell(`PETERMANN — RELATÓRIO DA EQUIPE`);
    r++;
    merge(ws, r, 0, r, 7);
    ws[XLSX.utils.encode_cell({r, c:0})] = subCell(`Mês: ${MESES[mes-1]}/${ano}      Gerado em ${new Date().toLocaleDateString('pt-BR')}`);
    r += 2;

    hdrRow(ws, r, ['Núcleo','Colaborador','RDM Gasto','RDM Repasse','RDM Saldo','RDA Gasto','RDA Repasse','RDA Saldo']);
    r++;

    let tRDMg=0,tRDMr=0,tRDAg=0,tRDAr=0, any=false;
    const nucs = {};
    collabs.forEach(c => { (nucs[c.nucleo] = nucs[c.nucleo]||[]).push(c); });

    for (const [nucleo, membros] of Object.entries(nucs).sort()) {
      const sorted = membros.sort((a,b)=>(a.nome||'').localeCompare(b.nome||''));
      sorted.forEach(c => {
        const cns = notas.filter(n=>n.user_id===c.id);
        const crs = repasses.filter(r=>r.user_id===c.id);
        const rdmG = cns.filter(n=>n.tipo==='RDM').reduce((s,n)=>s+Number(n.valor||0),0);
        const rdmR = crs.filter(r=>r.tipo==='RDM').reduce((s,r)=>s+Number(r.valor||0),0);
        const rdaG = cns.filter(n=>n.tipo==='RDA').reduce((s,n)=>s+Number(n.valor||0),0);
        const rdaR = crs.filter(r=>r.tipo==='RDA').reduce((s,r)=>s+Number(r.valor||0),0);
        tRDMg+=rdmG; tRDMr+=rdmR; tRDAg+=rdaG; tRDAr+=rdaR;
        if (rdmG||rdmR||rdaG||rdaR) any=true;
        const sRDM=rdmR-rdmG, sRDA=rdaR-rdaG;
        ws[XLSX.utils.encode_cell({r,c:0})] = strCell(nucleo);
        ws[XLSX.utils.encode_cell({r,c:1})] = strCell(c.nome||c.email);
        ws[XLSX.utils.encode_cell({r,c:2})] = numCell(rdmG);
        ws[XLSX.utils.encode_cell({r,c:3})] = numCell(rdmR);
        ws[XLSX.utils.encode_cell({r,c:4})] = sRDM<0?numNeg(sRDM):numCell(sRDM);
        ws[XLSX.utils.encode_cell({r,c:5})] = numCell(rdaG);
        ws[XLSX.utils.encode_cell({r,c:6})] = numCell(rdaR);
        ws[XLSX.utils.encode_cell({r,c:7})] = sRDA<0?numNeg(sRDA):numCell(sRDA);
        r++;
      });
    }

    r++;
    const sTRDM=tRDMr-tRDMg, sTRDA=tRDAr-tRDAg;
    merge(ws, r, 0, r, 1);
    ws[XLSX.utils.encode_cell({r,c:0})] = { t:'s', v:'TOTAL GERAL', s:{ font:{...FONT_TOT,color:{rgb:COR.branco}}, fill:FILL_HDR, border:BORDER_THIN, alignment:ALIGN_C } };
    ws[XLSX.utils.encode_cell({r,c:2})] = totCell(tRDMg);
    ws[XLSX.utils.encode_cell({r,c:3})] = totCell(tRDMr);
    ws[XLSX.utils.encode_cell({r,c:4})] = sTRDM<0?totNeg(sTRDM):totCell(sTRDM);
    ws[XLSX.utils.encode_cell({r,c:5})] = totCell(tRDAg);
    ws[XLSX.utils.encode_cell({r,c:6})] = totCell(tRDAr);
    ws[XLSX.utils.encode_cell({r,c:7})] = sTRDA<0?totNeg(sTRDA):totCell(sTRDA);

    r--;
    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r:r-1,c:7}});
    return ws;
  }

  /* ── Exportar Excel anual ─────────────────────────────── */
  function exportarAnual(ano, notas, repasses, colab) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildResumo(notas,repasses,ano,colab), 'RESUMO');
    XLSX.utils.book_append_sheet(wb, buildRDM(notas,repasses,ano),          'RDM Detalhado');
    XLSX.utils.book_append_sheet(wb, buildRDA(notas,repasses,ano),          'RDA Detalhado');
    XLSX.utils.book_append_sheet(wb, buildRepasses(repasses,ano),           'Repasses');
    const nome = (colab.nome||'colab').replace(/\s+/g,'_');
    XLSX.writeFile(wb, `Petermann_${nome}_${ano}.xlsx`);
  }

  /* ── Exportar Equipe (gestor) ─────────────────────────── */
  function exportarEquipe(notas, repasses, collabs, mes, ano, gestorNome) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildEquipe(notas,repasses,collabs,mes,ano), 'EQUIPE');
    const nome = (gestorNome||'equipe').replace(/\s+/g,'_');
    XLSX.writeFile(wb, `Petermann_${nome}_Equipe_${MESES[mes-1]}${ano}.xlsx`);
  }

  /* ── Exportar CSV mensal ──────────────────────────────── */
  function exportarCSV(mes, ano, notas, repasses, colab) {
    const mesNome = MESES[mes-1];
    const rows = [
      ['PETERMANN', `${mesNome}/${ano}`, '', '', colab.nome||''], [''],
      ['Tipo','Subtipo','Data','CNPJ','Razão Social','Valor (R$)','Captura'],
    ];
    notas.filter(n=>n.mes===mes && n.ano===ano && !n.deleted)
      .sort((a,b)=>a.data.localeCompare(b.data))
      .forEach(n => rows.push([n.tipo, n.subtipo||'', n.data,
        n.cnpj||'', n.razao_social||'', brl(n.valor), n.metodo_captura||'']));
    const rs = repasses.filter(r=>r.mes===mes && r.ano===ano && !r.deleted);
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

  return { exportarAnual, exportarCSV, exportarEquipe, buildResumo, buildRDM, buildRDA, buildRepasses, buildEquipe };
})();
