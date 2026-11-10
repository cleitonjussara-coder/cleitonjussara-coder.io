<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Services\AlertaErro;
use App\Services\BackupCompleto;
use App\Services\DriveBackup;
use App\Services\FotoStorage;
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
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\TestCase;
use ZipArchive;

/**
 * 05/11/2026 — backup diário das fotos (backup:gerar --fotos-novas).
 *
 * O teste de restauração provou o buraco: o banco tem cópia diária, mas o anexo
 * só entrava no ZIP completo de domingo, e nota nova ficava até 7 dias sem cópia
 * da foto. O fotos-*.zip leva tudo o que mudou desde o último completo, então
 * restaurar é sempre: último completo + último fotos.
 *
 * Mesmo perigo do diário do banco: os três tipos moram na mesma pasta, no servidor
 * e no Drive, e nenhum pode apagar o outro. Banco em arquivo temporário pelo mesmo
 * motivo de BackupBancoDiarioTest (VACUUM INTO), nunca o database.sqlite local.
 */
class BackupFotosDiarioTest extends TestCase
{
    use InteractsWithTime;

    private const COMPLETO = 'petermann-2026-11-01-0330.zip';

    private const ZIP_DO_DIA = 'fotos-2026-11-05-0245.zip';

    private string $tmp;

    protected function setUp(): void
    {
        parent::setUp();
        $this->tmp = sys_get_temp_dir().'/backup-fotos-teste-'.Str::random(8);
        mkdir($this->tmp.'/app/backups', 0777, true);
        $this->app->useStoragePath($this->tmp);

        touch($this->tmp.'/banco.sqlite');
        config(['database.connections.sqlite.database' => $this->tmp.'/banco.sqlite']);
        DB::purge('sqlite');
        Artisan::call('migrate', ['--force' => true]);

        Storage::fake('fotos');
        $this->travelTo(Carbon::parse('2026-11-05 05:45:00', 'UTC'));   // 02:45 em Brasília
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

    /** Anexo no disco com a data de modificação pedida (em UTC). */
    private function foto(string $rel, string $quando, string $conteudo = 'foto'): void
    {
        Storage::disk('fotos')->put($rel, $conteudo);
        touch(Storage::disk('fotos')->path($rel), Carbon::parse($quando, 'UTC')->getTimestamp());
    }

    private function completoNaPasta(string $nome = self::COMPLETO): void
    {
        file_put_contents($this->pasta().'/'.$nome, 'zip');
    }

    private function nomes(string $prefixo, int $quantos, string $inicio = '2026-09-01', string $hora = '0245'): array
    {
        $d = Carbon::parse($inicio);
        $out = [];
        for ($i = 0; $i < $quantos; $i++) {
            $out[] = $prefixo.'-'.$d->copy()->addDays($i)->format('Y-m-d').'-'.$hora.'.zip';
        }

        return $out;
    }

    private function zipsNaPasta(string $prefixo, int $quantos, string $inicio = '2026-09-01', string $hora = '0245'): array
    {
        $nomes = $this->nomes($prefixo, $quantos, $inicio, $hora);
        foreach ($nomes as $n) {
            file_put_contents($this->pasta().'/'.$n, 'zip');
        }

        return $nomes;
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

    private function metodoDeCompressao(string $zip, string $entrada): int
    {
        $z = new ZipArchive;
        $this->assertTrue($z->open($zip) === true);
        $st = $z->statName($entrada);
        $z->close();

        return $st['comp_method'];
    }

    private function lerDoZip(string $zip, string $entrada): string
    {
        $z = new ZipArchive;
        $this->assertTrue($z->open($zip) === true);
        $s = (string) $z->getFromName($entrada);
        $z->close();

        return $s;
    }

    private function gravarConexao(array $d = []): void
    {
        file_put_contents($this->tmp.'/app/drive-backup.json', json_encode($d + ['refresh_token' => 'RT-BOM', 'email' => 'dono@teste.local', 'pasta_id' => 'PASTA']));
    }

    /** Pasta do Drive de mentira. $respeitaFiltro false devolve a pasta inteira: o app não pode depender do filtro de lá. */
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

    private function rodar(array $opcoes = []): int
    {
        return Artisan::call('backup:gerar', ['--fotos-novas' => true, '--sem-drive' => true] + $opcoes);
    }

    /* ── o que entra no zip ──────────────────────────────────── */

    public function test_fotos_novas_entram_e_as_antigas_nao(): void
    {
        $this->completoNaPasta();
        $this->foto('colab-1/antiga.jpg', '2026-10-20 12:00:00');
        $this->foto('colab-1/nova.jpg', '2026-11-03 12:00:00');
        $this->foto('colab-2/km-1.pdf', '2026-11-04 12:00:00');

        $this->assertSame(0, $this->rodar());

        $this->assertSame([self::ZIP_DO_DIA], $this->naPasta('fotos'));
        $zip = $this->pasta().'/'.self::ZIP_DO_DIA;
        $this->assertSame(['LEIA-ME.txt', 'fotos/colab-1/nova.jpg', 'fotos/colab-2/km-1.pdf'], $this->entradasDoZip($zip));
        $this->assertSame('foto', $this->lerDoZip($zip, 'fotos/colab-1/nova.jpg'));
        $this->assertSame(ZipArchive::CM_STORE, $this->metodoDeCompressao($zip, 'fotos/colab-1/nova.jpg'), 'jpg não encolhe: comprimir só gasta tempo');
        $this->assertSame([self::COMPLETO], $this->naPasta('petermann'));
        $this->assertSame([], $this->naPasta('banco'));
    }

    public function test_folga_de_um_dia_conta_da_hora_de_brasilia_do_nome_do_completo(): void
    {
        /* 01/11 03:30 em Brasília = 06:30 UTC; menos 1 dia = 31/10 06:30 UTC */
        $this->completoNaPasta();
        $this->foto('c/fora.jpg', '2026-10-31 06:29:00');
        $this->foto('c/dentro.jpg', '2026-10-31 06:31:00');

        $this->rodar();

        $this->assertSame(['LEIA-ME.txt', 'fotos/c/dentro.jpg'], $this->entradasDoZip($this->pasta().'/'.self::ZIP_DO_DIA));
    }

    public function test_base_e_o_completo_mais_novo(): void
    {
        $this->completoNaPasta('petermann-2026-10-25-0330.zip');
        $this->completoNaPasta();
        $this->foto('c/de-antes-do-ultimo.jpg', '2026-10-28 12:00:00');
        $this->foto('c/nova.jpg', '2026-11-02 12:00:00');

        $this->rodar();

        $this->assertSame(['LEIA-ME.txt', 'fotos/c/nova.jpg'], $this->entradasDoZip($this->pasta().'/'.self::ZIP_DO_DIA));
    }

    public function test_data_do_completo_vem_do_nome_e_nao_da_data_do_arquivo(): void
    {
        $this->completoNaPasta();
        touch($this->pasta().'/'.self::COMPLETO, Carbon::parse('2026-11-05 05:00:00', 'UTC')->getTimestamp());   // cópia/restauração muda a data do arquivo
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');

        $this->rodar();

        $this->assertContains('fotos/c/nova.jpg', $this->entradasDoZip($this->pasta().'/'.self::ZIP_DO_DIA));
    }

    public function test_miniatura_e_temporario_ficam_de_fora(): void
    {
        $this->completoNaPasta();
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');
        $this->foto('c/mini/nova.jpg', '2026-11-03 12:00:00');
        $this->foto('c/.tmp-nota-abc.jpg', '2026-11-03 12:00:00');

        $this->rodar();

        $this->assertSame(['LEIA-ME.txt', 'fotos/c/nova.jpg'], $this->entradasDoZip($this->pasta().'/'.self::ZIP_DO_DIA));
    }

    public function test_leia_me_diz_a_base_e_como_restaurar(): void
    {
        $this->completoNaPasta();
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');

        $this->rodar();

        $txt = $this->lerDoZip($this->pasta().'/'.self::ZIP_DO_DIA, 'LEIA-ME.txt');
        $this->assertStringContainsString(self::COMPLETO, $txt);
        $this->assertStringContainsString('storage/app/fotos', $txt);
        $this->assertStringContainsString('banco-', $txt);
        $this->assertStringContainsString('mais novo', $txt);
    }

    /* ── sem completo, sem foto nova, opções trocadas ────────── */

    public function test_sem_completo_falha_com_erro_claro_e_nao_gera_nada(): void
    {
        $this->zipsNaPasta('banco', 2);   // banco diário não serve de base
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');
        $avisos = $this->anotarAvisos();

        $this->assertSame(1, $this->rodar());

        $this->assertStringContainsString('completo', Artisan::output());
        $this->assertSame([], $this->naPasta('fotos'));
        $this->assertCount(1, $avisos);
        $this->assertSame('backup-fotos-falhou', $avisos[0][2]);
        $this->assertStringContainsString('completo', $avisos[0][1]);
    }

    public function test_sem_foto_nova_nao_cria_zip_sai_com_sucesso_e_nao_mexe_em_nada(): void
    {
        $this->completoNaPasta();
        $this->foto('c/antiga.jpg', '2026-10-01 12:00:00');
        $antigos = $this->zipsNaPasta('fotos', 10);
        $this->gravarConexao();
        $g = $this->driveFalso($this->nomes('fotos', 20));
        $avisos = $this->anotarAvisos();

        $saida = Artisan::call('backup:gerar', ['--fotos-novas' => true]);

        $this->assertSame(0, $saida);
        $this->assertStringContainsString('nenhuma foto nova', Artisan::output());
        $this->assertSame($antigos, $this->naPasta('fotos'), 'sem zip novo a rotação não anda');
        $this->assertSame([], $g->enviados);
        $this->assertSame([], $g->apagados);
        $this->assertCount(0, $avisos);
    }

    public function test_so_miniatura_nova_conta_como_sem_foto_nova(): void
    {
        $this->completoNaPasta();
        $this->foto('c/mini/nova.jpg', '2026-11-03 12:00:00');

        $this->assertSame(0, $this->rodar());

        $this->assertSame([], $this->naPasta('fotos'));
    }

    public function test_fotos_novas_com_so_banco_e_erro_claro_e_nao_gera_nada(): void
    {
        $this->completoNaPasta();
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');
        $this->anotarAvisos();

        $saida = $this->rodar(['--so-banco' => true]);

        $texto = Artisan::output();   // a segunda leitura vem vazia
        $this->assertSame(1, $saida);
        $this->assertStringContainsString('--fotos-novas', $texto);
        $this->assertStringContainsString('--so-banco', $texto);
        $this->assertSame([], $this->naPasta('fotos'));
        $this->assertSame([], $this->naPasta('banco'));
    }

    public function test_zip_que_nao_fecha_vira_excecao(): void
    {
        $this->completoNaPasta();
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('zip das fotos novas');
        app(BackupCompleto::class)->gerarFotos($this->tmp.'/pasta-que-nao-existe/fotos.zip');
    }

    public function test_cada_zip_do_dia_traz_tudo_desde_o_completo_sem_depender_do_anterior(): void
    {
        $this->completoNaPasta();
        $this->foto('c/segunda.jpg', '2026-11-02 12:00:00');
        $this->travelTo(Carbon::parse('2026-11-03 05:45:00', 'UTC'));
        $this->rodar();

        $this->foto('c/terca.jpg', '2026-11-03 12:00:00');
        $this->travelTo(Carbon::parse('2026-11-04 05:45:00', 'UTC'));
        $this->rodar();

        $this->assertSame(['fotos-2026-11-03-0245.zip', 'fotos-2026-11-04-0245.zip'], $this->naPasta('fotos'));
        $this->assertSame(
            ['LEIA-ME.txt', 'fotos/c/segunda.jpg', 'fotos/c/terca.jpg'],
            $this->entradasDoZip($this->pasta().'/fotos-2026-11-04-0245.zip'),
        );
    }

    /* ── anexo que muda enquanto o zip é montado ─────────────── */

    /** O zip fixa o tamanho no addFile e só lê o arquivo no close(): é nesse intervalo que $mexer roda, a cada fechamento. */
    private function backupQueMexeAntesDeFechar(callable $mexer): object
    {
        return new class($mexer) extends BackupCompleto
        {
            public int $fechamentos = 0;

            public function __construct(private $mexer) {}

            protected function fecharZip(ZipArchive $zip): bool
            {
                ($this->mexer)(++$this->fechamentos);

                return parent::fecharZip($zip);
            }
        };
    }

    /** Troca como o salvarPara: grava ao lado e move por cima. */
    private function trocarAnexo(string $rel, string $conteudo): void
    {
        $p = Storage::disk('fotos')->path($rel);
        file_put_contents($p.'.troca', $conteudo);
        rename($p.'.troca', $p);
    }

    public static function trocas(): array
    {
        return ['por um maior' => [200000], 'por um menor' => [50000]];
    }

    #[DataProvider('trocas')]
    public function test_anexo_trocado_antes_de_fechar_sai_inteiro(int $novoTamanho): void
    {
        $this->completoNaPasta();
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00', str_repeat('A', 100000));
        $novo = str_repeat('B', $novoTamanho);
        $b = $this->backupQueMexeAntesDeFechar(function (int $vez) use ($novo) {
            if ($vez === 1) {
                $this->trocarAnexo('c/nova.jpg', $novo);
            }
        });

        $r = $b->gerarFotos($this->pasta().'/'.self::ZIP_DO_DIA);

        $this->assertSame(2, $b->fechamentos);
        $this->assertSame(1, $r['fotos']);
        $this->assertSame($novo, $this->lerDoZip($r['arquivo'], 'fotos/c/nova.jpg'));
    }

    public function test_anexo_apagado_antes_de_fechar_nao_derruba_o_zip_do_dia(): void
    {
        $this->completoNaPasta();
        $this->foto('c/fica.jpg', '2026-11-03 12:00:00');
        $this->foto('c/some.jpg', '2026-11-03 12:00:00');
        $b = $this->backupQueMexeAntesDeFechar(function (int $vez) {
            if ($vez === 1) {
                Storage::disk('fotos')->delete('c/some.jpg');
            }
        });

        $r = $b->gerarFotos($this->pasta().'/'.self::ZIP_DO_DIA);

        $this->assertSame(1, $r['fotos']);
        $this->assertSame(['LEIA-ME.txt', 'fotos/c/fica.jpg'], $this->entradasDoZip($r['arquivo']));
    }

    public function test_anexo_que_nunca_para_de_mudar_vira_falha_sem_deixar_zip(): void
    {
        $this->completoNaPasta();
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00', 'a');
        $b = $this->backupQueMexeAntesDeFechar(function (int $vez) {
            $this->trocarAnexo('c/nova.jpg', str_repeat('b', 1000 * $vez));
        });

        try {
            $b->gerarFotos($this->pasta().'/'.self::ZIP_DO_DIA);
            $this->fail('zip com foto cortada não pode sair como sucesso');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('zip das fotos novas', $e->getMessage());
        }

        $this->assertSame(3, $b->fechamentos);
        $this->assertSame([self::COMPLETO], array_values(array_diff(scandir($this->pasta()), ['.', '..'])));
    }

    /* ── comparação com o que o completo guardou ─────────────── */

    private function gerarCompletoDeVerdade(): void
    {
        $this->travelTo(Carbon::parse('2026-11-01 06:30:00', 'UTC'));
        app(BackupCompleto::class)->gerar($this->pasta().'/'.self::COMPLETO);
        $this->travelTo(Carbon::parse('2026-11-05 05:45:00', 'UTC'));
    }

    /** Extrai os zips na ordem do LEIA-ME e devolve o conteúdo de um anexo restaurado. */
    private function restaurado(array $zips, string $rel): ?string
    {
        $alvo = $this->tmp.'/restaurado-'.Str::random(6);
        foreach ($zips as $nome) {
            $z = new ZipArchive;
            $this->assertTrue($z->open($this->pasta().'/'.$nome) === true);
            $z->extractTo($alvo);
            $z->close();
        }
        $p = $alvo.'/fotos/'.$rel;

        return is_file($p) ? (string) file_get_contents($p) : null;
    }

    public static function promocoes(): array
    {
        return ['tamanho diferente' => ['NOVO'], 'mesmo tamanho' => ['NOVO-1']];
    }

    #[DataProvider('promocoes')]
    public function test_espera_promovida_depois_do_completo_com_data_antiga_nao_volta_o_comprovante_velho(string $novo): void
    {
        $this->foto('user1/nota1.pdf', '2026-10-01 12:00:00', 'ANTIGO');
        $this->foto('user1/espera/nota1.pdf', '2026-10-29 12:00:00', $novo);
        $this->gerarCompletoDeVerdade();

        app(FotoStorage::class)->promoverEspera('user1', 'nota1');
        $this->foto('user1/outra.pdf', '2026-11-03 12:00:00');
        $this->rodar();

        $this->assertSame(['LEIA-ME.txt', 'fotos/user1/nota1.pdf', 'fotos/user1/outra.pdf'], $this->entradasDoZip($this->pasta().'/'.self::ZIP_DO_DIA));
        $this->assertSame($novo, $this->restaurado([self::COMPLETO, self::ZIP_DO_DIA], 'user1/nota1.pdf'));
    }

    public function test_espera_promovida_sem_anexo_anterior_tambem_entra(): void
    {
        $this->foto('user1/espera/nota2.pdf', '2026-10-29 12:00:00', 'NOVO');
        $this->gerarCompletoDeVerdade();

        app(FotoStorage::class)->promoverEspera('user1', 'nota2');
        $this->rodar();

        $this->assertSame('NOVO', $this->restaurado([self::COMPLETO, self::ZIP_DO_DIA], 'user1/nota2.pdf'));
    }

    public function test_anexo_igual_ao_do_completo_nao_entra_de_novo(): void
    {
        $this->foto('a/velha.jpg', '2026-09-10 12:00:01', 'velha');
        $this->foto('a/velha-par.jpg', '2026-09-10 12:00:02', 'velha');
        $this->gerarCompletoDeVerdade();

        $this->assertSame(0, $this->rodar());

        $this->assertSame([], $this->naPasta('fotos'), 'a comparação não pode transformar o diário num completo disfarçado');
    }

    public function test_completo_ilegivel_cai_na_data_do_arquivo_e_ainda_faz_o_zip(): void
    {
        $this->completoNaPasta();   // conteúdo que não é zip
        $this->foto('c/antiga.jpg', '2026-10-20 12:00:00');
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');

        $this->assertSame(0, $this->rodar());

        $this->assertSame(['LEIA-ME.txt', 'fotos/c/nova.jpg'], $this->entradasDoZip($this->pasta().'/'.self::ZIP_DO_DIA));
    }

    /* ── rotação no servidor ─────────────────────────────────── */

    public function test_rotacao_das_fotos_guarda_3_por_padrao_e_nao_toca_nos_outros(): void
    {
        $completos = $this->zipsNaPasta('petermann', 3, '2026-08-02', '0330');
        $this->completoNaPasta();
        $completos[] = self::COMPLETO;
        sort($completos);
        $bancos = $this->zipsNaPasta('banco', 20);
        $this->zipsNaPasta('fotos', 20);
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');

        $this->rodar();

        $this->assertCount(3, $this->naPasta('fotos'));
        $this->assertContains(self::ZIP_DO_DIA, $this->naPasta('fotos'));
        $this->assertSame($completos, $this->naPasta('petermann'));
        $this->assertSame($bancos, $this->naPasta('banco'));
    }

    public function test_rotacao_das_fotos_nunca_apaga_o_zip_que_acabou_de_sair(): void
    {
        $this->completoNaPasta();
        $this->zipsNaPasta('fotos', 5);
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');

        $this->rodar(['--manter' => 0]);

        $this->assertSame([self::ZIP_DO_DIA], $this->naPasta('fotos'));
    }

    public function test_rotacao_do_banco_e_do_completo_nao_tocam_nas_fotos(): void
    {
        $fotos = $this->zipsNaPasta('fotos', 20);
        $this->zipsNaPasta('banco', 20);
        $this->zipsNaPasta('petermann', 5, '2026-09-06', '0330');
        $this->anotarAvisos();

        Artisan::call('backup:gerar', ['--so-banco' => true, '--sem-drive' => true]);
        Artisan::call('backup:gerar', ['--sem-drive' => true]);

        $this->assertCount(7, $this->naPasta('banco'));
        $this->assertCount(2, $this->naPasta('petermann'));
        $this->assertSame($fotos, $this->naPasta('fotos'));
    }

    /* ── trava: o servidor só apaga o que está no Drive (07/11/2026) ── */

    public function test_servidor_so_apaga_a_copia_antiga_que_ja_esta_no_drive(): void
    {
        $this->gravarConexao();
        $this->completoNaPasta();
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');
        $antigos = $this->zipsNaPasta('fotos', 6, '2026-10-20');
        $g = $this->driveFalso(array_slice($antigos, 0, 2));   // no Drive só os 2 mais velhos

        $this->assertSame(0, Artisan::call('backup:gerar', ['--fotos-novas' => true]));

        $this->assertContains(self::ZIP_DO_DIA, $g->enviados);
        /* a regra manda tirar 20 a 23/10; só 20 e 21 estão no Drive, então 22 e 23 ficam */
        $this->assertSame([$antigos[2], $antigos[3], $antigos[4], $antigos[5], self::ZIP_DO_DIA], $this->naPasta('fotos'));
    }

    public function test_com_tudo_no_drive_o_servidor_fica_so_com_as_3_mais_novas(): void
    {
        $this->gravarConexao();
        $this->completoNaPasta();
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');
        $antigos = $this->zipsNaPasta('fotos', 6, '2026-10-20');
        $this->driveFalso($antigos);

        Artisan::call('backup:gerar', ['--fotos-novas' => true]);

        $this->assertSame([$antigos[4], $antigos[5], self::ZIP_DO_DIA], $this->naPasta('fotos'));
    }

    public function test_drive_desconectado_nao_apaga_nada_no_servidor(): void
    {
        Http::fake();
        $this->completoNaPasta();
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');
        $antigos = $this->zipsNaPasta('fotos', 6, '2026-10-20');

        $this->assertSame(0, Artisan::call('backup:gerar', ['--fotos-novas' => true]));

        $this->assertSame([...$antigos, self::ZIP_DO_DIA], $this->naPasta('fotos'));
        Http::assertNothingSent();
    }

    public function test_drive_com_erro_nao_apaga_nada_no_servidor_e_avisa(): void
    {
        $this->gravarConexao();
        Http::fake(['oauth2.googleapis.com/token' => Http::response(['error' => 'invalid_grant'], 400)]);
        $avisos = $this->anotarAvisos();
        $this->completoNaPasta();
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');
        $antigos = $this->zipsNaPasta('fotos', 6, '2026-10-20');

        $this->assertSame(0, Artisan::call('backup:gerar', ['--fotos-novas' => true]));

        $this->assertSame([...$antigos, self::ZIP_DO_DIA], $this->naPasta('fotos'));
        $this->assertCount(1, $avisos);
        $this->assertStringContainsString('Google Drive', $avisos[0][0]);
    }

    public function test_completo_tambem_so_sai_do_servidor_se_estiver_no_drive(): void
    {
        $this->gravarConexao();
        $this->anotarAvisos();
        $velhos = $this->zipsNaPasta('petermann', 4, '2026-10-04', '0330');   // 04, 05, 06 e 07/10
        $this->zipsNaPasta('banco', 1, '2026-11-05', '0230');
        $this->driveFalso([$velhos[0]]);

        Artisan::call('backup:gerar');

        $naPasta = $this->naPasta('petermann');
        $this->assertCount(4, $naPasta, 'novo + 07/10 pela regra; 05 e 06/10 não estão no Drive');
        $this->assertNotContains($velhos[0], $naPasta);
    }

    public function test_para_apagar_com_os_tres_tipos_nunca_cruza(): void
    {
        $mistura = array_map(fn ($n) => ['nome' => $n], array_merge(
            $this->nomes('fotos', 4), $this->nomes('banco', 4), $this->nomes('petermann', 4), ['qualquer-coisa.zip', 'fotos-velhas.zip'],
        ));

        foreach (['fotos', 'banco', 'petermann'] as $tipo) {
            $sai = array_column(BackupCompleto::paraApagar($mistura, 1, 0, $tipo), 'nome');
            $this->assertCount(3, $sai);
            foreach ($sai as $n) {
                $this->assertStringStartsWith($tipo.'-', $n);
            }
        }
    }

    public function test_prefixo_de_reconhece_os_tres_tipos(): void
    {
        $this->assertSame(BackupCompleto::PREFIXO_FOTOS, BackupCompleto::prefixoDe('fotos-2026-11-05-0245.zip'));
        $this->assertSame(BackupCompleto::PREFIXO_BANCO, BackupCompleto::prefixoDe('banco-2026-11-05-0230.zip'));
        $this->assertSame(BackupCompleto::PREFIXO_COMPLETO, BackupCompleto::prefixoDe('petermann-2026-11-01-0330.zip'));
        $this->assertNull(BackupCompleto::prefixoDe('fotos-novas.zip'));
    }

    /* ── rotação no Drive ────────────────────────────────────── */

    public static function filtroDoGoogle(): array
    {
        return ['Google filtra pelo nome' => [true], 'Google devolve a pasta inteira' => [false]];
    }

    #[DataProvider('filtroDoGoogle')]
    public function test_envio_das_fotos_ao_drive_gira_so_as_fotos(bool $respeitaFiltro): void
    {
        $this->gravarConexao();
        $completos = $this->nomes('petermann', 3, '2026-08-02', '0330');
        $bancos = $this->nomes('banco', 4);
        $fotos = $this->nomes('fotos', 4);
        $g = $this->driveFalso(array_merge($completos, $bancos, $fotos), $respeitaFiltro);

        $r = (new DriveBackup)->enviar($this->zipLocal(self::ZIP_DO_DIA), 2, 0);

        $this->assertSame([self::ZIP_DO_DIA], $g->enviados);
        $this->assertSame(3, $r['apagados']);
        $this->assertEqualsCanonicalizing(array_slice($fotos, 0, 3), $g->apagados);
        foreach (array_merge($completos, $bancos) as $n) {
            $this->assertContains($n, $g->arquivos);
        }
    }

    public static function outrosTipos(): array
    {
        return [
            'banco, Google filtra' => ['banco-2026-11-05-0230.zip', true],
            'banco, pasta inteira' => ['banco-2026-11-05-0230.zip', false],
            'completo, Google filtra' => [self::COMPLETO, true],
            'completo, pasta inteira' => [self::COMPLETO, false],
        ];
    }

    #[DataProvider('outrosTipos')]
    public function test_envio_dos_outros_tipos_nao_toca_nas_fotos_do_drive(string $zip, bool $respeitaFiltro): void
    {
        $this->gravarConexao();
        $fotos = $this->nomes('fotos', 4);
        $g = $this->driveFalso($fotos, $respeitaFiltro);

        $r = (new DriveBackup)->enviar($this->zipLocal($zip), 1, 0);

        $this->assertSame(0, $r['apagados']);
        $this->assertSame([], $g->apagados);
    }

    public function test_comando_guarda_14_no_drive_sem_mensal_e_preserva_os_outros(): void
    {
        $this->gravarConexao();
        $this->completoNaPasta();
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');
        $completos = $this->nomes('petermann', 3, '2026-08-02', '0330');
        $bancos = $this->nomes('banco', 35);
        $g = $this->driveFalso(array_merge($completos, $bancos, $this->nomes('fotos', 40, '2026-09-01')));

        $this->assertSame(0, Artisan::call('backup:gerar', ['--fotos-novas' => true]));

        $sobra = array_values($g->arquivos);
        $fotos = array_filter($sobra, fn ($n) => str_starts_with($n, 'fotos-'));
        $this->assertCount(14, $fotos);
        $this->assertContains(self::ZIP_DO_DIA, $sobra);
        $this->assertNotContains('fotos-2026-09-01-0245.zip', $sobra, 'sem cópia mensal');
        foreach (array_merge($completos, $bancos) as $n) {
            $this->assertContains($n, $sobra);
        }
    }

    /* ── o Perfil e a tela do app ────────────────────────────── */

    public function test_envio_das_fotos_nao_esconde_o_atraso_nem_o_erro_dos_outros(): void
    {
        $this->gravarConexao([
            'ultimo_envio' => '2026-10-04T03:31:00-03:00',
            'ultimo_arquivo' => 'petermann-2026-10-04-0330.zip',
            'ultimo_erro' => '01/11/2026 03:40 — upload interrompido',
            'banco_ultimo_arquivo' => 'banco-2026-11-05-0230.zip',
        ]);
        $this->driveFalso([]);

        (new DriveBackup)->enviar($this->zipLocal(self::ZIP_DO_DIA), 14, 0);

        $s = (new DriveBackup)->status();
        $this->assertSame('2026-10-04T03:31:00-03:00', $s['ultimo_envio'], 'o aviso de "confira o Crontab" olha o completo');
        $this->assertSame('petermann-2026-10-04-0330.zip', $s['ultimo_arquivo']);
        $this->assertStringContainsString('upload interrompido', $s['ultimo_erro']);
        $this->assertSame('banco-2026-11-05-0230.zip', $s['ultimo_arquivo_banco']);
        $this->assertSame(self::ZIP_DO_DIA, $s['ultimo_arquivo_fotos']);
        $this->assertNotNull($s['ultimo_envio_fotos']);
    }

    public function test_erro_das_fotos_aparece_no_perfil_em_campo_proprio_e_some_no_envio_bom(): void
    {
        $this->gravarConexao();
        Http::fake(['oauth2.googleapis.com/token' => Http::response(['error' => 'invalid_grant'], 400)]);
        $zip = $this->zipLocal(self::ZIP_DO_DIA);
        try {
            (new DriveBackup)->enviar($zip, 14, 0);
            $this->fail('devia falhar');
        } catch (RuntimeException) {
        }

        $this->assertStringContainsString('Backup diário das fotos:', (new DriveBackup)->status()['ultimo_erro']);
        $conexao = json_decode((string) file_get_contents($this->tmp.'/app/drive-backup.json'), true);
        $this->assertArrayNotHasKey('ultimo_erro', $conexao, 'a falha das fotos não entra no campo do completo');
        $this->assertArrayNotHasKey('banco_ultimo_erro', $conexao);

        Http::swap(new \Illuminate\Http\Client\Factory);
        $this->driveFalso([]);
        (new DriveBackup)->enviar($zip, 14, 0);

        $this->assertNull((new DriveBackup)->status()['ultimo_erro']);
    }

    public function test_tela_de_backups_so_ve_os_completos(): void
    {
        $this->completoNaPasta();
        $this->zipsNaPasta('fotos', 1, '2026-11-05');

        Sanctum::actingAs($this->pessoa('gestor'));

        $nomes = array_column($this->getJson('/api/backup/lista')->assertOk()->json('backups'), 'nome');
        $this->assertSame([self::COMPLETO], $nomes);
        $this->get('/api/backup/arquivo/'.self::ZIP_DO_DIA)->assertNotFound();
    }

    public function test_enviar_agora_sobe_o_completo_mesmo_com_fotos_mais_novo(): void
    {
        $this->gravarConexao();
        $this->completoNaPasta();
        $this->zipsNaPasta('fotos', 1, '2026-11-05');
        $g = $this->driveFalso([]);

        Sanctum::actingAs($this->pessoa('gestor'));
        $this->postJson('/api/backup/drive/enviar')->assertOk();

        $this->assertSame([self::COMPLETO], $g->enviados);
    }

    /* ── restaurar ───────────────────────────────────────────── */

    public function test_restaurar_completo_mais_fotos_devolve_todos_os_arquivos(): void
    {
        $this->foto('a/velha.jpg', '2026-09-10 12:00:00', 'velha');
        $this->foto('a/alterada.jpg', '2026-09-11 12:00:00', 'versão 1');
        $this->foto('b/velha.pdf', '2026-10-02 12:00:00', 'pdf');
        $this->foto('a/mini/velha.jpg', '2026-09-10 12:00:00', 'mini');

        $this->travelTo(Carbon::parse('2026-11-01 06:30:00', 'UTC'));
        app(BackupCompleto::class)->gerar($this->pasta().'/'.self::COMPLETO);

        $this->foto('a/nova.jpg', '2026-11-02 15:00:00', 'nova');
        $this->foto('c/primeira-do-colaborador.png', '2026-11-04 15:00:00', 'png');
        $this->foto('a/alterada.jpg', '2026-11-03 15:00:00', 'versão 2');
        $this->foto('a/mini/nova.jpg', '2026-11-02 15:00:00', 'mini');

        $this->travelTo(Carbon::parse('2026-11-05 05:45:00', 'UTC'));
        $this->rodar();

        $alvo = $this->tmp.'/restaurado';
        foreach ([self::COMPLETO, self::ZIP_DO_DIA] as $nome) {   // a ordem do LEIA-ME: completo, depois fotos por cima
            $z = new ZipArchive;
            $this->assertTrue($z->open($this->pasta().'/'.$nome) === true);
            $z->extractTo($alvo);
            $z->close();
        }

        $esperado = [];
        foreach (Storage::disk('fotos')->allFiles() as $rel) {
            if (! str_contains($rel, '/mini/')) {
                $esperado[$rel] = Storage::disk('fotos')->get($rel);
            }
        }
        ksort($esperado);
        $this->assertCount(5, $esperado);

        $obtido = [];
        foreach (File::allFiles($alvo.'/fotos') as $f) {
            $obtido[str_replace('\\', '/', $f->getRelativePathname())] = $f->getContents();
        }
        ksort($obtido);

        $this->assertSame($esperado, $obtido);
    }

    /* ── o completo continua igual ───────────────────────────── */

    public function test_completo_segue_identico(): void
    {
        $this->foto('a/velha.jpg', '2026-09-10 12:00:00', 'velha');
        $this->foto('a/nova.jpg', '2026-11-04 12:00:00', 'nova');
        $this->foto('a/mini/nova.jpg', '2026-11-04 12:00:00', 'mini');
        $this->foto('a/.tmp-nota-abc.jpg', '2026-11-04 12:00:00', 'tmp');
        $this->foto('a/espera/nota-1.jpg', '2026-11-04 12:00:00', 'espera');
        $this->completoNaPasta();   // um completo já na pasta não pode virar filtro: o completo leva tudo

        $r = app(BackupCompleto::class)->gerar($this->tmp.'/app/backups/petermann-2026-11-05-0330.zip');

        $this->assertSame(4, $r['fotos']);
        $this->assertSame([
            'LEIA-ME.txt', 'database.sqlite',
            'fotos/a/.tmp-nota-abc.jpg', 'fotos/a/espera/nota-1.jpg', 'fotos/a/nova.jpg', 'fotos/a/velha.jpg',
        ], $this->entradasDoZip($r['arquivo']));
        $this->assertSame(ZipArchive::CM_STORE, $this->metodoDeCompressao($r['arquivo'], 'fotos/a/velha.jpg'));
        $this->assertSame('velha', $this->lerDoZip($r['arquivo'], 'fotos/a/velha.jpg'));
        $this->assertStringStartsWith('SQLite format 3', $this->lerDoZip($r['arquivo'], 'database.sqlite'));
        $this->assertStringContainsString('fotos/          : 4 anexos', $this->lerDoZip($r['arquivo'], 'LEIA-ME.txt'));
    }

    /* ── avisos ──────────────────────────────────────────────── */

    public function test_aviso_de_falha_diz_que_foram_as_fotos_com_chave_propria(): void
    {
        $avisos = $this->anotarAvisos();
        $this->mock(BackupCompleto::class, function ($m) {
            $m->shouldReceive('gerarFotos')->andThrow(new RuntimeException('disco cheio'));
            $m->shouldNotReceive('podar');
        });

        $this->assertSame(1, $this->rodar());

        $this->assertCount(1, $avisos);
        [$titulo, $detalhe, $chave] = $avisos[0];
        $this->assertStringContainsString('diário das fotos', $titulo);
        $this->assertStringNotContainsString('banco', $titulo);
        $this->assertStringNotContainsString('semanal', $titulo);
        $this->assertStringContainsString('--fotos-novas', $detalhe);
        $this->assertStringContainsString('disco cheio', $detalhe);
        $this->assertSame('backup-fotos-falhou', $chave);
    }

    public function test_aviso_do_drive_diz_que_foi_o_zip_das_fotos(): void
    {
        $this->gravarConexao();
        $this->completoNaPasta();
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');
        $avisos = $this->anotarAvisos();
        Http::fake(['oauth2.googleapis.com/token' => Http::response(['error' => 'invalid_grant'], 400)]);

        $this->assertSame(0, Artisan::call('backup:gerar', ['--fotos-novas' => true]), 'falha no Drive não é falha do backup');

        $this->assertCount(1, $avisos);
        $this->assertStringContainsString('fotos', $avisos[0][0]);
        $this->assertStringContainsString('fotos', $avisos[0][1]);
        $this->assertStringNotContainsString('semana', $avisos[0][1]);
        $this->assertSame('backup-fotos-drive-falhou', $avisos[0][2]);
    }

    public function test_rodada_das_fotos_nao_cobra_o_diario_do_banco(): void
    {
        $this->completoNaPasta();
        $this->foto('c/nova.jpg', '2026-11-03 12:00:00');
        $avisos = $this->anotarAvisos();

        $this->assertSame(0, $this->rodar());

        $this->assertCount(0, $avisos);
    }
}
