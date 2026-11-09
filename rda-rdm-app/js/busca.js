'use strict';
/* ─────────────────────────────────────────────────────────────
   BUSCA GERAL (06/11/2026, pedido do Cleiton) — abre pelo campo do topo do menu.
   Telas saem do próprio menu, na hora e sem internet. Notas, repasses e pessoas vêm de GET /busca: é o servidor que decide
   o que cada papel enxerga. Dado nunca vai dentro do onclick: cada linha guarda a ação em `acoes` e o HTML leva só o índice.
   Depende de globais do app.js: $, sb, user, esc, brl, fmtDataBR, _itensMenu, _veEquipe, _ehContabilidade, _categoriaCV,
   _chaveCategoriaDetalhe, _notasComPendencia, garantirNotasNaLista, editarNota, verCartaoDoColaborador, switchView,
   irParaNotas, abrirAjuda, fecharMenu, _armarNav, verFoto, _fotoSeq, toast.
───────────────────────────────────────────────────────────── */
window.Busca = (() => {
  const ESPERA_MS = 300;
  const MAX_RECENTES = 5;
  const ATALHOS = [
    { k: 'sem_foto', rot: '📷 Notas sem foto' },
    { k: 'sem_valor', rot: '⚠️ Sem valor' },
    { k: 'duplicata', rot: '🔁 Possível duplicata', local: true, oculto: () => _ehContabilidade() },
    { k: 'pedidos', rot: '💸 Pedidos abertos', oculto: () => _ehContabilidade() },
    { k: 'hoje', rot: '📅 Notas de hoje' },
    { k: 'faturamento', rot: '🏢 Faturamento do mês', oculto: () => !_veEquipe() },
  ];

  let texto = '', filtro = 'tudo', atalho = null;
  let res = null, carregando = false, falhou = false;
  let seq = 0, timer = null, acoes = [];

  const normal = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const chaveRecentes = () => 'busca_recentes_' + (user?.id || '');
  const mostra = v => esc(v == null ? '' : v);

  function recentes() {
    try { const l = JSON.parse(localStorage.getItem(chaveRecentes()) || '[]'); return Array.isArray(l) ? l.filter(x => typeof x === 'string') : []; }
    catch (_) { return []; }
  }
  function lembrar() {
    const t = texto.trim();
    if (t.length < 2) return;
    try { localStorage.setItem(chaveRecentes(), JSON.stringify([t, ...recentes().filter(x => x !== t)].slice(0, MAX_RECENTES))); } catch (_) {}
  }

  function telasAchadas() {
    const termos = normal(texto).split(/\s+/).filter(Boolean);
    if (!termos.length) return [];
    return _itensMenu().filter(it => { const alvo = normal(it.lbl + ' ' + it.sub); return termos.every(t => alvo.includes(t)); });
  }

  /* Cada linha registra o que o toque faz; fecha a busca antes de abrir a nota, a ficha ou a tela. */
  function acao(fn) { acoes.push(fn); return acoes.length - 1; }
  function saindo(fn) { return acao(() => { lembrar(); fechar(); fn(); }); }
  function linha(ico, titulo, sub, valor, i) {
    return `<button class="bsg-l" onclick="Busca.tocar(${i})"><span class="bsg-i" aria-hidden="true">${ico}</span><span class="bsg-t"><b>${mostra(titulo)}</b>${sub ? `<small>${mostra(sub)}</small>` : ''}</span>${valor ? `<em>${mostra(valor)}</em>` : ''}<span class="bsg-seta" aria-hidden="true">›</span></button>`;
  }
  function donoDe(x) {
    if (!_veEquipe()) return '';
    if (!x.user_id) return 'Faturamento geral';
    return x.user_id === user?.id ? (user?.nome || 'Você') : (x.user_nome || 'Colaborador');
  }
  function linhaNota(n) {
    const cat = _categoriaCV(_chaveCategoriaDetalhe(n))?.nome;
    const sub = [donoDe(n), cat, n.data ? fmtDataBR(String(n.data).slice(0, 10)) : ''].filter(Boolean).join(' · ');
    const html = linha('🧾', n.razao_social || 'Sem empresa', sub, Number(n.valor) > 0 ? brl(n.valor) : 'sem valor',
      saindo(() => { garantirNotasNaLista([n]); editarNota(n.id); }));
    if (!n.foto_path) return html;
    return `<div class="bsg-lw">${html}<button class="bsg-ver" onclick="Busca.tocar(${acao(() => verAnexo(n))})" aria-label="Ver, baixar ou compartilhar o anexo">📎 Ver</button></div>`;
  }
  /* 📎 Ver (08/11/2026, pedido do Cleiton): abre o mesmo visualizador das notas, com ⬇ Baixar e ↗ Compartilhar, por cima da
     busca — ao fechar, os resultados continuam ali. As setas ‹ › passam pelos anexos desta lista de resultados. */
  async function verAnexo(n) {
    const lista = (res?.notas || []).filter(x => x.foto_path);
    garantirNotasNaLista(lista.length ? lista : [n]);
    _fotoSeq = lista.map(x => x.id);
    if (!(await verFoto(n.id, true))) toast('Anexo não encontrado', 'err');
  }
  function linhaRepasse(r) {
    const pedido = String(r.kind || 'received') !== 'received';
    const nome = r.destino === 'recarga' ? 'Recarga do cartão' : `${pedido ? 'Pedido de repasse' : 'Repasse'} ${r.tipo || ''}`.trim();
    const sub = [donoDe(r), r.data ? fmtDataBR(String(r.data).slice(0, 10)) : '', r.descricao].filter(Boolean).join(' · ');
    return linha('💸', nome, sub, brl(r.valor), saindo(() => (_veEquipe() && r.user_id ? verCartaoDoColaborador(r.user_id) : switchView('saldo'))));
  }
  function linhaPessoa(p) {
    const regime = p.role === 'contabilidade' ? 'Contador' : p.regime === 'cv' ? 'C.V.' : 'RDM/RDA';
    return linha('👤', p.nome || p.email, `${regime}${p.ativo === false ? ' · desativado' : ''} · abrir ficha`, '', saindo(() => verCartaoDoColaborador(p.id)));
  }
  function linhaTela(it) {
    return linha(it.ico, it.lbl, it.sub, '', saindo(() => (it.view ? switchView(it.view) : irParaNotas())));
  }

  function secao(titulo, qtd, total, html) {
    if (!html) return '';
    return `<div class="bsg-sec"><span>${titulo}</span><small>${total > qtd ? `${qtd} de ${total}` : qtd}</small></div>${html}`;
  }

  function corpoInicial() {
    const lista = recentes();
    return `<div class="bsg-sec"><span>Atalhos</span></div>
      <div class="bsg-at">${ATALHOS.filter(a => !a.oculto?.()).map(a => `<button onclick="Busca.atalho('${a.k}')">${a.rot}</button>`).join('')}</div>
      ${lista.length ? `<div class="bsg-sec"><span>Buscas recentes</span></div>${lista.map(t => linha('🕘', t, '', '', acao(() => usar(t)))).join('')}` : ''}
      <p class="bsg-dica">Dá para buscar por fornecedor, CNPJ, número da nota, valor, placa${_veEquipe() ? ', pessoa' : ''} ou nome da tela. Na busca com várias palavras, todas precisam combinar.</p>`;
  }

  function corpoResultados() {
    const telas = atalho ? [] : telasAchadas();
    const r = res || { notas: [], repasses: [], pessoas: [], total_notas: 0, total_repasses: 0 };
    const grupos = [
      ['telas', 'Telas', telas.length, telas.length, () => telas.map(linhaTela).join('')],
      ['pessoas', 'Pessoas', r.pessoas.length, r.pessoas.length, () => r.pessoas.map(linhaPessoa).join('')],
      ['notas', 'Notas', r.notas.length, r.total_notas, () => r.notas.map(linhaNota).join('')],
      ['repasses', 'Repasses', r.repasses.length, r.total_repasses, () => r.repasses.map(linhaRepasse).join('')],
    ].filter(g => g[2] > 0);
    if (filtro !== 'tudo' && !grupos.some(g => g[0] === filtro)) filtro = 'tudo';

    const a = ATALHOS.find(x => x.k === atalho);
    const topo = a ? `<div class="bsg-chips"><button class="chip active" onclick="Busca.limpar()">${a.rot} ✕</button></div>` : '';
    const aviso = carregando ? '<p class="bsg-dica">Buscando…</p>'
      : !navigator.onLine ? '<p class="bsg-dica">Sem internet: aqui aparecem só as telas. Notas e pessoas voltam com a conexão.</p>'
      : falhou ? '<p class="bsg-dica">Não deu para buscar agora. Confira a internet e tente de novo.</p>' : '';
    if (!grupos.length) {
      if (aviso) return topo + aviso;
      return `${topo}<p class="bsg-dica">${a ? 'Nada aqui por enquanto.' : `Nada encontrado para “${mostra(texto.trim())}”.`}</p>
        ${a ? '' : linha('❓', 'Procurar no Como usar', 'abre a ajuda do app', '', saindo(() => abrirAjuda()))}`;
    }
    const chip = (k, rot, n) => `<button class="chip ${filtro === k ? 'active' : ''}" aria-pressed="${filtro === k}" onclick="Busca.filtrar('${k}')">${rot}${n === undefined ? '' : ' ' + n}</button>`;
    const chips = grupos.length > 1 ? `<div class="bsg-chips">${chip('tudo', 'Tudo')}${grupos.map(g => chip(g[0], g[1], g[3])).join('')}</div>` : '';
    const lista = grupos.filter(g => filtro === 'tudo' || filtro === g[0]).map(g => secao(g[1], g[2], g[3], g[4]())).join('');
    const corte = r.total_notas > r.notas.length ? '<p class="bsg-dica">Há mais notas. Digite mais uma palavra para refinar.</p>' : '';
    return topo + chips + aviso + lista + corte;
  }

  function pintar() {
    const el = $('bsg-corpo');
    if (!el) return;
    acoes = [];
    el.innerHTML = atalho || texto.trim() ? corpoResultados() : corpoInicial();
  }

  async function buscar(params) {
    const meu = ++seq;
    if (!sb?.busca || !navigator.onLine) { carregando = false; res = null; pintar(); return; }
    carregando = true; falhou = false; pintar();
    try {
      const r = await sb.busca.geral(params);
      if (meu !== seq) return;   // chegou depois de outra digitação: não pinta por cima
      res = r; carregando = false; pintar();
    } catch (_) {
      if (meu !== seq) return;
      res = null; falhou = true; carregando = false; pintar();
    }
  }

  function digitar(v) {
    texto = String(v || '');
    atalho = null; filtro = 'tudo';
    clearTimeout(timer);
    seq++;
    res = null; falhou = false;
    if (texto.trim().length < 2) { carregando = false; pintar(); return; }
    carregando = true;
    pintar();
    timer = setTimeout(() => buscar({ q: texto.trim() }), ESPERA_MS);
  }

  function usar(t) {
    const inp = $('bsg-inp');
    if (inp) inp.value = t;
    digitar(t);
  }

  function limpar() {
    const inp = $('bsg-inp');
    if (inp) { inp.value = ''; inp.focus(); }
    digitar('');
  }

  /* Duplicata é conta do próprio app (ver _recalcularDuplicatas): usa a lista de pendências, sem ir ao servidor. */
  function escolherAtalho(k) {
    const a = ATALHOS.find(x => x.k === k);
    if (!a) return;
    clearTimeout(timer);
    seq++;
    texto = ''; atalho = k; filtro = 'tudo'; falhou = false;
    const inp = $('bsg-inp'); if (inp) inp.value = '';
    if (a.local) {
      const notas = _notasComPendencia().filter(x => x.motivos.includes('possível duplicata')).map(x => x.nota);
      res = { notas, total_notas: notas.length, repasses: [], total_repasses: 0, pessoas: [] };
      carregando = false;
      pintar();
      return;
    }
    res = null;
    buscar({ atalho: k });
  }

  function abrir() {
    fecharMenu();
    fechar();
    texto = ''; atalho = null; filtro = 'tudo'; res = null; carregando = false; falhou = false;
    const ov = document.createElement('div');
    ov.id = 'busca-overlay';
    ov.className = 'bsg';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-label', 'Busca geral');
    ov.innerHTML = `<div class="bsg-hd">
        <button class="bsg-v" onclick="Busca.fechar()" aria-label="Fechar a busca">‹</button>
        <input id="bsg-inp" class="inp" type="search" autocomplete="off" enterkeyhint="search" placeholder="${_veEquipe() ? 'Buscar nota, pessoa ou tela…' : 'Buscar nota ou tela…'}" aria-label="Buscar" oninput="Busca.digitar(this.value)">
      </div>
      <div class="bsg-c" id="bsg-corpo"></div>`;
    /* o "voltar" do celular fecha as janelas tocando no fundo delas (ver _fecharJanelaAberta): aqui o fundo é o próprio overlay */
    ov.addEventListener('click', e => { if (e.target === ov) fechar(); });
    document.body.appendChild(ov);
    pintar();
    try { _armarNav(); } catch (_) {}
    $('bsg-inp')?.focus();
  }

  function fechar() {
    clearTimeout(timer);
    seq++;
    document.getElementById('busca-overlay')?.remove();
  }

  return {
    abrir, fechar, digitar, limpar, atalho: escolherAtalho,
    filtrar(k) { filtro = k; pintar(); },
    tocar(i) { acoes[i]?.(); },
  };
})();
