'use strict';
/* Voltar para a aba anterior sem cair no começo dela (07/11/2026, pedido do Cleiton). Roda o trecho de navegação do
   app.js de verdade (NOME_VIEW … switchView) em jsdom, com as telas falsas: confere que Voltar, Avançar e a trilha
   devolvem a ficha da Equipe, a pasta de Arquivos e a aba de Despesas, e que entrar pelo menu abre do começo.
     node scripts/testar-voltar-abas.js */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(process.env.JSDOM_DIR || path.join(__dirname, '..', 'rda-rdm-app', 'node_modules', 'jsdom'));

const app = fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'app.js'), 'utf8');
const ini = app.indexOf('const NOME_VIEW = {');
const fim = app.indexOf('/* ═══════════════════════════════════════════════════════════\n   VIEW: DESPESAS');
if (ini < 0 || fim < 0) throw new Error('trecho da navegação não encontrado');
const trecho = app.slice(ini, fim).replace(/^const |^let /gm, 'var ');

let falhas = 0;
const confere = (ok, texto) => { console.log(`${ok ? '  ok ' : 'FALHOU'} ${texto}`); if (!ok) falhas++; };

function montar() {
  const dom = new JSDOM(`<nav id="trilha-nav"></nav><button id="btn-inicio-rodape"></button><button id="btn-avancar"></button>
    <button id="btn-voltar-rodape" style="display:none"></button><button id="btn-topo"></button><main id="app-content"></main>`, { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  w.eval(`
    var $ = id => document.getElementById(id);
    var esc = s => String(s == null ? '' : s);
    var viewAtual = null, MODULOS_EXTRAS = false;
    var _pagamentoCV = null, _abaDespesa = null;
    var desenhos = [], restaurados = [], arqRestaurados = [];
    var _limparPreEscolhas = () => {}, _ehContabilidade = () => false, _pintarBarraUsuario = () => {}, _voltarRodape = () => {};
    var _veFrota = () => true, _ehGestorOuAdmin = () => true, fecharMenu = () => {}, fecharCameraNota = () => {};
    var renderHome = () => desenhos.push('home'), renderInicio = () => desenhos.push('inicio'), renderNotas = () => desenhos.push('notas');
    var renderDespesas = () => desenhos.push('despesas:' + _pagamentoCV + ':' + _abaDespesa);
    var renderNotasApagadas = () => {}, renderSaldo = () => {}, renderPerfil = () => desenhos.push('perfil'), renderHistorico = () => {};
    var renderEquipe = () => desenhos.push('equipe:' + (Gestor._id || 'lista'));
    var _montarArquivos = () => desenhos.push('arquivos:' + (Arquivos._colab || 'pastas') + ':' + (Arquivos._mes || '-'));
    window.Gestor = { _id: null,
      estado() { return { id: this._id }; },
      restaurar(e, y) { restaurados.push({ e, y }); this._id = e && e.id; },
      reset() { this._id = null; } };
    window.Arquivos = { _colab: null, _mes: null,
      estado() { return { colab: this._colab, mes: this._mes }; },
      restaurar(e) { arqRestaurados.push(e); this._colab = e.colab; this._mes = e.mes; },
      reset() { this._colab = null; this._mes = null; }, desmontar() {} };
  `);
  w.eval(trecho);
  return w;
}
const ultimo = w => w.eval('desenhos[desenhos.length - 1]');

console.log('Equipe: a ficha volta aberta');
{
  const w = montar();
  w.eval("switchView('inicio'); switchView('equipe'); Gestor._id = 'u1'; renderEquipe();");
  w.eval("switchView('arquivos'); Arquivos._colab = 'u1'; Arquivos._mes = 10;");
  w.eval('voltarView()');
  confere(w.eval('viewAtual') === 'equipe', 'Voltar leva à Equipe');
  confere(ultimo(w) === 'equipe:u1', `com a ficha aberta (desenhou ${ultimo(w)})`);
  confere(w.eval('restaurados.length') === 1, 'Gestor.restaurar foi chamado uma vez');
  confere(/Arquivos/.test(w.document.getElementById('btn-avancar').textContent), 'e o Avançar oferece Arquivos');
  w.eval('avancarView()');
  confere(ultimo(w) === 'arquivos:u1:10', `Avançar volta para a pasta e o mês (desenhou ${ultimo(w)})`);
}

console.log('Entrar pelo menu abre do começo');
{
  const w = montar();
  w.eval("switchView('inicio'); switchView('equipe'); Gestor._id = 'u1'; switchView('perfil'); switchView('equipe');");
  confere(ultimo(w) === 'equipe:lista', `Equipe pelo menu abre a lista (desenhou ${ultimo(w)})`);
  confere(w.eval('restaurados.length') === 0, 'nada foi restaurado');
}

console.log('Despesas: a aba RDA/RDM e a forma de pagamento voltam');
{
  const w = montar();
  w.eval("switchView('inicio'); switchView('despesas'); _pagamentoCV = 'cartao'; _abaDespesa = 'RDM'; switchView('notas'); voltarView();");
  confere(ultimo(w) === 'despesas:cartao:RDM', `Despesas volta na aba RDM do cartão (desenhou ${ultimo(w)})`);
  w.eval("switchView('perfil'); switchView('despesas');");
  confere(ultimo(w) === 'despesas:null:null', `pelo menu, Despesas abre do começo (desenhou ${ultimo(w)})`);
}

console.log('Trilha: mostra o caminho e volta até a tela tocada');
{
  const w = montar();
  w.eval("switchView('inicio'); switchView('equipe'); Gestor._id = 'u9'; switchView('arquivos'); Arquivos._colab = 'u9'; switchView('perfil');");
  const t = w.document.getElementById('trilha-nav').textContent.replace(/\s+/g, ' ');
  confere(/Início›Equipe›Arquivos›Perfil/.test(t), `trilha com o caminho inteiro (${t.trim()})`);
  const bEquipe = [...w.document.querySelectorAll('.trilha-item')].find(b => /Equipe/.test(b.textContent));
  confere(bEquipe.getAttribute('onclick') === "voltarPara('equipe')", 'o botão da trilha volta, não abre do zero');
  w.eval(bEquipe.getAttribute('onclick'));
  confere(w.eval('viewAtual') === 'equipe' && ultimo(w) === 'equipe:u9', `tocar em Equipe volta à ficha (desenhou ${ultimo(w)})`);
  confere(w.eval('_fwdViews.join(",")') === 'perfil,arquivos', `Avançar refaz o caminho: Arquivos e depois Perfil (${w.eval('_fwdViews.join(",")')})`);
  w.eval('avancarView()');
  confere(ultimo(w) === 'arquivos:u9:-', `Avançar abre a pasta de novo (desenhou ${ultimo(w)})`);
  w.eval('avancarView()');
  confere(w.eval('viewAtual') === 'perfil', 'e depois o Perfil');
}

console.log('Botão "Voltar para" do rodapé');
{
  const w = montar();
  w.eval("switchView('inicio'); switchView('equipe'); Gestor._id = 'u2'; switchView('arquivos');");
  const b = w.document.getElementById('btn-inicio-rodape');
  confere(/Voltar para.*Equipe/.test(b.textContent), `mostra o nome da tela anterior (${b.textContent})`);
  b.onclick();
  confere(ultimo(w) === 'equipe:u2', `e volta para a ficha (desenhou ${ultimo(w)})`);
}

console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo');
process.exit(falhas ? 1 : 0);
