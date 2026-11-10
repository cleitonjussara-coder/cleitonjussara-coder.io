<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Services\AlertaErro;
use App\Services\BackupCompleto;
use App\Services\DriveBackup;
use Illuminate\Foundation\Testing\Concerns\InteractsWithTime;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use PDO;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\TestCase;
use ZipArchive;

/**
 * 03/11/2026 — backup diário só do banco (backup:gerar --so-banco).
 *
 * O ZIP completo sai aos domingos: uma pane perdia até 7 dias. O perigo do
 * diário é a rotação: servidor e Drive guardam os dois tipos na mesma pasta,
 * e uma rodada diária jamais pode apagar um ZIP completo (nem o contrário).
 *
 * Sem RefreshDatabase de propósito: VACUUM INTO não roda dentro de transação
 * e em :memory: não há arquivo para copiar. Cada teste usa um banco em arquivo
 * numa pasta temporária, nunca o database.sqlite local.
 */
class BackupBancoDiarioTest extends TestCase
{
    use InteractsWithTime;

    private string $tmp;

    protected function setUp(): void
    {
        parent::setUp();
        $this->tmp = sys_get_temp_dir().'/backup-banco-teste-'.Str::random(8);
        mkdir($this->tmp.'/app/backups', 0777, true);
        $this->app->useStoragePath($this->tmp);

        touch($this->tmp.'/banco.sqlite');
        config(['database.connections.sqlite.database' => $this->tmp.'/banco.sqlite']);
        DB::purge('sqlite');
        Artisan::call('migrate', ['--force' => true]);

        Storage::fake('fotos');
        $this->travelTo(Carbon::parse('2026-11-03 05:30:00', 'UTC'));   // 02:30 em Brasília
    }

    protected function tearDown(): void
    {
        DB::purge('sqlite');
        File::deleteDirectory($this->tmp);
        parent::tearDown();
    }

    /* ── apoio ───────────────────────────────────────────────── */

    private function pasta(): string
    {
        return $this->tmp.'/app/backups';
    }

    /** Cria zips de mentira na pasta, um por dia, do mais antigo ao mais novo. */
    private function zipsNaPasta(string $prefixo, int $quantos, string $inicio = '2026-09-01', string $hora = '0230'): array
    {
        $nomes = $this->nomes($prefixo, $quantos, $inicio, $hora);
        foreach ($nomes as $n) {
            file_put_contents($this->pasta().'/'.$n, 'zip');
        }

        return $nomes;
    }

    private function nomes(string $prefixo, int $quantos, string $inicio = '2026-09-01', string $hora = '0230'): array
    {
        $d = Carbon::parse($inicio);
        $out = [];
        for ($i = 0; $i < $quantos; $i++) {
            $out[] = $prefixo.'-'.$d->copy()->addDays($i)->format('Y-m-d').'-'.$hora.'.zip';
        }

        return $out;
    }

    private function naPasta(string $prefixo): array
    {
        $out = array_map('basename', glob($this->pasta().'/'.$prefixo.'-*.zip') ?: []);
        sort($out);

        return $out;
    }

    private function entradasDoZip(string $caminho): array
    {
        $z = new ZipArchive;
        $this->assertTrue($z->open($caminho) === true, 'o zip abre');
        $out = [];
        for ($i = 0; $i < $z->numFiles; $i++) {
            $out[] = $z->getNameIndex($i);
        }
        $z->close();
        sort($out);

        return $out;
    }

    private function gravarConexao(array $d = []): void
    {
        file_put_contents($this->tmp.'/app/drive-backup.json', json_encode($d + ['refresh_token' => 'RT-BOM', 'email' => 'dono@teste.local', 'pasta_id' => 'PASTA']));
    }

    private function conexao(): array
    {
        return json_decode((string) file_get_contents($this->tmp.'/app/drive-backup.json'), true);
    }

    /**
     * Pasta do Drive de mentira, com os arquivos em $nomes. $respeitaFiltro
     * imita o "name contains" do Google; false devolve a pasta inteira, para
     * provar que o app não depende só do filtro de lá.
     */
    private function driveFalso(array $nomes, bool $respeitaFiltro = true): object
    {
        $g = new class
        {
            public array $arquivos = [];

            public array $apagados = [];

            public array $enviados = [];

            public ?string $nomeEmEnvio = null;
        };
        foreach ($nomes as $i => $n) {
            $g->arquivos['F'.$i] = $n;
        }

        Http::fake([
            'oauth2.googleapis.com/token' => Http::response(['access_token' => 'tok-acesso']),
            'www.googleapis.com/upload/drive/v3/files*' => function (Request $req) use ($g) {
                $g->nomeEmEnvio = $req->data()['name'] ?? null;

                return Http::response('', 200, ['Location' => 'https://upload.test/sessao-1']);
            },
            'upload.test/*' => function () use ($g) {
                $id = 'NOVO'.count($g->enviados);
                $g->arquivos[$id] = $g->nomeEmEnvio;
                $g->enviados[] = $g->nomeEmEnvio;

                return Http::response(['id' => $id], 200);
            },
            'www.googleapis.com/drive/v3/files/PASTA*' => Http::response(['id' => 'PASTA', 'trashed' => false]),
            'www.googleapis.com/drive/v3/files*' => function (Request $req) use ($g, $respeitaFiltro) {
                if ($req->method() === 'DELETE') {
                    $id = basename((string) parse_url($req->url(), PHP_URL_PATH));
                    $g->apagados[] = $g->arquivos[$id] ?? $id;
                    unset($g->arquivos[$id]);

                    return Http::response('', 204);
                }
                parse_str((string) parse_url($req->url(), PHP_URL_QUERY), $q);
                preg_match("/name contains '([^']+)'/", (string) ($q['q'] ?? ''), $m);
                $files = [];
                foreach ($g->arquivos as $id => $nome) {
                    if (! $respeitaFiltro || ! isset($m[1]) || str_contains($nome, $m[1])) {
                        $files[] = ['id' => $id, 'name' => $nome, 'size' => '3', 'createdTime' => '2026-11-01T00:00:00Z'];
                    }
                }

                return Http::response(['files' => $files]);
            },
        ]);

        return $g;
    }

    private function zipLocal(string $nome): string
    {
        $p = $this->pasta().'/'.$nome;
        file_put_contents($p, random_bytes(2048));

        return $p;
    }

    private function pessoa(string $role): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(),
            'nome' => ucfirst($role), 'email' => $role.'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    /** Troca o AlertaErro por um que só anota os avisos: [título, detalhe, chave]. */
    private function anotarAvisos(): \ArrayObject
    {
        $avisos = new \ArrayObject;
        $this->mock(AlertaErro::class, function ($m) use ($avisos) {
            $m->shouldReceive('avisar')->andReturnUsing(function ($titulo, $detalhe, $chave = null) use ($avisos) {
                $avisos->append([$titulo, $detalhe, $chave]);

                return true;
            });
        });

        return $avisos;
    }

    /* ── o zip do dia ────────────────────────────────────────── */

    public function test_so_banco_gera_zip_com_o_banco_e_sem_fotos(): void
    {
        Storage::disk('fotos')->put('colab-1/nota-1.jpg', 'foto');

        $saida = Artisan::call('backup:gerar', ['--so-banco' => true, '--sem-drive' => true]);

        $this->assertSame(0, $saida);
        $this->assertSame(['banco-2026-11-03-0230.zip'], $this->naPasta('banco'));
        $this->assertSame([], $this->naPasta('petermann'), 'o diário não gera ZIP completo');
        $this->assertSame(['LEIA-ME.txt', 'database.sqlite'], $this->entradasDoZip($this->pasta().'/banco-2026-11-03-0230.zip'));
        $this->assertSame([], glob($this->tmp.'/app/*.sqlite') ?: [], 'não sobra cópia temporária do banco');
    }

    public function test_o_banco_restaurado_abre_como_sqlite_valido_e_com_os_dados(): void
    {
        $colab = $this->pessoa('colaborador');
        Artisan::call('backup:gerar', ['--so-banco' => true, '--sem-drive' => true]);

        $z = new ZipArchive;
        $this->assertTrue($z->open($this->pasta().'/banco-2026-11-03-0230.zip') === true);
        $z->extractTo($this->tmp.'/restaurado');
        $z->close();

        $arq = $this->tmp.'/restaurado/database.sqlite';
        $this->assertStringStartsWith('SQLite format 3', (string) file_get_contents($arq, false, null, 0, 16));
        $pdo = new PDO('sqlite:'.$arq);
        $this->assertSame('ok', $pdo->query('PRAGMA integrity_check')->fetchColumn());
        $st = $pdo->prepare('SELECT nome FROM colaboradores WHERE id = ?');
        $st->execute([$colab->id]);
        $this->assertSame('Colaborador', $st->fetchColumn());
        unset($st, $pdo);
    }

    public function test_copia_vazia_do_banco_falha_e_nao_gira_as_copias_boas(): void
    {
        $antigos = $this->zipsNaPasta('banco', 20);
        $avisos = $this->anotarAvisos();
        $this->partialMock(BackupCompleto::class, function ($m) {
            $m->shouldReceive('copiarBanco')->andReturnUsing(function ($destino) {
                touch($destino);
            });
        });

        $saida = Artisan::call('backup:gerar', ['--so-banco' => true, '--sem-drive' => true]);

        $this->assertSame(1, $saida);
        $this->assertSame($antigos, $this->naPasta('banco'), 'nenhuma cópia boa sai por causa de um backup ruim');
        $this->assertCount(1, $avisos);
        $this->assertSame([], glob($this->tmp.'/app/*.sqlite') ?: []);
    }

    /* ── rotação no servidor ─────────────────────────────────── */

    public function test_rotacao_do_diario_guarda_7_por_padrao_e_nao_toca_nos_completos(): void
    {
        $this->zipsNaPasta('banco', 20);
        $completos = $this->zipsNaPasta('petermann', 3, '2026-08-02', '0330');

        Artisan::call('backup:gerar', ['--so-banco' => true, '--sem-drive' => true]);

        $this->assertCount(7, $this->naPasta('banco'));
        $this->assertContains('banco-2026-11-03-0230.zip', $this->naPasta('banco'));
        $this->assertSame($completos, $this->naPasta('petermann'));
    }

    public function test_rotacao_do_diario_respeita_manter_e_nunca_apaga_o_zip_que_acabou_de_sair(): void
    {
        $this->zipsNaPasta('banco', 6);

        Artisan::call('backup:gerar', ['--so-banco' => true, '--sem-drive' => true, '--manter' => 3]);
        $this->assertCount(3, $this->naPasta('banco'));

        Artisan::call('backup:gerar', ['--so-banco' => true, '--sem-drive' => true, '--manter' => 0]);
        $this->assertSame(['banco-2026-11-03-0230.zip'], $this->naPasta('banco'));
    }

    public function test_rotacao_do_completo_nao_toca_nos_diarios(): void
    {
        $diarios = $this->zipsNaPasta('banco', 5);
        $this->zipsNaPasta('petermann', 5, '2026-09-06', '0330');
        $this->anotarAvisos();   // os diários daqui são velhos: o aviso de "parou" não pode virar e-mail real

        Artisan::call('backup:gerar', ['--sem-drive' => true]);

        $this->assertCount(2, $this->naPasta('petermann'), 'o padrão do completo continua 2');
        $this->assertSame($diarios, $this->naPasta('banco'));
    }

    public function test_para_apagar_com_lista_misturada_nunca_cruza_os_tipos(): void
    {
        $banco = array_map(fn ($n) => ['nome' => $n], $this->nomes('banco', 4));
        $completo = array_map(fn ($n) => ['nome' => $n], $this->nomes('petermann', 4));
        $mistura = array_merge($banco, $completo, [['nome' => 'qualquer-coisa.zip']]);

        $saiBanco = array_column(BackupCompleto::paraApagar($mistura, 1, 0, BackupCompleto::PREFIXO_BANCO), 'nome');
        $saiCompleto = array_column(BackupCompleto::paraApagar($mistura, 1, 0), 'nome');

        $this->assertCount(3, $saiBanco);
        $this->assertCount(3, $saiCompleto);
        foreach ($saiBanco as $n) {
            $this->assertStringStartsWith('banco-', $n);
        }
        foreach ($saiCompleto as $n) {
            $this->assertStringStartsWith('petermann-', $n);
        }
    }

    /* ── rotação no Drive ────────────────────────────────────── */

    public static function filtroDoGoogle(): array
    {
        return ['Google filtra pelo nome' => [true], 'Google devolve a pasta inteira' => [false]];
    }

    #[DataProvider('filtroDoGoogle')]
    public function test_envio_do_diario_ao_drive_gira_so_os_diarios(bool $respeitaFiltro): void
    {
        $this->gravarConexao();
        $completos = $this->nomes('petermann', 3, '2026-08-02', '0330');
        $diarios = $this->nomes('banco', 4);
        $g = $this->driveFalso(array_merge($completos, $diarios), $respeitaFiltro);

        $r = (new DriveBackup)->enviar($this->zipLocal('banco-2026-11-03-0230.zip'), 2, 0);

        $this->assertSame(['banco-2026-11-03-0230.zip'], $g->enviados);
        $this->assertSame(3, $r['apagados']);
        $this->assertEqualsCanonicalizing(array_slice($diarios, 0, 3), $g->apagados);
        foreach ($completos as $n) {
            $this->assertContains($n, $g->arquivos, 'ZIP completo continua no Drive');
        }
    }

    #[DataProvider('filtroDoGoogle')]
    public function test_envio_do_completo_ao_drive_gira_so_os_completos(bool $respeitaFiltro): void
    {
        $this->gravarConexao();
        $completos = $this->nomes('petermann', 3, '2026-08-02', '0330');
        $diarios = $this->nomes('banco', 4);
        $g = $this->driveFalso(array_merge($completos, $diarios), $respeitaFiltro);

        $r = (new DriveBackup)->enviar($this->zipLocal('petermann-2026-11-01-0330.zip'), 1, 0);

        $this->assertSame(3, $r['apagados']);
        $this->assertEqualsCanonicalizing($completos, $g->apagados);
        foreach ($diarios as $n) {
            $this->assertContains($n, $g->arquivos, 'diário continua no Drive');
        }
    }

    public function test_comando_diario_guarda_30_no_drive_sem_mensal_e_preserva_os_completos(): void
    {
        $this->gravarConexao();
        $completos = $this->nomes('petermann', 3, '2026-08-02', '0330');
        $diarios = $this->nomes('banco', 35);
        $g = $this->driveFalso(array_merge($completos, $diarios));

        $saida = Artisan::call('backup:gerar', ['--so-banco' => true]);

        $this->assertSame(0, $saida);
        $sobra = array_values($g->arquivos);
        $this->assertCount(30, array_filter($sobra, fn ($n) => str_starts_with($n, 'banco-')));
        $this->assertContains('banco-2026-11-03-0230.zip', $sobra);
        foreach ($completos as $n) {
            $this->assertContains($n, $sobra);
        }
    }

    public function test_nome_desconhecido_nao_sobe_nem_gira_nada_no_drive(): void
    {
        $this->gravarConexao();
        $g = $this->driveFalso($this->nomes('petermann', 3));

        try {
            (new DriveBackup)->enviar($this->zipLocal('outra-coisa.zip'), 1, 0);
            $this->fail('devia recusar');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('outra-coisa.zip', $e->getMessage());
        }

        $this->assertSame([], $g->apagados);
        $this->assertSame([], $g->enviados);
    }

    /* ── a tela do app continua vendo só os completos ────────── */

    public function test_tela_de_backups_so_ve_os_completos_em_cada_papel(): void
    {
        $this->zipsNaPasta('petermann', 1, '2026-11-01', '0330');
        $this->zipsNaPasta('banco', 1, '2026-11-03');

        Sanctum::actingAs($this->pessoa('colaborador'));
        $this->getJson('/api/backup/lista')->assertForbidden();

        foreach (['gestor', 'admin'] as $papel) {
            Sanctum::actingAs($this->pessoa($papel));
            $nomes = array_column($this->getJson('/api/backup/lista')->assertOk()->json('backups'), 'nome');
            $this->assertSame(['petermann-2026-11-01-0330.zip'], $nomes);
            $this->get('/api/backup/arquivo/banco-2026-11-03-0230.zip')->assertNotFound();
            $this->get('/api/backup/arquivo/petermann-2026-11-01-0330.zip')->assertOk();
        }
    }

    public function test_enviar_agora_sobe_o_completo_mesmo_com_diario_mais_novo(): void
    {
        $this->gravarConexao();
        $this->zipsNaPasta('petermann', 1, '2026-11-01', '0330');
        $this->zipsNaPasta('banco', 1, '2026-11-03');
        $g = $this->driveFalso([]);

        Sanctum::actingAs($this->pessoa('gestor'));
        $this->postJson('/api/backup/drive/enviar')->assertOk();

        $this->assertSame(['petermann-2026-11-01-0330.zip'], $g->enviados);
    }

    /* ── o que o Perfil mostra do Drive ──────────────────────── */

    public function test_envio_diario_nao_esconde_o_atraso_nem_o_erro_do_completo(): void
    {
        $this->gravarConexao([
            'ultimo_envio' => '2026-10-04T03:31:00-03:00',
            'ultimo_arquivo' => 'petermann-2026-10-04-0330.zip',
            'ultimo_erro' => '01/11/2026 03:40 — upload interrompido',
        ]);
        $this->driveFalso([]);

        (new DriveBackup)->enviar($this->zipLocal('banco-2026-11-03-0230.zip'), 30, 0);

        $s = (new DriveBackup)->status();
        $this->assertSame('2026-10-04T03:31:00-03:00', $s['ultimo_envio'], 'o aviso de "confira o Crontab" olha o completo');
        $this->assertSame('petermann-2026-10-04-0330.zip', $s['ultimo_arquivo']);
        $this->assertStringContainsString('upload interrompido', $s['ultimo_erro']);
        $this->assertSame('banco-2026-11-03-0230.zip', $s['ultimo_arquivo_banco']);
        $this->assertNotNull($s['ultimo_envio_banco']);
    }

    public function test_erro_do_diario_aparece_no_perfil_e_some_no_proximo_envio_bom(): void
    {
        $this->gravarConexao();
        Http::fake(['oauth2.googleapis.com/token' => Http::response(['error' => 'invalid_grant'], 400)]);
        $zip = $this->zipLocal('banco-2026-11-03-0230.zip');
        try {
            (new DriveBackup)->enviar($zip, 30, 0);
            $this->fail('devia falhar');
        } catch (RuntimeException) {
        }
        $s = (new DriveBackup)->status();
        $this->assertStringContainsString('invalid_grant', $s['ultimo_erro']);
        $this->assertStringContainsString('banco', $s['ultimo_erro']);
        $this->assertArrayNotHasKey('ultimo_erro', $this->conexao(), 'a falha do diário não entra no campo do completo');

        Http::swap(new \Illuminate\Http\Client\Factory);
        $this->driveFalso([]);
        (new DriveBackup)->enviar($zip, 30, 0);

        $this->assertNull((new DriveBackup)->status()['ultimo_erro']);
    }

    public function test_erro_antigo_do_completo_nao_esconde_a_falha_do_diario_no_perfil(): void
    {
        $this->gravarConexao([
            'ultimo_erro' => '01/11/2026 03:40 — upload interrompido',
            'banco_ultimo_erro' => '03/11/2026 02:31 — invalid_grant',
        ]);

        $erro = (new DriveBackup)->status()['ultimo_erro'];

        $this->assertStringContainsString('upload interrompido', $erro);
        $this->assertStringContainsString('Backup diário do banco: 03/11/2026 02:31 — invalid_grant', $erro);
    }

    /* ── o diário parou de rodar ─────────────────────────────── */

    public function test_rodada_do_completo_avisa_se_o_diario_nunca_rodou(): void
    {
        $avisos = $this->anotarAvisos();

        $this->assertSame(0, Artisan::call('backup:gerar', ['--sem-drive' => true]));

        $this->assertCount(1, $avisos);
        [$titulo, $detalhe, $chave] = $avisos[0];
        $this->assertStringContainsString('diário', $titulo);
        $this->assertStringContainsString('--so-banco', $detalhe);
        $this->assertSame('backup-banco-parado', $chave);
    }

    public function test_rodada_do_completo_avisa_se_o_diario_parou_ha_mais_de_2_dias(): void
    {
        $this->zipsNaPasta('banco', 3, '2026-10-29');   // o mais novo é de 31/10 02:30
        $avisos = $this->anotarAvisos();

        $this->assertSame(0, Artisan::call('backup:gerar', ['--sem-drive' => true]));

        $this->assertCount(1, $avisos);
        $this->assertStringContainsString('banco-2026-10-31-0230.zip', $avisos[0][1]);
        $this->assertCount(3, $this->naPasta('banco'), 'detectar e avisar é o limite: nada é apagado por isso');
    }

    public function test_rodada_do_completo_nao_avisa_com_o_diario_em_dia(): void
    {
        $this->zipsNaPasta('banco', 1, '2026-11-02');
        $avisos = $this->anotarAvisos();

        $this->assertSame(0, Artisan::call('backup:gerar', ['--sem-drive' => true]));

        $this->assertCount(0, $avisos);
    }

    public function test_rodada_diaria_nao_confere_a_si_mesma(): void
    {
        $this->zipsNaPasta('banco', 1, '2026-09-01');
        $avisos = $this->anotarAvisos();

        $this->assertSame(0, Artisan::call('backup:gerar', ['--so-banco' => true, '--sem-drive' => true]));

        $this->assertCount(0, $avisos);
    }

    public function test_falha_ao_avisar_que_o_diario_parou_nao_derruba_o_completo_nem_o_drive(): void
    {
        $this->gravarConexao();
        $g = $this->driveFalso([]);
        $this->mock(AlertaErro::class, function ($m) {
            $m->shouldReceive('avisar')->andThrow(new RuntimeException('sem e-mail'));
        });

        $this->assertSame(0, Artisan::call('backup:gerar'));

        $this->assertSame(['petermann-2026-11-03-0230.zip'], $g->enviados);
    }

    /* ── avisos de falha ─────────────────────────────────────── */

    public function test_aviso_de_falha_diz_que_foi_o_diario(): void
    {
        $avisos = $this->anotarAvisos();
        $this->mock(BackupCompleto::class, function ($m) {
            $m->shouldReceive('gerarBanco')->andThrow(new RuntimeException('disco cheio'));
            $m->shouldNotReceive('podar');
        });

        $this->assertSame(1, Artisan::call('backup:gerar', ['--so-banco' => true, '--sem-drive' => true]));

        $this->assertCount(1, $avisos);
        [$titulo, $detalhe, $chave] = $avisos[0];
        $this->assertStringContainsString('diário', $titulo);
        $this->assertStringContainsString('banco', $titulo);
        $this->assertStringNotContainsString('semanal', $titulo);
        $this->assertStringContainsString('--so-banco', $detalhe);
        $this->assertStringContainsString('disco cheio', $detalhe);
        $this->assertSame('backup-banco-falhou', $chave);
    }

    public function test_aviso_de_falha_diz_que_foi_o_completo(): void
    {
        $avisos = $this->anotarAvisos();
        $this->mock(BackupCompleto::class, function ($m) {
            $m->shouldReceive('gerar')->andThrow(new RuntimeException('disco cheio'));
            $m->shouldNotReceive('podar');
        });

        $this->assertSame(1, Artisan::call('backup:gerar', ['--sem-drive' => true]));

        [$titulo, , $chave] = $avisos[0];
        $this->assertStringContainsString('completo', $titulo);
        $this->assertStringContainsString('semanal', $titulo);
        $this->assertSame('backup-falhou', $chave, 'chave separada: o freio de 1 hora de um não engole o aviso do outro');
    }

    public function test_aviso_do_drive_diz_qual_zip_nao_subiu(): void
    {
        $this->gravarConexao();
        $avisos = $this->anotarAvisos();
        Http::fake(['oauth2.googleapis.com/token' => Http::response(['error' => 'invalid_grant'], 400)]);

        $this->assertSame(0, Artisan::call('backup:gerar', ['--so-banco' => true]), 'falha no Drive não é falha do backup');
        $this->assertSame(0, Artisan::call('backup:gerar', []));

        $this->assertCount(2, $avisos);
        $this->assertStringContainsString('banco', $avisos[0][0].$avisos[0][1]);
        $this->assertStringNotContainsString('semana', $avisos[0][1]);
        $this->assertSame('backup-banco-drive-falhou', $avisos[0][2]);
        $this->assertStringContainsString('semana', $avisos[1][1]);
        $this->assertSame('backup-drive-falhou', $avisos[1][2]);
    }
}
