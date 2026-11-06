'use strict';
/* ─────────────────────────────────────────────────────────────
   FECHAMENTO DE MÊS (06/11/2026, decisão do dono) — vale para a empresa inteira.
   Quem decide de verdade é o servidor (App\Services\FechamentoMes): daqui só sai
   o aviso antes de a pessoa perder tempo. Lista velha no aparelho não trava nada
   que não deva, porque o 423 volta pela fila e db.js mostra o motivo.
     • Formulário: nota de mês fechado abre sem Salvar, com aviso; o gestor pode
       reabrir ali mesmo. Nota NOVA com data de mês fechado salva, e o aviso diz
       que ela vai para conferência. Nota que ainda não chegou ao servidor conta
       como nova, mesmo já tendo id (ver _naoEnviada).
     • Salvar e excluir nunca esperam a rede: valem com a lista guardada.
     • Equipe: quadro com os meses, histórico e a lista "Fora do fechamento".
     • Relatórios do app: nota que aguarda conferência fica fora do Excel e do CSV, como
       nos relatórios do servidor (aguardando e avisos). As telas seguem com ela.
   Depende de globais do app.js: $, sb, esc, _at, brl, toast, fmtDataBR, setLoading,
   pedirCampos, pedirConfirmacao, mostrarAviso, _ehGestorOuAdmin; e de FusoBR e DB.
───────────────────────────────────────────────────────────── */
window.Fechamento = (() => {
  const CHAVE_META = 'meses_fechados';
  const CHAVE_AGUARDA = 'notas_aguardando';
  const NOMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const INTERVALO_MS = 60_000;

  let fechados = new Set();       // 'aaaa-mm'
  let carregouMeta = false;
  let conferidoEm = 0;
  let painel = null;              // última resposta do servidor para o quadro da Equipe
  let quadroAberto = false;       // sobrevive ao redesenho da Equipe
  let form = { id: null, data: null };   // nota aberta no formulário: id e a data com que abriu

  const chave = (ano, mes) => `${ano}-${String(mes).padStart(2, '0')}`;
  const doMes = data => String(data || '').slice(0, 7);
  const rotuloDe = data => { const [a, m] = doMes(data).split('-'); return `${NOMES[Number(m) - 1] || m}/${a}`; };
  const grande = t => t.charAt(0).toUpperCase() + t.slice(1);
  const estaFechado = data => fechados.has(doMes(data));
  const quando = iso => (iso ? `${FusoBR.data(iso)} às ${FusoBR.hora(iso, { hour: '2-digit', minute: '2-digit' })}` : '');

  /* 06/11/2026: nota que o servidor ainda não tem é nota NOVA, mesmo com id: na fila, ou em "falhou" por anexo vazio. Ele a aceita,
     e travá-la aqui prendia o lançamento num formulário sem Salvar, com a gestão sem saber que ela existe. O que veio do servidor
     tem server_updated_at; o que veio da Equipe nem traz `synced`. Nota antiga editada sem versão guardada cai aqui também, e aí
     quem barra é o 423, com o motivo. */
  const _naoEnviada = n => !!n && n.synced === false && !n.server_updated_at;

  function _guardar(lista) {
    fechados = new Set((lista || []).map(m => chave(m.ano, m.mes)));
    DB.setMeta(CHAVE_META, [...fechados]).catch(() => {});
  }

  /* Só o aparelho: é a parte que salvar e excluir podem esperar. */
  async function _lerGuardada() {
    if (carregouMeta) return;
    carregouMeta = true;
    try { fechados = new Set(await DB.getMeta(CHAVE_META, [])); } catch (_) {}
  }

  /* Lê a última lista conhecida (o app abre sem rede) e, no máximo a cada minuto, pergunta ao servidor. */
  async function atualizar(forcar = false) {
    await _lerGuardada();
    if (!sb || !navigator.onLine || (!forcar && Date.now() - conferidoEm < INTERVALO_MS)) return;
    conferidoEm = Date.now();
    try {
      const r = await sb.fechamento.lista();
      _guardar(r?.fechados);
      if (r?.meses) painel = r;
    } catch (_) { conferidoEm = 0; }   // sem resposta: vale a lista guardada, e a próxima abertura pergunta de novo
  }

  /* ── Relatórios do app ────────────────────────────────── */
  /* 06/11/2026: as notas que os relatórios deixam de fora, sempre do servidor. A cópia da nota no aparelho não serve: conferir não
     muda o updated_at, e a nota já conferida continuaria parecendo pendente. Sem rede vale a última lista: Excel do colaborador
     funciona offline. */
  async function aguardando() {
    if (sb && navigator.onLine) {
      try {
        const r = await sb.fechamento.aguardando();
        const lista = Array.isArray(r?.notas) ? r.notas : [];
        DB.setMeta(CHAVE_AGUARDA, lista).catch(() => {});
        return lista;
      } catch (_) {}
    }
    try { return (await DB.getMeta(CHAVE_AGUARDA, [])) || []; } catch (_) { return []; }
  }

  /* Mesma frase de App\Services\NotasAguardando. */
  function frase(lista, onde, origem = '') {
    if (!lista.length) return '';
    const total = lista.reduce((s, n) => s + Number(n.valor || 0), 0);
    const dinheiro = 'R$ ' + total.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const um = lista.length === 1;
    return `${um ? '1 nota' : `${lista.length} notas`} (${dinheiro})${origem ? ` ${origem}` : ''} ${um ? 'aguarda conferência e não entra' : 'aguardam conferência e não entram'} ${onde}`;
  }

  /* O que o arquivo diz: o que ficou fora do período e, se ele mostra saldo, o que ficou fora do saldo trazido. Faturamento não é
     gasto de colaborador e já não entra nestes relatórios. */
  function avisos(lista, { ano, mes = null, ids = null, onde = 'nesta planilha', saldo = true }) {
    const deles = (lista || []).filter(n => n.pagamento !== 'empresa' && (!ids || ids.includes(n.user_id)));
    const k = o => Number(o.ano) * 12 + Number(o.mes);
    const noPeriodo = deles.filter(n => Number(n.ano) === Number(ano) && (!mes || Number(n.mes) === Number(mes)));
    const antes = deles.filter(n => (mes ? k(n) < Number(ano) * 12 + Number(mes) : Number(n.ano) < Number(ano)));
    return [
      frase(noPeriodo, onde),
      saldo ? frase(antes, mes ? 'no saldo trazido dos meses anteriores' : 'no saldo do ano anterior', mes ? 'de meses anteriores' : 'de anos anteriores') : '',
    ].filter(Boolean);
  }

  /* ── Formulário da nota ───────────────────────────────── */
  function _situacaoDoForm() {
    const dataAgora = $('nf-data')?.value || '';
    if (form.existe && estaFechado(form.data)) return { tipo: 'travada', data: form.data };
    if (form.existe && estaFechado(dataAgora)) return { tipo: 'mover', data: dataAgora };
    if (!form.existe && estaFechado(dataAgora)) return { tipo: 'nova', data: dataAgora };
    return null;
  }

  function aplicarNoFormulario() {
    const banner = $('nf-fechamento');
    if (!banner) return;
    const s = _situacaoDoForm();
    const bloqueia = s && s.tipo !== 'nova';
    $('nf-btn-salvar').style.display = bloqueia ? 'none' : '';
    banner.style.display = s ? 'flex' : 'none';
    if (!s) return;
    const rotulo = rotuloDe(s.data);
    const gestor = _ehGestorOuAdmin();
    $('nf-fech-titulo').textContent = s.tipo === 'nova' ? `${grande(rotulo)} já foi fechado` : `🔒 ${grande(rotulo)} está fechado`;
    $('nf-fech-texto').textContent = s.tipo === 'nova'
      ? 'Pode salvar: a nota entra e vai para a conferência da gestão. Depois de salva, só muda se o mês for reaberto.'
      : (s.tipo === 'mover' ? 'Esta nota não pode ir para um mês fechado.' : 'Esta nota não pode ser alterada nem excluída.')
        + (gestor ? ' Para mudar, reabra o mês.' : ' Se precisar corrigir, fale com o gestor.');
    const botao = $('nf-fech-reabrir');
    botao.style.display = bloqueia && gestor ? '' : 'none';
    botao.dataset.ano = doMes(s.data).slice(0, 4);
    botao.dataset.mes = String(Number(doMes(s.data).slice(5, 7)));
  }

  function abrirForm(dados) {
    const existe = !!dados?.id && !_naoEnviada(dados);
    form = { existe, data: existe ? dados.data : null };
    aplicarNoFormulario();
    const aberta = form;
    atualizar().then(() => { if (aberta === form) aplicarNoFormulario(); });
  }

  /* Rede de segurança do Salvar: a data pode ter vindo do OCR ou do QR, que escrevem no campo sem disparar evento.
     06/11/2026: o servidor é perguntado sem esperar a resposta. Com sinal fraco a espera chegava a 30 s antes de gravar no aparelho,
     a cada tentativa, e fechar o app nesse tempo perdia o lançamento. Lista velha não faz mal: a recusa volta pela fila, com aviso. */
  async function conferirAoSalvar() {
    await _lerGuardada();
    atualizar();
    const estavaVisivel = $('nf-fechamento')?.style.display === 'flex';
    aplicarNoFormulario();
    const s = _situacaoDoForm();
    if (!s) return true;
    if (s.tipo === 'nova') {
      if (!estavaVisivel) await mostrarAviso(`${grande(rotuloDe(s.data))} já foi fechado\nA nota vai ser salva e segue para a conferência da gestão.`);
      return true;
    }
    return false;
  }

  /* Lixeira, restaurar e apagar: avisa antes em vez de deixar a pessoa fazer e ver desfeito. Devolve true se barrou. */
  async function barrarNotas(lista) {
    await _lerGuardada();
    atualizar();   // sem esperar, como no Salvar
    const meses = [...new Set((lista || []).filter(n => n && !_naoEnviada(n) && estaFechado(n.data)).map(n => rotuloDe(n.data)))];
    if (!meses.length) return false;
    await mostrarAviso(`Mês fechado\n${grande(meses.join(', '))}: nota de mês fechado não pode ser excluída nem restaurada. ${_ehGestorOuAdmin() ? 'Reabra o mês em Equipe, no quadro Fechamento de mês.' : 'Se precisar, fale com o gestor.'}`);
    return true;
  }

  /* ── Ações ────────────────────────────────────────────── */
  async function _depois(r) {
    _guardar(r?.fechados);
    if (r?.meses) painel = r;
    _pintarQuadro();
    aplicarNoFormulario();
  }

  async function fechar(d) {
    const rotulo = rotuloDe(chave(d.ano, d.mes));
    /* fechar de novo com nota a conferir: ela volta a sair da planilha (ver Nota::noRelatorio); melhor saber antes */
    const aConferir = Number((painel?.meses || []).find(m => Number(m.ano) === Number(d.ano) && Number(m.mes) === Number(d.mes))?.fora || 0);
    const ok = await pedirConfirmacao({
      titulo: `Fechar ${rotulo}?`,
      mensagem: 'Vale para a empresa inteira. Ninguém altera nem apaga nota ou repasse deste mês até ele ser reaberto, nem o gestor.\n\nNota nova que ainda estiver em algum aparelho entra mesmo assim e aparece aqui para conferir. Ela só vai para a planilha depois de conferida.'
        + (aConferir ? `\n\n${aConferir === 1 ? '1 nota deste mês ainda está a conferir e vai sair' : `${aConferir} notas deste mês ainda estão a conferir e vão sair`} da planilha até a conferência.` : ''),
      confirmar: 'Fechar mês',
    });
    if (!ok) return;
    setLoading(true, 'Fechando…');
    try {
      await _depois(await sb.fechamento.fechar(Number(d.ano), Number(d.mes)));
      toast(`${grande(rotulo)} fechado 🔒`);
    } catch (e) { toast('Não deu: ' + (e.message || 'erro'), 'err'); } finally { setLoading(false); }
  }

  async function reabrir(d) {
    if (!sb || !navigator.onLine) { toast('Precisa de internet para reabrir', 'err'); return; }
    const rotulo = rotuloDe(chave(d.ano, d.mes));
    const r = await pedirCampos({
      titulo: `Reabrir ${rotulo}`,
      dica: 'Fica registrado quem reabriu, quando e por quê. A planilha já entregue pode mudar enquanto o mês estiver aberto.',
      confirmar: 'Reabrir',
      campos: [{ id: 'motivo', rotulo: 'Motivo', linhas: 3, maxlength: 500, placeholder: 'Por que o mês está sendo reaberto?', validar: t => (t.length < 3 ? 'Diga o motivo para reabrir.' : '') }],
    });
    if (!r) return;
    setLoading(true, 'Reabrindo…');
    try {
      await _depois(await sb.fechamento.reabrir(Number(d.ano), Number(d.mes), r.motivo));
      toast(`${grande(rotulo)} reaberto`);
    } catch (e) { toast('Não deu: ' + (e.message || 'erro'), 'err'); } finally { setLoading(false); }
  }

  async function conferir(id, btn) {
    if (btn) btn.disabled = true;
    try {
      await _depois(await sb.fechamento.conferir(id));
      toast('Nota conferida ✅ Já entra na planilha');
    } catch (e) {
      toast('Não deu: ' + (e.message || 'erro'), 'err');
      if (btn) btn.disabled = false;
    }
  }

  /* ── Quadro da Equipe ─────────────────────────────────── */
  function _linhaMes(m, podeAlterar) {
    const sub = m.fechado
      ? `Fechado por ${esc(m.fechado_por || 'Sistema')} em ${esc(quando(m.fechado_em))}`
      : (m.pode_fechar ? 'Aberto' : 'Mês em andamento');
    const dados = `data-ano="${Number(m.ano)}" data-mes="${Number(m.mes)}"`;
    const acao = !podeAlterar ? ''
      : m.fechado ? `<button type="button" class="btn btn-sm btn-outline" ${dados} onclick="Fechamento.reabrir(this.dataset)">Reabrir</button>`
      : m.pode_fechar ? `<button type="button" class="btn btn-sm btn-primary" ${dados} onclick="Fechamento.fechar(this.dataset)">Fechar</button>` : '';
    return `<div class="fech-linha">
      <div class="fech-info">
        <div class="fech-mes">${m.fechado ? '🔒 ' : ''}${esc(grande(m.rotulo))}${m.fora ? ` <span class="fech-selo">${Number(m.fora)} a conferir</span>` : ''}</div>
        <div class="fech-sub">${sub}</div>
      </div>
      ${acao}
    </div>`;
  }

  function _linhaFora(n, podeAlterar) {
    return `<div class="fech-linha">
      <div class="fech-info">
        <div class="fech-mes">${esc(n.razao_social || 'Sem empresa')} · ${brl(n.valor)}</div>
        <div class="fech-sub">${esc(n.dono_nome || '')} · ${esc(fmtDataBR(n.data))} (${esc(n.rotulo)})</div>
        <div class="fech-sub">Chegou em ${esc(quando(n.chegou_em))}</div>
        <div class="fech-sub">${n.fora_da_planilha ? 'Fora da planilha até ser conferida' : 'Mês reaberto: já sai na planilha. Ao fechar de novo, sai dela até ser conferida'}</div>
      </div>
      ${podeAlterar ? `<button type="button" class="btn btn-sm btn-outline" data-id="${_at(n.id)}" onclick="Fechamento.conferir(this.dataset.id,this)">Conferida</button>` : ''}
    </div>`;
  }

  function _linhaHistorico(h) {
    return `<div class="fech-hist">
      <div class="fech-mes">${h.acao === 'reabrir' ? '🔓 Reabriu' : '🔒 Fechou'} ${esc(h.rotulo)}</div>
      <div class="fech-sub">${esc(h.por_nome)} · ${esc(quando(h.feito_em))}</div>
      ${h.motivo ? `<div class="fech-sub">Motivo: ${esc(h.motivo)}</div>` : ''}
    </div>`;
  }

  function _pintarQuadro() {
    const el = $('fech-quadro');
    if (!el) return;
    if (!painel) { el.innerHTML = ''; return; }
    if (painel.disponivel === false) {
      el.innerHTML = '<div class="dash-card"><div class="dash-card-title">🔒 Fechamento de mês</div><div class="fech-sub">Ainda não está ativo no servidor: falta atualizar a estrutura do banco.</div></div>';
      return;
    }
    const fora = painel.fora || [];
    const pode = !!painel.pode_alterar;
    const historico = painel.historico || [];
    el.innerHTML = `<details class="dash-card fech-card" ${quadroAberto ? 'open' : ''} ontoggle="Fechamento.lembrar(this.open)">
      <summary class="fech-resumo"><span class="dash-card-title" style="margin:0">🔒 Fechamento de mês</span>${fora.length ? `<span class="fech-selo">${fora.length} a conferir</span>` : ''}</summary>
      ${pode ? '<div class="fech-dica">Mês fechado protege a planilha entregue à contabilidade. Vale para toda a empresa.</div>' : '<div class="fech-dica">Só gestor e admin fecham e reabrem. Mês fechado não recebe correção.</div>'}
      ${fora.length ? `<div class="fech-titulo">Fora do fechamento</div>
      <div class="fech-dica">Notas novas que chegaram dos aparelhos depois de o mês fechar. Já estão nos saldos das telas; só vão para a planilha do mês depois de conferidas.</div>
      ${fora.map(n => _linhaFora(n, pode)).join('')}` : ''}
      <div class="fech-titulo">Meses</div>
      ${(painel.meses || []).map(m => _linhaMes(m, pode)).join('')}
      ${historico.length ? `<details class="fech-det"><summary>Histórico (${historico.length})</summary>${historico.map(_linhaHistorico).join('')}</details>` : ''}
    </details>`;
  }

  async function pintar() {
    await atualizar(true);
    _pintarQuadro();
  }

  document.addEventListener('input', e => { if (e.target?.id === 'nf-data') aplicarNoFormulario(); });
  document.addEventListener('change', e => { if (e.target?.id === 'nf-data') aplicarNoFormulario(); });

  return {
    atualizar, estaFechado, abrirForm, aplicarNoFormulario, conferirAoSalvar, barrarNotas, pintar, fechar, reabrir, conferir, aguardando, avisos, frase,
    abrirQuadro: () => { quadroAberto = true; },
    lembrar: aberto => { quadroAberto = aberto; },
  };
})();
