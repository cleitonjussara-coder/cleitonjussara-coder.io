'use strict';
/* ─── Lançar várias notas de uma vez (20/11/2026, pedido do Paulo, sobretudo para o Faturamento) ────────────────────
   1. Escolher, arrastar, colar (Ctrl+V) ou FOTOGRAFAR EM SEQUÊNCIA (câmera do app aberta foto atrás de foto, com contorno,
      foco e flash, e "✔ Concluir").
   2. O app lê todas em segundo plano: toda foto passa pelo localizador de cantos do scanner (o mesmo do "Ajuste os cantos"
      do editor, que o Cleiton aprovou: acha a nota, endireita e corta) e depois pela leitura de sempre (IA no servidor,
      Tesseract de reserva; PDF pelo texto embutido).
   3. Conferência rápida: foto e dados lado a lado, passar as notas com setas ou deslizando, corrigir data/valor ali,
      "⬚ Ajustar cantos" (editor) ou "✏️ Abrir completa" (formulário).
   4. "📤 Enviar as N notas": salva uma por uma pelo formulário NORMAL (todas as conferências de sempre: duplicata, CPF de
      outra pessoa, mês fechado, data no futuro). Se alguma não passar, o envio para nela com o formulário aberto; ao
      salvar, continua sozinho. Também há "uma por uma" ("Salvar e próxima").
   Cada nota continua sendo um lançamento separado. Depende de app.js (formulário, leitura, câmera) e de scanner.js. */
window.LoteNotas = (() => {
  /* por lote: tudo fica na memória do aparelho até ser salvo. No computador (pasta cheia de notas) cabe mais. */
  const MAX = (window.matchMedia && matchMedia('(pointer: coarse)').matches) ? 30 : 80;
  const LEITURAS = 2;        // leituras ao mesmo tempo (a IA do servidor tem limite por minuto)
  /* modo: '' (lista), 'seq' (uma por uma), 'conf' (abriu completa pela conferência), 'envio' (Enviar todas) */
  const S = { base: null, comum: {}, itens: [], ativo: false, noForm: false, lendo: 0, seq: 0, modo: '', conf: 0, parado: false };

  const _el = id => document.getElementById(id);
  const _prontos = () => S.itens.filter(i => ['lida', 'conferir'].includes(i.status));
  const _restantes = () => S.itens.filter(i => ['fila', 'lendo', 'lida', 'conferir'].includes(i.status));
  const _lendo = () => S.itens.some(i => ['fila', 'lendo'].includes(i.status));
  const _plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

  /* ── abrir o lote ── base = { user_id, pagamento, semColaborador, tipo?, subtipo?, ... } (o que o caminho já escolheu) */
  function abrir(base = {}) {
    const b = { ...base };
    ['_manual', '_sugestao', '_direitoParaFoto', '_tipoSelecionado'].forEach(k => delete b[k]);
    S.itens.forEach(_soltar);
    Object.assign(S, { base: b, itens: [], ativo: false, noForm: false, lendo: 0, modo: '', conf: 0, parado: false });
    S.comum = { tipo: b.tipo || (b.pagamento === 'empresa' ? 'RDM' : ''), subtipo: b.subtipo || '' };
    _montar();
    _pintar();
  }

  /* atalho da aba (Despesas → RDA/RDM → 📚 Várias notas): abre o lote e já a câmera em sequência, no mesmo toque */
  function abrirComCamera(base = {}) { abrir(base); fotografar(); }

  function _ehFaturamento() { return S.base?.pagamento === 'empresa'; }
  function _quem() {
    if (!_ehFaturamento()) return '';
    if (S.base.semColaborador || !S.base.user_id) return 'Independente (sem colaborador)';
    return (typeof equipePorId !== 'undefined' && equipePorId[S.base.user_id]?.nome) || 'Colaborador';
  }
  function _categorias() {
    const base = ['Abastecimento', 'Hospedagem', 'Pedágio', 'Manutenção de Veículos', 'Exames', 'Outros'];
    const fat = (_ehFaturamento() && typeof CATEGORIAS_SO_FATURAMENTO !== 'undefined') ? CATEGORIAS_SO_FATURAMENTO.map(c => c.subtipo) : [];
    return [...base, ...fat.filter(c => !base.includes(c))];
  }
  function _abaCategoria() {
    if (S.base._categoriaEscolhida && S.base.subtipo) return `${S.base.tipo || ''} · ${S.base.subtipo}`;
    const t = S.comum.tipo || 'aba escolhida em cada nota';
    return S.comum.tipo === 'RDA' ? 'RDA' : `${t}${S.comum.subtipo ? ' · ' + S.comum.subtipo : ' · categoria lida da nota'}`;
  }

  function _montar() {
    let ov = _el('lote-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'lote-overlay';
      ov.className = 'full-overlay';
      document.body.appendChild(ov);
      document.addEventListener('paste', _aoColar);
    }
    const cvFixo = !!(S.base._categoriaEscolhida && S.base.subtipo);   // C.V.: a categoria veio da tela anterior
    ov.innerHTML = `
      <div class="form-hdr">
        <button class="btn-voltar" aria-label="Voltar" onclick="LoteNotas.fechar()">‹ Voltar</button>
        <h3>📚 Várias notas${_ehFaturamento() ? ' · Faturamento' : ''}</h3>
        <span></span>
      </div>
      <div class="form-body">
        ${_ehFaturamento() ? `<div class="lote-quem">🏢 ${esc(_quem())}</div>` : ''}
        <div class="lote-regra"><b>Uma nota por foto.</b> Cada foto (ou arquivo) vira um lançamento. Não junte várias notas na mesma foto.</div>
        ${_ehFaturamento() ? '' : '<div class="lote-regra lote-regra-dia">📅 <b>Lance as notas todo dia</b>, no dia do gasto. Esta opção é para agilizar, não para juntar notas: evite deixar acumular.</div>'}
        <div class="lote-drop" id="lote-drop" tabindex="0">
          <div class="lote-drop-ico">🗂️</div>
          <div><b>Fotografe as notas uma atrás da outra</b> ou escolha fotos, PDFs e XMLs — vários de uma vez.</div>
          <div class="lote-drop-sub">No computador, também dá para <b>arrastar</b> os arquivos para cá ou <b>colar</b> (Ctrl+V).</div>
          <div class="lote-drop-bts">
            <button type="button" class="btn btn-primary btn-sm" onclick="LoteNotas.fotografar()">📷 Fotografar em sequência</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById('lote-arq').click()">📂 Escolher arquivos</button>
            ${'webkitdirectory' in document.createElement('input') ? `<button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById('lote-pasta').click()">📁 Escolher pasta</button>` : ''}
          </div>
          <input type="file" id="lote-arq" multiple accept="image/*,application/pdf,.pdf,.xml,text/xml,application/xml" style="display:none" onchange="LoteNotas.adicionar(this.files); this.value=''">
          <input type="file" id="lote-pasta" webkitdirectory multiple style="display:none" onchange="LoteNotas.adicionar(this.files, true); this.value=''">
          <input type="file" id="lote-cam" accept="image/*" capture="environment" style="display:none" onchange="LoteNotas.adicionar(this.files); this.value=''">
        </div>
        <div class="lote-comum">
          <div class="lote-comum-tit">Igual em todas <span>(dá para mudar em cada nota)</span></div>
          ${cvFixo ? `<div class="lote-comum-fixo">${esc(S.base.tipo || '')} · ${esc(S.base.subtipo)}</div>` : `
          <div class="lote-comum-grade">
            <label>Aba<select class="inp" id="lote-tipo" onchange="LoteNotas._comum()">
              <option value="">Escolher em cada nota</option>
              <option value="RDM"${S.comum.tipo === 'RDM' ? ' selected' : ''}>RDM</option>
              <option value="RDA"${S.comum.tipo === 'RDA' ? ' selected' : ''}>RDA</option>
            </select></label>
            <label id="lote-cat-lbl">Categoria<select class="inp" id="lote-cat" onchange="LoteNotas._comum()">
              <option value="">Ler de cada nota</option>
              ${_categorias().map(c => `<option${S.comum.subtipo === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
            </select></label>
          </div>`}
        </div>
        <div id="lote-lista"></div>
        <div id="lote-acoes"></div>
      </div>
      <div id="lote-conf" class="lote-conf" style="display:none"></div>`;
    ov.style.display = 'flex';
    const drop = _el('lote-drop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('sobre'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('sobre'));
    drop.addEventListener('drop', async e => {
      e.preventDefault(); drop.classList.remove('sobre');
      const entradas = [...(e.dataTransfer?.items || [])].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
      if (entradas.some(en => en.isDirectory)) adicionar(await _arquivosDasEntradas(entradas), true);   // pasta arrastada: lê tudo dentro
      else adicionar(e.dataTransfer?.files);
    });
    _comum();
  }

  function _comum() {
    const t = _el('lote-tipo'), c = _el('lote-cat');
    if (t) S.comum.tipo = t.value;
    if (c) S.comum.subtipo = c.value;
    const lbl = _el('lote-cat-lbl');
    if (lbl) lbl.style.display = S.comum.tipo === 'RDA' ? 'none' : '';   // RDA não tem categoria
  }

  function _aoColar(e) {
    const ov = _el('lote-overlay');
    if (!ov || ov.style.display === 'none') return;
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    adicionar(files);
  }

  /* ── câmera do app em sequência ── */
  function fotografar() {
    if (S.itens.length >= MAX) { toast(`Cabem ${MAX} notas por vez`, 'err'); return; }
    abrirCameraNota(null, {
      sequencia: true, scanner: true, inputReserva: 'lote-cam',
      dica: 'Enquadre a nota — a próxima foto sai quando você trocar de nota',
      aoFoto: f => adicionar([f]),
      aoConcluir: n => { _pintar(); if (n) toast(`${_plural(n, 'foto guardada', 'fotos guardadas')} — o app está lendo`); },
    });
  }

  /* pasta arrastada (20/11/2026): percorre as subpastas também */
  async function _arquivosDasEntradas(entradas) {
    const out = [];
    const arquivo = en => new Promise(r => en.file(r, () => r(null)));
    const ler = dir => new Promise(r => { const rd = dir.createReader(); const todos = [];
      const lote = () => rd.readEntries(l => { if (!l.length) r(todos); else { todos.push(...l); lote(); } }, () => r(todos)); lote(); });
    const visitar = async en => {
      if (out.length > 500) return;
      if (en.isFile) { const f = await arquivo(en); if (f) out.push(f); }
      else if (en.isDirectory) for (const filho of await ler(en)) await visitar(filho);
    };
    for (const en of entradas) await visitar(en);
    return out;
  }

  /* ── fila de arquivos ── dePasta: arquivos que não são nota (planilha, txt…) são ignorados sem aviso de erro */
  function adicionar(lista, dePasta = false) {
    let files = [...(lista || [])];
    if (dePasta) files = files.filter(f => !/^\./.test(f.name || '')).sort((a, b) => String(a.webkitRelativePath || a.name).localeCompare(String(b.webkitRelativePath || b.name), 'pt-BR', { numeric: true }));
    if (!files.length) { if (dePasta) toast('Essa pasta não tem foto, PDF nem XML de nota', 'err'); return; }
    let fora = 0, tipoErrado = 0;
    for (const f of files) {
      const ext = _extDoArquivo(f);
      if (!(_ehImagemExt(ext) || ext === 'pdf' || ext === 'xml' || /^image\//i.test(f.type || ''))) { tipoErrado++; continue; }
      if (S.itens.length >= MAX) { fora++; continue; }
      S.itens.push({ id: ++S.seq, file: f, nome: f.name || `imagem colada ${S.seq}`, status: 'fila', edit: {} });
    }
    if (tipoErrado) toast(dePasta ? `${tipoErrado} arquivo(s) da pasta não são nota (só foto, PDF ou XML) e foram ignorados` : `${tipoErrado} arquivo(s) ficaram de fora: só foto, PDF ou XML`, 'err');
    if (fora) toast(`Cabem ${MAX} notas por vez — ${fora} ficaram de fora. Lance estas e depois as outras.`, 'err', 5000);
    _pintar();
    _lerProximas();
  }

  function _lerProximas() {
    while (S.lendo < LEITURAS) {
      const it = S.itens.find(i => i.status === 'fila');
      if (!it) return;
      it.status = 'lendo'; S.lendo++;
      _ler(it).catch(() => { it.status = 'conferir'; it.ocr = it.ocr || {}; })
        .finally(() => { S.lendo--; _pintar(); _pintarConf(); _lerProximas(); });
      _pintar();
    }
  }

  /* localizador de cantos do scanner (o do "Ajuste os cantos"): acha a nota, endireita a perspectiva e corta */
  async function _cantos(blob) {
    if (!window.Scanner?.endireitar) return blob;
    try { const r = await Scanner.endireitar(blob); return r?.endireitou && r.blob ? r.blob : blob; } catch (_) { return blob; }
  }

  async function _lerImagem(it, blob) {
    it.blob = blob;
    if (it.url) { try { URL.revokeObjectURL(it.url); } catch (_) {} it.url = null; }
    it.ocr = await _lerNota(blob);
    if (it.ocr?.cortado && _cortadoBarra(it.ocr, it.ocr.chave)) { it.status = 'erro'; it.motivo = 'texto cortado na foto — fotografe de novo'; return; }
    _resumir(it);
  }

  async function _ler(it) {
    let f = it.file;
    if (!f || f.size === 0) { it.status = 'erro'; it.motivo = 'arquivo vazio (baixe para o aparelho e escolha de novo)'; return; }
    try { await f.slice(0, 16).arrayBuffer(); } catch (_) { it.status = 'erro'; it.motivo = 'o aparelho não deixou ler o arquivo'; return; }
    const ext = _extDoArquivo(f);
    if (ext === 'xml') { it.ext = 'xml'; it.ocr = null; it.status = 'lida'; it.resumo = 'XML da nota'; return; }
    if (ext === 'pdf') {
      it.ext = 'pdf';
      const { blob, texto } = await _renderPdfPagina1(f);
      it.render = blob;
      const temTexto = String(texto || '').replace(/\s/g, '').length >= 40;
      it.ocr = temTexto && window.OCR?.parseFiscalText ? OCR.parseFiscalText(texto) : await _lerNota(blob);
      await _lerQr(it, blob);
      _resumir(it);
      return;
    }
    it.ext = 'jpg';
    try { f = await _normalizarOrientacao(f); } catch (_) {}
    try { f = await _endireitarNota(f); } catch (_) {}
    if (window.FotoBranca && !f.__brancaConferida) {
      let branca = null;
      try { branca = await FotoBranca.emBranco(f); } catch (_) {}
      if (branca === true) { it.status = 'erro'; it.motivo = 'foto em branco'; return; }
    }
    it.original = f;                 // o QR é procurado na foto inteira (fotoOriginal), sem o corte
    await _lerQr(it, f);
    await _lerImagem(it, await _cantos(f));
  }

  /* QR Code da foto (20/11/2026, "lançar com QR Code em sequência"): lido já na leitura em segundo plano, na foto inteira.
     Com a chave, o formulário não lê de novo e completa CNPJ, UF e mês pela chave, como no lançamento pelo QR. */
  async function _lerQr(it, blob) {
    try { it.qr = (typeof _lerQRdaImagem === 'function') ? await _lerQRdaImagem(blob) : null; } catch (_) { it.qr = null; }
    if (it.qr && !(it.qr.chave?.length === 44 || it.qr.documento === 'nfse')) it.qr = null;
  }
  const _qrTxt = it => it.qr?.chave ? '🔑 QR lido' : it.qr?.documento === 'nfse' ? '🔑 QR da NFS-e' : 'sem QR';

  function _resumir(it) {
    const o = it.ocr || {};
    /* 20/11/2026: uma nota por foto. A IA contou 2+ documentos: fica de fora, salvo se a pessoa disser "É uma nota só" */
    if (o.qtd > 1 && !it.umaSo) { it.status = 'erro'; it.multi = true; it.motivo = `${o.qtd} notas na mesma foto — fotografe cada uma separada`; return; }
    it.multi = false;
    const partes = [o.razao_social || (o.cnpj ? 'CNPJ ' + o.cnpj : ''), o.data ? fmtDataBR(o.data) : ''].filter(Boolean);
    it.valor = Number(o.valor) > 0 ? Number(o.valor) : null;
    if (!o.cnpj && it.qr?.cnpj) partes.unshift('CNPJ ' + it.qr.cnpj);
    it.resumo = [partes.join(' · ') || 'sem fornecedor lido', it.ext === 'xml' ? '' : _qrTxt(it)].filter(Boolean).join(' · ');
    it.status = (it.valor || Number(it.edit.valor) > 0) ? 'lida' : 'conferir';
  }

  function _soltar(it) { if (it?.url) { try { URL.revokeObjectURL(it.url); } catch (_) {} it.url = null; } }

  function umaSo(id) {
    const it = S.itens.find(x => x.id === id);
    if (!it || !it.multi) return;           // só a que foi marcada "N notas na mesma foto"
    it.umaSo = true;
    _resumir(it);
    _pintar();
  }

  function remover(id) {
    const i = S.itens.findIndex(x => x.id === id);
    if (i >= 0 && S.itens[i].status !== 'lendo') { _soltar(S.itens[i]); S.itens.splice(i, 1); }
    _pintar();
  }

  /* ── tela da lista ── */
  const ICO = { fila: '⏳', lendo: '🔎', lida: '✅', conferir: '⚠️', erro: '⛔', salva: '💾', pulada: '⏭️' };
  const _valorDe = it => Number(it.edit.valor) > 0 ? Number(it.edit.valor) : it.valor;
  function _linha(it) {
    const v = _valorDe(it);
    const sub = it.status === 'fila' ? 'na fila para ler'
      : it.status === 'lendo' ? 'lendo…'
      : it.status === 'erro' ? it.motivo
      : it.status === 'salva' ? 'lançada'
      : it.status === 'pulada' ? 'pulada — não foi lançada'
      : it.status === 'conferir' ? `${it.resumo || ''} · sem valor: conferir`
      : it.resumo;
    const tira = ['fila', 'lida', 'conferir', 'erro', 'pulada'].includes(it.status);
    return `<div class="lote-item ${it.status}">
      <span class="lote-item-ico">${ICO[it.status]}</span>
      <div class="lote-item-txt"><div class="lote-item-nome">${esc(it.nome)}</div><div class="lote-item-sub">${esc(sub || '')}</div></div>
      <span class="lote-item-val">${v ? esc(brl(v)) : ''}</span>
      ${it.multi ? `<button type="button" class="btn btn-outline btn-sm lote-item-uma" onclick="LoteNotas.umaSo(${it.id})">É uma nota só</button>` : ''}
      ${tira ? `<button type="button" class="lote-item-x" aria-label="Tirar da lista" onclick="LoteNotas.remover(${it.id})">✕</button>` : ''}
    </div>`;
  }

  function _pintar() {
    const lista = _el('lote-lista'), acoes = _el('lote-acoes');
    if (!lista || !acoes) return;
    const n = S.itens.length;
    const lidas = S.itens.filter(i => !['fila', 'lendo'].includes(i.status)).length;
    const salvas = S.itens.filter(i => i.status === 'salva').length;
    const prontas = _prontos().length;
    lista.innerHTML = n ? `<div class="lote-lista-tit">${_plural(n, 'nota', 'notas')} · ${_plural(lidas, 'lida', 'lidas')}${salvas ? ` · ${_plural(salvas, 'lançada', 'lançadas')}` : ''}</div>`
      + S.itens.map(_linha).join('') : '';
    acoes.innerHTML = prontas
      ? `<button type="button" class="btn btn-primary btn-full" onclick="LoteNotas.conferir()">🔍 Conferir e enviar (${prontas} pronta${prontas > 1 ? 's' : ''})</button>
         <button type="button" class="btn btn-outline btn-full" style="margin-top:8px" onclick="LoteNotas.comecar()">✍️ Lançar uma por uma (formulário completo)</button>
         ${_lendo() ? '<div class="lote-dica">As outras continuam sendo lidas enquanto você confere.</div>' : ''}`
      : _lendo() ? '<div class="lote-dica">Lendo as notas…</div>'
      : n && salvas ? `<div class="lote-dica">Pronto: ${_plural(salvas, 'nota lançada', 'notas lançadas')}.</div><button type="button" class="btn btn-outline btn-full" onclick="LoteNotas.fechar(true)">Concluir</button>`
      : '';
  }

  /* ── conferência rápida: foto + dados, passar as notas ── */
  function conferir(i = 0) {
    const lista = _prontos();
    if (!lista.length) { toast('Espere a leitura terminar', 'err'); return; }
    S.conf = Math.max(0, Math.min(i, lista.length - 1));
    const c = _el('lote-conf'); if (!c) return;
    c.style.display = 'flex';
    _pintarConf();
  }
  function _fecharConf() { const c = _el('lote-conf'); if (c) c.style.display = 'none'; _pintar(); }

  function _imgDe(it) {
    const b = it.ext === 'pdf' ? it.render : it.ext === 'xml' ? null : it.blob;
    if (!b) return '';
    if (!it.url) it.url = URL.createObjectURL(b);
    return it.url;
  }

  function _pintarConf() {
    const c = _el('lote-conf');
    if (!c || c.style.display === 'none') return;
    const lista = _prontos();
    if (!lista.length) { _fecharConf(); return; }
    if (S.conf >= lista.length) S.conf = lista.length - 1;
    const it = lista[S.conf];
    const o = it.ocr || {};
    const data = it.edit.data || o.data || '';
    const valor = it.edit.valor ?? (it.valor ? String(it.valor) : '');
    const img = _imgDe(it);
    const semValor = !(Number(valor) > 0);
    c.innerHTML = `
      <div class="form-hdr">
        <button class="btn-voltar" aria-label="Voltar à lista" onclick="LoteNotas._fecharConf()">‹ Lista</button>
        <h3>Conferir · ${S.conf + 1} de ${lista.length}</h3>
        <span class="lote-conf-selo ${semValor ? 'aviso' : ''}">${semValor ? 'sem valor' : '✓'}</span>
      </div>
      <div class="lote-conf-corpo" id="lote-conf-corpo">
        <div class="lote-conf-foto" onclick="LoteNotas._ampliar()">
          ${img ? `<img src="${_at(img)}" alt="Nota ${S.conf + 1}">` : '<div class="lote-conf-semfoto">📄 XML — sem imagem</div>'}
          ${img ? '<span class="lote-conf-zoom">toque para ampliar</span>' : ''}
        </div>
        <div class="lote-conf-dados">
          <div class="lote-conf-campo"><span>Fornecedor</span><b>${esc(o.razao_social || (o.cnpj ? 'CNPJ ' + o.cnpj : 'não lido — confira ao abrir completa'))}</b></div>
          <div class="lote-conf-grade">
            <label>Data<input type="date" class="inp" value="${_at(data)}" onchange="LoteNotas._editar('data', this.value)"></label>
            <label>Valor (R$)<input type="number" inputmode="decimal" step="any" min="0" class="inp${semValor ? ' lote-falta' : ''}" value="${_at(valor)}" placeholder="digite" onchange="LoteNotas._editar('valor', this.value)"></label>
          </div>
          <div class="lote-conf-campo"><span>Aba · Categoria</span><b>${esc(_abaCategoria())}</b></div>
          ${it.ext === 'xml' ? '' : `<div class="lote-conf-campo"><span>QR Code</span><b class="${it.qr ? 'lote-qr-ok' : 'lote-qr-nao'}">${it.qr?.chave ? '🔑 lido · chave ' + esc(it.qr.chave.replace(/(\d{4})(?=\d)/g, '$1 ')) : it.qr ? '🔑 lido (NFS-e)' : 'não encontrado na foto — os dados vêm da leitura do texto'}</b></div>`}
          <div class="lote-conf-campo"><span>Arquivo</span><b class="lote-conf-arq">${esc(it.nome)}</b></div>
          <div class="lote-conf-bts">
            ${it.ext === 'jpg' ? '<button type="button" class="btn btn-outline btn-sm" onclick="LoteNotas._ajustarCantos()">⬚ Ajustar cantos</button>' : ''}
            <button type="button" class="btn btn-outline btn-sm" onclick="LoteNotas._abrirCompleta()">✏️ Abrir completa</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="LoteNotas._tirarDaConf()">🗑 Tirar do lote</button>
          </div>
        </div>
      </div>
      <div class="lote-conf-nav">
        <button type="button" class="btn btn-outline" ${S.conf === 0 ? 'disabled' : ''} onclick="LoteNotas._mover(-1)">‹ Anterior</button>
        <span>deslize para os lados</span>
        <button type="button" class="btn btn-outline" ${S.conf >= lista.length - 1 ? 'disabled' : ''} onclick="LoteNotas._mover(1)">Próxima ›</button>
      </div>
      <div class="lote-conf-envio">
        <button type="button" class="btn btn-primary btn-full" onclick="LoteNotas.enviar()">📤 Enviar ${lista.length === 1 ? 'a nota' : `as ${lista.length} notas`}</button>
        <div class="lote-dica">O app salva uma por uma. Se alguma tiver problema (duplicata, mês fechado, data), para nela para você corrigir.</div>
      </div>`;
    const corpo = _el('lote-conf-corpo');
    let x0 = null;
    corpo?.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
    corpo?.addEventListener('touchend', e => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 60) _mover(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function _itConf() { return _prontos()[S.conf]; }
  function _mover(d) { S.conf += d; _pintarConf(); }
  function _editar(campo, v) {
    const it = _itConf(); if (!it) return;
    it.edit[campo] = v;
    if (campo === 'valor') { it.status = Number(v) > 0 || it.valor ? 'lida' : 'conferir'; _pintarConf(); }
  }
  function _tirarDaConf() { const it = _itConf(); if (it) { it.status = 'pulada'; _pintarConf(); _pintar(); } }

  function _ampliar() {
    const it = _itConf(); const src = it && _imgDe(it);
    if (!src) return;
    const v = document.createElement('div');
    v.className = 'lote-zoom';
    v.innerHTML = `<img src="${_at(src)}" alt="Nota ampliada"><button type="button" class="btn btn-sm" aria-label="Fechar">✕ Fechar</button>`;
    v.onclick = () => v.remove();
    document.body.appendChild(v);
  }

  /* o mesmo "Ajuste os cantos" do editor da foto (EditorFoto, soCantos); a nota ajustada é lida de novo */
  async function _ajustarCantos() {
    const it = _itConf(); if (!it || !window.EditorFoto) return;
    const novo = await EditorFoto.abrir(it.original || it.blob, { soCantos: true });
    if (!novo) return;
    it.status = 'lendo'; _pintarConf(); _pintar();
    try { await _lerImagem(it, novo); } catch (_) { it.status = 'conferir'; }
    _pintar(); _pintarConf();
  }

  /* ── abrir no formulário ── */
  function _dadosDoForm() {
    const dados = { ...S.base, _lote: true, _tipoSelecionado: true, metodo_captura: 'foto' };
    if (!S.base._categoriaEscolhida) {
      if (S.comum.tipo) dados.tipo = S.comum.tipo;
      if (S.comum.subtipo && dados.tipo !== 'RDA') { dados.subtipo = S.comum.subtipo; dados._categoriaEscolhida = true; }
    }
    return dados;
  }

  async function _abrirItem(it, { escondido = false } = {}) {
    S.atual = it.id;
    const ov = _el('lote-overlay'); if (ov && !escondido) ov.style.display = 'none';
    await abrirFormNota(_dadosDoForm());
    if (escondido) { const f = _el('nota-form-overlay'); if (f) f.style.display = 'none'; }
    _barra(it);
    /* o anexo entra como no "Anexar arquivo", mas com a leitura já pronta: sem recorte e sem ler de novo */
    if (it.ext === 'xml') {
      fotoBlob = it.file; fotoOriginal = it.file; fotoExt = 'xml';
      fotoURL = URL.createObjectURL(it.file); atualizarPreviewFoto(fotoURL);
      await extrairDadosDoXML(it.file);
    } else if (it.ext === 'pdf') {
      fotoBlob = it.file; fotoOriginal = it.file; fotoExt = 'pdf';
      fotoURL = URL.createObjectURL(it.file);
      _setFotoRender(it.render); atualizarPreviewFoto(fotoURL);
      await extrairDadosDaFoto(it.render, it.ocr || {});
    } else {
      if (it.qr?.chave) { const k = _el('nf-chave'); if (k) k.value = it.qr.chave; }
      if (it.qr?.qr_url) { const q = _el('nf-qr-url'); if (q) q.value = it.qr.qr_url; }
      fotoBlob = it.blob; fotoOriginal = it.original || it.blob; fotoExt = 'jpg';
      fotoURL = URL.createObjectURL(it.blob); atualizarPreviewFoto(fotoURL);
      await extrairDadosDaFoto(it.blob, it.ocr || {});
    }
    /* o que a pessoa corrigiu na conferência vale sobre a leitura */
    if (it.edit.data) { const d = _el('nf-data'); if (d) d.value = it.edit.data; }
    if (Number(it.edit.valor) > 0) { const v = _el('nf-valor'); if (v) v.value = Number(it.edit.valor); }
    if (escondido) { const o = _el('ocr-overlay'); if (o) o.style.display = 'none'; }
  }

  function _barra(it) {
    const total = S.itens.filter(i => !['erro', 'pulada'].includes(i.status)).length;
    const pos = S.itens.filter(i => !['erro', 'pulada'].includes(i.status)).indexOf(it) + 1;
    const corpo = document.querySelector('#nota-form-overlay .form-body');
    let b = _el('nf-lote-barra');
    if (!b && corpo) { b = document.createElement('div'); b.id = 'nf-lote-barra'; corpo.prepend(b); }
    if (b) {
      b.style.display = '';
      b.innerHTML = `<div class="nf-lote-tit">📚 Nota ${pos} de ${total}${S.modo === 'envio' ? ' · corrija e salve para continuar o envio' : ''}</div>
        <div class="nf-lote-sub">${esc(it.nome)}</div>
        <div class="nf-lote-bts">
          <button type="button" class="btn btn-outline btn-sm" onclick="LoteNotas.pular()">⏭️ Pular</button>
          <button type="button" class="btn btn-outline btn-sm" onclick="LoteNotas.parar()">⏹ Parar</button>
        </div>`;
    }
    const sv = _el('nf-btn-salvar');
    if (sv) sv.textContent = S.modo === 'conf' ? 'Salvar' : (_prontos().length > 1 || _lendo()) ? 'Salvar e próxima' : 'Salvar e concluir';
  }

  function _limparBarra() {
    const b = _el('nf-lote-barra'); if (b) b.style.display = 'none';
    const sv = _el('nf-btn-salvar'); if (sv) sv.textContent = 'Salvar';
  }

  /* chamado por abrirFormNota: só a nota aberta PELO lote conta quando for salva */
  function formAberto(dados) {
    S.noForm = !!(dados && dados._lote && S.ativo);
    if (!S.noForm) _limparBarra();
  }

  /* uma por uma: abre a 1ª pronta no formulário completo, "Salvar e próxima" */
  async function comecar() {
    const it = _prontos()[0];
    if (!it) { toast('Espere a leitura terminar', 'err'); return; }
    S.ativo = true; S.modo = 'seq';
    await _abrirItem(it);
  }

  async function _abrirCompleta() {
    const it = _itConf(); if (!it) return;
    S.ativo = true; S.modo = 'conf';
    await _abrirItem(it);
  }

  /* chamado por salvarNota depois de gravar; devolve true se o lote cuidou do que vem depois */
  function salvou(saved) {
    if (!S.ativo || !S.noForm) return false;
    S.noForm = false;
    const it = S.itens.find(i => i.id === S.atual);
    if (it) { it.status = 'salva'; it.notaId = saved?.id; }
    _limparBarra();
    if (S.modo === 'envio') { if (S.parado) { S.parado = false; setTimeout(_enviarProxima, 350); } return true; }
    if (S.modo === 'conf') { _voltarConf(); return true; }
    _proximaSeq();
    return true;
  }

  function _voltarConf() {
    S.ativo = false; S.modo = '';
    const ov = _el('lote-overlay'); if (ov) ov.style.display = 'flex';
    _pintar();
    if (_prontos().length) conferir(S.conf); else _fecharConf();
  }

  function _proximaSeq() {
    const prox = _prontos()[0];
    if (prox) { setTimeout(() => _abrirItem(prox), 350); return; }
    _fim();
  }

  function _fim() {
    S.ativo = false; S.modo = ''; S.parado = false;
    const ov = _el('lote-overlay'); if (ov) ov.style.display = 'flex';
    _fecharConf();
    _pintar();
    if (_lendo()) toast('Lançadas as que estavam prontas — as outras ainda estão sendo lidas');
  }

  /* ── Enviar todas ── */
  async function enviar() {
    if (!_prontos().length) return;
    S.ativo = true; S.modo = 'envio'; S.parado = false;
    await _enviarProxima();
  }

  async function _enviarProxima() {
    if (S.modo !== 'envio') return;
    const it = _prontos()[0];
    if (!it) {
      const n = S.itens.filter(i => i.status === 'salva').length;
      _progresso(null);
      _fim();
      toast(`📤 ${_plural(n, 'nota enviada', 'notas enviadas')}`);
      return;
    }
    const total = S.itens.filter(i => ['lida', 'conferir', 'salva'].includes(i.status)).length;
    const feitas = S.itens.filter(i => i.status === 'salva').length;
    _progresso(`Enviando ${feitas + 1} de ${total}…`);
    await _abrirItem(it, { escondido: true });
    if (S.modo !== 'envio') return;
    await salvarNota();
    if (S.modo !== 'envio') return;
    if (it.status === 'salva') { setTimeout(_enviarProxima, 150); return; }
    /* não passou numa conferência: mostra o formulário desta nota; salvar continua o envio */
    _progresso(null);
    S.parado = true; S.noForm = true;
    const f = _el('nota-form-overlay'); if (f) f.style.display = 'flex';
    _barra(it);
  }

  function _progresso(txt) {
    let p = _el('lote-progresso');
    if (!txt) { if (p) p.remove(); return; }
    if (!p) { p = document.createElement('div'); p.id = 'lote-progresso'; p.className = 'lote-progresso'; document.body.appendChild(p); }
    p.innerHTML = `<div class="ocr-spin"></div><div>${esc(txt)}</div>`;
  }

  function pular() {
    const it = S.itens.find(i => i.id === S.atual);
    if (it) it.status = 'pulada';
    S.noForm = false;
    fecharFormNota();
    _limparBarra();
    if (S.modo === 'envio') { S.parado = false; setTimeout(_enviarProxima, 150); return; }
    if (S.modo === 'conf') { _voltarConf(); return; }
    _proximaSeq();
  }

  function parar() {
    const modo = S.modo;
    S.noForm = false; S.ativo = false; S.modo = ''; S.parado = false;
    _progresso(null);
    fecharFormNota();
    _limparBarra();
    const ov = _el('lote-overlay'); if (ov) ov.style.display = 'flex';
    _pintar();
    if ((modo === 'conf' || modo === 'envio') && _prontos().length) conferir(S.conf); else _fecharConf();
  }

  /* "‹ Voltar" do formulário durante o lote = parar (a nota aberta continua na lista para depois) */
  function formFechadoPeloUsuario() { if (S.ativo) parar(); }

  async function fechar(semPerguntar) {
    const falta = _restantes().length;
    if (!semPerguntar && falta) {
      const ok = await pedirConfirmacao({ titulo: 'Sair do lançamento de várias notas?',
        mensagem: `${_plural(falta, 'nota ainda não foi lançada', 'notas ainda não foram lançadas')}. As já lançadas ficam salvas.`,
        confirmar: 'Sair', cancelar: 'Continuar aqui' });
      if (!ok) return;
    }
    S.itens.forEach(_soltar);
    Object.assign(S, { itens: [], ativo: false, noForm: false, modo: '', parado: false });
    _progresso(null);
    const ov = _el('lote-overlay'); if (ov) ov.style.display = 'none';
    _limparBarra();
  }

  return { abrir, abrirComCamera, adicionar, remover, umaSo, fotografar, comecar, conferir, enviar, pular, parar, fechar,
           formAberto, salvou, formFechadoPeloUsuario,
           _comum, _fecharConf, _mover, _editar, _tirarDaConf, _ampliar, _ajustarCantos, _abrirCompleta,
           get ativo() { return S.ativo; }, _estado: S };
})();
