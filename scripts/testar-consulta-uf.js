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

console.log(falhas ? `\n${falhas} caso(s) falharam.` : '\nTudo certo.');
process.exit(falhas ? 1 : 0);
