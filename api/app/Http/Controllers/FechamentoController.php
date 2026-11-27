<?php

namespace App\Http\Controllers;

use App\Models\Conferencia;
use App\Models\Nota;
use App\Models\Repasse;
use App\Services\DuplicataNota;
use App\Services\FechamentoMes;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Schema;

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

    /**
     * GET /fechamento/resumo?ano=&mes= (27/11/2026, verificação de 26/11, fase 3 item 3) — o que falta olhar antes de fechar:
     * notas do mês (empresa inteira), conferidas, sem anexo, sem valor, possíveis duplicatas (mesma regra do aviso da gestão,
     * contada só na nota mais nova do par) e pedidos de repasse abertos. Só informa: fechar continua livre.
     */
    public function resumo(Request $r, DuplicataNota $dup): JsonResponse
    {
        abort_unless($r->user()->gerencia(), 403, 'Só gestor ou admin veem o resumo do fechamento');
        $d = $this->periodo($r);
        $notas = Nota::where('deleted', false)->where('ano', $d['ano'])->where('mes', $d['mes'])->get();
        $conferidas = Conferencia::tabelaExiste()
            ? Conferencia::where('tipo', 'nota')->whereIn('registro_id', $notas->pluck('id'))->get()->filter->conferida()->count()
            : null;
        $duplicatas = 0;
        foreach ($notas as $n) {
            $achou = $dup->achar(DuplicataNota::dadosDe($n), $n->id);
            if ($achou && ($achou[0]->created_at <= $n->created_at)) {
                $duplicatas++;   // só a mais nova do par conta: duas notas iguais no mês são 1 duplicata
            }
        }
        $pedidos = Repasse::where('deleted', false)->where('ano', $d['ano'])->where('mes', $d['mes'])
            ->whereIn('kind', ['requested', 'request', 'pedido', 'solicitado'])->whereNull('atendido_em')
            ->when(Schema::hasColumn('repasses', 'recusado_em'), fn ($q) => $q->whereNull('recusado_em'))
            ->get(['valor']);

        return response()->json([
            'ano' => $d['ano'], 'mes' => $d['mes'],
            'notas' => $notas->count(),
            'conferidas' => $conferidas,
            'sem_anexo' => $notas->filter(fn ($n) => ! $n->foto_path)->count(),
            'sem_valor' => $notas->filter(fn ($n) => (float) $n->valor <= 0)->count(),
            'duplicatas' => $duplicatas,
            'pedidos_abertos' => $pedidos->count(),
            'pedidos_valor' => round((float) $pedidos->sum('valor'), 2),
        ]);
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
