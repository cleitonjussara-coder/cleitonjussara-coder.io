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

    private function nomes($linhas): array
    {
        $ids = $linhas->flatMap(fn ($c) => [$c->conferido_por, $c->desmarcado_por])->filter()->unique()->values();

        return $ids->isEmpty() ? [] : Colaborador::whereIn('id', $ids)->pluck('nome', 'id')->all();
    }
}
