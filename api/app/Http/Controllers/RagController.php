<?php

namespace App\Http\Controllers;

use App\Services\RagCodigo;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;

/**
 * Assistente de código do Notas Petermann. Só responde se RAG_ATIVO=true no .env
 * do servidor; desligado por padrão, então publicar esta versão não muda nada
 * para a equipe. Limite diário por usuário, como nas leituras por IA.
 */
class RagController extends Controller
{
    public function perguntar(Request $r, RagCodigo $rag): JsonResponse
    {
        $dados = $r->validate(['pergunta' => ['required', 'string', 'min:5', 'max:500']]);

        if (! config('petermann.rag.ativo')) {
            return response()->json(['motivo' => 'desligado'], 404);
        }
        if (! $rag->disponivel()) {
            return response()->json(['motivo' => 'indisponivel'], 503);
        }

        $chave = 'rag:'.$r->user()->id.':'.now('America/Sao_Paulo')->format('Y-m-d');
        $limite = (int) config('petermann.rag.limite_dia');
        if ($limite > 0 && (int) Cache::get($chave, 0) >= $limite) {
            return response()->json(['motivo' => 'limite'], 429);
        }
        Cache::add($chave, 0, now()->addDay());
        Cache::increment($chave);

        $resultado = $rag->perguntar($dados['pergunta']);
        if ($resultado === null) {
            return response()->json(['motivo' => 'falhou'], 502);
        }

        return response()->json($resultado);
    }
}
