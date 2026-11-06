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
  let _fotoKm = null;     // foto do formulário (Blob em memória; a cópia que sobrevive a recarga fica no rascunho)
  let _idNovo = null;     // id da leitura nova, escolhido ao abrir: repetir o envio depois de uma recarga não duplica
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

  /* ── Rascunho do formulário (03/11/2026) ─────────────────
     Relato do campo: "quando salva a foto volta para o início e não salva nada". O Android matava a página enquanto a
     câmera do sistema estava aberta (log de acesso: página recarregada no mesmo build, sem PUT /km); a volta da câmera
     também podia achar versão nova e recarregar. Tudo o que estava no formulário vivia só na memória da página.
     Campos no localStorage (síncrono: fica gravado mesmo que a página morra logo depois), foto no IndexedDB. Sai do
     aparelho só ao salvar ou ao tocar em Voltar. Cada conta tem o seu (num aparelho compartilhado, um não apaga o do
     outro) e vale por RASCUNHO_VALIDADE. */
  const KEY_RASCUNHO = () => `frota_rascunho_${user?.id}`;
  const KEY_RASCUNHO_FOTO = () => `frota_rascunho_foto_${user?.id}`;
  const RASCUNHO_VALIDADE = 3 * 24 * 3600 * 1000;

  const _formAberto = () => $('km-overlay')?.style.display === 'flex';
  function _lerRascunho() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY_RASCUNHO()) || 'null');
      return d && d.uid === user?.id && Date.now() - d.em < RASCUNHO_VALIDADE ? d : null;
    } catch (_) { return null; }
  }
  /* `extra`: camera (saiu para fotografar, foto ainda não voltou) e foto (há foto guardada no IndexedDB) */
  function _guardarRascunho(extra = {}) {
    if (!_formAberto() || !user?.id) return;
    const antes = _lerRascunho();
    const d = {
      uid: user.id, em: Date.now(), id: $('km-id').value || null, id_novo: _idNovo,
      veiculo_id: $('km-veiculo').value, data: $('km-data').value, odometro: $('km-odometro').value, obs: $('km-obs').value,
      odo_lido: _odoLido, camera: !!antes?.camera, foto: !!antes?.foto, ...extra,
    };
    try { localStorage.setItem(KEY_RASCUNHO(), JSON.stringify(d)); } catch (_) {}
  }
  function _limparRascunho() {
    try { localStorage.removeItem(KEY_RASCUNHO()); } catch (_) {}
    DB.setMeta(KEY_RASCUNHO_FOTO(), null).catch(() => {});
  }

  /* Reabre o formulário como estava. Só preenche: a foto recuperada não passa de novo pelo recorte e pela leitura, que
     podem ser o que derrubou a página; o número se digita. */
  /* `_restaurando` nasce antes do primeiro await: tocar em "Lançar KM" enquanto o rascunho volta espera por ele em vez de
     abrir um formulário em branco, que apagaria o rascunho. */
  let _restaurando = null;
  function restaurarRascunho() {
    if (!_restaurando) _restaurando = _restaurar().finally(() => { _restaurando = null; });
    return _restaurando;
  }
  async function _restaurar() {
    const d = _lerRascunho();
    if (!d || _formAberto()) return false;
    /* a cópia do aparelho vem primeiro: com sinal fraco, esperar a rede deixaria a pessoa no Início por até 30 s */
    if (!veiculos.length) { try { veiculos = (await DB.getMeta('frota_veiculos')) || []; } catch (_) {} }
    if (!veiculos.length && sb && navigator.onLine) {
      try { veiculos = (await sb.frota.veiculos(_ehGestorOuAdmin())) || []; await DB.setMeta('frota_veiculos', veiculos); } catch (_) {}
    }
    let foto = null;
    if (d.foto) {
      const f = await DB.getMeta(KEY_RASCUNHO_FOTO()).catch(() => null);
      if (f?.uid === user?.id && f.blob?.size) foto = f.blob;
    }
    await abrirForm(null, null, d);
    if (!_formAberto()) return false;
    const sel = $('km-veiculo');
    if (d.veiculo_id && sel.value !== d.veiculo_id) {
      /* veículo fora da lista dos ativos (leitura antiga em correção): sem a opção, o Salvar trocaria o veículo */
      if (![...sel.options].some(o => o.value === d.veiculo_id)) {
        const v = veiculos.find(x => x.id === d.veiculo_id);
        sel.insertAdjacentHTML('beforeend', `<option value="${_at(d.veiculo_id)}">${esc(v?.placa || 'Veículo da leitura')}</option>`);
      }
      sel.value = d.veiculo_id; sel.disabled = false; $('km-veiculo-fixo').style.display = 'none';
    }
    $('km-id').value = d.id || '';
    if (d.id) $('km-titulo').textContent = 'Editar registro de KM';
    _idNovo = d.id ? null : (d.id_novo || _idNovo);
    if (d.data) $('km-data').value = d.data;
    $('km-odometro').value = d.odometro || '';
    $('km-obs').value = d.obs || '';
    _odoLido = d.odo_lido ?? null;
    _fotoKm = foto;
    _mostrarUltimaLeitura();
    if (foto) {
      $('km-foto-nome').textContent = '📷 foto do odômetro pronta para enviar';
      _avisoOdo($('km-odometro').value ? 'Registro recuperado com a foto. Confira e toque em Salvar.' : 'Registro recuperado com a foto. Digite o odômetro e toque em Salvar.', 'ok');
    } else if (d.camera || d.foto) {
      _avisoOdo('Registro recuperado, mas o celular fechou o app e a foto se perdeu. Fotografe de novo.', 'warn');
    } else {
      _avisoOdo('Registro recuperado. Confira e toque em Salvar.', 'ok');
    }
    _guardarRascunho({ camera: false, foto: !!foto });
    toast('Registro de KM recuperado');
    return true;
  }

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
      const f = (await _fila()).filter(_meu);
      if (!f.length) return 0;
      const enviados = new Map(), erros = new Map();     // id → versão enviada; id → motivo da recusa
      for (const it of f) {
        try {
          await sb.frota.kmUpsert(it.id, it.payload);
          if (it.foto?.blob) {
            try { await sb.frota.kmFoto(it.id, it.foto.blob, it.foto.ext || 'jpg'); }
            catch (e) {
              if (!e?.status) throw e;                      // caiu a rede na foto: o item fica e repete (mesmo id, não duplica)
              console.warn('[frota] foto da fila não subiu:', e.message);
            }
          }
          enviados.set(it.id, it.criado_em);
          ok++;
        } catch (e) {
          if (!e?.status) break;                            // fetch falhou: tenta depois
          erros.set(it.id, e.message || 'falhou');
        }
      }
      /* relê a fila: o que entrou ou foi corrigido durante o envio fica. Regravar a lista do começo apagava esses itens. */
      const atual = await _fila();
      await _salvarFila(atual
        .filter(x => !(enviados.has(x.id) && enviados.get(x.id) === x.criado_em))
        .map(x => (erros.has(x.id) ? { ...x, erro: erros.get(x.id) } : x)));
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
    try {
      /* modelo montado no servidor (cores e filtros garantidos); sem internet, o gerador do aparelho */
      if (navigator.onLine && window.API?.relatorio?.kmControle) {
        const blob = await window.API.relatorio.kmControle(anual.ano);
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = `Planilha_Controle_Frota_${anual.ano}.xlsx`; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else await Excel.exportarFrota(anual);
      toast('Planilha gerada 📗');
    } catch (e) { toast('Planilha: ' + e.message, 'err'); }
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
  async function abrirForm(id = null, veiculoId = null, rascunho = null) {
    if (!rascunho) {
      if (_restaurando) await _restaurando.catch(() => {});
      if (_formAberto()) return;                     // o rascunho voltou nesse meio tempo: não abre outro por cima
    }
    if (!veiculos.length) { try { veiculos = (await DB.getMeta('frota_veiculos')) || []; } catch (_) {} }
    const ativos = veiculos.filter(v => v.ativo !== false);
    if (!ativos.length) { toast('Nenhum veículo cadastrado — peça ao gestor', 'err'); return; }
    const r = id ? _reg(id) : null;
    _fotoKm = null; _odoLido = null; _avisoOdo(''); _fecharBuscaVeiculo();
    _idNovo = r ? null : crypto.randomUUID();
    if (!rascunho) _limparRascunho();              // formulário novo: o rascunho antigo foi resolvido (salvo ou Voltar)
    _ligarRascunho();
    $('km-id').value = r?.id || '';
    const sel = $('km-veiculo');
    /* corrigir leitura de um veículo hoje inativo: o veículo dela tem que estar na lista, senão o campo fica em branco
       e o Salvar trocaria o veículo da leitura sem querer */
    const lista = [...ativos];
    if (r && !lista.some(v => v.id === r.veiculo_id)) lista.push(veiculos.find(v => v.id === r.veiculo_id) || { id: r.veiculo_id, placa: r.placa || '?', modelo: r.modelo });
    sel.innerHTML = lista.map(v => `<option value="${_at(v.id)}">${esc(v.placa)}${v.modelo ? ' · ' + esc(v.modelo) : ''}${v.ativo === false || !ativos.includes(v) ? ' (inativo)' : ''}</option>`).join('');
    $('km-data').max = hojeDoApp();                 // a leitura registra algo que já aconteceu
    /* Veículo: vem preenchido pela leitura editada, pelo botão do próprio veículo, pelo veículo de que o usuário é
       responsável, pelo último que ELE registrou (pedido de 06/11/2026: fica fixado depois do primeiro registro) ou pelo
       único existente. O risco de placa errada fica coberto pelo aviso de fixado e pela confirmação da placa ao salvar. */
    const meus = ativos.filter(v => v.responsavel_id === user?.id);
    const doBotao = veiculoId && ativos.find(v => v.id === veiculoId);
    const ultimo = ativos.find(v => v.meu_ultimo);
    const certo = r?.veiculo_id || doBotao?.id || (meus.length === 1 ? meus[0].id : '') || ultimo?.id || (ativos.length === 1 ? ativos[0].id : '');
    if (!certo) sel.insertAdjacentHTML('afterbegin', '<option value="">Escolha o veículo…</option>');
    sel.value = certo;
    /* veículo cadastrado para a pessoa, ou o último dela, fica FIXADO ao registrar uma leitura nova; "Usar outro veículo" destrava */
    const dele = meus.length === 1 && certo === meus[0].id;
    const fixar = !r && !doBotao && !!certo && (dele || certo === ultimo?.id);
    $('km-fixo-txt').textContent = dele ? 'Veículo cadastrado para você.' : 'Último veículo que você registrou.';
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
  function fecharForm() { $('km-overlay').style.display = 'none'; _limparRascunho(); }
  /* qualquer coisa digitada ou escolhida no formulário já vai para o rascunho */
  let _rascunhoLigado = false;
  function _ligarRascunho() {
    if (_rascunhoLigado) return;
    _rascunhoLigado = true;
    const ov = $('km-overlay');
    ov.addEventListener('input', e => { if (e.target.id !== 'km-foto') _guardarRascunho(); });
    ov.addEventListener('change', e => { if (e.target.id !== 'km-foto') _guardarRascunho(); });
  }
  function destravarVeiculo() { $('km-veiculo').disabled = false; $('km-veiculo-fixo').style.display = 'none'; _pintarVeiculo(); _abrirBuscaVeiculo(); }

  /* Escolha do veículo pelo nome da pessoa (06/11/2026): placa sozinha confundia. O <select> escondido segue guardando o
     valor (rascunho e Salvar leem dele); aqui só se mostra e se busca. O nome vem do Responsável habitual ou, enquanto ele
     não está preenchido, do cadastro "Nome - MODELO". */
  const _semAcento = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  function _partesVeiculo(v) {
    const m = String(v.modelo || '').trim(), i = m.indexOf(' - ');
    return { nome: v.responsavel_nome || (i > 0 ? m.slice(0, i).trim() : ''), carro: i > 0 ? m.slice(i + 3).trim() : m, placa: v.placa || '' };
  }
  const _textoVeiculo = p => ({ titulo: p.nome || p.carro || p.placa, sub: [p.nome ? p.carro : '', p.nome || p.carro ? p.placa : ''].filter(Boolean).join(' · ') });
  function _opcoesVeiculo() {
    return [...$('km-veiculo').options].filter(o => o.value).map(o => {
      const v = veiculos.find(x => x.id === o.value) || { placa: o.textContent };
      const p = _partesVeiculo(v);
      return { id: o.value, ...p, ..._textoVeiculo(p), meu: !!user?.id && v.responsavel_id === user.id, inativo: o.textContent.endsWith('(inativo)'),
               busca: _semAcento([p.nome, v.modelo, v.placa].join(' ')) };
    }).sort((a, b) => (b.meu - a.meu) || (!a.nome - !b.nome) || a.titulo.localeCompare(b.titulo, 'pt-BR', { sensitivity: 'base' }));
  }
  function _pintarVeiculo() {
    const sel = $('km-veiculo'), btn = $('km-vei-btn');
    const i = _opcoesVeiculo().find(x => x.id === sel.value);
    btn.disabled = sel.disabled;
    btn.innerHTML = i ? `<span class="km-vei-txt"><b>${esc(i.titulo)}</b><small>${esc(i.sub)}${i.inativo ? ' (inativo)' : ''}</small></span>` : '<span class="km-vei-txt">Escolha o veículo…</span>';
  }
  function filtrarVeiculos() {
    const termos = _semAcento($('km-vei-q').value).split(/\s+/).filter(Boolean), atual = $('km-veiculo').value;
    const itens = _opcoesVeiculo().filter(i => termos.every(t => i.busca.includes(t)));
    $('km-vei-lista').innerHTML = itens.map(i => `<button type="button" class="km-vei-item${i.id === atual ? ' sel' : ''}" data-id="${_at(i.id)}"><span class="km-vei-txt"><b>${esc(i.titulo)}</b><small>${esc(i.sub)}${i.inativo ? ' (inativo)' : ''}</small></span></button>`).join('')
      || '<div class="km-vei-vazio">Nenhum veículo encontrado</div>';
  }
  function _abrirBuscaVeiculo() { $('km-vei-q').value = ''; filtrarVeiculos(); $('km-vei-busca').style.display = 'block'; }
  function _fecharBuscaVeiculo() { $('km-vei-busca').style.display = 'none'; }
  function alternarBuscaVeiculo() { if ($('km-vei-busca').style.display === 'none') _abrirBuscaVeiculo(); else _fecharBuscaVeiculo(); }
  function escolherVeiculo(e) {
    const item = e.target.closest('[data-id]');
    if (!item) return;
    $('km-veiculo').value = item.dataset.id;
    _fecharBuscaVeiculo();
    _mostrarUltimaLeitura();
    _guardarRascunho();
    if (!$('km-odometro').value) $('km-odometro').focus();
  }

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
    _pintarVeiculo();
    if (!$('km-veiculo').value) { $('km-ultima').textContent = 'Escolha o veículo antes de registrar.'; return; }
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

  /* Câmera dentro do app, como a da nota (06/10/2026): a câmera do sistema põe o app em segundo plano e o Android, sem
     memória, mata a página. A do sistema fica de reserva, para quem não tem getUserMedia ou recusou a permissão. */
  function fotografar() {
    _guardarRascunho({ camera: true });
    if (typeof abrirCameraNota !== 'function') { $('km-foto').click(); return; }
    abrirCameraNota(() => _guardarRascunho({ camera: false }), {
      aoFoto: file => onFoto({ target: { files: [file], value: '' } }),
      dica: 'Enquadre o odômetro e toque no botão',
      inputReserva: 'km-foto',
    });
  }

  /* Copia os bytes para um Blob antes de qualquer outro passo: o File da câmera do sistema pode morrer depois (caso José,
     20/10/2026), e guardada aqui a foto escapa se a página cair no recorte, na leitura ou na compressão. */
  async function _guardarFotoRascunho(arquivo) {
    const blob = new Blob([await arquivo.arrayBuffer()], { type: arquivo.type || 'image/jpeg' });
    try {
      await DB.setMeta(KEY_RASCUNHO_FOTO(), { uid: user?.id, blob });
      _guardarRascunho({ camera: false, foto: true });
    } catch (_) { _guardarRascunho({ camera: false, foto: false }); }
    return blob;
  }

  async function onFoto(e) {
    _fotoKm = e.target.files?.[0] || null;
    $('km-foto-nome').textContent = _fotoKm ? '📷 foto do odômetro pronta para enviar' : '';
    _odoLido = null; _avisoOdo('');
    if (!_fotoKm) { _guardarRascunho({ camera: false }); return; }
    try { _fotoKm = await _guardarFotoRascunho(_fotoKm); } catch (_) { _guardarRascunho({ camera: false, foto: false }); }
    if (!window.Recorte || !window.OCR) return;
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
      _guardarRascunho({ foto: false });
      DB.setMeta(KEY_RASCUNHO_FOTO(), null).catch(() => {});
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
      _guardarRascunho();
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

  /* leitura nova: este passa a ser o veículo fixado da pessoa, já na próxima abertura, mesmo sem internet */
  function _lembrarVeiculo(veiculoId) {
    if ($('km-id').value) return;
    veiculos.forEach(v => { v.meu_ultimo = v.id === veiculoId; });
    DB.setMeta('frota_veiculos', veiculos).catch(() => {});
  }

  async function salvar() {
    const id = $('km-id').value || _idNovo || crypto.randomUUID();
    const payload = {
      veiculo_id: $('km-veiculo').value,
      data: $('km-data').value,
      odometro: parseInt($('km-odometro').value, 10),
      observacao: $('km-obs').value.trim() || null,
    };
    if (!payload.veiculo_id || !payload.data || !Number.isFinite(payload.odometro)) { toast('Veículo, data e odômetro são obrigatórios', 'err'); return; }
    /* Local visitado (06/11/2026): obrigatório na leitura nova, na que ainda está na fila e na que já tinha texto. Só a
       leitura antiga, gravada sem local, pode ser corrigida sem inventar um. */
    const naFila = (await _fila()).find(x => x.id === id);       // correção de leitura pendente (depois de recarregar, _reg não a conhece)
    const exigeLocal = !$('km-id').value || !!naFila || !!_reg($('km-id').value)?.observacao;
    if (exigeLocal && (payload.observacao || '').length < 3) { toast('Descreva o local visitado: campo, fazenda ou cidade', 'err'); $('km-obs').focus(); return; }
    if (!$('km-id').value) {                       // leitura nova: confirma a placa por extenso
      const v = veiculos.find(x => x.id === payload.veiculo_id);
      if (!(await pedirConfirmacao({ mensagem: `Registrar ${kmFmt(payload.odometro)} km no veículo ${v?.placa || '?'}${v?.modelo ? ' · ' + v.modelo : ''}? Confira se a placa é a do carro que você está usando.`, confirmar: 'Placa certa, salvar' }))) return;
    }
    if (payload.data > hojeDoApp()) { toast('A data da leitura não pode ser depois de hoje', 'err'); return; }
    /* A hora em que a leitura foi feita (relógio do aparelho acertado pelo servidor) acompanha o registro novo — é ela
       que o histórico mostra, mesmo que a leitura só suba horas depois, quando voltar o sinal. Ao editar, vale a original. */
    const existente = $('km-id').value ? _reg($('km-id').value) : null;
    if (!$('km-id').value) payload.registrado_em = new Date(sb?.horaServidorMs ? sb.horaServidorMs() : Date.now()).toISOString();
    if (naFila?.payload?.registrado_em) payload.registrado_em = naFila.payload.registrado_em;
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
    } else if (naFila?.foto?.blob) foto = naFila.foto;           // sem foto nova, vale a que estava na fila

    setLoading(true);
    try {
      if (!navigator.onLine || !sb) {
        await enfileirar(id, payload, foto);
        _lembrarVeiculo(payload.veiculo_id);
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
          _lembrarVeiculo(payload.veiculo_id);
          fecharForm(); toast('📴 Conexão falhou: registro guardado no aparelho');
          await _aposSalvar(); return;
        }
        throw e;                                    // 422/403: mostra o motivo
      }
      _lembrarVeiculo(payload.veiculo_id);
      if (foto) {
        try { await sb.frota.kmFoto(id, foto.blob, foto.ext); }
        catch (e) {
          if (!e?.status) {                        // caiu a rede na foto: fica na fila e sobe depois (mesmo id, não duplica)
            await enfileirar(id, payload, foto);
            fecharForm(); toast('📴 Registro salvo. A foto fica no aparelho e sobe quando o sinal melhorar');
            await _aposSalvar(); return;
          }
          toast('Registro salvo, mas a foto não subiu: ' + e.message, 'err');
        }
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

  return { render, trocarAba, abaAtiva: () => _aba, mudarMes, lancar, abrirForm, fecharForm, salvar, excluir, verFoto, onFoto, fotografar, restaurarRascunho,
           destravarVeiculo, alternarBuscaVeiculo, filtrarVeiculos, escolherVeiculo, abrirFormVeiculo, fecharFormVeiculo, salvarVeiculo, onVeiculoChange: _mostrarUltimaLeitura,
           exportarExcel, exportarCSV, reenviar, subirFila,
           pendentes: () => _pendTodos };
})();
