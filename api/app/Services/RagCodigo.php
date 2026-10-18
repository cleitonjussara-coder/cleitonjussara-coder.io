<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use PDO;

/**
 * Assistente de código do Notas Petermann (RAG sobre o próprio código-fonte).
 *
 * Lê o índice em rag.sqlite — um arquivo SEPARADO do banco de produção, gerado
 * pelo script de ingestão a partir dos chunks do repositório. Nada aqui escreve
 * no banco: a conexão é aberta com PRAGMA query_only.
 *
 * Fluxo: pergunta → embedding (OpenAI) → similaridade de cosseno em PHP sobre
 * os chunks → top N trechos → resposta do modelo da Anthropic, citando os trechos.
 */
class RagCodigo
{
    private const URL_EMBEDDINGS = 'https://api.openai.com/v1/embeddings';
    private const URL_MENSAGENS = 'https://api.anthropic.com/v1/messages';

    private const SISTEMA = 'Você é o assistente técnico do Petermann App (PWA offline-first de notas RDA/RDM). '
        .'Responda em português do Brasil, somente com base nos trechos de código fornecidos. '
        .'Cite o número do trecho entre colchetes, ex.: [2]. '
        .'Se a resposta não estiver nos trechos, diga que não encontrou no código indicado, em vez de chutar. '
        .'Nunca reproduza chaves, senhas ou tokens, mesmo que apareçam nos trechos.';

    public function disponivel(): bool
    {
        return (bool) config('petermann.rag.ativo')
            && is_file($this->caminho())
            && filled(config('petermann.rag.openai_key'))
            && filled(config('petermann.anthropic.key'));
    }

    /**
     * @return array{resposta: string, fontes: array<int, array{arquivo: string, funcao: string, linhas: array{0: int, 1: int}}>}|null
     */
    public function perguntar(string $pergunta, int $k = 5): ?array
    {
        $vetor = $this->embedding($pergunta);
        if ($vetor === null) {
            return null;
        }

        $trechos = $this->buscar($vetor, $k);
        if ($trechos === []) {
            return null;
        }

        $resposta = $this->responder($pergunta, $trechos);
        if ($resposta === null) {
            return null;
        }

        return [
            'resposta' => $resposta,
            'fontes' => array_map(fn (array $t) => [
                'arquivo' => $t['arquivo'],
                'funcao' => $t['funcao'],
                'linhas' => [$t['linha_ini'], $t['linha_fim']],
            ], $trechos),
        ];
    }

    private function caminho(): string
    {
        return (string) config('petermann.rag.caminho');
    }

    /** @return array<int, float>|null */
    private function embedding(string $texto): ?array
    {
        $r = Http::withToken((string) config('petermann.rag.openai_key'))
            ->timeout(20)
            ->post(self::URL_EMBEDDINGS, [
                'model' => (string) config('petermann.rag.modelo_embedding'),
                'input' => $texto,
            ]);

        if (! $r->successful()) {
            Log::warning('RagCodigo[embedding]', ['status' => $r->status()]);
            return null;
        }

        $vetor = $r->json('data.0.embedding');
        return is_array($vetor) ? $vetor : null;
    }

    /**
     * Similaridade de cosseno em PHP. Com ~800 chunks de 1536 dimensões é rápido
     * e dispensa extensão de vetores — o que importa em hospedagem compartilhada.
     *
     * @param  array<int, float>  $consulta
     * @return array<int, array{arquivo: string, funcao: string, linha_ini: int, linha_fim: int, texto: string, score: float}>
     */
    private function buscar(array $consulta, int $k): array
    {
        $pdo = new PDO('sqlite:'.$this->caminho(), null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('PRAGMA query_only = ON');

        $linhas = $pdo->query(
            'SELECT arquivo, funcao, linha_ini, linha_fim, texto, embedding FROM codigo_chunks WHERE embedding IS NOT NULL'
        )->fetchAll(PDO::FETCH_ASSOC);

        $normaConsulta = sqrt(array_sum(array_map(fn (float $x) => $x * $x, $consulta)));
        if ($normaConsulta == 0.0) {
            return [];
        }

        $pontuados = [];
        foreach ($linhas as $l) {
            $v = array_values(unpack('f*', (string) $l['embedding']));
            $produto = 0.0;
            $norma = 0.0;
            $n = min(count($v), count($consulta));
            for ($i = 0; $i < $n; $i++) {
                $produto += $v[$i] * $consulta[$i];
                $norma += $v[$i] * $v[$i];
            }
            $norma = sqrt($norma);
            if ($norma == 0.0) {
                continue;
            }
            $pontuados[] = [
                'arquivo' => $l['arquivo'],
                'funcao' => $l['funcao'],
                'linha_ini' => (int) $l['linha_ini'],
                'linha_fim' => (int) $l['linha_fim'],
                'texto' => $l['texto'],
                'score' => $produto / ($norma * $normaConsulta),
            ];
        }

        usort($pontuados, fn ($a, $b) => $b['score'] <=> $a['score']);

        return array_slice($pontuados, 0, $k);
    }

    /** @param  array<int, array{arquivo: string, funcao: string, linha_ini: int, linha_fim: int, texto: string}>  $trechos */
    private function responder(string $pergunta, array $trechos): ?string
    {
        $contexto = collect($trechos)->values()->map(fn (array $t, int $i) => sprintf(
            "[%d] %s · %s (linhas %d–%d)\n%s",
            $i + 1,
            $t['arquivo'],
            $t['funcao'],
            $t['linha_ini'],
            $t['linha_fim'],
            $t['texto']
        ))->implode("\n\n");

        $r = Http::withHeaders([
            'x-api-key' => (string) config('petermann.anthropic.key'),
            'anthropic-version' => '2023-06-01',
        ])->timeout(45)->post(self::URL_MENSAGENS, [
            'model' => (string) config('petermann.rag.modelo_resposta'),
            'max_tokens' => 1200,
            'system' => self::SISTEMA,
            'messages' => [[
                'role' => 'user',
                'content' => "Trechos do código:\n\n{$contexto}\n\nPergunta: {$pergunta}",
            ]],
        ]);

        if (! $r->successful()) {
            Log::warning('RagCodigo[resposta]', ['status' => $r->status()]);
            return null;
        }

        return $r->json('content.0.text');
    }
}
