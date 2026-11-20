'use strict';
/* ─── Lançar várias notas de uma vez (20/11/2026, pedido do Paulo, sobretudo para o Faturamento) ────────────────────
   A pessoa escolhe (ou cola, ou arrasta) várias fotos/PDFs/XMLs. O app lê todas em segundo plano (a mesma leitura do
   lançamento comum: IA no servidor, Tesseract de reserva, texto embutido do PDF) e depois abre o formulário NORMAL de
   cada uma, já preenchido, com "Salvar e próxima". Cada nota continua sendo um lançamento separado e passa por todas as
   conferências de sempre (duplicata, CPF de outra pessoa, mês fechado, data no futuro): nada é gravado sem a tela.
   Depende de app.js: abrirFormNota, extrairDadosDaFoto, extrairDadosDoXML, _lerNota, _renderPdfPagina1, _endireitarNota,
   _normalizarOrientacao, _cortadoBarra, _extDoArquivo, _ehImagemExt, _setFotoRender, atualizarPreviewFoto, fecharFormNota
   e das variáveis fotoBlob/fotoOriginal/fotoExt/fotoURL. */
window.LoteNotas = (() => {
  const MAX = 30;            // por lote: tudo fica na memória do aparelho até ser salvo
  const LEITURAS = 2;        // leituras ao mesmo tempo (a IA do servidor tem limite por minuto)
  const S = { base: null, comum: {}, itens: [], ativo: false, noForm: false, lendo: 0, seq: 0 };

  const _el = id => document.getElementById(id);
  const _pendentes = () => S.itens.filter(i => ['lida', 'conferir'].includes(i.status));
  const _restantes = () => S.itens.filter(i => ['fila', 'lendo', 'lida', 'conferir'].includes(i.status));

  /* ── abrir o lote ── base = { user_id, pagamento, semColaborador, tipo?, subtipo?, ... } (o que o caminho já escolheu) */
  function abrir(base = {}) {
    const b = { ...base };
    ['_manual', '_sugestao', '_direitoParaFoto', '_tipoSelecionado'].forEach(k => delete b[k]);
    Object.assign(S, { base: b, itens: [], ativo: false, noForm: false, lendo: 0 });
    S.comum = { tipo: b.tipo || (b.pagamento === 'empresa' ? 'RDM' : ''), subtipo: b.subtipo || '' };
    _montar();
    _pintar();
  }

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
        <div class="lote-drop" id="lote-drop" tabindex="0">
          <div class="lote-drop-ico">🗂️</div>
          <div><b>Escolha fotos, PDFs ou XMLs</b> — vários de uma vez.</div>
          <div class="lote-drop-sub">No computador, também dá para <b>arrastar</b> os arquivos para cá ou <b>colar</b> (Ctrl+V).</div>
          <div class="lote-drop-bts">
            <button type="button" class="btn btn-primary btn-sm" onclick="document.getElementById('lote-arq').click()">📂 Escolher arquivos</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById('lote-cam').click()">📷 Fotografar</button>
          </div>
          <input type="file" id="lote-arq" multiple accept="image/*,application/pdf,.pdf,.xml,text/xml,application/xml" style="display:none" onchange="LoteNotas.adicionar(this.files); this.value=''">
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
      </div>`;
    ov.style.display = 'flex';
    const drop = _el('lote-drop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('sobre'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('sobre'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('sobre'); adicionar(e.dataTransfer?.files); });
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

  /* ── fila de arquivos ── */
  function adicionar(lista) {
    const files = [...(lista || [])];
    if (!files.length) return;
    let fora = 0, tipoErrado = 0;
    for (const f of files) {
      const ext = _extDoArquivo(f);
      if (!(_ehImagemExt(ext) || ext === 'pdf' || ext === 'xml' || /^image\//i.test(f.type || ''))) { tipoErrado++; continue; }
      if (S.itens.length >= MAX) { fora++; continue; }
      S.itens.push({ id: ++S.seq, file: f, nome: f.name || `imagem colada ${S.seq}`, status: 'fila' });
    }
    if (tipoErrado) toast(`${tipoErrado} arquivo(s) ficaram de fora: só foto, PDF ou XML`, 'err');
    if (fora) toast(`Cabem ${MAX} notas por vez — ${fora} ficaram de fora. Lance estas e depois as outras.`, 'err', 5000);
    _pintar();
    _lerProximas();
  }

  function _lerProximas() {
    while (S.lendo < LEITURAS) {
      const it = S.itens.find(i => i.status === 'fila');
      if (!it) return;
      it.status = 'lendo'; S.lendo++;
      _ler(it).catch(() => { it.status = 'conferir'; it.ocr = {}; })
        .finally(() => { S.lendo--; _pintar(); _lerProximas(); });
      _pintar();
    }
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
    } else {
      it.ext = 'jpg';
      try { f = await _normalizarOrientacao(f); } catch (_) {}
      try { f = await _endireitarNota(f); } catch (_) {}
      it.blob = f;
      if (window.FotoBranca) {
        let branca = null;
        try { branca = await FotoBranca.emBranco(f); } catch (_) {}
        if (branca === true) { it.status = 'erro'; it.motivo = 'foto em branco'; return; }
      }
      it.ocr = await _lerNota(f);
      if (it.ocr?.cortado && _cortadoBarra(it.ocr, it.ocr.chave)) { it.status = 'erro'; it.motivo = 'texto cortado na foto — fotografe de novo'; return; }
    }
    const o = it.ocr || {};
    const partes = [o.razao_social || (o.cnpj ? 'CNPJ ' + o.cnpj : ''), o.data ? fmtDataBR(o.data) : ''].filter(Boolean);
    it.valor = Number(o.valor) > 0 ? Number(o.valor) : null;
    it.resumo = partes.join(' · ') || 'sem fornecedor lido';
    it.status = it.valor ? 'lida' : 'conferir';
  }

  function remover(id) {
    const i = S.itens.findIndex(x => x.id === id);
    if (i >= 0 && S.itens[i].status !== 'lendo') S.itens.splice(i, 1);
    _pintar();
  }

  /* ── tela da lista ── */
  const ICO = { fila: '⏳', lendo: '🔎', lida: '✅', conferir: '⚠️', erro: '⛔', salva: '💾', pulada: '⏭️' };
  function _linha(it) {
    const val = it.valor ? brl(it.valor) : '';
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
      <span class="lote-item-val">${esc(val)}</span>
      ${tira ? `<button type="button" class="lote-item-x" aria-label="Tirar da lista" onclick="LoteNotas.remover(${it.id})">✕</button>` : ''}
    </div>`;
  }

  function _pintar() {
    const lista = _el('lote-lista'), acoes = _el('lote-acoes');
    if (!lista || !acoes) return;
    const n = S.itens.length;
    const lidas = S.itens.filter(i => !['fila', 'lendo'].includes(i.status)).length;
    const salvas = S.itens.filter(i => i.status === 'salva').length;
    const prontas = _pendentes().length;
    lista.innerHTML = n ? `<div class="lote-lista-tit">${n} nota${n > 1 ? 's' : ''} · ${lidas} lida${lidas !== 1 ? 's' : ''}${salvas ? ` · ${salvas} lançada${salvas > 1 ? 's' : ''}` : ''}</div>`
      + S.itens.map(_linha).join('') : '';
    const lendo = S.itens.some(i => ['fila', 'lendo'].includes(i.status));
    acoes.innerHTML = prontas
      ? `<button type="button" class="btn btn-primary btn-full" onclick="LoteNotas.comecar()">${salvas ? 'Continuar' : 'Começar'}: abrir a próxima nota (${prontas} pronta${prontas > 1 ? 's' : ''})</button>
         ${lendo ? '<div class="lote-dica">As outras continuam sendo lidas enquanto você lança.</div>' : ''}`
      : lendo ? '<div class="lote-dica">Lendo as notas…</div>'
      : n && salvas ? `<div class="lote-dica">Pronto: ${salvas} nota${salvas > 1 ? 's' : ''} lançada${salvas > 1 ? 's' : ''}.</div><button type="button" class="btn btn-outline btn-full" onclick="LoteNotas.fechar(true)">Concluir</button>`
      : '';
  }

  /* ── lançar uma por uma ── */
  async function comecar() {
    const it = _pendentes()[0];
    if (!it) { toast('Espere a leitura terminar', 'err'); return; }
    S.ativo = true;
    await _abrirItem(it);
  }

  async function _abrirItem(it) {
    S.atual = it.id;
    const ov = _el('lote-overlay'); if (ov) ov.style.display = 'none';
    const dados = { ...S.base, _lote: true, _tipoSelecionado: true, metodo_captura: 'foto' };
    if (!S.base._categoriaEscolhida) {
      if (S.comum.tipo) dados.tipo = S.comum.tipo;
      if (S.comum.subtipo && dados.tipo !== 'RDA') { dados.subtipo = S.comum.subtipo; dados._categoriaEscolhida = true; }
    }
    await abrirFormNota(dados);
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
      fotoBlob = it.blob; fotoOriginal = it.blob; fotoExt = 'jpg';
      fotoURL = URL.createObjectURL(it.blob); atualizarPreviewFoto(fotoURL);
      await extrairDadosDaFoto(it.blob, it.ocr || {});
    }
  }

  function _barra(it) {
    const total = S.itens.filter(i => i.status !== 'erro').length;
    const pos = S.itens.filter(i => i.status !== 'erro').indexOf(it) + 1;
    const corpo = document.querySelector('#nota-form-overlay .form-body');
    let b = _el('nf-lote-barra');
    if (!b && corpo) { b = document.createElement('div'); b.id = 'nf-lote-barra'; corpo.prepend(b); }
    if (b) {
      b.style.display = '';
      b.innerHTML = `<div class="nf-lote-tit">📚 Nota ${pos} de ${total}</div>
        <div class="nf-lote-sub">${esc(it.nome)}</div>
        <div class="nf-lote-bts">
          <button type="button" class="btn btn-outline btn-sm" onclick="LoteNotas.pular()">⏭️ Pular</button>
          <button type="button" class="btn btn-outline btn-sm" onclick="LoteNotas.parar()">⏹ Parar</button>
        </div>`;
    }
    const sv = _el('nf-btn-salvar');
    if (sv) sv.textContent = _pendentes().length > 1 || S.itens.some(i => ['fila', 'lendo'].includes(i.status)) ? 'Salvar e próxima' : 'Salvar e concluir';
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

  /* chamado por salvarNota depois de gravar; devolve true se o lote cuidou do que vem depois */
  function salvou(saved) {
    if (!S.ativo || !S.noForm) return false;
    S.noForm = false;
    const it = S.itens.find(i => i.id === S.atual);
    if (it) { it.status = 'salva'; it.notaId = saved?.id; }
    _proxima();
    return true;
  }

  function _proxima() {
    _limparBarra();
    const prox = _pendentes()[0];
    if (prox) { setTimeout(() => _abrirItem(prox), 350); return; }
    S.ativo = false;
    const ov = _el('lote-overlay'); if (ov) ov.style.display = 'flex';
    _pintar();
    if (S.itens.some(i => ['fila', 'lendo'].includes(i.status))) toast('Lançadas as que estavam prontas — as outras ainda estão sendo lidas');
  }

  function pular() {
    const it = S.itens.find(i => i.id === S.atual);
    if (it) it.status = 'pulada';
    S.noForm = false;
    fecharFormNota();
    _proxima();
  }

  function parar() {
    S.noForm = false; S.ativo = false;
    fecharFormNota();
    _limparBarra();
    const ov = _el('lote-overlay'); if (ov) ov.style.display = 'flex';
    _pintar();
  }

  /* "‹ Voltar" do formulário durante o lote = parar (a nota aberta continua na lista para depois) */
  function formFechadoPeloUsuario() { if (S.ativo) parar(); }

  async function fechar(semPerguntar) {
    const falta = _restantes().length;
    if (!semPerguntar && falta) {
      const ok = await pedirConfirmacao({ titulo: 'Sair do lançamento de várias notas?',
        mensagem: `${falta} nota${falta > 1 ? 's' : ''} ainda não ${falta > 1 ? 'foram lançadas' : 'foi lançada'}. As já lançadas ficam salvas.`,
        confirmar: 'Sair', cancelar: 'Continuar aqui' });
      if (!ok) return;
    }
    Object.assign(S, { itens: [], ativo: false, noForm: false });
    const ov = _el('lote-overlay'); if (ov) ov.style.display = 'none';
    _limparBarra();
  }

  return { abrir, adicionar, remover, comecar, pular, parar, fechar, formAberto, salvou, formFechadoPeloUsuario, _comum,
           get ativo() { return S.ativo; }, _estado: S };
})();
