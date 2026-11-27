<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\Conferencia;
use App\Models\Nota;
use App\Models\Repasse;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * "✓ Conferido" (18/11/2026, Lote 3 da revisão do gestor, pedido do Cleiton).
 *
 *   GET /conferencias?dono_id=X        → as marcas das notas e repasses de uma pessoa (a ficha da Equipe);
 *   GET /conferencias?since=ISO         → o que foi marcado/desmarcado desde então (o Histórico);
 *   PUT /conferencias {tipo, registro_id, conferido} → marca ou desmarca.
 *   GET /conferencias/faltam            → notas a conferir por pessoa e mês, deste mês e do anterior (fila de decisões, 27/11/2026);
 *   PUT /conferencias/lote {registro_ids[]} → marca de uma vez as notas sem pendência (27/11/2026, fase 3 item 2).
 *
 * Só gestor e admin (o contador é SomenteLeitura e o colaborador não confere a própria nota). Conferir não toca a nota
 * nem o repasse: a marca vive na tabela conferencias.
 */
class ConferenciaController extends Controller
{
    public function index(Request $r): JsonResponse
    {
        abort_unless($r->user()->gerencia(), 403, 'Só gestor ou administrador vê as conferências');
        if (! Conferencia::tabelaExiste()) {
            return response()->json([]);   // API publicada antes da migração: a ficha segue sem a marca
        }
        $dono = trim((string) $r->query('dono_id', ''));
        $since = trim((string) $r->query('since', ''));
        abort_unless($dono !== '' || $since !== '', 422, 'Informe dono_id ou since');

        $q = Conferencia::query();
        if ($dono !== '') {
            $q->where('dono_id', $dono);
        }
        if ($since !== '') {
            try {
                $q->where('updated_at', '>=', \Illuminate\Support\Carbon::parse($since)->utc());
            } catch (\Throwable) {
                abort(422, 'Data inválida em since');
            }
        }
        $linhas = $q->orderByDesc('updated_at')->limit(2000)->get();

        return response()->json($linhas->map->paraApp($this->nomes($linhas))->values());
    }

    public function salvar(Request $r): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só gestor ou administrador marca o conferido');
        abort_unless(Conferencia::tabelaExiste(), 409, 'O servidor ainda não tem a estrutura do conferido. Peça ao admin para atualizar o banco.');
        $d = $r->validate([
            'tipo' => ['required', 'in:nota,repasse'],
            'registro_id' => ['required', 'string', 'max:64'],
            'conferido' => ['required', 'boolean'],
        ]);

        $registro = $d['tipo'] === 'nota' ? Nota::find($d['registro_id']) : Repasse::find($d['registro_id']);
        abort_unless($registro, 404, $d['tipo'] === 'nota' ? 'Nota não encontrada' : 'Repasse não encontrado');

        $c = Conferencia::firstOrNew(['tipo' => $d['tipo'], 'registro_id' => $d['registro_id']]);
        $c->dono_id = $registro->user_id;
        if ($d['conferido']) {
            $c->forceFill(['conferido_por' => $u->id, 'conferido_em' => now(), 'desmarcado_por' => null, 'desmarcado_em' => null]);
        } elseif ($c->exists && $c->conferida()) {
            $c->forceFill(['desmarcado_por' => $u->id, 'desmarcado_em' => now()]);
        } else {
            return response()->json(['tipo' => $d['tipo'], 'registro_id' => $d['registro_id'], 'conferido' => false]);   // nada a desmarcar
        }
        $c->save();

        return response()->json($c->paraApp($this->nomes(collect([$c]))));
    }

    /**
     * Fila de decisões (27/11/2026, verificação de 26/11, fase 3 item 1): quantas notas faltam conferir, por pessoa e mês,
     * no mês atual e no anterior (horário de Brasília). Sem o Faturamento sem colaborador (não tem ficha para abrir).
     * sem_pendencia = as que o "Conferir em lote" pegaria pela regra do servidor (com anexo e com valor).
     */
    public function faltam(Request $r): JsonResponse
    {
        abort_unless($r->user()->gerencia(), 403, 'Só gestor ou administrador vê as conferências');
        if (! Conferencia::tabelaExiste()) {
            return response()->json([]);
        }
        $hoje = now('America/Sao_Paulo');
        $ini = $hoje->copy()->startOfMonth()->subMonthNoOverflow();
        $notas = Nota::where('deleted', false)->whereNotNull('user_id')
            ->where(fn ($q) => $q->where(fn ($q) => $q->where('ano', $ini->year)->where('mes', $ini->month))
                ->orWhere(fn ($q) => $q->where('ano', $hoje->year)->where('mes', $hoje->month)))
            ->get(['id', 'user_id', 'ano', 'mes', 'valor', 'foto_path', 'created_at']);
        $ok = Conferencia::where('tipo', 'nota')->whereIn('registro_id', $notas->pluck('id'))->get()
            ->filter->conferida()->pluck('registro_id')->flip();
        $nomes = Colaborador::whereIn('id', $notas->pluck('user_id')->unique())->pluck('nome', 'id');
        $grupos = $notas->reject(fn ($n) => $ok->has($n->id))->groupBy(fn ($n) => $n->user_id.'|'.$n->ano.'|'.$n->mes);

        return response()->json($grupos->map(function ($g) use ($nomes) {
            $n = $g->first();

            return [
                'dono_id' => $n->user_id, 'nome' => $nomes[$n->user_id] ?? null, 'ano' => (int) $n->ano, 'mes' => (int) $n->mes,
                'notas' => $g->count(), 'valor' => round((float) $g->sum('valor'), 2),
                'sem_pendencia' => $g->filter(fn ($x) => $x->foto_path && (float) $x->valor > 0)->count(),
                'mais_antiga' => $g->map(fn ($x) => $x->created_at)->filter()->min()?->toIso8601String(),
            ];
        })->sortBy('mais_antiga')->values());
    }

    /**
     * Conferir em lote (27/11/2026, verificação de 26/11, fase 3 item 2): só notas, só marcar (desmarcar segue uma a uma).
     * O app manda as que vê sem pendência; aqui a regra é conferida de novo: nota apagada, sem anexo ou sem valor não é
     * marcada e volta em `pulados`. Nota já conferida fica como está (não troca quem conferiu nem a hora).
     */
    public function lote(Request $r): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só gestor ou administrador marca o conferido');
        abort_unless(Conferencia::tabelaExiste(), 409, 'O servidor ainda não tem a estrutura do conferido. Peça ao admin para atualizar o banco.');
        $d = $r->validate([
            'registro_ids' => ['required', 'array', 'min:1', 'max:500'],
            'registro_ids.*' => ['required', 'string', 'max:64'],
        ]);
        $ids = array_values(array_unique($d['registro_ids']));

        $notas = Nota::whereIn('id', $ids)->get()->keyBy('id');
        $ja = Conferencia::where('tipo', 'nota')->whereIn('registro_id', $ids)->get()->keyBy('registro_id');
        $marcadas = collect();
        $pulados = [];
        \Illuminate\Support\Facades\DB::transaction(function () use ($ids, $notas, $ja, $u, &$marcadas, &$pulados) {
            foreach ($ids as $id) {
                $n = $notas->get($id);
                if (! $n || $n->deleted || ! $n->foto_path || (float) $n->valor <= 0) {
                    $pulados[] = $id;
                    continue;
                }
                $c = $ja->get($id) ?? new Conferencia(['tipo' => 'nota', 'registro_id' => $id]);
                if ($c->exists && $c->conferida()) {
                    $marcadas->push($c);
                    continue;
                }
                $c->dono_id = $n->user_id;
                $c->forceFill(['conferido_por' => $u->id, 'conferido_em' => now(), 'desmarcado_por' => null, 'desmarcado_em' => null]);
                $c->save();
                $marcadas->push($c);
            }
        });
        $nomes = $this->nomes($marcadas);

        return response()->json(['conferidas' => $marcadas->map(fn ($c) => $c->paraApp($nomes))->values(), 'pulados' => $pulados]);
    }

    private function nomes($linhas): array
    {
        $ids = $linhas->flatMap(fn ($c) => [$c->conferido_por, $c->desmarcado_por])->filter()->unique()->values();

        return $ids->isEmpty() ? [] : Colaborador::whereIn('id', $ids)->pluck('nome', 'id')->all();
    }
}
