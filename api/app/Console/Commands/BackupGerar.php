<?php

namespace App\Console\Commands;

use App\Services\BackupCompleto;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

/**
 * php84 artisan backup:gerar [--manter=8]
 *
 * É a linha do Agendador de tarefas do painel da Locaweb (1x por semana):
 *   /usr/bin/php84 /home/.../api-petermann/artisan backup:gerar
 * Gera storage/app/backups/petermann-AAAA-MM-DD-HHMM.zip (banco + fotos)
 * e apaga os mais antigos além de --manter. O admin vê e baixa pelo Perfil.
 */
class BackupGerar extends Command
{
    protected $signature = 'backup:gerar {--manter=8 : quantas cópias guardar}';

    protected $description = 'Backup completo (banco + fotos) em storage/app/backups, com rotação';

    public function handle(BackupCompleto $b): int
    {
        $t = microtime(true);
        try {
            $r = $b->gerar();
            $apagados = $b->podar((int) $this->option('manter'));
            $msg = sprintf('backup ok: %s (%.1f MB, %d fotos, %.1fs; %d antigo(s) apagado(s))',
                basename($r['arquivo']), $r['bytes'] / 1048576, $r['fotos'], microtime(true) - $t, $apagados);
            $this->info($msg);
            Log::info($msg);

            return self::SUCCESS;
        } catch (\Throwable $e) {
            $this->error('backup falhou: '.$e->getMessage());
            Log::error('backup falhou: '.$e->getMessage());
            try {
                app(\App\Services\AlertaErro::class)->avisar('Backup semanal FALHOU', 'O crontab backup:gerar falhou: '.$e->getMessage()."\n\nOs backups anteriores continuam em storage/app/backups.", 'backup-falhou');
            } catch (\Throwable) {
            }

            return self::FAILURE;
        }
    }
}
