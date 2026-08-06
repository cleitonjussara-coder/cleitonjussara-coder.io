'use strict';
/* ─────────────────────────────────────────────────────────────
   gsheets.js — Planilha do Google "ao vivo"
   Cria/atualiza UMA planilha por colaborador/ano na pasta
   compartilhada do Drive (mesma das fotos → já compartilhável).
   Reaproveita o token OAuth do GDrive (escopo 'drive' cobre o Sheets).

   A planilha pessoal segue o MODELO PADRÃO DA EMPRESA — as mesmas 5
   abas do "PLANILHA DE RDM E RDA_.xlsx" (CABEÇALHO, NORMAS, BANCO DE
   DADOS, R.D.M., R.D.A), com as fórmulas ligando uma na outra, já
   preenchida com as notas do app.

   Duas regras que valem para tudo aqui:

   1) NENHUMA fórmula usa vírgula como separador de argumentos.
      Com valueInputOption USER_ENTERED o Sheets interpreta a fórmula
      como se tivesse sido digitada na interface, e no locale pt_BR o
      separador é ';'. Em vez de apostar, tudo é escrito em forma que
      dispensa separador: SUM(a,b,c) vira a+b+c e SUM(x:y,z:w) vira
      SUM(x:y)+SUM(z:w). Mesmo resultado, imune ao locale.

   2) Nome de aba com ponto ou espaço PRECISA de aspas simples na
      referência: 'R.D.M.'!E38, 'BANCO DE DADOS'!C95. Sem aspas o
      Sheets lê o ponto como parte do endereço e devolve #REF!.

   Os blocos mensais crescem conforme a quantidade de notas e os SUM
   acompanham — por isso os construtores devolvem, além das linhas, em
   que linha caiu o total de cada mês: é disso que a aba BANCO DE DADOS
   precisa para se referenciar.
───────────────────────────────────────────────────────────── */
window.GSheets = (() => {
  const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
  const DRIVE_API  = 'https://www.googleapis.com/drive/v3/files';
  const MIME_SHEET = 'application/vnd.google-apps.spreadsheet';
  const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const MESES_LONGOS = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO',
                        'JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
  const MESES_TITULO = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                        'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const cur = v => parseFloat(Number(v || 0).toFixed(2));

  /* Bloco do tamanho exato dos lançamentos: mês sem nota nem aparece, e mês
     com nota não reserva linha em branco. É o que mantém cada aba curta o
     bastante para caber numa página — a planilha é regerada pelo botão, então
     o mês surge sozinho quando a primeira nota entrar.
     Consequência assumida: não há linha vaga para lançar à mão; para isso é
     preciso inserir a linha e esticar o SUM do bloco. */
  const MIN_RDM = 0;
  const MIN_RDA = 0;

  /* paleta — mesma identidade do app */
  const VERDE  = { red: 0.176, green: 0.416, blue: 0.310 };   // #2D6A4F
  const CLARO  = { red: 0.902, green: 0.945, blue: 0.921 };   // faixa de mês
  const BRANCO = { red: 1, green: 1, blue: 1 };

  /* títulos das abas — iguais aos do arquivo modelo, inclusive os pontos */
  const ABA = {
    cab   : 'CABEÇALHO',
    normas: 'NORMAS',
    banco : 'BANCO DE DADOS',
    rdm   : 'R.D.M.',
    rda   : 'R.D.A',
  };

  /* ════════════ Grade esparsa ════════════
     O modelo não é uma tabela: são células soltas em posições fixas
     (D1, B6, I7, L5:X11…). Montar isso como matriz de matrizes fica
     ilegível, então escreve-se por coordenada e a matriz sai no fim. */
  function grade() {
    const cel = new Map();
    let maxR = 0, maxC = 0;
    return {
      set(r, c, v) {
        if (v === undefined || v === null || v === '') return;
        cel.set(r + ':' + c, v);
        if (r > maxR) maxR = r;
        if (c > maxC) maxC = c;
      },
      linha(r, c0, vals) { vals.forEach((v, i) => this.set(r, c0 + i, v)); },
      get maxRow() { return maxR; },
      rows() {
        const out = [];
        for (let r = 1; r <= maxR; r++) {
          const l = [];
          for (let c = 1; c <= maxC; c++) l.push(cel.has(r + ':' + c) ? cel.get(r + ':' + c) : '');
          out.push(l);
        }
        return out;
      },
    };
  }

  /* colunas por letra, para o código ficar parecido com o modelo */
  const A=1, B=2, C=3, D=4, E=5, F=6, G=7, H=8, I=9, J=10, L=12, M=13, S=19;

  const _data   = d => {
    const s = String(d || '');
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : s;      // pt_BR entende dd/mm/aaaa
  };
  const _cnpj   = v => (v ? (window.BrasilAPI ? BrasilAPI.formatar(v) : v) : '');
  const _doMes  = (arr, m, ano) => (arr || []).filter(x => x.mes === m && x.ano === ano && !x.deleted);

  /* Em que linha cai o TOTAL de cada extrato de repasse na aba BANCO DE
     DADOS. Precisa ser calculado fora do buildBanco porque a aba R.D.M.
     tambem aponta para ele (G2 = total recebido) — foi justamente esse
     descasamento que deixou o SALDO do RDM mostrando o gasto inteiro. */
  const LIN_EXTRATO = 15;
  const MIN_EXTRATO = 12;
  const _repDo = (repasses, tipo, ano) =>
    (repasses || []).filter(r => r.tipo === tipo && r.ano === ano && !r.deleted)
                    .sort((a, b) => String(a.data).localeCompare(String(b.data)));
  function _linhasExtrato(repasses, ano) {
    return {
      rdm: LIN_EXTRATO + Math.max(MIN_EXTRATO, _repDo(repasses, 'RDM', ano).length),
      rda: LIN_EXTRATO + Math.max(MIN_EXTRATO, _repDo(repasses, 'RDA', ano).length),
    };
  }

  /* ════════════ ABA CABEÇALHO ════════════
     É a fonte da verdade: todas as outras abas referenciam B6 (nome),
     B7 (safra) e I7 (ano). Mudando aqui, a planilha inteira acompanha. */
  function buildCabecalho(ano, colab) {
    const g = grade();
    g.set(1, D, 'PETERMANN & MORAIS LTDA ME - CNPJ 17.117.768/0001-42');
    g.set(2, D, 'Rua Natal Vasconcelos Montes, 185 - Sala 01. Centro.');
    g.set(3, D, 'CEP.: 75.503-340');
    g.set(4, D, 'Itumbiara, Goiás');
    g.set(5, A, 'DESPESAS CORPORATIVAS | PETERMANN & MORAIS LTDA');
    g.set(6, A, 'FUNCIONÁRIO:');
    g.set(6, B, (colab && colab.nome) || '');
    g.set(7, A, 'SAFRA:');
    /* Safra = ano civil na Petermann. O "25/26" do arquivo é rótulo
       daquele documento, não regra — não derivar de corte julho/junho. */
    g.set(7, B, String(ano));
    g.set(7, H, 'ANO DO EXERCÍCIO:');
    g.set(7, I, ano);
    g.set(8, A, 'RELATÓRIO DE DESPESAS MENSAIS (RDM) E RELATÓRIO DE DESPESAS COM ALIMENTAÇÕES (RDA).');
    g.set(10, A, `Gerado pelo Petermann App em ${_agora()} — os valores vêm das notas lançadas no aplicativo.`);
    return { title: ABA.cab, rows: g.rows(), moeda: [], negrito: [[5, 0, 9], [6, 0, 9], [8, 0, 9]] };
  }

  /* ════════════ ABA NORMAS ════════════
     Vazia no modelo (a folha de normas é imagem colada à mão). Fica
     como aba vazia só para a planilha ter as 5 abas na mesma ordem. */
  function buildNormas() {
    const g = grade();
    g.set(1, A, 'NORMAS');
    g.set(3, A, 'Aba reservada às normas internas — cole aqui a folha de orientações da empresa.');
    return { title: ABA.normas, rows: g.rows(), moeda: [], negrito: [[1, 0, 6]] };
  }

  /* ════════════ ABA R.D.M. ════════════
     Três categorias lado a lado (B/C/D, E/F/G, H/I/J), um bloco por mês.
     Devolve `totaisMes` = linha do total de cada mês (o E38 do modelo),
     que a aba BANCO DE DADOS referencia. */
  function buildRDM(notas, ano, linhaRecebidoRDM) {
    const g = grade();
    const CATS = ['Abastecimento', 'Hospedagem', 'Outros'];
    const COL  = [B, E, H];                       // coluna inicial de cada categoria

    g.set(1, A, `='${ABA.cab}'!B6`);
    g.set(1, B, 'RELATÓRIO DE DESPESAS MENSAIS (R.D.M.)');
    g.set(1, G, `='${ABA.cab}'!B6`);
    g.set(1, J, `='${ABA.cab}'!I7`);

    g.set(2, B, 'TOTAL DE GASTO ACUMULADO');
    g.set(2, E, 'TOTAL RECEBIDO');
    g.set(2, H, 'SALDO');

    g.set(3, B, 'ABASTECIMENTO');
    g.set(3, E, 'HOSPEDAGENS');
    g.set(3, H, "OUTROS (BORRACHARIA/OFICINA/EPI'S)");
    COL.forEach(c => g.linha(4, c, ['DATA', 'CNPJ DA NOTA', 'R$']));

    /* 12 posições; mês sem nota fica null e nem ocupa linha na aba —
       o BANCO DE DADOS lê isso e escreve 0 na grade daquele mês. */
    const totaisMes = new Array(12).fill(null);
    const moeda = [], realce = [];
    let r = 5;
    for (let m = 1; m <= 12; m++) {
      const doMes = _doMes(notas, m, ano).filter(n => n.tipo === 'RDM');
      if (!doMes.length) continue;
      const porCat = CATS.map(cat => doMes
        .filter(n => (n.subtipo || 'Outros') === cat)
        .sort((a, b) => String(a.data).localeCompare(String(b.data))));

      const altura = Math.max(MIN_RDM, 1, ...porCat.map(l => l.length));
      const rLabel = r;
      const rIni   = r + 1;
      const rFim   = rIni + altura - 1;
      const rTotal = rFim + 1;
      const rMes   = rTotal + 1;

      COL.forEach((c, k) => {
        g.set(rLabel, c, MESES_LONGOS[m - 1]);
        porCat[k].forEach((n, i) => {
          g.set(rIni + i, c,     _data(n.data));
          g.set(rIni + i, c + 1, _cnpj(n.cnpj));
          g.set(rIni + i, c + 2, cur(n.valor));
        });
        g.set(rTotal, c,     'TOTAL DE GASTOS');
        g.set(rTotal, c + 2, `=SUM(${_col(c + 2)}${rIni}:${_col(c + 2)}${rFim})`);
        moeda.push([rIni - 1, c + 1, rTotal, c + 2]);   // 0-indexed: R$ da categoria
      });
      /* total do mês: soma as três categorias sem vírgula (locale) */
      g.set(rMes, E, `=D${rTotal}+G${rTotal}+J${rTotal}`);
      moeda.push([rMes - 1, E - 1, rMes, E]);
      realce.push([rLabel, 1, 10, CLARO], [rTotal, 1, 10, CLARO]);

      totaisMes[m - 1] = rMes;
      r = rMes + 1;
    }

    /* sem nenhum mês lançado o acumulado seria "=" (fórmula vazia) → 0 */
    const usados = totaisMes.filter(Boolean);
    g.set(2, D, usados.length ? '=' + usados.map(x => `E${x}`).join('+') : 0);
    g.set(2, G, `='${ABA.banco}'!C${linhaRecebidoRDM}`);   // total recebido
    /* SALDO = recebido - gasto: o que ainda resta do repasse com o
       colaborador. O arquivo modelo traz =D2-G2 aqui (gasto - recebido) e
       =B7-B9 no BANCO DE DADOS (recebido - gasto), ou seja, o mesmo saldo
       com sinais opostos em abas diferentes. Seguimos o sentido do BANCO,
       que é o que corresponde ao significado do numero. */
    g.set(2, J, '=G2-D2');
    moeda.push([1, D - 1, 2, D], [1, G - 1, 2, G], [1, J - 1, 2, J]);

    return {
      title: ABA.rdm, rows: g.rows(), moeda, realce,
      negrito: [[1, 0, 10], [2, 0, 10]],
      cabecalho: [[3, 1, 10], [4, 1, 10]],
      congelar: 4,
      totaisMes,
    };
  }

  /* ════════════ ABA R.D.A ════════════
     Sempre alimentação, sem categoria. Dois pares de colunas por mês
     (B/C/D e E/F/G) — a esquerda enche primeiro, igual ao modelo. */
  function buildRDA(notas, ano) {
    const g = grade();
    g.set(1, A, `='${ABA.cab}'!B6`);
    g.set(1, B, 'RELATÓRIO DE DESPESAS COM ALIMENTAÇÕES (R.D.A.)');
    g.set(1, F, `='${ABA.cab}'!B6`);

    const totaisMes = new Array(12).fill(null);
    const moeda = [], realce = [], cabecalhos = [];
    let r = 4;
    for (let m = 1; m <= 12; m++) {
      const doMes = _doMes(notas, m, ano)
        .filter(n => n.tipo === 'RDA')
        .sort((a, b) => String(a.data).localeCompare(String(b.data)));
      if (!doMes.length) continue;

      const altura = Math.max(MIN_RDA, 1, Math.ceil(doMes.length / 2));
      const esquerda = doMes.slice(0, altura);
      const direita  = doMes.slice(altura);

      const rLabel  = r;
      const rHeader = r + 1;
      const rIni    = r + 2;
      const rFim    = rIni + altura - 1;
      const rTotal  = rFim + 1;

      g.set(rLabel, B, MESES_LONGOS[m - 1]);
      g.set(rLabel, E, `='${ABA.cab}'!I7`);
      g.linha(rHeader, B, ['DATA', 'CNPJ', 'R$']);
      g.linha(rHeader, E, ['DATA', 'CNPJ', 'R$']);

      [[esquerda, B], [direita, E]].forEach(([lista, c]) => {
        lista.forEach((n, i) => {
          g.set(rIni + i, c,     _data(n.data));
          g.set(rIni + i, c + 1, _cnpj(n.cnpj));
          g.set(rIni + i, c + 2, cur(n.valor));
        });
        moeda.push([rIni - 1, c + 1, rTotal, c + 2]);
      });

      g.set(rTotal, B, 'TOTAL DE GASTOS');
      g.set(rTotal, G, `=SUM(D${rIni}:D${rFim})+SUM(G${rIni}:G${rFim})`);
      moeda.push([rTotal - 1, G - 1, rTotal, G]);
      realce.push([rLabel, 1, 7, CLARO], [rTotal, 1, 7, CLARO]);
      cabecalhos.push([rHeader, 1, 7]);

      totaisMes[m - 1] = rTotal;
      r = rTotal + 1;
    }

    return {
      title: ABA.rda, rows: g.rows(), moeda, realce,
      negrito: [[1, 0, 7]],
      cabecalho: cabecalhos,
      congelar: 1,
      totaisMes,
    };
  }

  /* ════════════ ABA BANCO DE DADOS ════════════
     Cruza tudo: extratos de repasse (entrada manual ou do app), resumo
     mês a mês puxado das abas R.D.M./R.D.A, trimestres e total geral. */
  function buildBanco(repasses, ano, refRDM, refRDA) {
    const g = grade();
    const rdm = _repDo(repasses, 'RDM', ano);
    const rda = _repDo(repasses, 'RDA', ano);

    const LIN_INI = LIN_EXTRATO;
    const { rdm: totRDM, rda: totRDA } = _linhasExtrato(repasses, ano);

    /* ── grade mensal (L5:X11) ── */
    g.set(3, L, '=B5');
    g.set(4, L, 'EXERCÍCIO DE ');
    g.set(4, S, `='${ABA.cab}'!I7`);
    g.set(5, L, 'Meses');
    MESES_TITULO.forEach((nome, i) => g.set(5, M + i, nome));

    /* refRDM/refRDA têm 12 posições; null = mês que não virou bloco na aba
       (nenhuma nota). A grade continua mostrando os 12 meses, mas o mês
       ausente recebe 0 em vez de uma referência para linha inexistente. */
    g.set(6, L, 'RDM');
    refRDM.forEach((lin, i) => g.set(6, M + i, lin ? `='${ABA.rdm}'!E${lin}` : 0));
    g.set(8, L, 'RDA');
    refRDA.forEach((lin, i) => g.set(8, M + i, lin ? `='${ABA.rda}'!G${lin}` : 0));

    /* trimestres: 3 meses somados sem vírgula */
    [0, 3, 6, 9].forEach(off => {
      const c = M + off;
      const a = _col(c), b = _col(c + 1), d = _col(c + 2);
      g.set(7, c, `=${a}6+${b}6+${d}6`);
      g.set(9, c, `=${a}8+${b}8+${d}8`);
      g.set(10, c, `=${a}7+${a}9`);
    });
    g.set(7,  L, 'Trimestres');
    g.set(9,  L, 'Trimestres');
    g.set(10, L, 'TOTAL/TRIM');
    g.set(11, L, 'TOTAL GERAL');
    g.set(11, M, '=M10+P10+S10+V10');

    /* ── cabeçalho e totalizadores da esquerda ── */
    g.set(5, B, `='${ABA.cab}'!B6`);
    g.set(5, I, `='${ABA.cab}'!I7`);
    g.set(6, B, 'CUSTOS TOTAIS DE RDM RECEBIDO');
    g.set(6, F, 'CUSTOS TOTAIS DE RDA RECEBIDO');
    g.set(7, B, `=C${totRDM}`);
    g.set(7, F, `=H${totRDA}`);
    g.set(8, B, 'TOTAL DE GASTO ACUMULADO DE RDM');
    g.set(8, F, 'TOTAL DE GASTO ACUMULADO DE RDA');
    g.set(9, B, `='${ABA.rdm}'!D2`);
    const rdaUsados = refRDA.filter(Boolean);
    g.set(9, F, rdaUsados.length ? '=' + rdaUsados.map(l => `'${ABA.rda}'!G${l}`).join('+') : 0);
    g.set(10, B, 'SALDO DE RDM RECEBIDO');
    g.set(10, F, 'SALDO DE RDA RECEBIDO');
    g.set(11, B, '=B7-B9');
    g.set(11, F, '=F7-F9');

    g.set(12, B, 'Inserir COM ATENÇÃO abaixo, todo o valor repassado para as despesas mensais!');
    g.set(12, F, 'Inserir COM ATENÇÃO abaixo, todo o valor repassado para as despesas de alimentação!');
    g.set(13, B, 'EXTRATO DE RDM RECEBIDO');
    g.set(13, F, 'EXTRATO DE RDA RECEBIDO');
    g.set(14, B, 'DATA'); g.set(14, C, 'R$');
    g.set(14, F, 'DATA'); g.set(14, H, 'R$');

    rdm.forEach((x, i) => { g.set(LIN_INI + i, B, _data(x.data)); g.set(LIN_INI + i, C, cur(x.valor)); });
    rda.forEach((x, i) => { g.set(LIN_INI + i, F, _data(x.data)); g.set(LIN_INI + i, H, cur(x.valor)); });

    g.set(totRDM, B, 'TOTAL');
    g.set(totRDM, C, `=SUM(C${LIN_INI}:C${totRDM - 1})`);
    g.set(totRDA, F, 'TOTAL');
    g.set(totRDA, H, `=SUM(H${LIN_INI}:H${totRDA - 1})`);
    g.set(totRDA + 1, F, 'CONSUMIDO');
    g.set(totRDA + 1, H, '=F9');
    g.set(totRDA + 2, F, 'SALDO');
    g.set(totRDA + 2, H, `=H${totRDA}-H${totRDA + 1}`);

    const moeda = [
      [5, B - 1, 11, B], [5, F - 1, 11, F],                       // totalizadores
      [5, M - 1, 11, M + 11],                                     // grade mensal
      [LIN_INI - 1, C - 1, totRDM, C],                            // extrato RDM
      [LIN_INI - 1, H - 1, totRDA + 2, H],                        // extrato RDA
    ];
    return {
      title: ABA.banco, rows: g.rows(), moeda,
      negrito: [[5, 0, 23], [12, 0, 8], [13, 0, 8]],
    };
  }

  /* índice de coluna → letra (1=A) */
  function _col(n) {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
    return s;
  }

  /* ════════════ EQUIPE (consolidado do gestor — fora do modelo) ════════════ */
  function buildEquipe(notas, repasses, collabs, mes, ano, gestorNome) {
    const rows = [
      ['PETERMANN — RELATÓRIO DA EQUIPE'],
      [`Mês: ${MESES[mes-1]}/${ano}    Atualizado em ${_agora()}` + (gestorNome ? `    Gestor: ${gestorNome}` : '')],
      [],
      ['Núcleo','Colaborador','RDM Gasto','RDM Repasse','RDM Saldo','RDA Gasto','RDA Repasse','RDA Saldo'],
    ];
    let tRDMg = 0, tRDMr = 0, tRDAg = 0, tRDAr = 0;
    const nucs = {};
    (collabs || []).forEach(c => { (nucs[c.nucleo] = nucs[c.nucleo] || []).push(c); });
    for (const [nucleo, membros] of Object.entries(nucs).sort()) {
      membros.slice().sort((a, b) => (a.nome || '').localeCompare(b.nome || '')).forEach(c => {
        const cns = (notas || []).filter(n => n.user_id === c.id && !n.deleted);
        const crs = (repasses || []).filter(r => r.user_id === c.id && !r.deleted);
        const rdmG = cns.filter(n => n.tipo === 'RDM').reduce((s, n) => s + cur(n.valor), 0);
        const rdmR = crs.filter(r => r.tipo === 'RDM').reduce((s, r) => s + cur(r.valor), 0);
        const rdaG = cns.filter(n => n.tipo === 'RDA').reduce((s, n) => s + cur(n.valor), 0);
        const rdaR = crs.filter(r => r.tipo === 'RDA').reduce((s, r) => s + cur(r.valor), 0);
        tRDMg += rdmG; tRDMr += rdmR; tRDAg += rdaG; tRDAr += rdaR;
        rows.push([nucleo, c.nome || c.email, cur(rdmG), cur(rdmR), cur(rdmR-rdmG), cur(rdaG), cur(rdaR), cur(rdaR-rdaG)]);
      });
    }
    rows.push([]);
    rows.push(['TOTAL GERAL', '', cur(tRDMg), cur(tRDMr), cur(tRDMr-tRDMg), cur(tRDAg), cur(tRDAr), cur(tRDAr-tRDAg)]);
    return {
      title: 'EQUIPE', rows,
      moeda: [[4, 2, rows.length, 8]],
      negrito: [[3, 0, 8]],
    };
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
    const q = `name='${title.replace(/'/g, "\\'")}' and mimeType='${MIME_SHEET}' and trashed=false`;
    const data = await _req(`${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`);
    return (data.files || [])[0]?.id || null;
  }

  async function _criarPlanilha(title, tabTitles) {
    const ss = await _req(SHEETS_API, {
      method: 'POST',
      json: { properties: { title, locale: 'pt_BR' }, sheets: tabTitles.map(t => ({ properties: { title: t } })) },
    });
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

  /* formatação: negrito nos rótulos, R$ nas faixas de valor.
     As faixas vêm dos construtores em índice 0 (como a API quer). */
  function _formatRequests(sheetId, tab) {
    const reqs = [];
    if (tab.congelar) reqs.push({ updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: tab.congelar } },
      fields: 'gridProperties.frozenRowCount' } });

    /* faixa de cabeçalho: fundo verde, texto branco em negrito */
    (tab.cabecalho || []).forEach(([r, c0, c1]) => reqs.push({ repeatCell: {
      range: { sheetId, startRowIndex: r - 1, endRowIndex: r, startColumnIndex: c0, endColumnIndex: c1 },
      cell: { userEnteredFormat: {
        backgroundColor: VERDE,
        textFormat: { foregroundColor: BRANCO, bold: true },
        horizontalAlignment: 'CENTER' } },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)' } }));

    /* faixa de mês e linha de total: fundo claro + negrito */
    (tab.realce || []).forEach(([r, c0, c1, cor]) => reqs.push({ repeatCell: {
      range: { sheetId, startRowIndex: r - 1, endRowIndex: r, startColumnIndex: c0, endColumnIndex: c1 },
      cell: { userEnteredFormat: { backgroundColor: cor, textFormat: { bold: true } } },
      fields: 'userEnteredFormat(backgroundColor,textFormat.bold)' } }));

    (tab.negrito || []).forEach(([r, c0, c1]) => reqs.push({ repeatCell: {
      range: { sheetId, startRowIndex: r - 1, endRowIndex: r, startColumnIndex: c0, endColumnIndex: c1 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold' } }));
    (tab.moeda || []).forEach(([r0, c0, r1, c1]) => reqs.push({ repeatCell: {
      range: { sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: 'R$ #,##0.00' } } },
      fields: 'userEnteredFormat.numberFormat' } }));
    reqs.push({ autoResizeDimensions: {
      dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 24 } } });
    return reqs;
  }

  /* ════════════ Publicação (cria/atualiza + escreve + formata) ════════════ */
  async function _publicar(title, tabs) {
    if (!GDrive.isConnected()) throw new Error('Conecte o Google Drive no Perfil primeiro');
    const tabTitles = tabs.map(t => t.title);

    let ssId = await _acharPlanilha(title);
    if (!ssId) ssId = (await _criarPlanilha(title, tabTitles)).spreadsheetId;

    const sheetMap = await _garantirAbas(ssId, tabTitles);

    await _req(`${SHEETS_API}/${ssId}/values:batchClear`, {
      method: 'POST', json: { ranges: tabTitles.map(t => `'${t}'`) },
    });

    /* USER_ENTERED (e não RAW) porque a planilha do modelo é feita de
       fórmulas — com RAW elas entrariam como texto literal. */
    await _req(`${SHEETS_API}/${ssId}/values:batchUpdate`, {
      method: 'POST',
      json: {
        valueInputOption: 'USER_ENTERED',
        data: tabs.map(t => ({ range: `'${t.title}'!A1`, values: t.rows.map(r => r.length ? r : ['']) })),
      },
    });

    try {
      const requests = tabs.flatMap(t => _formatRequests(sheetMap[t.title], t));
      await _req(`${SHEETS_API}/${ssId}:batchUpdate`, { method: 'POST', json: { requests } });
    } catch (e) { console.warn('Sheets formatação:', e.message); }

    return `https://docs.google.com/spreadsheets/d/${ssId}/edit`;
  }

  /* planilha pessoal anual — as 5 abas do modelo padrão da empresa */
  function montarAnual(ano, notas, repasses, colab) {
    const ext = _linhasExtrato(repasses, ano);
    const rdm = buildRDM(notas, ano, ext.rdm);
    const rda = buildRDA(notas, ano);
    return [
      buildCabecalho(ano, colab),
      buildNormas(),
      buildBanco(repasses, ano, rdm.totaisMes, rda.totaisMes),
      rdm,
      rda,
    ];
  }

  function exportarAnual(ano, notas, repasses, colab) {
    return _publicar(`Petermann ${((colab && colab.nome) || 'Colaborador').trim()} ${ano}`,
                     montarAnual(ano, notas, repasses, colab));
  }

  /* planilha consolidada da equipe (mensal, 1 aba) */
  function exportarEquipe(notas, repasses, collabs, mes, ano, gestorNome) {
    return _publicar(`Petermann Equipe ${MESES[mes-1]} ${ano}`,
                     [buildEquipe(notas, repasses, collabs, mes, ano, gestorNome)]);
  }

  return {
    exportarAnual, exportarEquipe,
    montarAnual, buildCabecalho, buildNormas, buildBanco, buildRDM, buildRDA, buildEquipe,
  };
})();
