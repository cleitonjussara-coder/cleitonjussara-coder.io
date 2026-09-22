<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\Convite;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

/**
 * Convite por link (reunião de 21/09/2026).
 *   POST /convites {role, nome?}   gestor/admin → {url, expira_em}
 *   GET  /convites/{token}         público → {valido, role, nome, gestor}
 *   GET  /convites                 gestor/admin → últimos convites (quem usou, quem não)
 * O aceite é no POST /auth/register com `convite` = token.
 */
class ConviteController extends Controller
{
    /** papéis que podem ser convidados por link — colaborador comum se cadastra sozinho */
    public const ROLES_CONVIDAVEIS = ['contabilidade', 'gestor', 'colaborador'];

    public function criar(Request $r): JsonResponse
    {
        $u = $r->user();
        abort_unless($u->gerencia(), 403, 'Só gestor ou admin convida');
        $d = $r->validate([
            'role' => ['required', Rule::in(self::ROLES_CONVIDAVEIS)],
            'nome' => ['nullable', 'string', 'max:120'],
        ]);
        /* 22/09/2026: o gestor também convida gestor (e edita papéis na Equipe).
           Admin não está em ROLES_CONVIDAVEIS — administrador só é promovido por
           outro administrador, na tela da Equipe. */

        $c = Convite::create([
            'id' => (string) Str::uuid(),
            'token' => Str::random(40),
            'role' => $d['role'],
            'nome' => trim($d['nome'] ?? '') ?: null,
            'criado_por' => $u->id,
            'expira_em' => now()->addDays(7),
        ]);

        return response()->json([
            'url' => config('petermann.front_url').'/?convite='.$c->token,
            'role' => $c->role,
            'expira_em' => $c->expira_em,
        ], 201);
    }

    public function ver(string $token): JsonResponse
    {
        $c = Convite::where('token', $token)->with('criador:id,nome')->first();
        if (! $c) {
            return response()->json(['valido' => false, 'motivo' => 'Convite não encontrado']);
        }
        if (! $c->valido()) {
            return response()->json(['valido' => false, 'motivo' => $c->usado_em ? 'Este convite já foi usado' : 'Este convite venceu — peça outro ao gestor']);
        }

        return response()->json([
            'valido' => true,
            'role' => $c->role,
            'nome' => $c->nome,
            'gestor' => $c->criador?->nome,
            'expira_em' => $c->expira_em,
        ]);
    }

    public function lista(Request $r): JsonResponse
    {
        abort_unless($r->user()->gerencia(), 403);
        $itens = Convite::query()->with('criador:id,nome')->orderByDesc('created_at')->limit(30)->get()
            ->map(fn (Convite $c) => [
                'id' => $c->id, 'role' => $c->role, 'nome' => $c->nome,
                'criado_por' => $c->criador?->nome, 'created_at' => $c->created_at,
                'expira_em' => $c->expira_em, 'usado_em' => $c->usado_em,
                'usado_por' => $c->usado_por ? Colaborador::find($c->usado_por)?->nome : null,
                'valido' => $c->valido(),
                'url' => $c->valido() ? config('petermann.front_url').'/?convite='.$c->token : null,
            ]);

        return response()->json($itens);
    }

    /** Usado pelo AuthController@register: devolve o convite válido ou aborta. */
    public static function consumir(string $token, Colaborador $novo): Convite
    {
        $c = Convite::where('token', $token)->first();
        abort_unless($c && $c->valido(), 422, 'Convite inválido, usado ou vencido');
        $c->forceFill(['usado_por' => $novo->id, 'usado_em' => now()])->save();

        return $c;
    }
}
