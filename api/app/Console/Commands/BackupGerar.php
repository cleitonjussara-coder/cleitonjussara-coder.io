<?php

namespace App\Console\Commands;

use App\Services\AlertaErro;
use App\Services\BackupCompleto;
use App\Services\DriveBackup;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

/**
 * php84 artisan backup:gerar [--manter=12] [--meses=12] [--sem-drive]
 *
 * É a linha do Agendador de tarefas do painel da Locaweb (1x por semana):
 *   /usr/bin/php84 /home/.../api-petermann/artisan backup:gerar
 * Gera storage/app/backups/petermann-AAAA-MM-DD-HHMM.zip (banco + fotos),
 * guarda as --manter cópias mais novas + a 1ª de cada mês nos últimos
 * --meses meses (disco é ilimitado, 21/09/2026) e, se o admin conectou o
 * Drive pelo Perfil, sobe a cópia para lá com a mesma rotação.
 * O admin vê e baixa pelo Perfil.
 */
class BackupGerar extends Command
{
    protected $signature = 'backup:gerar {--manter=12 : cópias semanais guardadas} {--meses=12 : meses com uma cópia mensal} {--sem-drive : não enviar ao Drive}';

    protected $description = 'Backup completo (banco + fotos) em storage/app/backups, com rotação e cópia no Google Drive';

    public function handle(BackupCompleto $b, DriveBackup $drive): int
    {
        $t = microtime(true);
        $manter = (int) $this->option('manter');
        $meses = (int) $this->option('meses');
        try {
            $r = $b->gerar();
            $apagados = $b->podar($manter, $meses);
            $msg = sprintf('backup ok: %s (%.1f MB, %d fotos, %.1fs; %d antigo(s) apagado(s))',
                basename($r['arquivo']), $r['bytes'] / 1048576, $r['fotos'], microtime(true) - $t, $apagados);
            $this->info($msg);
            Log::info($msg);
        } catch (\Throwable $e) {
            $this->error('backup falhou: '.$e->getMessage());
            Log::error('backup falhou: '.$e->getMessage());
            try {
                app(AlertaErro::class)->avisar('Backup semanal FALHOU', 'O crontab backup:gerar falhou: '.$e->getMessage()."\n\nOs backups anteriores continuam em storage/app/backups.", 'backup-falhou');
            } catch (\Throwable) {
            }

            return self::FAILURE;
        }

        /* Cópia fora da Locaweb. Falha aqui não é falha do backup: avisa e segue. */
        if ($this->option('sem-drive') || ! $drive->conectado()) {
            $this->line($drive->conectado() ? 'drive: pulado (--sem-drive)' : 'drive: não conectado — Perfil → Backup → Conectar Google Drive');

            return self::SUCCESS;
        }
        $t2 = microtime(true);
        try {
            $d = $drive->enviar($r['arquivo'], $manter, $meses);
            $msg = sprintf('drive ok: %s enviado em %.0fs (%d antigo(s) apagado(s) no Drive)', $d['nome'], microtime(true) - $t2, $d['apagados']);
            $this->info($msg);
            Log::info($msg);
        } catch (\Throwable $e) {
            $this->error('drive falhou: '.$e->getMessage());
            Log::error('drive falhou: '.$e->getMessage());
            try {
                app(AlertaErro::class)->avisar('Backup não subiu para o Google Drive', 'O zip da semana foi gerado e está na Locaweb, mas a cópia no Drive falhou: '
                    .$e->getMessage()."\n\nSe a autorização expirou: Perfil → Backup → Conectar Google Drive de novo.", 'backup-drive-falhou');
            } catch (\Throwable) {
            }
        }

        return self::SUCCESS;
    }
}
