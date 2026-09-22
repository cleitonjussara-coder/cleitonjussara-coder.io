<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Entrada pendente (22/09/2026): quem se cadastrou e ainda não foi confirmado
 * por gestor/admin tem token válido, mas não usa o sistema.
 *
 * Passa só o que a tela de espera precisa: ver o próprio perfil, corrigir o
 * nome, mandar a foto e sair. Todo o resto responde 403 com `pendente: true`,
 * que o app usa para abrir a tela "aguardando liberação".
 */
class ExigeConfirmacao
{
    /** Rotas liberadas para quem ainda não foi confirmado (nomes de path, sem /api). */
    private const LIVRES = ['me', 'me/foto', 'auth/logout', 'ping'];

    public function handle(Request $request, Closure $next): Response
    {
        $u = $request->user();
        if (! $u || $u->confirmado()) {
            return $next($request);
        }

        $caminho = ltrim(str_replace('api/', '', $request->path()), '/');
        if (in_array($caminho, self::LIVRES, true)) {
            return $next($request);
        }

        return response()->json([
            'message' => 'Seu cadastro está aguardando a liberação do gestor.',
            'pendente' => true,
        ], 403);
    }
}
