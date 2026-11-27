#!/usr/bin/env node
// Para onde vai a consulta de uma nota SEM QR, conforme a UF da chave. Sem navegador e sem dependência:
//   node scripts/testar-consulta-uf.js
// Sai com código 1 se algum caso falhar.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'sefaz.js'), 'utf8'), ctx);
const S = ctx.window.SEFAZ;

let falhas = 0;
const confere = (nome, veio, esperado) => {
  const ok = veio === esperado;
  console.log((ok ? '  ok  ' : '  FALHOU  ') + nome + (ok ? '' : `  (veio ${veio}, esperado ${esperado})`));
  if (!ok) falhas++;
};
// chave de 11/2026 com UF e modelo escolhidos
const chave = (uf, modelo) => uf + '261112345678000199' + modelo + '001000000123100000012' + '0';

console.log('NFC-e do RS');
const rs = S.destinoConsulta(chave('43', '65'));
confere('abre a consulta pública da SVRS com a chave', rs.url, 'https://dfe-portal.svrs.rs.gov.br/Dfe/ConsultaPublicaDfe?ChaveAcessoDfe=' + chave('43', '65'));
confere('avisa que a chave já vai preenchida', rs.preenchida, true);
confere('copia a chave por garantia', rs.colarChave, true);
confere('mostra a UF', rs.uf, 'RS');

console.log('O que não muda');
confere('NF-e (55) do RS segue no portal nacional', S.destinoConsulta(chave('43', '55')).url.startsWith('https://www.nfe.fazenda.gov.br/'), true);
confere('NFC-e de GO segue preenchida', S.destinoConsulta(chave('52', '65')).url.includes('?chaveAcesso=' + chave('52', '65')), true);
confere('UF sem página segue no portal nacional', S.destinoConsulta(chave('50', '65')).colarChave, false);

// O aviso que a pessoa lê, tirado do próprio app.js
const app = fs.readFileSync(path.join(__dirname, '..', 'rda-rdm-app', 'js', 'app.js'), 'utf8').replace(/\r/g, '');
const de = app.indexOf('async function resolverLinkConsulta(');
const ate = app.indexOf('/* ── Aba/categoria automática', de);
if (de < 0 || ate < 0) throw new Error('trecho da consulta não encontrado no app.js');

let tempo = 0;   // quanto o último aviso fica na tela (ms)
const aviso = async (c, copia) => {
  let texto = '';
  const tela = {
    window: { SEFAZ: S, open: () => ({ location: {}, close() {} }) },
    SEFAZ: S,
    DB: { getMeta: async () => null },
    navigator: { clipboard: copia ? { writeText: async () => {} } : undefined },
    toast: (t, tipo, ms) => { texto = t; tempo = ms || 3000; },
    _digitos: s => String(s || '').replace(/\D/g, ''),
    _qrUrlSegura: u => u,
  };
  vm.runInNewContext(app.slice(de, ate), tela);
  tela.abrirConsultaChave(c, null);
  await new Promise(r => setTimeout(r, 20));
  return texto;
};

(async () => {
  console.log('Aviso na tela');
  const comCopia = await aviso(chave('43', '65'), true);
  // 27/11/2026, testado com cupom real: o login gov.br apaga a chave; o segundo toque no 🔗 copia de novo
  confere('RS ensina o passo a passo', comCopia, 'SEFAZ-RS: o login gov.br apaga a chave. Depois de entrar, toque no 🔗 de novo e cole a chave.');
  const semCopia = await aviso(chave('43', '65'), false);
  confere('RS sem cópia não manda colar', semCopia, 'SEFAZ-RS: o login gov.br apaga a chave. Depois de entrar, digite os 44 dígitos.');
  confere('RS fica tempo de ler', tempo >= 8000, true);
  confere('GO não fala em login', (await aviso(chave('52', '65'), true)), 'Abrindo a consulta da SEFAZ-GO com a chave preenchida — é só pesquisar');

  console.log(falhas ? `\n${falhas} caso(s) falharam.` : '\nTudo certo.');
  process.exit(falhas ? 1 : 0);
})();
