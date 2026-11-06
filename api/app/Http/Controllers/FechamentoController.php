<?php

namespace App\Http\Controllers;

use App\Models\Nota;
use App\Services\FechamentoMes;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

/**
 * Fechamento de mês (06/11/2026). Só gestor e admin fecham e reabrem. Contador lê o estado: a escrita dele para no
 * SomenteLeitura, porque estas rotas não estão em ESCRITA_LIVRE. Quem decide é App\Services\FechamentoMes.
 */
class FechamentoController extends Controller
{
    public function __construct(private FechamentoMes $fechamento) {}

    /** GET /fechamento — colaborador recebe só `fechados`; quem vê a equipe recebe também meses, histórico e o que falta conferir. */
    public function index(Request $r): JsonResponse
    {
        return response()->json($this->fechamento->painel($r->user()));
    }

    /** GET /fechamento/aguardando — as notas que os relatórios deixam de fora agora, só as que a pessoa pode ver. */
    public function aguardando(Request $r): JsonResponse
    {
        return response()->json(['notas' => $this->fechamento->aguardando($r->user())]);
    }

    /** POST /fechamento/fechar {ano, mes} */
    public function fechar(Request $r): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só gestor ou admin fecham o mês');
        $d = $this->periodo($r);
        abort_unless($this->fechamento->podeFechar($d['ano'], $d['mes']), 422, 'Só dá para fechar mês que já terminou.');
        $jaEstava = $this->fechamento->fechar($d['ano'], $d['mes'], $u);
        if (! $jaEstava) {
            Log::warning('mês fechado', ['mes' => "{$d['mes']}/{$d['ano']}", 'por' => $u->email]);
        }

        return response()->json(['ok' => true, 'ja_estava' => $jaEstava] + $this->fechamento->painel($u));
    }

    /** POST /fechamento/reabrir {ano, mes, motivo} */
    public function reabrir(Request $r): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só gestor ou admin reabrem o mês');
        $d = $this->periodo($r);
        $motivo = trim((string) $r->validate(['motivo' => ['required', 'string', 'max:500']])['motivo']);
        abort_if(mb_strlen($motivo) < 3, 422, 'Diga por que o mês está sendo reaberto.');
        $jaEstava = $this->fechamento->reabrir($d['ano'], $d['mes'], $motivo, $u);
        if (! $jaEstava) {
            Log::warning('mês reaberto', ['mes' => "{$d['mes']}/{$d['ano']}", 'por' => $u->email, 'motivo' => $motivo]);
        }

        return response()->json(['ok' => true, 'ja_estava' => $jaEstava] + $this->fechamento->painel($u));
    }

    /** POST /fechamento/fora/{id}/conferir — tira a nota da lista "Fora do fechamento". Vale com o mês fechado: não altera a nota. */
    public function conferir(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só gestor ou admin conferem');
        abort_unless($this->fechamento->ativo() && Nota::temForaFechamento(), 503, 'O fechamento de mês ainda não está ativo no servidor.');
        $nota = Nota::findOrFail($id);
        abort_if($nota->fora_fechamento_em === null, 422, 'Esta nota não está fora do fechamento.');
        $this->fechamento->conferir($nota, $u);

        return response()->json(['ok' => true] + $this->fechamento->painel($u));
    }

    private function periodo(Request $r): array
    {
        abort_unless($this->fechamento->ativo(), 503, 'O fechamento de mês ainda não está ativo no servidor.');

        return array_map('intval', $r->validate([
            'ano' => ['required', 'integer', 'min:2020', 'max:2100'],
            'mes' => ['required', 'integer', 'between:1,12'],
        ]));
    }
}
