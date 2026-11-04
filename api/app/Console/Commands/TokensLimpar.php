<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * php84 artisan tokens:limpar [--dias=180]
 *
 * Linha do crontab (1x por dia):
 *   40 4 * * * /usr/bin/php84 /home/.../api-petermann/artisan tokens:limpar
 *
 * Cada login cria uma sessão e nenhuma vencia: celular perdido ou trocado ficava com acesso para sempre (04/11/2026).
 * Apaga só a sessão parada há mais de --dias. Não há prazo fixo de propósito: quem trabalha em campo offline por semanas
 * não pode ser derrubado com notas na fila. O efeito colateral é o Rastreio mostrar "sem registro" para quem sumiu há meses.
 */
class TokensLimpar extends Command
{
    protected $signature = 'tokens:limpar {--dias=180 : apaga sessão sem uso há mais que isto}';

    protected $description = 'Apaga as sessões paradas há muito tempo';

    public function handle(): int
    {
        $dias = max(30, (int) $this->option('dias'));
        $corte = now()->subDays($dias);

        $apagadas = DB::table('personal_access_tokens')
            ->where(fn ($q) => $q->where('last_used_at', '<', $corte)
                ->orWhere(fn ($w) => $w->whereNull('last_used_at')->where('created_at', '<', $corte)))
            ->delete();

        $msg = "tokens:limpar: {$apagadas} sessão(ões) parada(s) há mais de {$dias} dias apagada(s)";
        $this->info($msg);
        Log::info($msg);

        return self::SUCCESS;
    }
}
