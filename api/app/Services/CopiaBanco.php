<?php

namespace App\Services;

use Carbon\Carbon;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use RuntimeException;

/**
 * Copia o banco inteiro de uma conexão para outra (06/10/2026, troca do
 * SQLite pelo MySQL a pedido do Cleiton: a equipe vai passar de 100 pessoas).
 *
 * Serve nos dois sentidos:
 *   • sqlite → mysql: a virada (artisan banco:mudar mysql);
 *   • mysql → sqlite: a volta, e o backup quando o banco é MySQL (o zip
 *     continua levando um database.sqlite, que abre em qualquer lugar).
 *
 * O destino recebe a estrutura pelas próprias migrações e é ESVAZIADO antes
 * da cópia: o que vale é sempre a origem. Nada é gravado na origem.
 */
class CopiaBanco
{
    /** Tabelas que não se copiam: a das migrações o `migrate` do destino já preenche. */
    private const PULAR = ['migrations', 'sqlite_sequence'];

    private const LOTE = 200;

    /**
     * Valores que não cabem no destino (texto maior que a coluna). O SQLite
     * não confere tamanho; o MySQL recusa. Vazio = pode copiar.
     *
     * @return list<string>
     */
    public function problemas(string $de, string $para): array
    {
        $this->prepararDestino($para);
        if (DB::connection($para)->getDriverName() === 'sqlite') {
            return [];
        }
        $out = [];
        foreach ($this->tabelas($de, $para) as $t) {
            foreach ($this->colunasDestino($para, $t) as $c => $info) {
                if (! $info['tamanho'] || ! in_array($c, $this->colunas($de, $t), true)) {
                    continue;
                }
                $max = (int) DB::connection($de)->table($t)->max(DB::raw('length('.$this->q($de, $c).')'));
                if ($max > $info['tamanho']) {
                    $n = DB::connection($de)->table($t)->whereRaw('length('.$this->q($de, $c).') > ?', [$info['tamanho']])->count();
                    $out[] = "{$t}.{$c}: {$n} linha(s) com até {$max} caracteres (cabe {$info['tamanho']})";
                }
            }
        }

        return $out;
    }

    /**
     * Copia tudo e confere a contagem de cada tabela.
     *
     * @return array<string, int> linhas copiadas por tabela
     */
    public function copiar(string $de, string $para, ?callable $log = null): array
    {
        @set_time_limit(0);
        @ini_set('memory_limit', '512M');
        $this->prepararDestino($para);

        $dst = DB::connection($para);
        $tabelas = $this->tabelas($de, $para);
        $contagem = [];

        Schema::connection($para)->disableForeignKeyConstraints();
        try {
            foreach ($tabelas as $t) {
                $dst->table($t)->delete();
            }
            foreach ($tabelas as $t) {
                $contagem[$t] = $this->copiarTabela($de, $para, $t);
                $log && $log("{$t}: {$contagem[$t]}");
            }
        } finally {
            Schema::connection($para)->enableForeignKeyConstraints();
        }

        $diferencas = [];
        foreach ($tabelas as $t) {
            $a = DB::connection($de)->table($t)->count();
            $b = $dst->table($t)->count();
            if ($a !== $b) {
                $diferencas[] = "{$t}: origem {$a}, destino {$b}";
            }
        }
        if ($diferencas) {
            throw new RuntimeException('Contagem diferente depois da cópia — '.implode('; ', $diferencas));
        }

        return $contagem;
    }

    /** Liga uma conexão SQLite descartável num arquivo (backup e testes). */
    public static function conexaoArquivo(string $nome, string $arquivo): string
    {
        if (! is_file($arquivo)) {
            touch($arquivo);
        }
        config(["database.connections.{$nome}" => [
            'driver' => 'sqlite',
            'database' => $arquivo,
            'prefix' => '',
            'foreign_key_constraints' => false,
        ]]);
        DB::purge($nome);

        return $nome;
    }

    private function prepararDestino(string $para): void
    {
        $codigo = Artisan::call('migrate', ['--database' => $para, '--force' => true]);
        if ($codigo !== 0) {
            throw new RuntimeException('As migrações não rodaram no destino: '.trim(Artisan::output()));
        }
    }

    private function copiarTabela(string $de, string $para, string $t): int
    {
        $comuns = array_values(array_intersect($this->colunas($de, $t), array_keys($this->colunasDestino($para, $t))));
        $datas = array_keys(array_filter($this->colunasDestino($para, $t), fn ($i) => $i['data']));
        $converteData = DB::connection($para)->getDriverName() !== 'sqlite';

        $n = 0;
        $lote = [];
        foreach (DB::connection($de)->table($t)->select($comuns)->cursor() as $linha) {
            $linha = (array) $linha;
            if ($converteData) {
                foreach ($datas as $c) {
                    if (array_key_exists($c, $linha)) {
                        $linha[$c] = $this->data($linha[$c]);
                    }
                }
            }
            $lote[] = $linha;
            if (count($lote) >= self::LOTE) {
                DB::connection($para)->table($t)->insert($lote);
                $n += count($lote);
                $lote = [];
            }
        }
        if ($lote) {
            DB::connection($para)->table($t)->insert($lote);
            $n += count($lote);
        }

        return $n;
    }

    /**
     * O app já mandou datas em ISO ("2026-09-20T02:43:49.923Z") e o SQLite
     * guardava como veio. O MySQL só aceita "AAAA-MM-DD HH:MM:SS".
     */
    private function data(mixed $v): mixed
    {
        if ($v === null || $v === '') {
            return null;
        }
        if (! is_string($v) || preg_match('/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/', $v)) {
            return $v;
        }
        $tz = preg_match('/(Z|[+-]\d{2}:?\d{2})$/', $v);
        $c = Carbon::parse($v);
        if ($tz) {
            $c = $c->utc();
        }

        return strlen($v) === 10 ? $c->format('Y-m-d') : $c->format('Y-m-d H:i:s');
    }

    /** Tabelas da origem que também existem no destino. */
    private function tabelas(string $de, string $para): array
    {
        $destino = array_flip($this->nomesTabelas($para));

        return array_values(array_filter(
            $this->nomesTabelas($de),
            fn ($t) => isset($destino[$t]) && ! in_array($t, self::PULAR, true),
        ));
    }

    private function nomesTabelas(string $con): array
    {
        $schema = DB::connection($con)->getDriverName() === 'sqlite' ? null : DB::connection($con)->getDatabaseName();

        return array_column(Schema::connection($con)->getTables($schema), 'name');
    }

    private function colunas(string $con, string $t): array
    {
        return array_column(Schema::connection($con)->getColumns($t), 'name');
    }

    /** @return array<string, array{tamanho: int, data: bool}> */
    private function colunasDestino(string $con, string $t): array
    {
        $out = [];
        foreach (Schema::connection($con)->getColumns($t) as $c) {
            $tipo = strtolower((string) $c['type_name']);
            $tamanho = 0;
            if (in_array($tipo, ['varchar', 'char'], true) && preg_match('/\((\d+)\)/', (string) $c['type'], $m)) {
                $tamanho = (int) $m[1];
            }
            $out[$c['name']] = ['tamanho' => $tamanho, 'data' => in_array($tipo, ['date', 'datetime', 'timestamp'], true)];
        }

        return $out;
    }

    private function q(string $con, string $coluna): string
    {
        return DB::connection($con)->getQueryGrammar()->wrap($coluna);
    }
}
