<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\Justificativa;
use App\Models\Nota;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Rastreio da equipe (11/10/2026) — só gestor/admin.
 * Para cada pessoa ativa (menos o Contador, que só consulta): quando ela usou o app por
 * último, quando lançou a última nota, quantas lançou hoje / na semana / no mês e as
 * últimas notas mexidas (lançou, editou, apagou). Complementa o Histórico, que é a lista
 * cronológica de tudo; aqui a visão é POR colaborador, para ver quem está parado.
 *
 * "Visto no app" = último uso de qualquer token de login da pessoa (o Sanctum grava
 * last_used_at a cada requisição autenticada). Sem coluna nova, sem migração.
 */
class RastreioController extends Controller
{
    private const TZ = 'America/Sao_Paulo';

    /** Janela de notas olhadas (dias). Quem não mexeu em nota nesse período aparece "sem notas". */
    private const JANELA_DIAS = 60;

    public function atividade(Request $r): JsonResponse
    {
        abort_unless($r->user()->gerencia(), 403, 'Só gestor ou administrador vê o rastreio da equipe');

        $agora = Carbon::now(self::TZ);
        $hojeIni = $agora->copy()->startOfDay()->utc();
        $semanaIni = $agora->copy()->subDays(6)->startOfDay()->utc();
        $mesIni = $agora->copy()->startOfMonth()->utc();
        $desde = $agora->copy()->subDays(self::JANELA_DIAS)->utc();

        $pessoas = Colaborador::query()->where('ativo', true)->where('role', '!=', 'contabilidade')
            ->orderBy('nome')->get(['id', 'nome', 'role', 'regime']);

        $visto = DB::table('personal_access_tokens')
            ->where('tokenable_type', (new Colaborador)->getMorphClass())
            ->selectRaw('tokenable_id, max(last_used_at) as visto')
            ->groupBy('tokenable_id')
            ->pluck('visto', 'tokenable_id');

        $porPessoa = Nota::query()->whereNotNull('user_id')->where('updated_at', '>=', $desde)
            ->orderByDesc('updated_at')->limit(5000)
            ->get(['id', 'user_id', 'tipo', 'subtipo', 'razao_social', 'cnpj', 'valor', 'deleted', 'created_at', 'updated_at'])
            ->groupBy('user_id');

        /* Pedido de justificativa (19/10/2026): o último de cada pessoa (o cancelado não vale —
           é como se não tivesse sido feito) e quando o freio de frequência libera um novo. */
        $ultimaJust = collect();
        if (Justificativa::tabelaExiste()) {
            $ultimaJust = Justificativa::query()->with(['colaborador:id,nome', 'autor:id,nome'])
                ->whereIn('colaborador_id', $pessoas->pluck('id'))->whereNull('cancelada_em')
                ->orderByDesc('created_at')->get()->groupBy('colaborador_id')->map->first();
        }
        $intervaloJust = max(0, (int) config('petermann.justificativa.intervalo_horas', 24));

        $equipe = $pessoas->map(function (Colaborador $p) use ($visto, $porPessoa, $hojeIni, $semanaIni, $mesIni, $ultimaJust, $intervaloJust) {
            $todas = $porPessoa->get($p->id, collect());
            $vivas = $todas->where('deleted', false);
            $lancadas = fn (Carbon $ini) => $vivas->filter(fn ($n) => $n->created_at >= $ini);
            $doMes = $lancadas($mesIni);
            $ultimoLancamento = $vivas->max('created_at');
            $just = $ultimaJust->get($p->id);
            $liberaEm = $just && $intervaloJust > 0 ? $just->created_at->copy()->addHours($intervaloJust) : null;

            return [
                'id' => $p->id,
                'nome' => $p->nome,
                'role' => $p->role,
                'regime' => $p->regime,
                'visto_em' => ($v = $visto->get($p->id)) ? Carbon::parse($v, 'UTC')->toIso8601String() : null,
                'ultimo_lancamento_em' => $ultimoLancamento?->toIso8601String(),
                'ultima_atividade_em' => $todas->first()?->updated_at?->toIso8601String(),
                'hoje' => $lancadas($hojeIni)->count(),
                'semana' => $lancadas($semanaIni)->count(),
                'mes' => $doMes->count(),
                'mes_valor' => round((float) $doMes->sum('valor'), 2),
                'justificativa' => $just?->paraApp(),
                'justificativa_libera_em' => $liberaEm && $liberaEm->isFuture() ? $liberaEm->toIso8601String() : null,
                'recentes' => $todas->take(5)->map(fn ($n) => [
                    'id' => $n->id,
                    'acao' => $n->deleted ? 'apagou' : ($n->created_at && $n->updated_at && abs($n->updated_at->diffInSeconds($n->created_at)) < 3 ? 'lançou' : 'editou'),
                    'tipo' => $n->tipo,
                    'subtipo' => $n->subtipo,
                    'fornecedor' => $n->razao_social,
                    'cnpj' => $n->cnpj,
                    'valor' => (float) $n->valor,
                    'quando' => $n->updated_at?->toIso8601String(),
                ])->values(),
            ];
        })->values();

        return response()->json(['gerado_em' => now()->toIso8601String(), 'janela_dias' => self::JANELA_DIAS, 'equipe' => $equipe]);
    }
}
