<?php

namespace App\Providers;

use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        /* 04/11/2026: login limitado por conta, não só por IP. A equipe costuma sair pelo mesmo IP (escritório, 4G), então
           o erro de um não pode travar os outros; e 20 tentativas por minuto numa conta só era folga demais. */
        RateLimiter::for('login', function (Request $r) {
            /* roda antes da validação: e-mail pode chegar como lista, e isso tem que dar 422 lá na frente, não 500 aqui */
            $email = $r->input('email');
            $conta = mb_strtolower(trim(is_string($email) ? $email : ''));
            $espere = fn () => response()->json(['message' => 'Muitas tentativas de entrar. Aguarde 1 minuto e tente de novo.'], 429);

            return [
                Limit::perMinute(8)->by('conta:'.$conta.'|'.$r->ip())->response($espere),
                Limit::perMinute(20)->by('ip:'.$r->ip())->response($espere),
            ];
        });
    }
}
