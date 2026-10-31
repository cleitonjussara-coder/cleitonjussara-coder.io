'use strict';
/* ─────────────────────────────────────────────────────────────
   FROTA.js — registro de KM dos veículos (pedido em 16/09/2026)

   Cada colaborador registra a leitura do odômetro do veículo que está
   usando (data, km, observação e, se quiser, foto do painel). O gestor vê,
   por veículo, o km rodado no mês e quem dirigiu; também cadastra os
   veículos. Dashboard e planilha (Excel/CSV) vêm de GET /frota/anual.

   HISTÓRICO E PAINEL (21/10/2026): a tela tem três abas — Painel (km por
   dia/semana/mês + ranking), Histórico (cartões com filtros, toque abre o
   detalhe) e Veículos (gestor/admin). Painel, histórico e detalhe moram em
   frota-painel.js (window.FrotaPainel); aqui ficam o esqueleto da tela, o
   formulário de registro, os veículos e a fila offline.

   OFFLINE (18/09/2026): a tela guarda no aparelho o que baixou por último
   (veículos, registros do mês, resumo, anual) e mostra isso sem internet;
   registro novo sem sinal entra numa FILA local (com a foto) e sobe
   sozinho quando a conexão volta — igual às notas. Cadastro de veículo
   continua só online (é raro e é do gestor).

   Depende de globais do app.js: $, sb, user, toast, setLoading, esc,
   fmtData, filMes, filAno, MESES, _ehGestorOuAdmin, switchView, DB.
───────────────────────────────────────────────────────────── */
window.Frota = (() => {

  let veiculos = [];      // ativos (gestor: todos, ao gerenciar)
  let registros = [];     // do mês em foco (visíveis para mim) + pendentes locais
  let resumo = null;      // {veiculos:[...], total_km}
  let anual = null;       // GET /frota/anual do ano em foco
  let _fotoKm = null;     // File escolhido no formulário
  let _offline = false;   // renderizou a partir do cache
  let _cacheEm = null;    // quando o cache foi gravado
  let _aba = 'painel';    // painel | plan | hist | vei
  let _pendTodos = [];    // fila do aparelho (só da conta logada), em qualquer mês, no formato dos registros

  const kmFmt = n => Number(n || 0).toLocaleString('pt-BR');
  /* texto seguro em ATRIBUTO HTML (o esc do app só troca & < >). Id de veículo/registro nunca vai para dentro de código de
     onclick: vai em data-id e o handler lê this.dataset.id. */
  /* "hoje" em Brasília segundo o servidor (o relógio do aparelho pode estar adiantado) */
  const hojeDoApp = () => (sb?.hojeDoServidor ? sb.hojeDoServidor() : FusoBR.hojeISO());
  const _at = s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const KEY_CACHE = () => `frota_cache_${filAno}_${filMes}`;
  const KEY_ANUAL = () => `frota_anual_${filAno}`;
  const KEY_FILA = 'frota_fila';

  /* ── Fila local (registros feitos sem internet) ─────────── */
  /* A fila é do APARELHO, mas cada item é de uma conta: `uid` grava quem
     registrou. Só os itens de quem está logado sobem ou aparecem — num
     aparelho compartilhado, o 'online' subia a fila inteira com o token de
     quem tivesse entrado depois. `_fila()` devolve todos (para regravar sem
     perder os dos outros); `_minhas()` filtra. */
  async function _fila() {
    try {
      const f = (await DB.getMeta(KEY_FILA)) || [];
      /* Itens anteriores ao build 392 não têm dono. Ficam com quem abrir a
         fila primeiro — na prática 1 aparelho = 1 pessoa; sem isso ficariam
         presos para sempre, invisíveis e sem subir. */
      if (user?.id && f.some(it => !it.uid)) {
        f.forEach(it => { if (!it.uid) it.uid = user.id; });
        await DB.setMeta(KEY_FILA, f);
      }
      return f;
    } catch (_) { return []; }
  }
  const _meu = it => !!user?.id && it.uid === user.id;
  async function _minhas() { return (await _fila()).filter(_meu); }
  async function _salvarFila(f) { try { await DB.setMeta(KEY_FILA, f); } catch (_) {} }

  async function enfileirar(id, payload, foto) {
    const f = await _fila();
    const i = f.findIndex(x => x.id === id);
    const item = { id, uid: user?.id, payload, foto: foto || (i >= 0 ? f[i].foto : null), criado_em: new Date().toISOString(), erro: null };
    if (i >= 0) f[i] = item; else f.push(item);
    await _salvarFila(f);
  }

  /* Sobe a fila. Chamado ao abrir a tela com internet, ao salvar e no evento
     'online'. 422 (odômetro menor) fica na fila com o erro, para a pessoa
     corrigir pelo ✏️ — nunca se perde. */
  let _subindo = false;
  async function subirFila() {
    if (_subindo || !sb || !user?.id || !navigator.onLine) return 0;
    _subindo = true;
    let ok = 0;
    try {
      const todos = await _fila();
      const f = todos.filter(_meu);
      if (!f.length) return 0;
      const outros = todos.filter(it => !_meu(it));      // de outras contas: ficam como estão
      const resto = [];
      for (const it of f) {
        try {
          await sb.frota.kmUpsert(it.id, it.payload);
          if (it.foto?.blob) {
            try { await sb.frota.kmFoto(it.id, it.foto.blob, it.foto.ext || 'jpg'); }
            catch (e) { console.warn('[frota] foto da fila não subiu:', e.message); }
          }
          ok++;
        } catch (e) {
          const semRede = !e?.status;                       // fetch falhou: tenta depois
          resto.push({ ...it, erro: semRede ? null : (e.message || 'falhou') });
          if (semRede) { resto.push(...f.slice(f.indexOf(it) + 1)); break; }
        }
      }
      await _salvarFila([...outros, ...resto]);
      if (ok) toast(`${ok} registro${ok > 1 ? 's' : ''} de KM enviado${ok > 1 ? 's' : ''} ✅`);
    } finally { _subindo = false; }
    return ok;
  }
  window.addEventListener('online', () => { subirFila().then(n => { if (n && viewAtual === 'frota') render(); }).catch(() => {}); });

  /* ── Carga (rede → cache) ───────────────────────────────── */
  async function carregar() {
    if (!sb || !navigator.onLine) throw new Error('offline');
    await subirFila();
    const gestor = _ehGestorOuAdmin();
    const [v, r, s, a] = await Promise.all([
      sb.frota.veiculos(gestor),
      sb.frota.km({ ano: filAno, mes: filMes }),
      gestor ? sb.frota.resumo(filAno, filMes) : Promise.resolve(null),
      sb.frota.anual(filAno),
    ]);
    veiculos = v || []; registros = r || []; resumo = s; anual = a;
    _offline = false; _cacheEm = new Date().toISOString();
    try {
      await DB.setMeta(KEY_CACHE(), { veiculos, registros, resumo, em: _cacheEm });
      await DB.setMeta(KEY_ANUAL(), anual);
      await DB.setMeta('frota_veiculos', veiculos);        // para o formulário offline em qualquer mês
    } catch (_) {}
  }
  async function carregarDoCache() {
    const c = await DB.getMeta(KEY_CACHE()).catch(() => null);
    veiculos = c?.veiculos || (await DB.getMeta('frota_veiculos').catch(() => null)) || [];
    registros = c?.registros || []; resumo = c?.resumo || null;
    anual = await DB.getMeta(KEY_ANUAL()).catch(() => null);
    _cacheEm = c?.em || null; _offline = true;
  }
  /* registros da fila aparecem na lista como pendentes */
  async function _mesclarPendentes() {
    const f = await _minhas();
    _pendTodos = f.map(it => {
      const v = veiculos.find(x => x.id === it.payload.veiculo_id);
      return { id: it.id, veiculo_id: it.payload.veiculo_id, placa: v?.placa || '?', modelo: v?.modelo, user_id: user?.id, user_nome: user?.nome,
               data: it.payload.data, odometro: it.payload.odometro, observacao: it.payload.observacao, foto_path: null,
               _pendente: true, _erro: it.erro, _foto: !!it.foto };
    }).sort((a, b) => String(b.data).localeCompare(String(a.data)) || b.odometro - a.odometro);
    const pend = _pendTodos.filter(it => { const d = it.data || ''; return Number(d.slice(0, 4)) === filAno && Number(d.slice(5, 7)) === filMes; });
    const ids = new Set(pend.map(p => p.id));
    registros = [...pend, ...registros.filter(r => !ids.has(r.id))];
  }
  /* o registro com esse id, de onde estiver: mês carregado, fila do aparelho ou histórico */
  const _reg = id => registros.find(x => x.id === id) || _pendTodos.find(x => x.id === id) || window.FrotaPainel?.registro?.(id) || null;

  /* ── Tela ───────────────────────────────────────────────── */
  async function render() {
    const el = $('app-content');
    window.FrotaPainel?.fecharDetalhe?.();
    window.FrotaPainel?.invalidar?.();              // salvou/excluiu/voltou: painel e histórico buscam de novo
    el.innerHTML = '<div class="loading-state"><div class="spin"></div><p>Carregando frota…</p></div>';
    try { await carregar(); }
    catch (e) {
      await carregarDoCache();
      if (!veiculos.length && !registros.length && !anual) {
        el.innerHTML = `<div class="db-container"><div class="db-card" style="text-align:center;padding:24px">
          <div style="font-size:31px">🚗</div><p style="margin-top:8px;color:var(--text2)">Sem conexão e sem dados guardados ainda. Abra a Frota uma vez com internet.</p>
          <button class="btn btn-outline" style="margin-top:12px" onclick="Frota.render()">Tentar de novo</button></div></div>`;
        return;
      }
    }
    await _mesclarPendentes();
    const gestor = _ehGestorOuAdmin();
    const fila = await _minhas();
    if (_aba === 'vei' && !gestor) _aba = 'painel';

    el.innerHTML = `
    <div class="db-container">
      <div class="page-hd"><h2>🚗 Frota / KM</h2></div>
      ${_offline ? `<div class="ini-dica" style="border-left:3px solid var(--warning)">📴 <b>Sem internet</b> — mostrando o que foi baixado${_cacheEm ? ' em ' + new Date(_cacheEm).toLocaleString('pt-BR', { timeZone: FusoBR.TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}. Você pode registrar KM normalmente: fica guardado e sobe sozinho.</div>` : ''}
      ${fila.length ? `<div class="ini-dica" style="border-left:3px solid var(--warning)">⏳ <b>${fila.length} registro${fila.length > 1 ? 's' : ''} aguardando envio</b>${fila.some(f => f.erro) ? ' — algum foi recusado pelo servidor; veja o ⚠️ no Histórico e corrija' : ''}. ${navigator.onLine ? '<a class="link" onclick="Frota.reenviar()">Enviar agora</a>' : ''}</div>` : ''}

      <div class="fq-abas" id="fq-abas">${_abasHTML(gestor)}</div>

      <button class="pnl pnl-atalho" style="margin:8px 14px 0;width:calc(100% - 28px)" onclick="Frota.abrirForm()">
        <span class="pnl-conteudo">
          <span class="pnl-ico">🛣️</span>
          <span><span class="pnl-tit" style="display:block">Registrar KM</span><span class="pnl-sub" style="font-size:13px">Leitura do odômetro do veículo que você está usando</span></span>
        </span>
      </button>

      ${veiculos.filter(v => v.ativo !== false).length ? '' : `<div class="ini-dica">🚗 Nenhum veículo cadastrado ainda.${gestor ? ' Cadastre o primeiro na aba <b>Veículos</b>.' : ' Peça ao gestor para cadastrar os veículos.'}</div>`}

      <div id="fq-corpo"></div>
    </div>`;
    await _montarAba();
  }

  function _abasHTML(gestor) {
    const aba = (k, t) => `<button class="chip ${_aba === k ? 'active' : ''}" onclick="Frota.trocarAba('${k}')">${t}</button>`;
    return aba('painel', 'Painel') + aba('plan', 'Planilha') + aba('hist', 'Histórico') + (gestor ? aba('vei', 'Veículos') : '');
  }

  /* troca a aba sem baixar tudo de novo: só repinta o corpo (o painel e o histórico buscam o que precisam) */
  function trocarAba(k) {
    if (k) _aba = k;
    const a = $('fq-abas');
    if (a) a.innerHTML = _abasHTML(_ehGestorOuAdmin());
    return _montarAba();
  }

  async function _montarAba() {
    const c = $('fq-corpo');
    if (!c) return;
    window.FrotaPainel?.cancelar?.();               // resposta de outra aba que ainda esteja vindo não pinta por cima desta
    window.FrotaPlanilha?.cancelar?.();
    if (_aba === 'vei') { c.innerHTML = _veiculosHTML(); return; }
    if (_aba === 'plan') {
      if (!window.FrotaPlanilha) { c.innerHTML = '<div class="ini-dica">Atualize o app (feche e abra de novo) para ver a planilha.</div>'; return; }
      return window.FrotaPlanilha.montar(c);
    }
    if (!window.FrotaPainel) { c.innerHTML = '<div class="ini-dica">Atualize o app (feche e abra de novo) para ver o painel e o histórico.</div>'; return; }
    return _aba === 'hist' ? window.FrotaPainel.historico(c) : window.FrotaPainel.painel(c);
  }

  /* Veículos (gestor/admin) */
  function _veiculosHTML() {
    return `
      <div class="ini-titulo" style="display:flex;justify-content:space-between;align-items:center">
        <span>Veículos (${veiculos.length})</span>
        <button class="btn btn-sm btn-primary" onclick="Frota.abrirFormVeiculo()" ${_offline ? 'disabled title="Precisa de internet"' : ''}>＋ Veículo</button>
      </div>
      <div class="notas-list">
        ${veiculos.map(v => `
        <div class="nota-card" style="${v.ativo === false ? 'opacity:.55' : ''}">
          <div class="nota-head">
            <span class="tipo-badge tipo-RDM">🚗 ${esc(v.placa)}</span>
            ${v.modelo ? `<span class="subtipo-tag">${esc(v.modelo)}</span>` : ''}
            ${v.ativo === false ? '<span class="subtipo-tag">inativo</span>' : ''}
            <span class="nota-data">${v.responsavel_nome ? '👤 ' + esc(v.responsavel_nome) : ''}</span>
          </div>
          ${v.ultimo_odometro != null ? `<div class="nota-body"><div class="nota-obs">Última leitura: <b>${kmFmt(v.ultimo_odometro)} km</b> em ${fmtData(v.ultima_data)}</div></div>` : ''}
          <div class="nota-foot">
            <button class="btn btn-outline btn-sm" data-id="${_at(v.id)}" onclick="FrotaPainel.verHistorico({veiculo_id:this.dataset.id})">🕓 Histórico</button>
            ${v.ativo === false ? '' : `<button class="btn btn-primary btn-sm" data-id="${_at(v.id)}" onclick="Frota.abrirForm(null, this.dataset.id)">＋ KM</button>`}
            <div class="nota-actions"><button class="btn-icon-sm" data-id="${_at(v.id)}" onclick="Frota.abrirFormVeiculo(this.dataset.id)" title="Editar" ${_offline ? 'disabled' : ''}>✏️</button></div>
          </div>
        </div>`).join('')}
      </div>`;
  }

  async function exportarExcel() {
    if (!anual) { toast('Abra a Frota com internet uma vez para gerar a planilha', 'err'); return; }
    setLoading(true, 'Gerando a planilha…');
    try { await Excel.exportarFrota(anual); toast('Planilha gerada 📗'); } catch (e) { toast('Planilha: ' + e.message, 'err'); }
    finally { setLoading(false); }
  }
  async function exportarCSV() {
    if (!anual) { toast('Abra a Frota com internet uma vez para gerar o CSV', 'err'); return; }
    setLoading(true);
    try { await Excel.exportarFrotaCSV(anual, filMes); } catch (e) { toast('CSV: ' + e.message, 'err'); }
    finally { setLoading(false); }
  }

  /* Só move o mês das planilhas (CSV do mês / Excel do ano); o painel e o histórico têm o período deles. Não refaz a
     tela (jogaria a rolagem para o topo, e o quadro fica no fim do Painel): troca o ano da planilha, se mudou, e
     repinta só o quadro. */
  async function mudarMes(delta) {
    const anoAntes = filAno;
    filMes += delta;
    if (filMes > 12) { filMes = 1; filAno++; }
    if (filMes < 1) { filMes = 12; filAno--; }
    window.FrotaPainel?.repintarPlanilhas?.();
    if (filAno !== anoAntes) {
      try {
        if (!sb || !navigator.onLine) throw new Error('offline');
        anual = await sb.frota.anual(filAno);
        try { await DB.setMeta(KEY_ANUAL(), anual); } catch (_) {}
      } catch (_) { anual = await DB.getMeta(KEY_ANUAL()).catch(() => null); }
    }
  }

  async function reenviar() { setLoading(true); try { await subirFila(); } finally { setLoading(false); } render(); }

  /* ── Formulário de KM ──────────────────────────────────── */
  async function abrirForm(id = null, veiculoId = null) {
    if (!veiculos.length) { try { veiculos = (await DB.getMeta('frota_veiculos')) || []; } catch (_) {} }
    const ativos = veiculos.filter(v => v.ativo !== false);
    if (!ativos.length) { toast('Nenhum veículo cadastrado — peça ao gestor', 'err'); return; }
    const r = id ? _reg(id) : null;
    _fotoKm = null; _odoLido = null; _avisoOdo('');
    $('km-id').value = r?.id || '';
    const sel = $('km-veiculo');
    /* corrigir leitura de um veículo hoje inativo: o veículo dela tem que estar na lista, senão o campo fica em branco
       e o Salvar trocaria o veículo da leitura sem querer */
    const lista = [...ativos];
    if (r && !lista.some(v => v.id === r.veiculo_id)) lista.push(veiculos.find(v => v.id === r.veiculo_id) || { id: r.veiculo_id, placa: r.placa || '?', modelo: r.modelo });
    sel.innerHTML = lista.map(v => `<option value="${_at(v.id)}">${esc(v.placa)}${v.modelo ? ' · ' + esc(v.modelo) : ''}${v.ativo === false || !ativos.includes(v) ? ' (inativo)' : ''}</option>`).join('');
    $('km-data').max = hojeDoApp();                 // a leitura registra algo que já aconteceu
    /* Veículo: só vem preenchido quando se sabe QUAL é (leitura editada, botão do próprio veículo, o veículo de que o
       usuário é responsável, ou o único existente). Nunca "o último usado": isso levava a gravar na placa errada sem
       perceber. Sem certeza, o campo fica vazio e obriga a escolher. */
    const meus = ativos.filter(v => v.responsavel_id === user?.id);
    const doBotao = veiculoId && ativos.find(v => v.id === veiculoId);
    const certo = r?.veiculo_id || doBotao?.id || (meus.length === 1 ? meus[0].id : '') || (ativos.length === 1 ? ativos[0].id : '');
    if (!certo) sel.insertAdjacentHTML('afterbegin', '<option value="">Escolha o veículo…</option>');
    sel.value = certo;
    /* veículo cadastrado para a pessoa (responsável) fica FIXADO ao registrar uma leitura nova; "Usar outro veículo" destrava */
    const fixar = !r && !doBotao && meus.length === 1 && certo === meus[0].id;
    sel.disabled = fixar;
    $('km-veiculo-fixo').style.display = fixar ? 'block' : 'none';
    $('km-data').value = r?.data || hojeDoApp();
    $('km-odometro').value = r?.odometro ?? '';
    $('km-obs').value = r?.observacao || '';
    $('km-foto-nome').textContent = r?.foto_path || r?._foto ? '📷 foto já guardada — escolha outra para trocar' : '';
    $('km-titulo').textContent = r ? 'Editar registro de KM' : 'Registrar KM';
    _mostrarUltimaLeitura();
    $('km-overlay').style.display = 'flex';
    setTimeout(() => $('km-odometro').focus(), 50);
  }
  function fecharForm() { $('km-overlay').style.display = 'none'; }
  function destravarVeiculo() { $('km-veiculo').disabled = false; $('km-veiculo-fixo').style.display = 'none'; $('km-veiculo').focus(); }

  /* A leitura de referência do veículo: a que o servidor informa (de qualquer pessoa, em qualquer mês) e o que há nesta
     tela (mês carregado e fila do aparelho); vale a mais recente. Ao EDITAR, a referência é a leitura ANTERIOR à que está
     sendo corrigida — nunca ela mesma, nem as que vieram depois dela. */
  function _ultimaLeitura() {
    const vid = $('km-veiculo').value, idAtual = $('km-id').value;
    const v = veiculos.find(x => x.id === vid);
    const editando = idAtual ? _reg(idAtual) : null;
    const mesmaLeitura = !!editando && editando.veiculo_id === vid;     // se trocou de veículo no formulário, é como registrar
    if (mesmaLeitura) {
      /* o histórico já sabe de onde a leitura partiu (o servidor calcula sobre o veículo inteiro) */
      const h = window.FrotaPainel?.registro?.(idAtual);
      if (h && h.anterior_odometro != null) return { odo: h.anterior_odometro, dt: h.anterior_data };
      if (h && h.anterior_odometro == null) return { odo: null, dt: null };      // é mesmo a primeira do veículo
    }
    const c = [];
    if (v?.ultimo_odometro != null && !mesmaLeitura) c.push({ odo: v.ultimo_odometro, dt: v.ultima_data });
    [...registros, ..._pendTodos].forEach(r => {
      if (r.veiculo_id !== vid || r.id === idAtual) return;
      if (mesmaLeitura && (r.data > editando.data || (r.data === editando.data && r.odometro >= editando.odometro))) return;   // só as anteriores
      c.push({ odo: r.odometro, dt: r.data });
    });
    /* cópia guardada antes do servidor informar a última leitura de cada veículo: o resumo do mês faz esse papel */
    const res = resumo?.veiculos?.find(x => x.veiculo_id === vid);
    if (v && v.ultimo_odometro === undefined && res?.ultimo_odometro != null) c.push({ odo: res.ultimo_odometro, dt: res.ultima_data });
    const ult = c.filter(x => x.dt).sort((a, b) => b.dt.localeCompare(a.dt) || b.odo - a.odo)[0];
    return { odo: ult?.odo ?? null, dt: ult?.dt ?? null };
  }

  function _mostrarUltimaLeitura() {
    if (!$('km-veiculo').value) { $('km-ultima').textContent = 'Escolha o veículo (confira a placa) antes de registrar.'; return; }
    const { odo, dt } = _ultimaLeitura();
    $('km-ultima').textContent = odo != null ? `Última leitura: ${kmFmt(odo)} km em ${fmtData(dt)}` : 'Primeira leitura deste veículo';
  }

  /* ── Leitura do odômetro pela foto (09/10/2026) ────────────
     Tirou a foto → enquadra o número → o app lê e SUGERE o valor no campo.
     Nunca salva sozinho: o aviso pede conferência, e leitura menor que a
     última (ou salto grande) é sinalizada. Qualquer falha deixa o campo como
     está — digitar continua funcionando como sempre. */
  const SALTO_SUSPEITO = 2000;        // km acima da última leitura que pedem confirmação
  let _odoLido = null;                // valor que o app leu da foto (para saber se o campo ainda é ele)

  function _avisoOdo(texto, tom) {
    const el = $('km-odo-aviso'); if (!el) return;
    el.textContent = texto || '';
    el.style.color = tom === 'warn' ? 'var(--danger, #b45309)' : tom === 'ok' ? 'var(--primary)' : 'var(--text2)';
    el.style.display = texto ? '' : 'none';
  }

  async function onFoto(e) {
    _fotoKm = e.target.files?.[0] || null;
    $('km-foto-nome').textContent = _fotoKm ? `📷 ${_fotoKm.name || 'foto do odômetro'} pronta para enviar` : '';
    _odoLido = null; _avisoOdo('');
    if (!_fotoKm || !window.Recorte || !window.OCR) return;
    let foto = _fotoKm;
    try { if (typeof _normalizarOrientacao === 'function') foto = await _normalizarOrientacao(foto); } catch (_) {}
    const ov = $('crop-overlay');
    const tit = ov?.querySelector('.crop-tit'), usar = $('crop-usar'), inteira = $('crop-inteira');
    const antes = [tit?.textContent, usar?.textContent, inteira?.textContent];
    if (tit) tit.textContent = 'Enquadre o odômetro';
    if (usar) usar.textContent = 'Ler número';
    if (inteira) inteira.textContent = 'Pular leitura';
    let recorte = null;
    try { recorte = await Recorte.abrir(foto, { odometro: true }); } catch (_) { recorte = null; }
    if (tit) tit.textContent = antes[0];
    if (usar) usar.textContent = antes[1];
    if (inteira) inteira.textContent = antes[2];
    if (recorte === false) {                                // X: descarta a foto do odômetro
      _fotoKm = null; e.target.value = '';
      $('km-foto-nome').textContent = '';
      return;
    }
    if (!recorte) return;                                   // "Pular leitura": fica só a foto anexada
    _avisoOdo('Lendo o número da foto…');
    try {
      const { odo: ref } = _ultimaLeitura();
      let r = { valor: null };
      /* Com internet, a IA de visão no servidor vai PRIMEIRO: lê em ~2 s e erra
         bem menos que o leitor do aparelho, que é lento (baixa o Tesseract na
         1ª vez e roda quatro leituras). O do aparelho fica de reserva: sem
         internet, sem chave/saldo no servidor, limite do dia ou IA sem ler. */
      if (navigator.onLine && sb?.frota?.kmLerFoto) {
        try {
          const ia = await sb.frota.kmLerFoto(await _imagemParaIa(recorte, 1000));
          if (ia?.valor != null) r = { valor: ia.valor };
        } catch (_) { /* segue para o leitor do aparelho */ }
      }
      if (r.valor == null) {
        _avisoOdo('Lendo o número no aparelho… (pode levar alguns segundos)');
        try { r = await OCR.lerOdometro(recorte, ref); } catch (_) { r = { valor: null }; }
      }
      if (r.valor == null) { _avisoOdo('Não consegui ler o número. Digite o odômetro.', 'warn'); return; }
      const campo = $('km-odometro'), atual = campo.value.trim();
      if (atual && atual !== String(_odoLido)) { _avisoOdo(`A foto parece indicar ${kmFmt(r.valor)} km, mas o campo já tem um valor — confira.`, 'warn'); return; }
      campo.value = r.valor; _odoLido = r.valor;
      if (ref != null && r.valor < ref) _avisoOdo(`Li ${kmFmt(r.valor)} km, menor que a última leitura (${kmFmt(ref)} km). Pode ser o parcial — confira ou enquadre de novo.`, 'warn');
      else if (ref != null && r.valor - ref > SALTO_SUSPEITO) _avisoOdo(`Li ${kmFmt(r.valor)} km, ${kmFmt(r.valor - ref)} km acima da última leitura. Confira o número.`, 'warn');
      else _avisoOdo('Lido da foto. Confira o número.', 'ok');
    } catch (_) {
      _avisoOdo('Não consegui ler o número (sem internet na primeira vez?). Digite o odômetro.', 'warn');
    }
  }

  /* Atalho "Lançar KM" do Início (31/10/2026): o formulário abre por cima de qualquer tela. Depois de salvar, quem estava
     na Frota vê a tela refeita; quem veio do Início continua nele (como nas notas) — render() trocaria a tela dele. */
  async function _aposSalvar() {
    if (viewAtual === 'frota') { await render(); return; }
    window.FrotaPainel?.invalidar?.();
    if (viewAtual === 'inicio') renderInicio();
  }
  async function lancar() {
    if (!veiculos.length && sb && navigator.onLine) {      // nunca abriu a Frota neste aparelho: busca os veículos agora
      try { veiculos = (await sb.frota.veiculos(_ehGestorOuAdmin())) || []; await DB.setMeta('frota_veiculos', veiculos); } catch (_) {}
    }
    return abrirForm();
  }

  async function salvar() {
    const id = $('km-id').value || crypto.randomUUID();
    const payload = {
      veiculo_id: $('km-veiculo').value,
      data: $('km-data').value,
      odometro: parseInt($('km-odometro').value, 10),
      observacao: $('km-obs').value.trim() || null,
    };
    if (!payload.veiculo_id || !payload.data || !Number.isFinite(payload.odometro)) { toast('Veículo, data e odômetro são obrigatórios', 'err'); return; }
    if (!$('km-id').value) {                       // leitura nova: confirma a placa por extenso
      const v = veiculos.find(x => x.id === payload.veiculo_id);
      if (!(await pedirConfirmacao({ mensagem: `Registrar ${kmFmt(payload.odometro)} km no veículo ${v?.placa || '?'}${v?.modelo ? ' · ' + v.modelo : ''}? Confira se a placa é a do carro que você está usando.`, confirmar: 'Placa certa, salvar' }))) return;
    }
    if (payload.data > hojeDoApp()) { toast('A data da leitura não pode ser depois de hoje', 'err'); return; }
    /* A hora em que a leitura foi feita (relógio do aparelho acertado pelo servidor) acompanha o registro novo — é ela
       que o histórico mostra, mesmo que a leitura só suba horas depois, quando voltar o sinal. Ao editar, vale a original. */
    const existente = $('km-id').value ? _reg($('km-id').value) : null;
    if (!existente) payload.registrado_em = new Date(sb?.horaServidorMs ? sb.horaServidorMs() : Date.now()).toISOString();
    else if (existente._pendente) {
      const q = (await _fila()).find(x => x.id === id);
      if (q?.payload?.registrado_em) payload.registrado_em = q.payload.registrado_em;
    }
    /* número lido da foto com salto grande sobre a última leitura: confirma antes de gravar */
    if (_odoLido != null && payload.odometro === _odoLido) {
      const { odo: ref } = _ultimaLeitura();
      if (ref != null && payload.odometro - ref > SALTO_SUSPEITO
          && !(await pedirConfirmacao({ mensagem: `O odômetro lido da foto (${kmFmt(payload.odometro)} km) está ${kmFmt(payload.odometro - ref)} km acima da última leitura (${kmFmt(ref)} km). Está certo?`, confirmar: 'Está certo, salvar' }))) return;
    }

    let foto = null;
    if (_fotoKm) {
      let blob = _fotoKm, ext = 'jpg';
      /* _comprimirImagem já endireita pelo EXIF (23/09/2026) */
      try { if (typeof _comprimirImagem === 'function') ({ blob, ext } = await _comprimirImagem(_fotoKm, 'jpg')); } catch (_) {}
      foto = { blob, ext };
    }

    setLoading(true);
    try {
      if (!navigator.onLine || !sb) {
        await enfileirar(id, payload, foto);
        fecharForm();
        toast('📴 Sem internet: registro guardado no aparelho — sobe sozinho quando voltar o sinal');
        await _aposSalvar();
        return;
      }
      try {
        await sb.frota.kmUpsert(id, payload);
      } catch (e) {
        if (!e?.status) {                          // caiu a rede no meio: fila
          await enfileirar(id, payload, foto);
          fecharForm(); toast('📴 Conexão falhou: registro guardado no aparelho');
          await _aposSalvar(); return;
        }
        throw e;                                    // 422/403: mostra o motivo
      }
      if (foto) {
        try { await sb.frota.kmFoto(id, foto.blob, foto.ext); }
        catch (e) { toast('Registro salvo, mas a foto não subiu: ' + e.message, 'err'); }
      }
      /* se era um item da fila (edição de pendente), tira da fila */
      const f = await _fila(); if (f.some(x => x.id === id)) await _salvarFila(f.filter(x => x.id !== id));
      fecharForm();
      /* corrigir leitura que já estava no servidor: atualiza no lugar (rolagem e páginas do histórico ficam); registro novo ou
         item da fila mexe nos avisos do alto da tela, então refaz tudo */
      if (existente && !existente._pendente) { toast('KM atualizado ✅'); await _atualizarLeve(); }
      else { toast('KM registrado ✅'); await _aposSalvar(); }
    } catch (e) {
      toast(e.message || 'Não foi possível salvar', 'err');
    } finally { setLoading(false); }
  }

  async function excluir(id) {
    const r = _reg(id);
    if (!r) return;
    const deOutro = r.user_id && r.user_id !== user?.id && r.user_nome ? ` feita por ${r.user_nome}` : '';
    if (!(await pedirConfirmacao({ mensagem: `Excluir a leitura de ${kmFmt(r.odometro)} km (${fmtData(r.data)}) do veículo ${r.placa}${deOutro}?`, confirmar: 'Excluir', perigo: true }))) return;
    if (r._pendente) {                              // só estava no aparelho
      const f = await _fila(); await _salvarFila(f.filter(x => x.id !== id));
      toast('Registro descartado'); await render(); return;
    }
    if (!navigator.onLine) { toast('Excluir precisa de internet', 'err'); return; }
    setLoading(true);
    try { await sb.frota.kmDelete(id); toast('Registro excluído'); await _atualizarLeve(); }
    catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  }

  /* Depois de corrigir/excluir um registro do servidor: confere os veículos (última leitura) e refaz só o que está na tela,
     sem "Carregando frota…", sem voltar ao topo e sem perder as páginas já carregadas do histórico. */
  async function _atualizarLeve() {
    try {
      const v = await sb.frota.veiculos(_ehGestorOuAdmin());
      if (v) { veiculos = v; try { await DB.setMeta('frota_veiculos', veiculos); } catch (_) {} }
    } catch (_) { /* sem a lista nova, a anterior serve */ }
    await window.FrotaPainel?.atualizar?.();
  }

  async function verFoto(id) {
    const r = _reg(id);
    if (!r?.foto_path) return;
    try {
      const url = await sb.fotos.url(r.foto_path);
      if (!url) throw new Error('Foto não encontrada');
      $('foto-viewer-img').src = url;
      $('foto-viewer-info').textContent = `🚗 ${r.placa} · ${kmFmt(r.odometro)} km · ${fmtData(r.data)}`;
      $('foto-viewer-overlay').style.display = 'flex';
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ── Cadastro de veículos (gestor/admin, online) ───────── */
  function abrirFormVeiculo(id = null) {
    if (!navigator.onLine) { toast('Cadastro de veículo precisa de internet', 'err'); return; }
    const v = id ? veiculos.find(x => x.id === id) : null;
    $('vei-id').value = v?.id || '';
    $('vei-placa').value = v?.placa || '';
    $('vei-modelo').value = v?.modelo || '';
    const sel = $('vei-resp');
    const pessoas = Object.values(window.equipePorId || {}).sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || '')));
    sel.innerHTML = '<option value="">— sem responsável fixo —</option>' + pessoas.map(p => `<option value="${_at(p.id)}">${esc(p.nome || p.email)}</option>`).join('');
    sel.value = v?.responsavel_id || '';
    $('vei-ativo').checked = v ? v.ativo !== false : true;
    $('vei-titulo').textContent = v ? 'Editar veículo' : 'Novo veículo';
    $('vei-overlay').style.display = 'flex';
  }
  function fecharFormVeiculo() { $('vei-overlay').style.display = 'none'; }

  async function salvarVeiculo() {
    const id = $('vei-id').value || crypto.randomUUID();
    const placa = $('vei-placa').value.trim();
    if (placa.replace(/[^A-Za-z0-9]/g, '').length < 7) { toast('Placa inválida (ex.: ABC1D23)', 'err'); return; }
    setLoading(true);
    try {
      await sb.frota.veiculoUpsert(id, {
        placa, modelo: $('vei-modelo').value.trim() || null,
        responsavel_id: $('vei-resp').value || null, ativo: $('vei-ativo').checked,
      });
      fecharFormVeiculo(); toast('Veículo salvo ✅'); await render();
    } catch (e) { toast(e.message || 'Não foi possível salvar', 'err'); }
    finally { setLoading(false); }
  }

  return { render, trocarAba, abaAtiva: () => _aba, mudarMes, lancar, abrirForm, fecharForm, salvar, excluir, verFoto, onFoto,
           destravarVeiculo, abrirFormVeiculo, fecharFormVeiculo, salvarVeiculo, onVeiculoChange: _mostrarUltimaLeitura,
           exportarExcel, exportarCSV, reenviar, subirFila,
           pendentes: () => _pendTodos };
})();
