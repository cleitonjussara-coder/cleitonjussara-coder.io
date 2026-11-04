<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Cabeçalhos de segurança em toda resposta da API (04/11/2026). A API não tinha nenhum: o navegador podia adivinhar o tipo
 * de um anexo e tratá-lo como página. HSTS só em HTTPS, para não atrapalhar o servidor local.
 */
class CabecalhosSeguranca
{
    public function handle(Request $request, Closure $next): Response
    {
        $resposta = $next($request);

        $resposta->headers->set('X-Content-Type-Options', 'nosniff');
        $resposta->headers->set('Referrer-Policy', 'no-referrer');
        if ($request->isSecure()) {
            $resposta->headers->set('Strict-Transport-Security', 'max-age=31536000');
        }

        return $resposta;
    }
}
