<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use RuntimeException;
use ZipArchive;

/**
 * Backup completo = banco (cópia íntegra por VACUUM INTO) + todas as fotos,
 * num único .zip em storage/app/backups (fora do public_html).
 *
 * Quem chama:
 *   • `php84 artisan backup:gerar` — agendado no painel da Locaweb
 *     (Agendador de tarefas), 1x por semana; mantém as N últimas cópias;
 *   • GET /backup/completo — o admin gera e baixa na hora pelo Perfil.
 *
 * Miniaturas (<user>/mini/) ficam de fora: são regeradas sozinhas.
 * Fotos entram sem compressão (jpg não encolhe; STORE é instantâneo).
 */
class BackupCompleto
{
    public const PASTA = 'backups';

    public const TZ = PontoCalculo::TZ;   // nome do arquivo na hora do Brasil

    public function pasta(): string
    {
        $p = storage_path('app/'.self::PASTA);
        if (! is_dir($p)) {
            @mkdir($p, 0755, true);
        }

        return $p;
    }

    /** Gera o zip e devolve ['arquivo' => caminho, 'fotos' => n, 'bytes' => tamanho]. */
    public function gerar(?string $destino = null): array
    {
        if (DB::connection()->getDriverName() !== 'sqlite') {
            throw new RuntimeException('Backup completo só para SQLite');
        }
        @ini_set('memory_limit', '512M');
        @set_time_limit(600);

        $destino = $destino ?: $this->pasta().'/petermann-'.now(PontoCalculo::TZ)->format('Y-m-d-Hi').'.zip';
        @unlink($destino);

        $tmpDb = storage_path('app/backup-'.now()->format('Ymd-His').'.sqlite');
        $this->copiarBanco($tmpDb);

        $zip = new ZipArchive;
        if ($zip->open($destino, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            @unlink($tmpDb);
            throw new RuntimeException('Não consegui criar o zip do backup');
        }
        $zip->addFile($tmpDb, 'database.sqlite');

        $raiz = rtrim(app(FotoStorage::class)->disk()->path(''), '/\\');
        $fotos = 0;
        if (is_dir($raiz)) {
            $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($raiz, \FilesystemIterator::SKIP_DOTS));
            foreach ($it as $f) {
                /** @var \SplFileInfo $f */
                $rel = str_replace('\\', '/', substr($f->getPathname(), strlen($raiz) + 1));
                if (str_contains($rel, '/'.FotoStorage::MINI_DIR.'/')) {
                    continue;
                }
                $zip->addFile($f->getPathname(), 'fotos/'.$rel);
                $zip->setCompressionName('fotos/'.$rel, ZipArchive::CM_STORE);
                $fotos++;
            }
        }
        $zip->addFromString('LEIA-ME.txt', $this->leiaMe($fotos));
        $zip->close();
        @unlink($tmpDb);

        return ['arquivo' => $destino, 'fotos' => $fotos, 'bytes' => filesize($destino) ?: 0];
    }

    /**
     * Cópia íntegra do banco mesmo com gente gravando. VACUUM INTO só existe
     * do SQLite 3.27 em diante e a Locaweb roda 3.26 — lá usa a API de
     * backup do próprio SQLite (SQLite3::backup), que também é consistente.
     */
    public function copiarBanco(string $destino): void
    {
        @unlink($destino);
        $origem = (string) DB::connection()->getDatabaseName();
        try {
            DB::statement('VACUUM INTO '.DB::connection()->getPdo()->quote($destino));
            if (is_file($destino) && filesize($destino) > 0) {
                return;
            }
        } catch (\Throwable) {
            // versão antiga: cai no backup API
        }
        if (! class_exists(\SQLite3::class)) {
            throw new RuntimeException('Sem VACUUM INTO nem extensão sqlite3 para copiar o banco');
        }
        $src = new \SQLite3($origem, SQLITE3_OPEN_READONLY);
        $dst = new \SQLite3($destino);
        $ok = $src->backup($dst);
        $dst->close();
        $src->close();
        if (! $ok || ! is_file($destino)) {
            throw new RuntimeException('SQLite3::backup falhou');
        }
    }

    /** Lista os backups guardados, mais novo primeiro. */
    public function listar(): array
    {
        $out = [];
        foreach (glob($this->pasta().'/petermann-*.zip') ?: [] as $f) {
            $out[] = ['nome' => basename($f), 'bytes' => filesize($f) ?: 0, 'em' => date('c', filemtime($f) ?: time())];
        }
        usort($out, fn ($a, $b) => strcmp($b['nome'], $a['nome']));

        return $out;
    }

    /**
     * Rotação (21/09/2026, disco ilimitado): guarda as $manter cópias mais
     * novas E a primeira cópia de cada mês nos últimos $meses meses. Assim
     * "a nota que alguém apagou em março" continua recuperável. Devolve
     * quantos apagou.
     */
    public function podar(int $manter, int $meses = 12): int
    {
        $n = 0;
        foreach ($this->paraApagar($this->listar(), $manter, $meses) as $b) {
            if (@unlink($this->pasta().'/'.$b['nome'])) {
                $n++;
            }
        }

        return $n;
    }

    /**
     * Decide quem sai, dada a lista (mais novo primeiro, cada item com
     * 'nome' petermann-AAAA-MM-DD-HHMM…). Puro: o DriveBackup usa a mesma
     * regra para a pasta no Drive.
     */
    public static function paraApagar(array $lista, int $manter, int $meses = 12): array
    {
        usort($lista, fn ($a, $b) => strcmp($b['nome'], $a['nome']));
        $recentes = array_slice($lista, 0, max(0, $manter));
        $fica = array_column($recentes, 'nome', 'nome');

        $limiteMes = now(self::TZ)->startOfMonth()->subMonths(max(0, $meses))->format('Y-m');
        $porMes = [];
        foreach (array_reverse($lista) as $b) {   // do mais antigo para o mais novo: o 1º de cada mês ganha
            if (! preg_match('/-(\d{4}-\d{2})-\d{2}-\d{4}/', $b['nome'], $m)) {
                continue;
            }
            if ($m[1] >= $limiteMes && ! isset($porMes[$m[1]])) {
                $porMes[$m[1]] = $b['nome'];
            }
        }
        $fica += array_combine($porMes, $porMes);

        return array_values(array_filter($lista, fn ($b) => ! isset($fica[$b['nome']])));
    }

    public function caminhoDe(string $nome): ?string
    {
        if (! preg_match('/^petermann-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/', $nome)) {
            return null;
        }
        $p = $this->pasta().'/'.$nome;

        return is_file($p) ? $p : null;
    }

    private function leiaMe(int $fotos): string
    {
        return "Backup do Petermann App — ".now(PontoCalculo::TZ)->format('d/m/Y H:i')."\n\n"
            ."database.sqlite : o banco inteiro (notas, repasses, colaboradores, frota, ponto)\n"
            ."fotos/          : {$fotos} anexos, na mesma estrutura do servidor (<colaborador>/<nota>.ext)\n\n"
            ."Para restaurar: copiar database.sqlite para api-petermann/database/ e a pasta fotos/\n"
            ."para api-petermann/storage/app/fotos/ (as miniaturas são refeitas sozinhas).\n";
    }
}
