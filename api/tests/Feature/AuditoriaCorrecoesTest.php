<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Services\BackupCompleto;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use RuntimeException;
use Tests\TestCase;

/**
 * Auditoria de 09/11/2026.
 *   • "Migrar" pelo app copia o banco antes de aplicar migração pendente; se a cópia falhar, não migra.
 *   • Leitura por IA (nota e odômetro) tem limite por minuto, além do teto diário que já existia.
 *
 * Banco em arquivo numa pasta temporária (VACUUM INTO não roda em :memory: nem dentro de transação), como no
 * BackupBancoDiarioTest. Nunca toca o database.sqlite local.
 */
class AuditoriaCorrecoesTest extends TestCase
{
    private string $tmp;

    protected function setUp(): void
    {
        parent::setUp();
        $this->tmp = sys_get_temp_dir().'/auditoria-teste-'.Str::random(8);
        mkdir($this->tmp.'/app/backups', 0777, true);
        mkdir($this->tmp.'/migracoes', 0777, true);
        $this->app->useStoragePath($this->tmp);

        touch($this->tmp.'/banco.sqlite');
        config(['database.connections.sqlite.database' => $this->tmp.'/banco.sqlite']);
        DB::purge('sqlite');
        Artisan::call('migrate', ['--force' => true]);
    }

    protected function tearDown(): void
    {
        DB::purge('sqlite');
        File::deleteDirectory($this->tmp);
        parent::tearDown();
    }

    private function pessoa(string $role): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(),
            'nome' => ucfirst($role), 'email' => $role.'-'.Str::random(4).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    /** Migração de mentira numa pasta extra: cria a tabela auditoria_teste. */
    private function migracaoPendente(): void
    {
        file_put_contents($this->tmp.'/migracoes/2099_01_01_000000_cria_auditoria_teste.php', <<<'PHP'
<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
return new class extends Migration {
    public function up(): void { Schema::create('auditoria_teste', fn (Blueprint $t) => $t->id()); }
    public function down(): void { Schema::dropIfExists('auditoria_teste'); }
};
PHP);
        $this->app['migrator']->path($this->tmp.'/migracoes');
    }

    private function zipsDeBanco(): array
    {
        return glob($this->tmp.'/app/backups/banco-*.zip') ?: [];
    }

    public function test_sem_migracao_pendente_nao_faz_backup(): void
    {
        Sanctum::actingAs($this->pessoa('gestor'));

        $this->postJson('/api/admin/migrar')->assertOk()->assertJson(['ok' => true, 'backup' => null]);
        $this->assertSame([], $this->zipsDeBanco());
    }

    public function test_com_migracao_pendente_copia_o_banco_antes(): void
    {
        $this->migracaoPendente();
        Sanctum::actingAs($this->pessoa('admin'));

        $r = $this->postJson('/api/admin/migrar')->assertOk()->assertJson(['ok' => true]);

        $zips = $this->zipsDeBanco();
        $this->assertCount(1, $zips);
        $this->assertSame(basename($zips[0]), $r->json('backup'));
        $this->assertTrue(Schema::hasTable('auditoria_teste'), 'a migração deveria ter rodado depois do backup');

        /* o backup é do banco ANTES da migração: a tabela nova não está nele */
        $zip = new \ZipArchive;
        $this->assertTrue($zip->open($zips[0]) === true);
        $copia = $this->tmp.'/copia.sqlite';
        file_put_contents($copia, $zip->getFromName('database.sqlite'));
        $zip->close();
        $tabelas = (new \PDO('sqlite:'.$copia))->query("SELECT name FROM sqlite_master WHERE type='table'")->fetchAll(\PDO::FETCH_COLUMN);
        $this->assertContains('colaboradores', $tabelas);
        $this->assertNotContains('auditoria_teste', $tabelas);
    }

    public function test_backup_falhou_nao_migra(): void
    {
        $this->migracaoPendente();
        $this->app->instance(BackupCompleto::class, new class extends BackupCompleto
        {
            public function __construct() {}

            public function gerarBanco(?string $destino = null): array
            {
                throw new RuntimeException('disco cheio');
            }
        });
        Sanctum::actingAs($this->pessoa('gestor'));

        $this->postJson('/api/admin/migrar')->assertStatus(500)->assertJson(['ok' => false, 'backup' => null]);
        $this->assertFalse(Schema::hasTable('auditoria_teste'), 'sem backup, a migração não pode rodar');
    }

    public function test_colaborador_nao_migra(): void
    {
        $this->migracaoPendente();
        Sanctum::actingAs($this->pessoa('colaborador'));

        $this->postJson('/api/admin/migrar')->assertForbidden();
        $this->assertSame([], $this->zipsDeBanco());
        $this->assertFalse(Schema::hasTable('auditoria_teste'));
    }

    public function test_leitura_por_ia_tem_limite_por_minuto(): void
    {
        config(['petermann.anthropic.key' => '']);   // IA "indisponível": responde na hora, sem chamar a Anthropic
        Sanctum::actingAs($this->pessoa('colaborador'));

        foreach (['/api/notas/ler-foto', '/api/km/ler-foto'] as $rota) {
            for ($i = 0; $i < 20; $i++) {
                $this->post($rota, ['file' => UploadedFile::fake()->image('a.jpg', 10, 10)], ['Accept' => 'application/json'])->assertOk();
            }
            $this->post($rota, ['file' => UploadedFile::fake()->image('a.jpg', 10, 10)], ['Accept' => 'application/json'])->assertStatus(429);
        }
    }
}
