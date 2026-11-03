// Teste de ponta a ponta: sobe o servidor MCP por stdio, como o Claude faria, e confere a ferramenta e o filtro por papel.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: 'teste', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(aqui, 'server.js')] }));

const { tools } = await client.listTools();
assert.deepEqual(tools.map(t => t.name), ['buscar_ajuda']);
assert.equal(tools[0].annotations.readOnlyHint, true);

const texto = async args => (await client.callTool({ name: 'buscar_ajuda', arguments: args })).content[0].text;

const km = await texto({ pergunta: 'como registro quilometragem do carro' });
assert.match(km, /Frota/);

const colab = await texto({ pergunta: 'como avisar o dono da nota para corrigir', papel: 'colaborador', k: 10 });
const gestor = await texto({ pergunta: 'como avisar o dono da nota para corrigir', papel: 'gestor', k: 10 });
assert.ok(!colab.includes('Avisar o dono da nota (24/10/2026)'), 'bloco do gestor vazou para o colaborador');
assert.match(gestor, /Avisar/);

assert.match(await texto({ pergunta: 'zzxx qqww' }), /Nada encontrado/);

const r = await client.callTool({ name: 'buscar_ajuda', arguments: { pergunta: 'ab' } }).catch(e => e);
assert.ok(r.isError || r instanceof Error, 'pergunta curta deveria ser recusada');

await client.close();
console.log('mcp-ajuda: ok');
