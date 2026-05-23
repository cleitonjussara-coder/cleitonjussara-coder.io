'use strict';
/* ─────────────────────────────────────────────────────────────
   Excel.js — exportação no formato Petermann via SheetJS
   4 abas: RESUMO | RDM Detalhado | RDA Detalhado | Repasses
───────────────────────────────────────────────────────────── */
window.Excel = (() => {
  const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const brl = v => new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2}).format(Number(v||0));
  const cur = v => parseFloat(Number(v||0).toFixed(2));

  /* ── RESUMO Jan-Dez ─────────────────────────────────── */
  function buildResumo(notas, repasses, ano, colab) {
    const rows = [
      ['PETERMANN — RELATÓRIO FINANCEIRO','','','','','',''],
      [`Colaborador: ${colab.nome||''}`, '', `Núcleo: ${colab.nucleo||''}`, '', `Ano: ${ano}`, '', ''],
      [''],
      ['Mês','RDM Gasto','RDM Recebido','RDM Saldo','RDA Gasto','RDA Recebido','RDA Saldo'],
    ];
    let tRDMg=0,tRDMr=0,tRDAg=0,tRDAr=0;
    for (let m = 1; m <= 12; m++) {
      const ns = notas.filter(n => n.mes===m && n.ano===ano && !n.deleted);
      const rs = repasses.filter(r => r.mes===m && r.ano===ano && !r.deleted);
      const rdmG = ns.filter(n=>n.tipo==='RDM').reduce((a,n)=>a+cur(n.valor),0);
      const rdmR = rs.filter(r=>r.tipo==='RDM').reduce((a,r)=>a+cur(r.valor),0);
      const rdaG = ns.filter(n=>n.tipo==='RDA').reduce((a,n)=>a+cur(n.valor),0);
      const rdaR = rs.filter(r=>r.tipo==='RDA').reduce((a,r)=>a+cur(r.valor),0);
      tRDMg+=rdmG; tRDMr+=rdmR; tRDAg+=rdaG; tRDAr+=rdaR;
      rows.push([MESES[m-1], brl(rdmG), brl(rdmR), brl(rdmR-rdmG), brl(rdaG), brl(rdaR), brl(rdaR-rdaG)]);
    }
    rows.push(['']);
    rows.push(['TOTAL', brl(tRDMg), brl(tRDMr), brl(tRDMr-tRDMg), brl(tRDAg), brl(tRDAr), brl(tRDAr-tRDAg)]);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{wch:8},{wch:14},{wch:16},{wch:14},{wch:14},{wch:16},{wch:14}];
    return ws;
  }

  /* ── RDM Detalhado (Abastecimento | Hospedagem | Outros) ── */
  function buildRDM(notas, repasses, ano) {
    const subs = ['Abastecimento','Hospedagem','Outros'];
    const rows = [
      [`RDM DETALHADO — ${ano}`], [''],
      ['Mês', ...subs, 'Total Gasto', '', 'Repasses', 'Saldo'],
    ];
    for (let m = 1; m <= 12; m++) {
      const ns = notas.filter(n => n.mes===m && n.ano===ano && n.tipo==='RDM' && !n.deleted);
      const rs = repasses.filter(r => r.mes===m && r.ano===ano && r.tipo==='RDM' && !r.deleted);
      const vals = subs.map(s => ns.filter(n=>n.subtipo===s).reduce((a,n)=>a+cur(n.valor),0));
      const tot  = vals.reduce((a,v)=>a+v, 0);
      const rep  = rs.reduce((a,r)=>a+cur(r.valor), 0);
      rows.push([MESES[m-1], ...vals.map(brl), brl(tot), '', brl(rep), brl(rep-tot)]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{wch:8},{wch:16},{wch:14},{wch:12},{wch:14},{wch:4},{wch:14},{wch:12}];
    return ws;
  }

  /* ── RDA Detalhado (data | CNPJ | valor) ─────────────── */
  function buildRDA(notas, repasses, ano) {
    const rows = [
      [`RDA DETALHADO — ${ano}`], [''],
      ['Mês','Data','CNPJ','Razão Social','Valor (R$)','Captura'],
    ];
    const ns = notas
      .filter(n => n.tipo==='RDA' && n.ano===ano && !n.deleted)
      .sort((a,b) => a.mes-b.mes || a.data.localeCompare(b.data));
    ns.forEach(n => rows.push([
      MESES[n.mes-1], n.data,
      n.cnpj ? BrasilAPI.formatar(n.cnpj) : '',
      n.razao_social || '', brl(n.valor), n.metodo_captura || 'manual',
    ]));
    rows.push(['']);
    for (let m = 1; m <= 12; m++) {
      const tot = ns.filter(n=>n.mes===m).reduce((a,n)=>a+cur(n.valor),0);
      if (tot > 0) rows.push([MESES[m-1],'','','Subtotal',brl(tot),'']);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{wch:8},{wch:12},{wch:20},{wch:34},{wch:14},{wch:10}];
    return ws;
  }

  /* ── Repasses ─────────────────────────────────────────── */
  function buildRepasses(repasses, ano) {
    const rows = [
      [`REPASSES RECEBIDOS — ${ano}`], [''],
      ['Mês','Data','Tipo','Valor (R$)','Descrição'],
    ];
    const rs = repasses
      .filter(r => r.ano===ano && !r.deleted)
      .sort((a,b) => a.mes-b.mes || a.data.localeCompare(b.data));
    rs.forEach(r => rows.push([MESES[r.mes-1], r.data, r.tipo, brl(r.valor), r.descricao||'']));
    rows.push(['']);
    ['RDM','RDA'].forEach(t => {
      const tot = rs.filter(r=>r.tipo===t).reduce((a,r)=>a+cur(r.valor),0);
      rows.push([`TOTAL ${t}`, '', '', brl(tot), '']);
    });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{wch:8},{wch:12},{wch:8},{wch:14},{wch:32}];
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
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), mesNome);
    const nome = (colab.nome||'notas').replace(/\s+/g,'_');
    XLSX.writeFile(wb, `Petermann_${nome}_${mesNome}${ano}.csv`);
  }

  return { exportarAnual, exportarCSV };
})();
