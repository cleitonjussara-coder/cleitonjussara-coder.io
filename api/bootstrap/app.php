<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

/* 20/11/2026: na Locaweb o PCRE JIT não consegue reservar memória executável. O primeiro preg_match de um pedido pesado
   (temCnpj() no PDF de Faturamento de 10/2026) soltava "preg_match(): Allocation of JIT memory failed", que o Laravel
   transforma em erro 500. Sem JIT as expressões dão o mesmo resultado. Vale para web e artisan; também em public/.user.ini. */
@ini_set('pcre.jit', '0');

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

        $middleware->append(\App\Http\Middleware\CabecalhosSeguranca::class);

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
