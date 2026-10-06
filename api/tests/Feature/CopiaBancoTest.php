<?php

namespace Tests\Feature;

use App\Services\CopiaBanco;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * 06/10/2026 — troca do SQLite pelo MySQL. A cópia tem que levar tudo, nos
 * dois sentidos, e recusar antes de começar quando um dado não cabe.
 *
 * Os casos com MySQL só rodam com um servidor de teste (descartável!):
 *   MYSQL_TEST_HOST=127.0.0.1 MYSQL_TEST_DATABASE=pm_test \
 *   MYSQL_TEST_USERNAME=pm MYSQL_TEST_PASSWORD=pm php vendor/bin/phpunit --filter CopiaBanco
 */
class CopiaBancoTest extends TestCase
{
    use RefreshDatabase;

    private array $arquivos = [];

    protected function tearDown(): void
    {
        foreach ($this->arquivos as $f) {
            @unlink($f);
        }
        parent::tearDown();
    }

    private function arquivo(string $nome): string
    {
        $f = sys_get_temp_dir().'/copia-'.$nome.'-'.Str::random(6).'.sqlite';
        $this->arquivos[] = $f;

        return CopiaBanco::conexaoArquivo($nome, $f);
    }

    /** A conexão em que o teste roda (SQLite em memória, ou MySQL se o phpunit apontar para ele). */
    private function origem(): string
    {
        return (string) config('database.default');
    }

    private function semear(): string
    {
        $uid = (string) Str::uuid();
        DB::table('colaboradores')->insert([
            'id' => $uid, 'nome' => 'Fulano', 'email' => 'f@teste.local', 'password' => 'x', 'role' => 'colaborador',
        ]);
        /* o app já gravou datas em ISO no SQLite: o MySQL não aceita sem converter */
        $criada = DB::connection()->getDriverName() === 'sqlite' ? '2026-09-20T02:43:49.923Z' : '2026-09-20 02:43:49';
        foreach (range(1, 450) as $i) {   // mais que um lote
            DB::table('notas')->insert([
                'id' => (string) Str::uuid(), 'user_id' => $uid, 'tipo' => 'RDM', 'valor' => $i,
                'data' => '2026-09-'.str_pad((string) (1 + $i % 28), 2, '0', STR_PAD_LEFT), 'mes' => 9, 'ano' => 2026,
                'created_at' => $criada, 'updated_at' => '2026-09-20 02:43:49',
            ]);
        }

        return $uid;
    }

    private function mysql(): string
    {
        if (! env('MYSQL_TEST_HOST')) {
            $this->markTestSkipped('sem MYSQL_TEST_HOST');
        }
        config(['database.connections.mysql_teste' => array_merge(config('database.connections.mysql'), [
            'host' => env('MYSQL_TEST_HOST'), 'port' => env('MYSQL_TEST_PORT', 3306),
            'database' => env('MYSQL_TEST_DATABASE'), 'username' => env('MYSQL_TEST_USERNAME'),
            'password' => env('MYSQL_TEST_PASSWORD'),
        ])]);
        DB::purge('mysql_teste');
        Schema::connection('mysql_teste')->dropAllTables();

        return 'mysql_teste';
    }

    public function test_copia_tudo_para_um_arquivo_sqlite(): void
    {
        $this->semear();
        $destino = $this->arquivo('bk');

        $n = app(CopiaBanco::class)->copiar($this->origem(), $destino);

        $this->assertSame(450, $n['notas']);
        $this->assertSame(1, $n['colaboradores']);
        $this->assertSame(450, DB::connection($destino)->table('notas')->count());
        $this->assertEqualsWithDelta(
            (float) DB::table('notas')->sum('valor'),
            (float) DB::connection($destino)->table('notas')->sum('valor'),
            0.001,
        );
    }

    public function test_copiar_de_novo_substitui_em_vez_de_duplicar(): void
    {
        $this->semear();
        $destino = $this->arquivo('bk');
        app(CopiaBanco::class)->copiar($this->origem(), $destino);
        app(CopiaBanco::class)->copiar($this->origem(), $destino);

        $this->assertSame(450, DB::connection($destino)->table('notas')->count());
    }

    public function test_ida_e_volta_pelo_mysql_preserva_os_dados(): void
    {
        $mysql = $this->mysql();
        $this->semear();

        app(CopiaBanco::class)->copiar($this->origem(), $mysql);
        $this->assertSame(450, DB::connection($mysql)->table('notas')->count());
        $this->assertSame('2026-09-20 02:43:49', (string) DB::connection($mysql)->table('notas')->value('created_at'));

        $volta = $this->arquivo('volta');
        app(CopiaBanco::class)->copiar($mysql, $volta);
        $this->assertSame(450, DB::connection($volta)->table('notas')->count());
        $this->assertSame('Fulano', DB::connection($volta)->table('colaboradores')->value('nome'));
    }

    public function test_recusa_antes_de_copiar_quando_um_texto_nao_cabe(): void
    {
        $mysql = $this->mysql();
        DB::table('veiculos')->insert(['id' => (string) Str::uuid(), 'placa' => 'ABC1D234XYZ99']);   // coluna de 10

        $p = app(CopiaBanco::class)->problemas($this->origem(), $mysql);

        $this->assertCount(1, $p);
        $this->assertStringContainsString('veiculos.placa', $p[0]);
        $this->assertSame(0, DB::connection($mysql)->table('veiculos')->count());
    }
}
