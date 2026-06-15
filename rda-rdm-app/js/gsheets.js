'use strict';
/* ─────────────────────────────────────────────────────────────
   gsheets.js — Planilha do Google "ao vivo"
   Cria/atualiza UMA planilha por colaborador/ano na pasta
   compartilhada do Drive (mesma das fotos → já compartilhável).
   Reaproveita o token OAuth do GDrive (escopo 'drive' cobre o Sheets).
───────────────────────────────────────────────────────────── */
window.GSheets = (() => {
  const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
  const DRIVE_API  = 'https://www.googleapis.com/drive/v3/files';
  const MIME_SHEET = 'application/vnd.google-apps.spreadsheet';
  const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const cur = v => parseFloat(Number(v || 0).toFixed(2));

  /* ════════════ Construtores de dados (puros → testáveis) ════════════
     Cada um devolve { title, rows, headerRow, moneyCols }.
     rows = matriz (linhas × colunas) com números reais nas colunas de R$. */

  function buildResumo(notas, repasses, ano, colab) {
    const rows = [
      ['PETERMANN — RELATÓRIO FINANCEIRO'],
      [`Colaborador: ${colab.nome || ''}    Núcleo: ${colab.nucleo || ''}    Ano: ${ano}`],
      [],
      ['Mês','RDM Gasto','RDM Repasse','RDM Saldo','RDA Gasto','RDA Repasse','RDA Saldo'],
    ];
    let tRDMg = 0, tRDMr = 0, tRDAg = 0, tRDAr = 0;
    for (let m = 1; m <= 12; m++) {
      const ns = notas.filter(n => n.mes === m && n.ano === ano && !n.deleted);
      const rs = repasses.filter(r => r.mes === m && r.ano === ano && !r.deleted);
      const rdmG = ns.filter(n => n.tipo === 'RDM').reduce((a, n) => a + cur(n.valor), 0);
      const rdmR = rs.filter(r => r.tipo === 'RDM').reduce((a, r) => a + cur(r.valor), 0);
      const rdaG = ns.filter(n => n.tipo === 'RDA').reduce((a, n) => a + cur(n.valor), 0);
      const rdaR = rs.filter(r => r.tipo === 'RDA').reduce((a, r) => a + cur(r.valor), 0);
      tRDMg += rdmG; tRDMr += rdmR; tRDAg += rdaG; tRDAr += rdaR;
      rows.push([MESES[m-1], cur(rdmG), cur(rdmR), cur(rdmR-rdmG), cur(rdaG), cur(rdaR), cur(rdaR-rdaG)]);
    }
    rows.push(['TOTAL', cur(tRDMg), cur(tRDMr), cur(tRDMr-tRDMg), cur(tRDAg), cur(tRDAr), cur(tRDAr-tRDAg)]);
    rows.push([]);
    rows.push([`Atualizado em ${_agora()} — Petermann App`]);
    return { title: 'RESUMO', rows, headerRow: 3, moneyCols: [1,2,3,4,5,6] };
  }

  function buildRDM(notas, repasses, ano) {
    const rows = [
      [`RDM DETALHADO — ${ano}`],
      [],
      ['Mês','Abastecimento','Hospedagem','Outros','Total Gasto','Repasses','Saldo'],
    ];
    const subs = ['Abastecimento','Hospedagem','Outros'];
    for (let m = 1; m <= 12; m++) {
      const ns = notas.filter(n => n.mes === m && n.ano === ano && n.tipo === 'RDM' && !n.deleted);
      const rs = repasses.filter(r => r.mes === m && r.ano === ano && r.tipo === 'RDM' && !r.deleted);
      const vals = subs.map(s => ns.filter(n => n.subtipo === s).reduce((a, n) => a + cur(n.valor), 0));
      const tot  = vals.reduce((a, v) => a + v, 0);
      const rep  = rs.reduce((a, r) => a + cur(r.valor), 0);
      rows.push([MESES[m-1], cur(vals[0]), cur(vals[1]), cur(vals[2]), cur(tot), cur(rep), cur(rep-tot)]);
    }
    return { title: 'RDM Detalhado', rows, headerRow: 2, moneyCols: [1,2,3,4,5,6] };
  }

  function buildRDA(notas, ano) {
    const rows = [
      [`RDA DETALHADO — ${ano}`],
      [],
      ['Mês','Data','CNPJ','Razão Social','Valor (R$)','Captura'],
    ];
    notas.filter(n => n.tipo === 'RDA' && n.ano === ano && !n.deleted)
      .sort((a, b) => a.mes - b.mes || String(a.data).localeCompare(String(b.data)))
      .forEach(n => rows.push([
        MESES[n.mes-1], n.data || '',
        n.cnpj ? (window.BrasilAPI ? BrasilAPI.formatar(n.cnpj) : n.cnpj) : '',
        n.razao_social || '', cur(n.valor), n.metodo_captura || 'manual',
      ]));
    return { title: 'RDA Detalhado', rows, headerRow: 2, moneyCols: [4] };
  }

  function buildRepasses(repasses, ano) {
    const rows = [
      [`REPASSES RECEBIDOS — ${ano}`],
      [],
      ['Mês','Data','Tipo','Valor (R$)','Descrição'],
    ];
    repasses.filter(r => r.ano === ano && !r.deleted)
      .sort((a, b) => a.mes - b.mes || String(a.data).localeCompare(String(b.data)))
      .forEach(r => rows.push([MESES[r.mes-1], r.data || '', r.tipo || '', cur(r.valor), r.descricao || '']));
    return { title: 'Repasses', rows, headerRow: 2, moneyCols: [3] };
  }

  function _agora() {
    const d = new Date();
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  /* ════════════ Chamadas autenticadas (token do GDrive) ════════════ */
  async function _req(url, opts = {}) {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${GDrive.getToken()}`,
        ...(opts.json ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.json ? JSON.stringify(opts.json) : undefined,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message || `Google ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async function _acharPlanilha(title) {
    const folder = GDrive.getFolderId();
    const q = `name='${title.replace(/'/g, "\\'")}' and mimeType='${MIME_SHEET}' and trashed=false`;
    const data = await _req(`${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`);
    // prefere a que está na pasta compartilhada; senão a primeira
    return (data.files || [])[0]?.id || null;
  }

  async function _criarPlanilha(title, tabTitles) {
    const ss = await _req(SHEETS_API, {
      method: 'POST',
      json: { properties: { title, locale: 'pt_BR' }, sheets: tabTitles.map(t => ({ properties: { title: t } })) },
    });
    // move para a pasta compartilhada do Drive (sai da raiz)
    try {
      await _req(`${DRIVE_API}/${ss.spreadsheetId}?addParents=${GDrive.getFolderId()}&removeParents=root&fields=id`,
        { method: 'PATCH', json: {} });
    } catch (_) { /* se a conta não tiver a pasta, segue na raiz mesmo */ }
    return ss;
  }

  /* garante que todas as abas existam; devolve mapa título → sheetId */
  async function _garantirAbas(ssId, tabTitles) {
    let meta = await _req(`${SHEETS_API}/${ssId}?fields=sheets(properties(sheetId,title))`);
    let existentes = meta.sheets.map(s => s.properties);
    const faltando = tabTitles.filter(t => !existentes.some(p => p.title === t));
    if (faltando.length) {
      await _req(`${SHEETS_API}/${ssId}:batchUpdate`, {
        method: 'POST',
        json: { requests: faltando.map(t => ({ addSheet: { properties: { title: t } } })) },
      });
      meta = await _req(`${SHEETS_API}/${ssId}?fields=sheets(properties(sheetId,title))`);
      existentes = meta.sheets.map(s => s.properties);
    }
    const map = {};
    existentes.forEach(p => { map[p.title] = p.sheetId; });
    return map;
  }

  /* formatação: congela cabeçalho, pinta header de verde, R$ nas colunas de valor */
  function _formatRequests(sheetId, tab) {
    const verde  = { red: 0.176, green: 0.416, blue: 0.310 };  // #2D6A4F
    const branco = { red: 1, green: 1, blue: 1 };
    const reqs = [
      { updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: tab.headerRow + 1 } },
          fields: 'gridProperties.frozenRowCount' } },
      { repeatCell: {
          range: { sheetId, startRowIndex: tab.headerRow, endRowIndex: tab.headerRow + 1 },
          cell: { userEnteredFormat: {
            backgroundColor: verde,
            textFormat: { foregroundColor: branco, bold: true } } },
          fields: 'userEnteredFormat(backgroundColor,textFormat)' } },
    ];
    tab.moneyCols.forEach(c => reqs.push({ repeatCell: {
      range: { sheetId, startRowIndex: tab.headerRow + 1, startColumnIndex: c, endColumnIndex: c + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: 'R$ #,##0.00' } } },
      fields: 'userEnteredFormat.numberFormat' } }));
    reqs.push({ autoResizeDimensions: {
      dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 8 } } });
    return reqs;
  }

  /* ════════════ Exportação principal ════════════ */
  async function exportarAnual(ano, notas, repasses, colab) {
    if (!GDrive.isConnected()) throw new Error('Conecte o Google Drive no Perfil primeiro');

    const tabs = [
      buildResumo(notas, repasses, ano, colab),
      buildRDM(notas, repasses, ano),
      buildRDA(notas, ano),
      buildRepasses(repasses, ano),
    ];
    const tabTitles = tabs.map(t => t.title);
    const title = `Petermann ${(colab.nome || 'Colaborador').trim()} ${ano}`;

    let ssId = await _acharPlanilha(title);
    if (!ssId) ssId = (await _criarPlanilha(title, tabTitles)).spreadsheetId;

    const sheetMap = await _garantirAbas(ssId, tabTitles);

    // limpa o conteúdo antigo de todas as abas (caso a nova versão seja menor)
    await _req(`${SHEETS_API}/${ssId}/values:batchClear`, {
      method: 'POST', json: { ranges: tabTitles.map(t => `'${t}'`) },
    });

    // escreve os valores de cada aba
    await _req(`${SHEETS_API}/${ssId}/values:batchUpdate`, {
      method: 'POST',
      json: {
        valueInputOption: 'RAW',
        data: tabs.map(t => ({ range: `'${t.title}'!A1`, values: t.rows.map(r => r.length ? r : ['']) })),
      },
    });

    // formatação (não crítica — se falhar, os dados já estão lá)
    try {
      const requests = tabs.flatMap(t => _formatRequests(sheetMap[t.title], t));
      await _req(`${SHEETS_API}/${ssId}:batchUpdate`, { method: 'POST', json: { requests } });
    } catch (e) { console.warn('Sheets formatação:', e.message); }

    return `https://docs.google.com/spreadsheets/d/${ssId}/edit`;
  }

  return {
    exportarAnual,
    buildResumo, buildRDM, buildRDA, buildRepasses,  // expostos p/ teste
  };
})();
