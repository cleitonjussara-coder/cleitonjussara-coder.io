<?php

namespace App\Console\Commands;

use App\Models\Colaborador;
use App\Services\PontoCalculo;
use App\Services\PushService;
use App\Services\SaldoAnterior;
use Illuminate\Console\Command;

/**
 * php84 artisan cartoes:verificar
 *
 * Linha sugerida no crontab da Locaweb (1x por dia, de manhã cedo):
 *   20 7 * * * /usr/bin/php84 /home/.../api-petermann/artisan cartoes:verificar
 *
 * Avisa quem gerencia quando o cartão pré-pago de alguém está acabando. Sem
 * saldo, a pessoa passa a pagar do bolso — que é o que o aviso quer evitar
 * (24/09/2026).
 *
 * 04/11/2026: saldo do ano anterior + recargas confirmadas do ano corrente em
 * Brasília − gasto no cartão do ano, igual à planilha CV (RelatorioCv), à ficha
 * da Equipe e ao cartao_saldo de Arquivos. O anterior vem de SaldoAnterior: o
 * dono pediu que o saldo acumule de um ano para o outro (substitui a regra da
 * manhã do mesmo dia, que olhava só o ano).
 */
class CartoesVerificar extends Command
{
    protected $signature = 'cartoes:verificar {--minimo=300 : abaixo deste valor o gestor é avisado}';

    protected $description = 'Avisa o gestor quando o cartão corporativo de alguém está acabando';

    public function handle(PushService $push, SaldoAnterior $saldos): int
    {
        $minimo = (float) $this->option('minimo');
        $baixos = [];
        $ano = now(PontoCalculo::TZ)->year;   // servidor fica em UTC: em 31/12 à noite já seria o ano seguinte
        $colabs = Colaborador::where('regime', 'cv')->where('ativo', true)->get();
        $anteriores = $saldos->deTodos($ano, $colabs->pluck('id'));
        $acumulados = $saldos->deTodos($ano + 1, $colabs->pluck('id'));   // tudo até dezembro do ano corrente

        foreach ($colabs as $c) {
            $antes = $anteriores[$c->id] ?? SaldoAnterior::zerado();
            $ate = $acumulados[$c->id] ?? SaldoAnterior::zerado();
            $saldo = $ate['cartao'];

            /* Sem nenhuma recarga registrada não se sabe o saldo do cartão —
               a conta daria zero e o gestor receberia um alarme falso por
               colaborador. Enquanto ninguém registrar a primeira recarga,
               este fica de fora (24/09/2026). 04/11/2026: de qualquer ano,
               porque a de ano passado agora faz parte do saldo. */
            if ($ate['recarga'] <= 0) {
                $this->line(sprintf('  %-28s sem recarga registrada — ignorado', mb_substr($c->nome ?: $c->email, 0, 28)));
                continue;
            }

            $this->line(sprintf('  %-28s anterior %10.2f  recarga %10.2f  gasto %10.2f  saldo %10.2f%s',
                mb_substr($c->nome ?: $c->email, 0, 28), $antes['cartao'], $ate['recarga'] - $antes['recarga'],
                $ate['cartao_gasto'] - $antes['cartao_gasto'], $saldo, $saldo < $minimo ? '  <= AVISAR' : ''));

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
