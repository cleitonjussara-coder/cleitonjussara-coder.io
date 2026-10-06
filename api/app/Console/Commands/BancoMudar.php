<?php

namespace App\Console\Commands;

use App\Services\CopiaBanco;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;

/**
 * php84 artisan banco:mudar mysql [--ensaio]
 * php84 artisan banco:mudar sqlite            (a volta, se precisar)
 *
 * Troca do SQLite pelo MySQL sem parar o sistema (06/10/2026, pedido do
 * Cleiton). Antes: criar o banco MySQL no painel da Locaweb e pôr no .env
 * MYSQL_HOST, MYSQL_DATABASE, MYSQL_USERNAME e MYSQL_PASSWORD.
 *
 *   --ensaio  copia para o MySQL e confere, mas o sistema continua no
 *             SQLite (dá para rodar de dia, para medir o tempo e achar
 *             problema de dado antes da virada).
 *   sem ele   API em manutenção por poucos segundos (o app guarda as notas
 *             no celular e reenvia sozinho), copia, confere, grava
 *             DB_CONNECTION no .env e sai da manutenção. Se a conferência
 *             falhar, nada muda: o sistema continua no banco de antes.
 */
class BancoMudar extends Command
{
    protected $signature = 'banco:mudar
        {para : mysql ou sqlite}
        {--ensaio : só copia e confere, sem virar}';

    protected $description = 'Copia o banco para MySQL (ou de volta para SQLite) e vira o sistema para ele';

    public function handle(CopiaBanco $copia): int
    {
        $para = (string) $this->argument('para');
        $de = (string) config('database.default');
        if (! in_array($para, ['mysql', 'sqlite'], true)) {
            $this->error('Use: banco:mudar mysql | banco:mudar sqlite');

            return self::FAILURE;
        }
        if ($para === $de) {
            $this->error("O sistema já está no {$para}.");

            return self::FAILURE;
        }

        try {
            DB::connection($para)->getPdo();
        } catch (\Throwable $e) {
            $this->error("Não conectei no {$para}: ".$e->getMessage());

            return self::FAILURE;
        }

        $problemas = $copia->problemas($de, $para);
        if ($problemas) {
            $this->error('Há dados que não cabem no destino. Nada foi alterado:');
            foreach ($problemas as $p) {
                $this->line("  - {$p}");
            }

            return self::FAILURE;
        }

        $ensaio = (bool) $this->option('ensaio');
        $t = microtime(true);
        if (! $ensaio) {
            Artisan::call('down', ['--retry' => 10]);
            sleep(2);   // deixa terminar quem já estava gravando
        }

        try {
            $contagem = $copia->copiar($de, $para, fn ($l) => $this->line("  {$l}"));
            if (! $ensaio) {
                $this->gravarEnv('DB_CONNECTION', $para);
            }
        } catch (\Throwable $e) {
            $this->error('Cópia falhou, o sistema continua no '.$de.': '.$e->getMessage());

            return self::FAILURE;
        } finally {
            if (! $ensaio) {
                Artisan::call('up');
            }
        }

        $this->info(sprintf('%s: %d tabelas, %d linhas, %.1fs%s',
            $ensaio ? 'ensaio ok' : "sistema agora no {$para}",
            count($contagem), array_sum($contagem), microtime(true) - $t,
            $ensaio ? ' (o sistema continua no '.$de.')' : ''));

        return self::SUCCESS;
    }

    private function gravarEnv(string $chave, string $valor): void
    {
        $arq = app()->environmentFilePath();
        $env = is_file($arq) ? (string) file_get_contents($arq) : '';
        $linha = "{$chave}={$valor}";
        $novo = preg_match("/^{$chave}=.*$/m", $env)
            ? preg_replace("/^{$chave}=.*$/m", $linha, $env)
            : rtrim($env)."\n{$linha}\n";
        if (file_put_contents($arq, $novo) === false) {
            throw new \RuntimeException("Não consegui gravar {$chave} no .env");
        }
    }
}
