<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\Justificativa;
use App\Services\JustificativaAviso;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

/**
 * Pedido de justificativa (19/10/2026, pedido do Paulo, gestor).
 *
 *   gestor/admin  → pede (POST /justificativas), cancela pedido aberto, marca a resposta como vista,
 *                   lista tudo (Histórico);
 *   colaborador   → só enxerga e responde o que é DELE (404 no dos outros);
 *   contador      → nada (o SomenteLeitura já fecha a escrita; aqui a leitura também).
 *
 * Freios (config petermann.justificativa): um pedido aberto por pessoa e um intervalo mínimo
 * (24 h) desde o último pedido dela; pedido cancelado não conta. Só se pede a quem tem papel
 * de colaborador, está ativo e já foi liberado — gestor/admin não justificam a si mesmos.
 */
class JustificativaController extends Controller
{
    public function __construct(private JustificativaAviso $aviso) {}

    /** GET /justificativas?since=&colaborador_id= — tudo, para o Histórico. Só gestor/admin. */
    public function index(Request $r): JsonResponse
    {
        abort_unless($r->user()->gerencia(), 403, 'Só gestor ou administrador vê as justificativas da equipe');
        $q = Justificativa::query()->with(['colaborador:id,nome', 'autor:id,nome'])->orderByDesc('created_at');
        if ($since = $r->query('since')) {
            try {
                $q->where('updated_at', '>=', Carbon::parse($since)->utc()->format('Y-m-d H:i:s'));
            } catch (\Throwable) {
            }
        }
        if ($r->filled('colaborador_id')) {
            $q->where('colaborador_id', $r->query('colaborador_id'));
        }

        return response()->json($q->limit(500)->get()->map->paraApp()->values());
    }

    /**
     * GET /justificativas/sino — o que cabe no sino de QUEM pergunta:
     *   colaborador  → os pedidos abertos para ele;
     *   gestor/admin → as respostas dos pedidos que ELE fez e ainda não marcou como vistas.
     */
    public function sino(Request $r): JsonResponse
    {
        $u = $r->user();
        abort_if($u->soLeitura(), 403, 'Contabilidade não usa as justificativas');
        $q = Justificativa::query()->with(['colaborador:id,nome', 'autor:id,nome'])->whereNull('cancelada_em');
        if ($u->gerencia()) {
            $q->where('pedido_por', $u->id)->whereNotNull('resposta')->whereNull('visto_em');
        } else {
            $q->where('colaborador_id', $u->id)->whereNull('resposta');
        }

        return response()->json($q->orderBy('created_at')->limit(50)->get()->map->paraApp()->values());
    }

    /** POST /justificativas — {colaborador_id, motivo, mensagem?}. Só gestor/admin. */
    public function store(Request $r): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só gestor ou administrador pede justificativa');
        $d = $r->validate([
            'colaborador_id' => ['required', 'string'],
            'motivo' => ['required', 'string', 'min:3', 'max:200'],
            'mensagem' => ['nullable', 'string', 'max:1000'],
        ], [
            'motivo.required' => 'Diga o motivo do pedido.',
            'motivo.min' => 'O motivo precisa de pelo menos 3 letras.',
            'motivo.max' => 'O motivo passou de 200 letras — resuma e use a mensagem para o resto.',
            'mensagem.max' => 'A mensagem passou de 1000 letras.',
        ]);

        $alvo = Colaborador::find($d['colaborador_id']);
        abort_unless($alvo, 404, 'Colaborador não encontrado');
        abort_if($alvo->id === $u->id, 422, 'Você não pode pedir justificativa a si mesmo');
        abort_unless($alvo->role === 'colaborador', 422, 'Justificativa só é pedida a colaborador (não a gestor, administrador ou contador)');
        abort_unless($alvo->ativo, 422, "{$alvo->nome} está desativado");
        abort_unless($alvo->confirmado(), 422, "{$alvo->nome} ainda não foi liberado para usar o app");

        /* freio 1: um pedido aberto por vez */
        $aberto = Justificativa::where('colaborador_id', $alvo->id)->whereNull('cancelada_em')->whereNull('resposta')->latest('created_at')->first();
        if ($aberto) {
            abort(422, "Já existe um pedido para {$alvo->nome} aguardando resposta (desde ".$this->quando($aberto->created_at).'). Espere a resposta ou cancele aquele pedido.');
        }

        /* freio 2: intervalo mínimo desde o último pedido (cancelado não conta) */
        $horas = max(0, (int) config('petermann.justificativa.intervalo_horas', 24));
        $ultimo = Justificativa::where('colaborador_id', $alvo->id)->whereNull('cancelada_em')->latest('created_at')->first();
        if ($horas > 0 && $ultimo && $ultimo->created_at->copy()->addHours($horas)->isFuture()) {
            $libera = $ultimo->created_at->copy()->addHours($horas);
            abort(422, "Já foi pedida justificativa a {$alvo->nome} em ".$this->quando($ultimo->created_at)." — para não incomodar, um novo pedido só sai depois de {$horas} h (a partir de ".$this->quando($libera).').');
        }

        $j = Justificativa::create([
            'colaborador_id' => $alvo->id,
            'pedido_por' => $u->id,
            'motivo' => trim($d['motivo']),
            'mensagem' => isset($d['mensagem']) ? (trim($d['mensagem']) ?: null) : null,
        ]);
        $this->aviso->pedido($j);

        return response()->json($j->fresh(['colaborador', 'autor'])->paraApp(), 201);
    }

    /** POST /justificativas/{id}/responder — {resposta}. Só o colaborador a quem foi pedido. */
    public function responder(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        $j = Justificativa::where('colaborador_id', $u->id)->find($id);
        abort_unless($j, 404, 'Pedido não encontrado');   // de outra pessoa = não existe (nada de 403 que confirme o id)
        $d = $r->validate([
            'resposta' => ['required', 'string', 'min:3', 'max:2000'],
        ], [
            'resposta.required' => 'Escreva a justificativa.',
            'resposta.min' => 'Escreva um pouco mais — pelo menos 3 letras.',
            'resposta.max' => 'A justificativa passou de 2000 letras.',
        ]);
        abort_if($j->cancelada_em, 422, 'Este pedido foi cancelado pelo gestor — não precisa mais responder.');
        abort_if($j->resposta !== null, 422, 'Este pedido já foi respondido.');

        $j->forceFill(['resposta' => trim($d['resposta']), 'respondido_em' => now()])->save();
        $this->aviso->resposta($j);

        return response()->json($j->fresh(['colaborador', 'autor'])->paraApp());
    }

    /** PATCH /justificativas/{id}/visto — o gestor deu "OK, vi" na resposta. Só gestor/admin. */
    public function visto(Request $r, string $id): JsonResponse
    {
        abort_unless($r->user()->gerencia(), 403, 'Só gestor ou administrador');
        $j = Justificativa::findOrFail($id);
        if ($j->resposta !== null && ! $j->visto_em) {
            $j->forceFill(['visto_em' => now()])->save();
        }

        return response()->json($j->fresh(['colaborador', 'autor'])->paraApp());
    }

    /** DELETE /justificativas/{id} — cancela um pedido ainda sem resposta. Só gestor/admin. */
    public function cancelar(Request $r, string $id): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só gestor ou administrador');
        $j = Justificativa::findOrFail($id);
        abort_if($j->resposta !== null, 422, 'Este pedido já foi respondido — não dá para cancelar.');
        if (! $j->cancelada_em) {
            $j->forceFill(['cancelada_em' => now(), 'cancelada_por' => $u->id])->save();
        }

        return response()->json($j->fresh(['colaborador', 'autor'])->paraApp());
    }

    /** "19/10 às 14:30" no horário de Brasília (o servidor roda em UTC). */
    private function quando(Carbon $t): string
    {
        $br = $t->copy()->setTimezone('America/Sao_Paulo');

        return $br->format('d/m').' às '.$br->format('H:i');
    }
}
