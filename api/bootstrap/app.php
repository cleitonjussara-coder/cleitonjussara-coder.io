<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        /* API sem sessão/cookie: só Bearer. O CORS libera o app (outro
           subdomínio) — origens em config/cors.php. */
        // (statefulApi NÃO é chamado de propósito: nada de cookie/CSRF)

        /* Sem token e sem "Accept: application/json" (robô, navegador na mão),
           o Authenticate tentava redirecionar para route('login'), que não
           existe → 500 + e-mail de erro à toa. Aqui não há tela de login:
           é sempre 401 (21/09/2026). */
        $middleware->redirectGuestsTo(fn (Request $r) => abort(401, 'Unauthenticated.'));
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
        /* Aviso por e-mail (20/09/2026). Só chega aqui o que é "reportável":
           404/403/422/401/throttle o Laravel já não reporta. Nunca lança. */
        $exceptions->report(function (Throwable $e): void {
            try {
                app(\App\Services\AlertaErro::class)->excecao($e);
            } catch (Throwable) {
            }
        });
    })->create();
