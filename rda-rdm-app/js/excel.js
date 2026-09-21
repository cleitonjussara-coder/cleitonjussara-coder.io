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
    r++; r++; // pula linha

    // Cabeçalho
    hdrRow(ws, r, ['Mês','RDM Gasto','RDM Repasse','RDM Saldo','RDA Gasto','RDA Repasse','RDA Saldo','Pend. Anterior','Saldo Acum.']);
    r++;

    let tRDMg=0,tRDMr=0,tRDAg=0,tRDAr=0;
    let acumRDM=0, acumRDA=0;
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
      acumRDM += sRDM; acumRDA += sRDA;
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
    const sTDMr = tRDMr-tRDMg, sTDAr = tRDAr-tRDAg;
    ws[XLSX.utils.encode_cell({r,c:0})] = { t:'s', v:'TOTAL', s:{ font:{...FONT_TOT,color:{rgb:COR.branco}}, fill:FILL_HDR, border:BORDER_THIN, alignment:ALIGN_C } };
    ws[XLSX.utils.encode_cell({r,c:1})] = totCell(tRDMg);
    ws[XLSX.utils.encode_cell({r,c:2})] = totCell(tRDMr);
    ws[XLSX.utils.encode_cell({r,c:3})] = sTDMr < 0 ? totNeg(sTDMr) : totCell(sTDMr);
    ws[XLSX.utils.encode_cell({r,c:4})] = totCell(tRDAg);
    ws[XLSX.utils.encode_cell({r,c:5})] = totCell(tRDAr);
    ws[XLSX.utils.encode_cell({r,c:6})] = sTDAr < 0 ? totNeg(sTDAr) : totCell(sTDAr);
    ws[XLSX.utils.encode_cell({r,c:7})] = { t:'s', v:'', s:{ border:BORDER_THIN } };
    ws[XLSX.utils.encode_cell({r,c:8})] = (acumRDM+acumRDA) < 0 ? totNeg(acumRDM+acumRDA) : totCell(acumRDM+acumRDA);
    r += 2;

    // Geração
    merge(ws, r, 0, r, 8);
    ws[XLSX.utils.encode_cell({r, c:0})] = subCell(`Gerado em ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})} — Petermann App`);
    r++;

    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r:r-1,c:8}});
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({s:{r:3,c:0},e:{r:3+11,c:8}}) };
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

    ws['!ref'] = XLSX.utils.encode_range({s:{r:0,c:0},e:{r,c:7}});
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
      s.src = 'https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js';
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
    exportarPonto:    comLib(exportarPonto),
    exportarPontoCSV: comLib(exportarPontoCSV),
    buildResumo, buildRDM, buildRDA, buildRepasses, buildEquipe,
  };
})();
