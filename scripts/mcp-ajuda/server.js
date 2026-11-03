// Servidor MCP local (stdio) da ajuda do NOTAS PM (03/11/2026).
// Ferramenta única: buscar_ajuda. Só LÊ o texto da ajuda (api/resources/ajuda); não acessa banco, rede, nem produção.
// A busca é o AjudaRag do próprio servidor, chamado por buscar.php — nada de BM25 reescrito aqui.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const PHP_WINGET = 'C:/Users/user/AppData/Local/Microsoft/WinGet/Packages/PHP.PHP.8.3_Microsoft.Winget.Source_8wekyb3d8bbwe/php.exe';
const PHP = process.env.PHP_BIN || (existsSync(PHP_WINGET) ? PHP_WINGET : 'php');

export function buscarNoPhp(pergunta, papel, k) {
  return new Promise((resolve, reject) => {
    const p = spawn(PHP, [path.join(aqui, 'buscar.php')], { env: { ...process.env, CACHE_STORE: 'array' } });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('busca demorou mais de 60 s')); }, 60_000);
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`php saiu com ${code}: ${err.slice(0, 300)}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`resposta inválida do php: ${out.slice(0, 200)}`)); }
    });
    p.stdin.end(JSON.stringify({ pergunta, papel, k }));
  });
}

export function formatar(r) {
  if (!r.trechos.length) return `Nada encontrado na ajuda para o papel "${r.papel}".`;
  return r.trechos
    .map((t, i) => `[${i + 1}] ${t.titulo || '(sem título)'}  (relevância ${t.score})\n${t.texto}`)
    .join('\n\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = new McpServer({ name: 'ajuda-notas-pm', version: '0.1.0' });

  server.registerTool(
    'buscar_ajuda',
    {
      title: 'Buscar na ajuda do NOTAS PM',
      description:
        'Busca por palavras nos textos da tela "Como usar" do app NOTAS PM e devolve os trechos mais relevantes, ' +
        'já filtrados pelo papel (o que a ajuda esconde de um papel não aparece). Use para responder como fazer algo no app. ' +
        'Só texto da ajuda: não traz dados de notas, repasses ou pessoas.',
      inputSchema: {
        pergunta: z.string().min(3).max(400).describe('A dúvida, em português, com as palavras do usuário'),
        papel: z.enum(['colaborador', 'gestor', 'admin', 'contabilidade']).default('colaborador')
          .describe('Papel de quem pergunta; padrão colaborador (o menos permissivo). gestor/admin veem também os textos de gestão.'),
        k: z.number().int().min(1).max(10).default(5).describe('Quantos trechos devolver'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pergunta, papel, k }) => {
      try {
        return { content: [{ type: 'text', text: formatar(await buscarNoPhp(pergunta, papel ?? 'colaborador', k ?? 5)) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `Falha na busca: ${e.message}` }] };
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
