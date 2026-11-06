<?php

namespace App\Http\Controllers;

use App\Models\RelatorioPedido;
use App\Services\PlanilhasEquipe;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * Planilhas da equipe pela fila (06/11/2026). O app pede, acompanha e baixa; quem gera é relatorios:processar.
 * O pedido é de quem pediu: para qualquer outra pessoa ele não existe (404).
 */
class RelatorioPedidoController extends Controller
{
    /** POST /relatorio/cv-equipe/pedido {ano, ids[], modo} */
    public function pedir(Request $r, PlanilhasEquipe $planilhas): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->veTudo(), 403, 'Só gestor ou admin gera as planilhas da equipe');
        abort_unless(RelatorioPedido::tabelaExiste(), 503, 'A fila de planilhas ainda não está ativa no servidor.');
        $d = $r->validate([
            'ano' => ['required', 'integer', 'min:2020', 'max:2100'],
            'ids' => ['nullable', 'array', 'max:200'],
            'ids.*' => ['string', 'size:36'],
            'modo' => ['nullable', 'in:unico,zip'],
        ]);
        $parametros = ['ano' => (int) $d['ano'], 'ids' => array_values($d['ids'] ?? []), 'modo' => $d['modo'] ?? 'unico'];
        sort($parametros['ids']);

        $qtd = $planilhas->colaboradores($parametros['ano'], $parametros['ids'])->count();
        abort_if($qtd === 0, 404, 'Ninguém com lançamento nesse ano');

        /* dois toques no botão não geram o mesmo arquivo duas vezes */
        $igual = RelatorioPedido::where('user_id', $u->id)->whereIn('estado', ['fila', 'gerando'])->get()
            ->first(fn ($p) => $p->parametros === $parametros);
        $pedido = $igual ?? RelatorioPedido::create([
            'id' => (string) Str::uuid(), 'user_id' => $u->id, 'tipo' => 'cv-equipe',
            'parametros' => $parametros, 'estado' => 'fila', 'nome' => $planilhas->nome($parametros['modo'], $parametros['ano']),
        ]);

        return response()->json($this->json($pedido) + ['pessoas' => $qtd], 202);
    }

    /** GET /relatorio/pedidos/{id} */
    public function ver(Request $r, string $id): JsonResponse
    {
        return response()->json($this->json($this->meu($r, $id)));
    }

    /** GET /relatorio/pedidos/{id}/arquivo */
    public function arquivo(Request $r, string $id): BinaryFileResponse
    {
        $p = $this->meu($r, $id);
        abort_unless($p->estado === 'pronto' && $p->arquivo && is_file($p->arquivo), 404, 'Arquivo não encontrado. Peça de novo.');

        return response()->download($p->arquivo, $p->nome);
    }

    private function meu(Request $r, string $id): RelatorioPedido
    {
        abort_unless(RelatorioPedido::tabelaExiste(), 404);

        return RelatorioPedido::where('id', $id)->where('user_id', $r->user()->id)->firstOrFail();
    }

    private function json(RelatorioPedido $p): array
    {
        return ['id' => $p->id, 'estado' => $p->estado, 'nome' => $p->nome, 'erro' => $p->erro, 'criado_em' => $p->created_at?->toIso8601String()];
    }
}
