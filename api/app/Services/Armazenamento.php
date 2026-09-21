<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

/**
 * Monitoramento do armazenamento no servidor (21/09/2026).
 *
 * A hospedagem compartilhada não avisa quando o espaço acaba: o upload de
 * foto simplesmente falha e o backup semanal para de sair. Este serviço mede
 * o que o app ocupa (banco, fotos, backups, logs), guarda uma amostra por dia
 * em storage/app/armazenamento.json e calcula a tendência.
 *
 * Quem chama:
 *   • `php84 artisan armazenamento:verificar` — cron diário; avisa por
 *     e-mail (AlertaErro) quando passa do limite ou o backup atrasa;
 *   • GET /admin/armazenamento — cartão "Armazenamento" no Perfil do admin.
 *
 * O limite vem de ARMAZENAMENTO_LIMITE_MB (o espaço do plano no painel da
 * Locaweb). Sem ele, mostra só os números absolutos.
 */
class Armazenamento
{
    public const HISTORICO = 'armazenamento.json';

    public const MAX_AMOSTRAS = 400;   // ~13 meses de amostras diárias

    public function __construct(private BackupCompleto $backup, private FotoStorage $fotos) {}

    /** Mede tudo agora. Barato: ~100 fotos + poucos zips. */
    public function medir(): array
    {
        $banco = 0;
        if (DB::connection()->getDriverName() === 'sqlite') {
            $arq = (string) DB::connection()->getDatabaseName();
            foreach ([$arq, $arq.'-wal', $arq.'-shm'] as $f) {
                $banco += is_file($f) ? (filesize($f) ?: 0) : 0;
            }
        }

        $raizFotos = rtrim($this->fotos->disk()->path(''), '/\\');
        [$fotosBytes, $fotosN, $miniBytes] = $this->pasta($raizFotos, FotoStorage::MINI_DIR);
        [$backupsBytes, $backupsN] = $this->pasta($this->backup->pasta());
        [$logsBytes] = $this->pasta(storage_path('logs'));

        $lista = $this->backup->listar();
        $ultimo = $lista[0] ?? null;
        $diasBackup = $ultimo ? (int) floor((time() - strtotime($ultimo['em'])) / 86400) : null;

        $limiteMb = (int) config('petermann.armazenamento.limite_mb', 0);
        $total = $banco + $fotosBytes + $miniBytes + $backupsBytes + $logsBytes;
        $pct = $limiteMb > 0 ? round($total / ($limiteMb * 1048576) * 100, 1) : null;

        $volume = null;   // o disco da Locaweb é compartilhado: só informativo
        $livre = @disk_free_space(storage_path());
        $tam = @disk_total_space(storage_path());
        if ($livre !== false && $tam) {
            $volume = ['total' => (int) $tam, 'livre' => (int) $livre, 'pct_usado' => round(($tam - $livre) / $tam * 100, 1)];
        }

        return [
            'em' => now(PontoCalculo::TZ)->toIso8601String(),
            'total' => $total,
            'limite_mb' => $limiteMb ?: null,
            'pct' => $pct,
            'nivel' => $this->nivel($pct, $diasBackup),
            'partes' => [
                'banco' => ['bytes' => $banco, 'n' => $this->contarLinhas()],
                'fotos' => ['bytes' => $fotosBytes, 'n' => $fotosN],
                'miniaturas' => ['bytes' => $miniBytes],
                'backups' => ['bytes' => $backupsBytes, 'n' => $backupsN],
                'logs' => ['bytes' => $logsBytes],
            ],
            'ultimo_backup' => $ultimo ? ['nome' => $ultimo['nome'], 'em' => $ultimo['em'], 'bytes' => $ultimo['bytes'], 'dias' => $diasBackup] : null,
            'volume' => $volume,
        ];
    }

    /** ok | aviso | critico — o que decide a cor no app e o e-mail no cron. */
    public function nivel(?float $pct, ?int $diasBackup): string
    {
        $aviso = (float) config('petermann.armazenamento.aviso_pct', 80);
        $critico = (float) config('petermann.armazenamento.critico_pct', 90);
        if ($pct !== null && $pct >= $critico) {
            return 'critico';
        }
        if ($diasBackup === null || $diasBackup > 8 || ($pct !== null && $pct >= $aviso)) {
            return 'aviso';
        }

        return 'ok';
    }

    /** Guarda a medição de hoje (uma por dia; a de hoje substitui a anterior). */
    public function registrar(array $medida): void
    {
        $hist = $this->historico();
        $dia = substr($medida['em'], 0, 10);
        $hist = array_values(array_filter($hist, fn ($a) => substr($a['em'], 0, 10) !== $dia));
        $hist[] = [
            'em' => $medida['em'],
            'total' => $medida['total'],
            'fotos' => $medida['partes']['fotos']['bytes'],
            'fotos_n' => $medida['partes']['fotos']['n'],
            'banco' => $medida['partes']['banco']['bytes'],
            'backups' => $medida['partes']['backups']['bytes'],
        ];
        $hist = array_slice($hist, -self::MAX_AMOSTRAS);
        @file_put_contents($this->arquivoHistorico(), json_encode($hist, JSON_UNESCAPED_UNICODE), LOCK_EX);
    }

    public function historico(): array
    {
        $f = $this->arquivoHistorico();
        if (! is_file($f)) {
            return [];
        }
        $h = json_decode((string) file_get_contents($f), true);

        return is_array($h) ? $h : [];
    }

    /**
     * Crescimento em bytes/dia (média dos últimos $dias com amostra) e
     * estimativa de quando o limite acaba. Null quando ainda não há dados.
     */
    public function tendencia(array $hist, ?int $limiteMb, int $dias = 30): array
    {
        $hist = array_values(array_filter($hist, fn ($a) => isset($a['em'], $a['total'])));
        $n = count($hist);
        if ($n < 2) {
            return ['por_dia' => null, 'por_mes' => null, 'dias_ate_limite' => null, 'amostras' => $n];
        }
        $fim = end($hist);
        $desde = strtotime($fim['em']) - $dias * 86400;
        $ini = $hist[0];
        foreach ($hist as $a) {
            if (strtotime($a['em']) >= $desde) {
                $ini = $a;
                break;
            }
        }
        $dt = max(1, (strtotime($fim['em']) - strtotime($ini['em'])) / 86400);
        $porDia = ($fim['total'] - $ini['total']) / $dt;
        $ate = null;
        if ($limiteMb && $porDia > 0) {
            $ate = (int) floor(($limiteMb * 1048576 - $fim['total']) / $porDia);
        }

        return ['por_dia' => (int) round($porDia), 'por_mes' => (int) round($porDia * 30), 'dias_ate_limite' => $ate, 'amostras' => $n];
    }

    /** [bytes, arquivos, bytesDaSubpastaIgnorada] — anda a pasta uma vez só. */
    private function pasta(string $dir, ?string $separar = null): array
    {
        if (! is_dir($dir)) {
            return [0, 0, 0];
        }
        $bytes = 0;
        $n = 0;
        $sep = 0;
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS));
        foreach ($it as $f) {
            /** @var \SplFileInfo $f */
            if (! $f->isFile()) {
                continue;
            }
            $tam = $f->getSize() ?: 0;
            if ($separar && str_contains(str_replace('\\', '/', $f->getPathname()), '/'.$separar.'/')) {
                $sep += $tam;
                continue;
            }
            $bytes += $tam;
            $n++;
        }

        return [$bytes, $n, $sep];
    }

    private function contarLinhas(): int
    {
        try {
            return (int) DB::table('notas')->where('deleted', false)->count()
                + (int) DB::table('repasses')->where('deleted', false)->count();
        } catch (\Throwable) {
            return 0;
        }
    }

    private function arquivoHistorico(): string
    {
        return storage_path('app/'.self::HISTORICO);
    }
}
