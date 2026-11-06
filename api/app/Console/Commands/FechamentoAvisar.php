<?php

namespace App\Console\Commands;

use App\Services\FechamentoMes;
use Illuminate\Console\Command;

/**
 * php84 artisan fechamento:avisar
 *
 * Linha do crontab (a cada 10 minutos):
 *   7,17,27,37,47,57 * * * * /usr/bin/php84 /home/.../api-petermann/artisan fechamento:avisar
 *
 * 06/11/2026: a nota de mês fechado que chega dentro da janela de aviso não toca o celular, para a fila que descarrega 30 notas
 * não virar 30 pushes. Sem isto ela só avisava se OUTRA nota chegasse depois da janela, e a última de um lote ficava sem aviso.
 * Quem decide a janela e o texto é FechamentoMes::avisarPendentes; aqui é só o relógio. Sem nada pendente, não faz nada.
 */
class FechamentoAvisar extends Command
{
    protected $signature = 'fechamento:avisar';

    protected $description = 'Avisa a gestão das notas fora do fechamento que ficaram sem aviso';

    public function handle(FechamentoMes $fechamento): int
    {
        $this->info('fechamento:avisar: '.$fechamento->avisarPendentes().' nota(s) avisada(s)');

        return self::SUCCESS;
    }
}
