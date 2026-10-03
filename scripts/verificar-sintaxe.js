#!/usr/bin/env node
// Hook PostToolUse (Edit|Write): confere a sintaxe do arquivo recém-editado.
//   .js  em rda-rdm-app/ ou api/  -> node --check
//   .php em api/                  -> php -l
// Erro => exit 2 com a mensagem em stderr (volta para o Claude). Qualquer
// outra situação (arquivo fora do escopo, vendor, ferramenta ausente) => exit 0.
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let entrada = '';
process.stdin.on('data', d => (entrada += d));
process.stdin.on('end', () => {
  let arquivo;
  try {
    const j = JSON.parse(entrada);
    arquivo = (j.tool_response && j.tool_response.filePath) || (j.tool_input && j.tool_input.file_path);
  } catch { return; }
  if (!arquivo || !fs.existsSync(arquivo)) return;

  const raiz = path.resolve(__dirname, '..');
  const rel = path.relative(raiz, path.resolve(arquivo)).split(path.sep).join('/');
  if (rel.startsWith('..') || /(^|\/)(vendor|node_modules)\//.test(rel)) return;

  let cmd, args;
  if (/\.js$/.test(rel) && /^(rda-rdm-app|api)\//.test(rel)) {
    cmd = process.execPath; args = ['--check', arquivo];
  } else if (/\.php$/.test(rel) && rel.startsWith('api/')) {
    cmd = 'php'; args = ['-l', arquivo];
  } else return;

  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) return; // php/node fora do PATH: não bloqueia
  if (r.status !== 0) {
    process.stderr.write(`Erro de sintaxe em ${rel}:\n${(r.stderr || r.stdout).trim()}\n`);
    process.exit(2);
  }
});
