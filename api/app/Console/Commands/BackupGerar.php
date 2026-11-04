<?php

namespace App\Console\Commands;

use App\Services\AlertaErro;
use App\Services\BackupCompleto;
use App\Services\DriveBackup;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Log;

/**
 * php84 artisan backup:gerar [--manter=2] [--meses=0] [--sem-drive]
 *
 * É a linha do Agendador de tarefas do painel da Locaweb (1x por semana):
 *   /usr/bin/php84 /home/.../api-petermann/artisan backup:gerar
 * Gera storage/app/backups/petermann-AAAA-MM-DD-HHMM.zip (banco + fotos) e
 * guarda no SERVIDOR só as --manter cópias mais novas (2, pedido do Cleiton
 * em 22/09/2026 para ocupar menos espaço; --meses=0 = sem cópia mensal).
 * No GOOGLE DRIVE a rotação é mais folgada (--drive-manter/--drive-meses):
 * lá o espaço é do próprio Drive e é a cópia que sobrevive se a Locaweb
 * perder o disco. O gestor/admin vê e baixa tudo pelo Perfil.
 *
 * Com --so-banco (03/11/2026, todo dia): gera banco-AAAA-MM-DD-HHMM.zip, só com
 * o banco, porque o completo de domingo deixava até 7 dias descobertos. Rotação
 * própria: 14 no servidor e 30 no Drive, sem mensal, salvo opção explícita.
 * Cada tipo só apaga cópias do próprio tipo.
 *
 * Quem para de rodar não falha, então não avisa: a rodada do completo confere se
 * o diário está em dia e manda um e-mail se não estiver (só avisa, não apaga nada).
 */
class BackupGerar extends Command
{
    /** Sem banco-*.zip mais novo que isto, o diário parou (2 madrugadas seguidas sem cópia). */
    private const DIARIO_ATRASO_DIAS = 2;

    protected $signature = 'backup:gerar
        {--so-banco : só o banco, sem fotos (backup diário, banco-*.zip)}
        {--manter= : cópias guardadas no servidor (padrão 2; com --so-banco, 14)}
        {--meses= : meses com uma cópia mensal no servidor (padrão 0 = nenhuma)}
        {--drive-manter= : cópias guardadas no Google Drive (padrão 12; com --so-banco, 30)}
        {--drive-meses= : meses com uma cópia mensal no Drive (padrão 12; com --so-banco, 0)}
        {--sem-drive : não enviar ao Drive}';

    protected $description = 'Backup em storage/app/backups (completo, ou só o banco com --so-banco), com rotação e cópia no Google Drive';

    public function handle(BackupCompleto $b, DriveBackup $drive): int
    {
        $t = microtime(true);
        $soBanco = (bool) $this->option('so-banco');
        /* os padrões dependem do modo, por isso não ficam na assinatura */
        $manter = max(1, $this->numero('manter', $soBanco ? 14 : 2));   // nunca apaga a cópia que acabou de sair
        $meses = $this->numero('meses', 0);
        try {
            $r = $soBanco ? $b->gerarBanco() : $b->gerar();
            $apagados = $b->podar($manter, $meses, $soBanco ? BackupCompleto::PREFIXO_BANCO : BackupCompleto::PREFIXO_COMPLETO);
            $msg = sprintf('backup ok: %s (%.1f MB, %s, %.1fs; %d antigo(s) apagado(s))',
                basename($r['arquivo']), $r['bytes'] / 1048576, $soBanco ? 'só banco' : $r['fotos'].' fotos', microtime(true) - $t, $apagados);
            $this->info($msg);
            Log::info($msg);
        } catch (\Throwable $e) {
            $this->error('backup falhou: '.$e->getMessage());
            Log::error('backup falhou: '.$e->getMessage());
            try {
                /* chaves separadas: o freio de 1 hora do AlertaErro não pode engolir o aviso do outro modo */
                app(AlertaErro::class)->avisar(
                    $soBanco ? 'Backup diário do banco FALHOU' : 'Backup semanal completo FALHOU',
                    'O crontab backup:gerar'.($soBanco ? ' --so-banco' : '').' falhou: '.$e->getMessage()."\n\nOs backups anteriores continuam em storage/app/backups.",
                    $soBanco ? 'backup-banco-falhou' : 'backup-falhou',
                );
            } catch (\Throwable) {
            }

            return self::FAILURE;
        }

        if (! $soBanco) {
            $this->conferirDiario($b);
        }

        /* Cópia fora da Locaweb. Falha aqui não é falha do backup: avisa e segue. */
        if ($this->option('sem-drive') || ! $drive->conectado()) {
            $this->line($drive->conectado() ? 'drive: pulado (--sem-drive)' : 'drive: não conectado — Perfil → Backup → Conectar Google Drive');

            return self::SUCCESS;
        }
        $t2 = microtime(true);
        try {
            $d = $drive->enviar(
                $r['arquivo'],
                max(1, $this->numero('drive-manter', $soBanco ? 30 : 12)),
                $this->numero('drive-meses', $soBanco ? 0 : 12),
            );
            $msg = sprintf('drive ok: %s enviado em %.0fs (%d antigo(s) apagado(s) no Drive)', $d['nome'], microtime(true) - $t2, $d['apagados']);
            $this->info($msg);
            Log::info($msg);
        } catch (\Throwable $e) {
            $this->error('drive falhou: '.$e->getMessage());
            Log::error('drive falhou: '.$e->getMessage());
            try {
                app(AlertaErro::class)->avisar(
                    $soBanco ? 'Backup diário do banco não subiu para o Google Drive' : 'Backup semanal completo não subiu para o Google Drive',
                    ($soBanco ? 'O zip do dia (só o banco)' : 'O zip completo da semana').' foi gerado e está na Locaweb, mas a cópia no Drive falhou: '
                        .$e->getMessage()."\n\nSe a autorização expirou: Perfil → Backup → Conectar Google Drive de novo.",
                    $soBanco ? 'backup-banco-drive-falhou' : 'backup-drive-falhou',
                );
            } catch (\Throwable) {
            }
        }

        return self::SUCCESS;
    }

    /**
     * Linha do diário não cadastrada ou parada no Agendador não gera erro nenhum
     * (03/11/2026): sem esta conferência, ninguém ficaria sabendo. A data sai do
     * nome do zip, que uma cópia do arquivo não muda. Nada aqui derruba o completo.
     */
    private function conferirDiario(BackupCompleto $b): void
    {
        try {
            $ultimo = $b->listar(BackupCompleto::PREFIXO_BANCO)[0]['nome'] ?? null;
            $data = $ultimo ? Carbon::createFromFormat('Y-m-d-Hi', substr($ultimo, strlen(BackupCompleto::PREFIXO_BANCO) + 1, 15), BackupCompleto::TZ) : null;
            if ($data && $data->greaterThanOrEqualTo(now(BackupCompleto::TZ)->subDays(self::DIARIO_ATRASO_DIAS))) {
                return;
            }
            $this->warn('backup diário do banco parado: '.($ultimo ?: 'nenhuma cópia na pasta'));
            Log::warning('backup diário do banco parado: '.($ultimo ?: 'nenhuma cópia na pasta'));
            app(AlertaErro::class)->avisar(
                'Backup diário do banco não está rodando',
                ($ultimo ? 'A cópia diária mais nova é '.$ultimo.'.' : 'Não há nenhuma cópia diária (banco-*.zip) em storage/app/backups.')
                    ."\n\nConfira no Agendador de tarefas da Locaweb a linha backup:gerar --so-banco. O backup completo de hoje saiu normal.",
                'backup-banco-parado',
            );
        } catch (\Throwable $e) {
            Log::warning('não consegui conferir o backup diário: '.$e->getMessage());
        }
    }

    /** Valor da opção, ou o padrão do modo quando ela não veio. */
    private function numero(string $opcao, int $padrao): int
    {
        $v = $this->option($opcao);

        return $v === null ? $padrao : (int) $v;
    }
}
