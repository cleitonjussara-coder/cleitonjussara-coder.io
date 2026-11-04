<?php

namespace App\Console\Commands;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use App\Services\PontoCalculo;
use App\Services\PushService;
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
 * 04/11/2026: a conta é a do ANO corrente em Brasília, recargas confirmadas
 * menos gasto no cartão, igual à planilha CV (RelatorioCv), à ficha da Equipe
 * e ao cartao_saldo de Arquivos. Antes somava todos os anos.
 */
class CartoesVerificar extends Command
{
    protected $signature = 'cartoes:verificar {--minimo=300 : abaixo deste valor o gestor é avisado}';

    protected $description = 'Avisa o gestor quando o cartão corporativo de alguém está acabando';

    public function handle(PushService $push): int
    {
        $minimo = (float) $this->option('minimo');
        $baixos = [];
        $ano = now(PontoCalculo::TZ)->year;   // servidor fica em UTC: em 31/12 à noite já seria o ano seguinte

        foreach (Colaborador::where('regime', 'cv')->where('ativo', true)->get() as $c) {
            $recarga = (float) Repasse::where('user_id', $c->id)->where('deleted', false)->where('ano', $ano)
                ->where(fn ($q) => $q->whereNull('kind')->orWhere('kind', 'received'))->where('destino', 'recarga')
                ->whereNotNull('confirmado_em')->sum('valor');
            /* 25/09/2026: só NÃO conta como gasto do cartão quem saiu da carteira
               (era 'reembolso') ou é Faturamento (pagamento='empresa') — mesma
               exclusão negativa usada em todo o resto do sistema, pra um valor de
               pagamento novo no futuro não ficar de fora do gasto por engano aqui. */
            $gasto = (float) Nota::where('user_id', $c->id)->where('deleted', false)->where('ano', $ano)
                ->where(function ($q) {
                    $q->whereNotIn('pagamento', ['carteira', 'empresa'])->orWhereNull('pagamento');
                })->sum('valor');
            $saldo = round($recarga - $gasto, 2);

            /* Sem nenhuma recarga registrada não se sabe o saldo do cartão —
               a conta daria zero e o gestor receberia um alarme falso por
               colaborador. Enquanto ninguém registrar a primeira recarga,
               este fica de fora (24/09/2026). 04/11/2026: a primeira do ano. */
            if ($recarga <= 0) {
                $this->line(sprintf('  %-28s sem recarga registrada — ignorado', mb_substr($c->nome ?: $c->email, 0, 28)));
                continue;
            }

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
