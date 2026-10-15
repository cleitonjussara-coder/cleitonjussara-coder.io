<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Services\DriveBackup;
use App\Services\GoogleOAuth;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use RuntimeException;
use Tests\TestCase;

/**
 * 15/10/2026 — Drive do backup "conectado com erro". Duas causas:
 *  1. o zip de 45 MB ia num PUT só e a conexão caía no meio (cURL error 56);
 *     agora sobe em pedaços e retoma de onde o Google parou;
 *  2. a reconexão aceitava um token SEM a permissão drive.file (caixa
 *     desmarcada na tela do Google) e o gravava por cima do que funcionava.
 *
 * O "Google" aqui é um simulador que só aceita pedaços em sequência, para
 * provar que o app não pula nem repete byte.
 */
class DriveBackupTest extends TestCase
{
    use RefreshDatabase;

    private const TAM = 700000;          // 3 pedaços de 256 KiB

    private string $tmp;

    private string $zip;

    protected function setUp(): void
    {
        parent::setUp();
        /* o arquivo drive-backup.json mora em storage/app: isola num diretório de teste */
        $this->tmp = sys_get_temp_dir().'/drive-backup-teste-'.Str::random(8);
        mkdir($this->tmp.'/app', 0777, true);
        $this->app->useStoragePath($this->tmp);
        $this->zip = $this->tmp.'/petermann-2026-10-11-0330.zip';
        file_put_contents($this->zip, random_bytes(self::TAM));
        $this->gravarConexao(['refresh_token' => 'RT-BOM', 'email' => 'dono@teste.local', 'pasta_id' => 'PASTA', 'ultimo_envio' => '2026-10-04T03:31:00-03:00']);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->tmp.'/app/*') ?: [] as $f) {
            @unlink($f);
        }
        @unlink($this->zip);
        @rmdir($this->tmp.'/app');
        @rmdir($this->tmp);
        parent::tearDown();
    }

    private function gravarConexao(array $d): void
    {
        file_put_contents($this->tmp.'/app/drive-backup.json', json_encode($d));
    }

    private function conexao(): array
    {
        return json_decode((string) file_get_contents($this->tmp.'/app/drive-backup.json'), true);
    }

    private function servico(int $pedaco = 262144, int $falhasMax = 3): DriveBackup
    {
        $d = new DriveBackup;
        $d->pedaco = $pedaco;
        $d->falhasMax = $falhasMax;
        $d->espera = 0;

        return $d;
    }

    /**
     * Google de mentira. $roteiro: nº do pedido de pedaço (1, 2, 3…) => ação:
     *   'cai'        a conexão cai antes de o Google receber nada
     *   'cai-depois' o Google recebe o pedaço, mas a resposta se perde
     *   '503'        erro temporário do Google
     *   '403'        erro definitivo
     */
    private function googleSimulado(array $roteiro = []): object
    {
        $g = new class
        {
            public int $recebido = 0;

            public int $pedidos = 0;

            public array $ranges = [];

            public array $roteiro = [];
        };
        $g->roteiro = $roteiro;

        Http::fake([
            'oauth2.googleapis.com/token' => Http::response(['access_token' => 'tok-acesso']),
            'www.googleapis.com/upload/drive/v3/files*' => Http::response('', 200, ['Location' => 'https://upload.test/sessao-1']),
            'www.googleapis.com/drive/v3/files/PASTA*' => Http::response(['id' => 'PASTA', 'trashed' => false]),
            'www.googleapis.com/drive/v3/files*' => Http::response(['files' => []]),
            'upload.test/*' => function (Request $req) use ($g) {
                $range = $req->header('Content-Range')[0] ?? '';
                $g->ranges[] = $range;
                $faixaRecebida = fn () => $g->recebido > 0 ? ['Range' => 'bytes=0-'.($g->recebido - 1)] : [];

                if (preg_match('/^bytes \*\/([0-9]+)$/', $range, $m)) {          // "até onde você tem?"
                    return $g->recebido >= (int) $m[1]
                        ? Http::response(['id' => 'ARQ1'], 200)
                        : Http::response('', 308, $faixaRecebida());
                }
                preg_match('/^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/', $range, $m);
                [, $ini, $fim, $total] = array_map('intval', $m + [0, 0, 0, 0]);
                $g->pedidos++;
                $acao = $g->roteiro[$g->pedidos] ?? null;

                if ($acao === 'cai') {
                    throw new ConnectionException('cURL error 56: Recv failure: Connection reset by peer');
                }
                if ($acao === '503') {
                    return Http::response('', 503);
                }
                if ($acao === '403') {
                    return Http::response(['error' => ['message' => 'The caller does not have permission']], 403);
                }
                if ($ini !== $g->recebido) {                                     // pulou ou repetiu byte
                    return Http::response(['error' => ['message' => "fora de ordem: esperava $g->recebido, veio $ini"]], 400);
                }
                $g->recebido = $fim + 1;
                if ($acao === 'cai-depois') {
                    throw new ConnectionException('cURL error 56: resposta perdida');
                }

                return $g->recebido >= $total
                    ? Http::response(['id' => 'ARQ1'], 200)
                    : Http::response('', 308, $faixaRecebida());
            },
        ]);

        return $g;
    }

    public function test_sobe_o_zip_em_pedacos_em_sequencia(): void
    {
        $g = $this->googleSimulado();

        $r = $this->servico()->enviar($this->zip);

        $this->assertSame('ARQ1', $r['id']);
        $this->assertSame(
            ['bytes 0-262143/700000', 'bytes 262144-524287/700000', 'bytes 524288-699999/700000'],
            $g->ranges,
        );
        $this->assertSame(self::TAM, $g->recebido);
        $c = $this->conexao();
        $this->assertNull($c['ultimo_erro']);
        $this->assertSame('petermann-2026-10-11-0330.zip', $c['ultimo_arquivo']);
    }

    public function test_conexao_cai_no_meio_e_o_envio_retoma_sem_recomecar(): void
    {
        $g = $this->googleSimulado([2 => 'cai']);

        $r = $this->servico()->enviar($this->zip);

        $this->assertSame('ARQ1', $r['id']);
        $this->assertSame(self::TAM, $g->recebido);
        // pedaço 2 falhou, perguntou ao Google, e reenviou o pedaço 2 a partir de 262144 (não do zero)
        $this->assertSame(
            ['bytes 0-262143/700000', 'bytes 262144-524287/700000', 'bytes */700000', 'bytes 262144-524287/700000', 'bytes 524288-699999/700000'],
            $g->ranges,
        );
    }

    public function test_resposta_perdida_mas_o_google_recebeu_continua_dali_sem_repetir_o_pedaco(): void
    {
        $g = $this->googleSimulado([2 => 'cai-depois']);

        $r = $this->servico()->enviar($this->zip);

        $this->assertSame('ARQ1', $r['id']);
        $this->assertSame(
            ['bytes 0-262143/700000', 'bytes 262144-524287/700000', 'bytes */700000', 'bytes 524288-699999/700000'],
            $g->ranges,
        );
    }

    public function test_cai_depois_do_ultimo_pedaco_e_o_google_ja_terminou(): void
    {
        $g = $this->googleSimulado([3 => 'cai-depois']);

        $r = $this->servico()->enviar($this->zip);

        $this->assertSame('ARQ1', $r['id']);
        $this->assertSame(self::TAM, $g->recebido);
        $this->assertSame('bytes */700000', end($g->ranges));
    }

    public function test_erro_503_do_google_tenta_de_novo(): void
    {
        $g = $this->googleSimulado([1 => '503', 2 => '503']);

        $r = $this->servico()->enviar($this->zip);

        $this->assertSame('ARQ1', $r['id']);
        $this->assertSame(self::TAM, $g->recebido);
    }

    public function test_desiste_depois_de_falhas_seguidas_e_avisa_no_perfil(): void
    {
        $g = $this->googleSimulado([1 => 'cai', 2 => 'cai', 3 => 'cai', 4 => 'cai', 5 => 'cai']);

        try {
            $this->servico(262144, 2)->enviar($this->zip);
            $this->fail('devia desistir');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('upload interrompido aos 0%', $e->getMessage());
        }

        $c = $this->conexao();
        $this->assertStringContainsString('upload interrompido', $c['ultimo_erro']);
        $this->assertSame('RT-BOM', $c['refresh_token'], 'falha de envio não derruba a conexão');
        $this->assertSame(0, $g->recebido);
    }

    public function test_erro_definitivo_nao_fica_repetindo(): void
    {
        $g = $this->googleSimulado([1 => '403']);

        try {
            $this->servico()->enviar($this->zip);
            $this->fail('devia falhar');
        } catch (RuntimeException $e) {
            $this->assertStringContainsString('The caller does not have permission', $e->getMessage());
        }

        $this->assertSame(1, $g->pedidos);
    }

    public function test_arquivo_vazio_nao_abre_upload(): void
    {
        $this->googleSimulado();
        file_put_contents($this->zip, '');

        $this->expectException(RuntimeException::class);
        $this->expectExceptionMessage('vazio');
        $this->servico()->enviar($this->zip);
    }

    /* ── Callback do Google: só conecta com a permissão do Drive ─────────── */

    private function admin(): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => 'Admin', 'email' => 'admin@teste.local',
            'password' => 'segredo123', 'role' => 'admin',
        ]);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function voltaDoGoogle(string $scope): \Illuminate\Testing\TestResponse
    {
        Http::fake([
            'oauth2.googleapis.com/token' => Http::response(['access_token' => 'a', 'refresh_token' => 'RT-NOVO', 'scope' => $scope]),
            'www.googleapis.com/oauth2/v3/userinfo' => Http::response(['sub' => '1', 'email' => 'Novo@Teste.Local', 'email_verified' => true]),
        ]);
        $url = app(GoogleOAuth::class)->urlParaBackup(route('auth.google.callback'), $this->admin()->id);
        parse_str((string) parse_url($url, PHP_URL_QUERY), $q);

        return $this->get(route('auth.google.callback', ['code' => 'codigo', 'state' => $q['state']]));
    }

    public function test_reconexao_sem_a_permissao_do_drive_nao_derruba_a_conexao_que_funciona(): void
    {
        $resp = $this->voltaDoGoogle('openid https://www.googleapis.com/auth/userinfo.email');

        $resp->assertRedirectContains('#drive_backup=sem_permissao');
        $c = $this->conexao();
        $this->assertSame('RT-BOM', $c['refresh_token'], 'o token que funcionava continua');
        $this->assertSame('dono@teste.local', $c['email']);
        $this->assertSame('2026-10-04T03:31:00-03:00', $c['ultimo_envio'], 'o histórico de envios continua');
        $this->assertStringContainsString('marque a caixa do Drive', $c['ultimo_erro']);
        Http::assertNotSent(fn (Request $r) => str_contains($r->url(), 'userinfo'));
    }

    public function test_reconexao_com_a_permissao_do_drive_conecta(): void
    {
        $resp = $this->voltaDoGoogle('openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file');

        $resp->assertRedirectContains('#drive_backup=ok');
        $c = $this->conexao();
        $this->assertSame('RT-NOVO', $c['refresh_token']);
        $this->assertSame('novo@teste.local', $c['email']);
    }

    public function test_sem_conexao_anterior_o_erro_aparece_no_status_para_o_perfil(): void
    {
        unlink($this->tmp.'/app/drive-backup.json');

        $this->voltaDoGoogle('openid email')->assertRedirectContains('#drive_backup=sem_permissao');

        $s = (new DriveBackup)->status();
        $this->assertFalse($s['conectado']);
        $this->assertStringContainsString('marque a caixa do Drive', $s['ultimo_erro']);
    }
}
