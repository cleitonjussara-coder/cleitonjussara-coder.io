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
 * Ordem (07/11/2026): gera → envia ao Drive → gira o servidor. A cópia antiga só
 * sai do servidor se estiver no Drive; sem Drive (desconectado ou com erro), o
 * servidor não apaga nada e avisa no log. Só --sem-drive gira sem conferir.
 *
 * Com --so-banco (03/11/2026, todo dia): gera banco-AAAA-MM-DD-HHMM.zip, só com
 * o banco, porque o completo de domingo deixava até 7 dias descobertos. Rotação
 * própria: 14 no servidor e 30 no Drive, sem mensal, salvo opção explícita.
 * Cada tipo só apaga cópias do próprio tipo.
 *
 * Com --fotos-novas (05/11/2026, todo dia): gera fotos-AAAA-MM-DD-HHMM.zip com os
 * anexos novos ou alterados desde o último completo, porque nota nova ficava até
 * 7 dias sem cópia do anexo. Restaurar = último completo + último fotos. Rotação
 * própria: 3 no servidor (eram 7 até 07/11/2026) e 14 no Drive, sem mensal. Sem foto nova não cria zip nem
 * gira nada; sem completo na pasta é erro.
 *
 * Quem para de rodar não falha, então não avisa: a rodada do completo confere se
 * o diário está em dia e manda um e-mail se não estiver (só avisa, não apaga nada).
 */
class BackupGerar extends Command
{
    /** Sem banco-*.zip mais novo que isto, o diário parou (2 madrugadas seguidas sem cópia). */
    private const DIARIO_ATRASO_DIAS = 2;

    /**
     * O que muda de um modo para o outro (05/11/2026): prefixo, padrões da rotação e
     * os textos do aviso. A chave de cada aviso é própria porque o freio de 1 hora do
     * AlertaErro não pode engolir o aviso de outro modo.
     */
    private const MODOS = [
        'completo' => [
            'prefixo' => BackupCompleto::PREFIXO_COMPLETO, 'manter' => 2, 'drive_manter' => 12, 'drive_meses' => 12,
            'titulo' => 'Backup semanal completo', 'opcao' => '', 'zip' => 'O zip completo da semana', 'chave' => 'backup',
        ],
        'banco' => [
            'prefixo' => BackupCompleto::PREFIXO_BANCO, 'manter' => 14, 'drive_manter' => 30, 'drive_meses' => 0,
            'titulo' => 'Backup diário do banco', 'opcao' => ' --so-banco', 'zip' => 'O zip do dia (só o banco)', 'chave' => 'backup-banco',
        ],
        'fotos' => [
            'prefixo' => BackupCompleto::PREFIXO_FOTOS, 'manter' => 3, 'drive_manter' => 14, 'drive_meses' => 0,
            'titulo' => 'Backup diário das fotos', 'opcao' => ' --fotos-novas', 'zip' => 'O zip do dia (só as fotos novas)', 'chave' => 'backup-fotos',
        ],
    ];

    protected $signature = 'backup:gerar
        {--so-banco : só o banco, sem fotos (backup diário, banco-*.zip)}
        {--fotos-novas : só os anexos novos desde o último completo (backup diário, fotos-*.zip)}
        {--manter= : cópias guardadas no servidor (padrão 2; com --so-banco, 14; com --fotos-novas, 3)}
        {--meses= : meses com uma cópia mensal no servidor (padrão 0 = nenhuma)}
        {--drive-manter= : cópias guardadas no Google Drive (padrão 12; com --so-banco, 30; com --fotos-novas, 14)}
        {--drive-meses= : meses com uma cópia mensal no Drive (padrão 12; com --so-banco ou --fotos-novas, 0)}
        {--sem-drive : não enviar ao Drive}';

    protected $description = 'Backup em storage/app/backups (completo, só o banco com --so-banco, ou só as fotos novas com --fotos-novas), com rotação e cópia no Google Drive';

    public function handle(BackupCompleto $b, DriveBackup $drive): int
    {
        $t = microtime(true);
        $soBanco = (bool) $this->option('so-banco');
        $soFotos = (bool) $this->option('fotos-novas');
        if ($soBanco && $soFotos) {
            $this->error('--fotos-novas e --so-banco não andam juntos: são duas linhas no Agendador, uma para cada.');

            return self::FAILURE;
        }
        $modo = self::MODOS[$soBanco ? 'banco' : ($soFotos ? 'fotos' : 'completo')];
        /* os padrões dependem do modo, por isso não ficam na assinatura */
        $manter = max(1, $this->numero('manter', $modo['manter']));   // nunca apaga a cópia que acabou de sair
        $meses = $this->numero('meses', 0);
        try {
            $r = $soBanco ? $b->gerarBanco() : ($soFotos ? $b->gerarFotos() : $b->gerar());
            if ($r['arquivo'] === null) {
                /* sem zip novo a rotação não anda: os diários antigos ainda são a única cópia do que eles trazem */
                $msg = 'backup ok: nenhuma foto nova desde '.$r['base'].', nenhum zip criado';
                $this->info($msg);
                Log::info($msg);

                return self::SUCCESS;
            }
            $msg = sprintf('backup ok: %s (%.1f MB, %s, %.1fs)',
                basename($r['arquivo']), $r['bytes'] / 1048576, $soBanco ? 'só banco' : $r['fotos'].' fotos', microtime(true) - $t);
            $this->info($msg);
            Log::info($msg);
        } catch (\Throwable $e) {
            $this->error('backup falhou: '.$e->getMessage());
            Log::error('backup falhou: '.$e->getMessage());
            try {
                app(AlertaErro::class)->avisar(
                    $modo['titulo'].' FALHOU',
                    'O crontab backup:gerar'.$modo['opcao'].' falhou: '.$e->getMessage()."\n\nOs backups anteriores continuam em storage/app/backups.",
                    $modo['chave'].'-falhou',
                );
            } catch (\Throwable) {
            }

            return self::FAILURE;
        }

        if (! $soBanco && ! $soFotos) {
            $this->conferirDiario($b);
        }

        $semDrive = (bool) $this->option('sem-drive');
        $conectado = ! $semDrive && $drive->conectado();
        if ($conectado) {
            $this->enviarAoDrive($drive, $r['arquivo'], $modo);
        } else {
            $this->line($semDrive ? 'drive: pulado (--sem-drive)' : 'drive: não conectado — Perfil → Backup → Conectar Google Drive');
        }

        /* 07/11/2026, pedido do Cleiton: a cópia antiga só sai do servidor depois de confirmada no Drive. Antes a rotação vinha
           antes do envio e, com o Drive desconectado ou falhando, o servidor seguia apagando o que talvez não existisse em
           outro lugar. Só --sem-drive (pedido explícito de quem roda) gira sem conferir. */
        $this->podarServidor($b, $drive, $manter, $meses, $modo['prefixo'], $semDrive, $conectado);

        return self::SUCCESS;
    }

    private function podarServidor(BackupCompleto $b, DriveBackup $drive, int $manter, int $meses, string $prefixo, bool $semDrive, bool $conectado): void
    {
        try {
            if ($semDrive) {
                $n = $b->podar($manter, $meses, $prefixo);
                $this->info("servidor: {$n} antigo(s) apagado(s)");
                Log::info("backup {$prefixo}: {$n} antigo(s) apagado(s) no servidor (--sem-drive)");

                return;
            }
            $sairiam = array_column(BackupCompleto::paraApagar($b->listar($prefixo), $manter, $meses, $prefixo), 'nome');
            if ($sairiam === []) {
                return;
            }
            $naNuvem = $conectado ? array_column($drive->listarNoDrive($prefixo), 'nome') : [];
            $n = $b->podar($manter, $meses, $prefixo, $naNuvem);
            $retidos = array_values(array_diff($sairiam, $naNuvem));
            $this->info("servidor: {$n} antigo(s) apagado(s), já guardado(s) no Drive");
            Log::info("backup {$prefixo}: {$n} antigo(s) apagado(s) no servidor, confirmado(s) no Drive");
            if ($retidos !== []) {
                $msg = 'servidor: '.count($retidos).' cópia(s) antiga(s) mantida(s) porque não estão no Drive: '.implode(', ', $retidos);
                $this->warn($msg);
                Log::warning('backup '.$prefixo.': '.$msg);
            }
        } catch (\Throwable $e) {
            /* sem confirmar o que está no Drive, nada sai do servidor */
            $this->warn('servidor: nenhuma cópia antiga apagada, não consegui conferir o Drive: '.$e->getMessage());
            Log::warning("backup {$prefixo}: rotação do servidor suspensa, Drive não conferido: ".$e->getMessage());
        }
    }

    /** Cópia fora da Locaweb. Falha aqui não é falha do backup: avisa e segue. */
    private function enviarAoDrive(DriveBackup $drive, string $arquivo, array $modo): void
    {
        $t2 = microtime(true);
        try {
            $d = $drive->enviar(
                $arquivo,
                max(1, $this->numero('drive-manter', $modo['drive_manter'])),
                $this->numero('drive-meses', $modo['drive_meses']),
            );
            $msg = sprintf('drive ok: %s enviado em %.0fs (%d antigo(s) apagado(s) no Drive)', $d['nome'], microtime(true) - $t2, $d['apagados']);
            $this->info($msg);
            Log::info($msg);
        } catch (\Throwable $e) {
            $this->error('drive falhou: '.$e->getMessage());
            Log::error('drive falhou: '.$e->getMessage());
            try {
                app(AlertaErro::class)->avisar(
                    $modo['titulo'].' não subiu para o Google Drive',
                    $modo['zip'].' foi gerado e está na Locaweb, mas a cópia no Drive falhou: '
                        .$e->getMessage()."\n\nSe a autorização expirou: Perfil → Backup → Conectar Google Drive de novo.",
                    $modo['chave'].'-drive-falhou',
                );
            } catch (\Throwable) {
            }
        }
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
