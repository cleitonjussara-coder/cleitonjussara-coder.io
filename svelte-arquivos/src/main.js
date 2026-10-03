import { mount, unmount } from 'svelte';
import App from './App.svelte';

/* Ponte com o app vanilla — terceira tela migrada (27/09/2026). Arquivos
   tem estado de navegação (colaborador/ano/mês) e é chamado de FORA
   (gestor.js: `Arquivos.abrirColab(id)`), então o objeto público continua
   se chamando `window.Arquivos` — substitui o arquivos.js original,
   mesmo nome, mesmas funções.

   Cada ação (mudar ano, abrir colaborador...) refaz a busca e REMONTA o
   componente do zero — igual ao render() de antes, que sempre trocava o
   innerHTML inteiro. As strings com HTML embutido (o "3 sem anexo" em
   laranja, por exemplo) continuam sendo montadas aqui, exatamente como no
   arquivos.js original — o componente só as insere com {@html}, não
   reformata nada. */

let instancia = null;
let elAlvo = null;
let dep = null;

let ano = null;
let colab = null;
let mes = null;
let resumo = null;
let lista = null;

const ini = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase();

function montar(elementoAlvo, deps) {
  elAlvo = elementoAlvo;
  dep = deps;
  if (ano === null) ano = dep.filAno;
  render();
}

function desmontar() {
  if (instancia) { unmount(instancia); instancia = null; }
  elAlvo = null;
}

function mostrar(nivel, dados) {
  if (!elAlvo) return;
  if (instancia) { unmount(instancia); instancia = null; }
  elAlvo.innerHTML = '';
  instancia = mount(App, {
    target: elAlvo,
    props: {
      nivel, dados, ano,
      onMudarAno: mudarAno, onAbrirColab: abrirColab, onAbrirMes: abrirMes,
      onVoltarMeses: voltarMeses, onVoltarColabs: voltarColabs,
      onVer: ver, onBaixarZip: baixarZip, onTentarDeNovo: render,
      onBaixarEquipe: baixarEquipe, onBaixarPlanilhas: baixarPlanilhas, meses: dep.MESES_LONGO.slice(1),
    },
  });
  dep.carregarAvatares?.();
}

async function render() {
  if (!elAlvo) return;
  if (!navigator.onLine) { mostrar('offline', null); return; }
  if (!dep.veEquipe() && !colab) colab = { user_id: dep.user.id, nome: dep.user.nome || dep.user.email };
  try {
    if (colab && mes) await renderMes();
    else if (colab) await renderMeses();
    else await renderColabs();
  } catch (e) {
    mostrar('erro', { mensagem: e?.message || 'erro' });
  }
}

async function renderColabs() {
  dep.voltarRodape(null);
  mostrar('carregando', null);
  resumo = await dep.sb.arquivos.resumo(ano);
  const cs = resumo.colaboradores || [];
  const { brl, esc } = dep;
  const totalNotas = cs.reduce((s, c) => s + c.qtd, 0);
  const totalValor = cs.reduce((s, c) => s + c.total, 0);
  const semAnexo = cs.reduce((s, c) => s + (c.qtd - c.com_anexo), 0);

  const cabecalhoSub = `${totalNotas} nota${totalNotas === 1 ? '' : 's'} em ${ano} · ${brl(totalValor)}${semAnexo ? ` · <b style="color:#ffd166">${semAnexo} sem anexo</b>` : ''}`;
  const colaboradores = cs.map(c => {
    const vazio = !c.qtd;
    return {
      userId: c.user_id,
      fotoPath: c.foto_path || '',
      iniciais: ini(c.nome || c.email),
      vazio,
      nomeHtml: `${esc(c.nome || c.email)}${c.ativo === false ? ' <span style="font-size:14px;opacity:.75">🚫 desativado</span>' : ''}`,
      subHtml: vazio ? `sem notas em ${ano}` : `${c.qtd} nota${c.qtd === 1 ? '' : 's'} · ${brl(c.total)}${c.qtd - c.com_anexo ? ` · <span style="color:#ffd166">${c.qtd - c.com_anexo} sem anexo</span>` : ''}`,
    };
  });
  mostrar('colabs', { cabecalhoSub, colaboradores });
}

async function renderMeses() {
  if (!resumo || resumo.ano !== ano) resumo = await dep.sb.arquivos.resumo(ano);
  const c = (resumo.colaboradores || []).find(x => x.user_id === colab.user_id) || { ...colab, qtd: 0, total: 0, com_anexo: 0, meses: [] };
  colab = c;
  dep.voltarRodape(dep.veEquipe() ? 'Arquivos.voltarColabs()' : "switchView('inicio')");
  mostrar('carregando', null);
  const { brl, esc } = dep;
  const porMes = {};
  (c.meses || []).forEach(m => { porMes[m.mes] = m; });
  const meses = [];
  for (let m = 1; m <= 12; m++) {
    const d = porMes[m];
    meses.push({
      mes: m,
      nome: dep.MESES[m - 1],
      vazio: !d,
      qtdTxt: d ? d.qtd + (d.qtd === 1 ? ' nota' : ' notas') : '—',
      valTxt: d ? brl(d.total) : '',
      alertaTxt: d && d.qtd - d.com_anexo ? `${d.qtd - d.com_anexo} sem anexo` : '',
    });
  }
  mostrar('meses', {
    cabecalhoTitulo: `📁 ${esc(c.nome || c.email)}`,
    cabecalhoSub: `${c.qtd} nota${c.qtd === 1 ? '' : 's'} em ${ano} · ${brl(c.total)}`,
    temNotas: !!c.qtd,
    comAnexo: c.com_anexo,
    meses,
  });
}

async function renderMes() {
  dep.voltarRodape('Arquivos.voltarMeses()');
  mostrar('carregando', null);
  lista = await dep.sb.arquivos.notas(colab.user_id, ano, mes);
  const ns = lista.notas || [];
  const { brl, esc, fmtData } = dep;
  const total = ns.reduce((s, n) => s + (n.valor || 0), 0);
  const comAnexo = ns.filter(n => n.foto_path).length;

  const ordem = ['RDA ALIMENTAÇÃO', 'RDM · ABASTECIMENTO', 'RDM · HOSPEDAGENS', 'RDM · OUTROS'];
  const gruposMap = {};
  ns.forEach(n => { (gruposMap[n.grupo] = gruposMap[n.grupo] || []).push(n); });
  const chaves = Object.keys(gruposMap).sort((a, b) => (ordem.indexOf(a) + 100) % 100 - (ordem.indexOf(b) + 100) % 100);
  const grupos = chaves.map(g => {
    const itens = gruposMap[g];
    const subtotal = itens.reduce((s, n) => s + (n.valor || 0), 0);
    return {
      nome: g,
      resumoTxt: `${itens.length} · ${brl(subtotal)}`,
      itens: itens.map(n => ({
        id: n.id,
        temMini: !!n.mini_url,
        miniUrl: n.mini_url || '',
        temAnexo: !!n.foto_path,
        titulo: esc(n.arquivo || ''),
        icoTxt: n.ext === 'pdf' ? '📄 PDF' : n.ext === 'xml' ? '🧾 XML' : '🖼️ ' + (n.ext || '').toUpperCase(),
        legendaHtml: `${fmtData(n.data)}<br><b>${brl(n.valor)}</b>`,
        fornHtml: esc((n.razao_social || '').split(' ').slice(0, 3).join(' ')),
      })),
    };
  });
  mostrar('mes', {
    cabecalhoTitulo: `📁 ${esc(colab.nome || colab.email)} · ${dep.MESES_LONGO[mes]}`,
    cabecalhoSub: `${ns.length} nota${ns.length === 1 ? '' : 's'} · ${brl(total)} · ${comAnexo} com anexo`,
    temNotas: !!ns.length,
    comAnexo,
    grupos,
  });
}

function mudarAno(d) { ano += d; resumo = null; lista = null; if (mes) mes = null; render(); }
function abrirColab(id) { colab = (resumo?.colaboradores || []).find(c => c.user_id === id) || { user_id: id }; mes = null; render(); }
function abrirMes(m) { mes = m; render(); }
function voltarMeses() { mes = null; lista = null; render(); }
function voltarColabs() { colab = null; mes = null; lista = null; render(); }

function ver(id) {
  const n = (lista?.notas || []).find(x => x.id === id);
  if (!n || !n.foto_path) return;
  dep.verFotoCompartilhado(n);
}

async function baixarZip(m) {
  if (!navigator.onLine) { dep.toast('Precisa de internet', 'err'); return; }
  dep.setLoading(true, m ? `Montando o ZIP de ${dep.MESES_LONGO[m]}…` : `Montando o ZIP de ${ano} (pode levar 1 min)…`);
  try {
    const blob = await dep.sb.arquivos.zip(colab.user_id, ano, m);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const nome = (colab.pasta || colab.nome || 'colaborador').replace(/[^A-Za-z0-9_-]+/g, '_');
    a.href = url; a.download = `Notas_${nome}_${ano}${m ? '-' + String(m).padStart(2, '0') : ''}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    dep.toast(`ZIP pronto (${(blob.size / 1024 / 1024).toFixed(1)} MB) ✅`);
  } catch (e) {
    dep.toast('Não foi possível montar o ZIP: ' + (e.message || 'erro'), 'err');
  } finally { dep.setLoading(false); }
}

function _salvarBlob(blob, nome) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/* 03/10/2026 (pedido da contabilidade): tudo da equipe numa tacada. */
async function baixarEquipe(m) {
  if (!navigator.onLine) { dep.toast('Precisa de internet', 'err'); return; }
  dep.setLoading(true, m ? `Montando o ZIP da equipe — ${dep.MESES_LONGO[m]}…` : `Montando o ZIP da equipe — ${ano} (pode levar alguns minutos)…`);
  try {
    const blob = await dep.sb.arquivos.zipEquipe(ano, m);
    _salvarBlob(blob, `Notas_Equipe_${ano}${m ? '-' + String(m).padStart(2, '0') : ''}.zip`);
    dep.toast(`ZIP da equipe pronto (${(blob.size / 1024 / 1024).toFixed(1)} MB) ✅`);
  } catch (e) {
    dep.toast('Não foi possível montar o ZIP da equipe: ' + (e.message || 'erro'), 'err');
  } finally { dep.setLoading(false); }
}

async function baixarPlanilhas() {
  if (!navigator.onLine) { dep.toast('Precisa de internet', 'err'); return; }
  dep.setLoading(true, `Gerando as planilhas de ${ano}… CV uns 5 s, RDM/RDA uns 20 s por pessoa`);
  try {
    const blob = await dep.sb.relatorio.cvEquipe(ano, null, 'zip');
    _salvarBlob(blob, `Planilhas_Equipe_${ano}.zip`);
    dep.toast(`Planilhas prontas (${(blob.size / 1024 / 1024).toFixed(1)} MB) ✅`);
  } catch (e) {
    dep.toast('Não foi possível gerar as planilhas: ' + (e.message || 'erro'), 'err');
  } finally { dep.setLoading(false); }
}

function reset() { colab = null; mes = null; lista = null; }

/* MESMO NOME do módulo original (window.Arquivos) — substitui o
   arquivos.js de antes, não convive com ele. gestor.js chama
   Arquivos.abrirColab(id) direto; switchView() chama Arquivos.reset() ao
   sair e Arquivos.montar(el, deps) ao entrar (ver app.js). */
window.Arquivos = { montar, desmontar, mudarAno, abrirColab, abrirMes, voltarMeses, voltarColabs, ver, baixarZip, reset };
