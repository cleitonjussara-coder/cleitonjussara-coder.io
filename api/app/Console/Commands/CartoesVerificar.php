<?php

namespace App\Console\Commands;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use App\Services\PushService;
use Illuminate\Console\Command;

/**
 * php84 artisan cartoes:verificar
 *
 * Linha sugerida no crontab da Locaweb (1x por dia, de manhã cedo):
 *   20 7 * * * /usr/bin/php84 /home/.../api-petermann/artisan cartoes:verificar
 *
 * Avisa quem gerencia quando o cartão pré-pago de alguém está acabando. A
 * conta é a mesma que o app mostra: recargas confirmadas menos o que foi
 * gasto no cartão. Sem saldo, a pessoa passa a pagar do bolso — que é o que
 * o aviso quer evitar (24/09/2026).
 */
class CartoesVerificar extends Command
{
    protected $signature = 'cartoes:verificar {--minimo=300 : abaixo deste valor o gestor é avisado}';

    protected $description = 'Avisa o gestor quando o cartão corporativo de alguém está acabando';

    public function handle(PushService $push): int
    {
        $minimo = (float) $this->option('minimo');
        $baixos = [];

        foreach (Colaborador::where('regime', 'cv')->where('ativo', true)->get() as $c) {
            $recarga = (float) Repasse::where('user_id', $c->id)->where('deleted', false)
                ->where('kind', 'received')->where('destino', 'recarga')
                ->whereNotNull('confirmado_em')->sum('valor');
            $gasto = (float) Nota::where('user_id', $c->id)->where('deleted', false)
                ->where(function ($q) {
                    $q->where('pagamento', '!=', 'reembolso')->orWhereNull('pagamento');
                })->sum('valor');
            $saldo = $recarga - $gasto;

            $this->line(sprintf('  %-28s recarga %10.2f  gasto %10.2f  saldo %10.2f%s',
                mb_substr($c->nome ?: $c->email, 0, 28), $recarga, $gasto, $saldo,
                $saldo < $minimo ? '  <= AVISAR' : ''));

            if ($saldo < $minimo) {
                $baixos[] = [$c, $saldo];
            }
        }

        foreach ($baixos as [$c, $saldo]) {
            $push->avisarGestores(
                'Cartão de '.($c->nome ?: $c->email).' acabando',
                'Saldo de R$ '.number_format($saldo, 2, ',', '.').' — faça a recarga antes que ele passe a pagar do bolso.',
                '/',
                'cartao-'.$c->id,
            );
        }

        $this->info(count($baixos).' cartão(ões) abaixo de R$ '.number_format($minimo, 2, ',', '.'));

        return self::SUCCESS;
    }
}
