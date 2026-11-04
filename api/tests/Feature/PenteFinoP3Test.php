<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\KmRegistro;
use App\Models\Nota;
use App\Models\PushSubscription;
use App\Models\Repasse;
use App\Services\FotoStorage;
use App\Services\PontoCalculo;
use App\Services\PushService;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Password;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Mockery;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\TestCase;

/**
 * Pente fino, prioridade 3, frente do servidor (04/11/2026): exclusão de colaborador, cadastro com e-mail em maiúsculas,
 * troca de anexo sem janela de perda e aviso do cartão com o mesmo número da ficha, de Arquivos e da planilha.
 */
class PenteFinoP3Test extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('fotos');
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function pessoa(string $role, string $nome, string $regime = 'rdm_rda'): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome, 'email' => Str::slug($nome).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['regime' => $regime, 'ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(Colaborador $c, float $valor = 10, ?string $pagamento = null, int $ano = 2026, bool $deleted = false): Nota
    {
        $n = new Nota([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => 'RDM', 'subtipo' => 'Outros', 'valor' => $valor,
            'data' => "{$ano}-03-10", 'mes' => 3, 'ano' => $ano, 'razao_social' => 'X', 'pagamento' => $pagamento, 'deleted' => $deleted,
        ]);
        $n->save();

        return $n;
    }

    private function repasse(Colaborador $c, float $valor, int $ano = 2026, array $outros = []): void
    {
        $r = new Repasse([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => 'RDM', 'valor' => $valor,
            'data' => "{$ano}-03-15", 'mes' => 3, 'ano' => $ano, 'kind' => $outros['kind'] ?? 'received',
            'destino' => $outros['destino'] ?? 'recarga', 'deleted' => $outros['deleted'] ?? false,
        ]);
        $r->forceFill(['confirmado_em' => array_key_exists('confirmado_em', $outros) ? $outros['confirmado_em'] : now()])->save();
    }

    private function excluir(Colaborador $gestor, Colaborador $alvo)
    {
        Sanctum::actingAs($gestor);

        return $this->postJson("/api/colaboradores/{$alvo->id}/excluir", ['confirmacao' => 'EXCLUIR']);
    }

    /* ── 1) Excluir colaborador ───────────────────────────────── */

    public function test_excluir_grava_lapide_de_cada_nota_inclusive_as_da_lixeira(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora');
        $alvo = $this->pessoa('colaborador', 'Alvo');
        $viva = $this->nota($alvo);
        $naLixeira = $this->nota($alvo, deleted: true);
        $deOutro = $this->nota($gestor);

        $this->excluir($gestor, $alvo)->assertOk()->assertJsonPath('notas', 2);

        $lapide = DB::table('notas_apagadas')->where('id', $viva->id)->first();
        $this->assertNotNull($lapide, 'sem lápide a cópia fica no aparelho do gestor para sempre');
        $this->assertSame($alvo->id, $lapide->user_id);
        $this->assertSame($gestor->id, $lapide->apagada_por);
        $this->assertNotNull($lapide->apagada_em);

        /* é por esta rota que o aparelho do gestor fica sabendo */
        $ids = $this->getJson('/api/notas/apagadas')->assertOk()->json();
        $this->assertEqualsCanonicalizing([$viva->id, $naLixeira->id], $ids);
        $this->assertNotNull(Nota::find($deOutro->id), 'nota de outra pessoa não é tocada');
    }

    public function test_excluir_que_falha_no_banco_nao_perde_arquivo_nem_deixa_lapide(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora');
        $alvo = $this->pessoa('colaborador', 'Alvo');
        $n = $this->nota($alvo);
        Storage::disk('fotos')->put("{$alvo->id}/{$n->id}.jpg", 'COMPROVANTE');
        DB::unprepared("CREATE TRIGGER trava_exclusao BEFORE DELETE ON colaboradores BEGIN SELECT RAISE(ABORT, 'falha simulada'); END");

        $this->excluir($gestor, $alvo)->assertStatus(500);

        $this->assertNotNull(Nota::find($n->id), 'a transação voltou');
        $this->assertSame('COMPROVANTE', Storage::disk('fotos')->get("{$alvo->id}/{$n->id}.jpg"), 'banco voltou, então o arquivo tem de continuar');
        $this->assertSame(0, DB::table('notas_apagadas')->count());
    }

    public function test_excluir_remove_a_pasta_inteira_depois_e_nao_toca_na_dos_outros(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora');
        $alvo = $this->pessoa('colaborador', 'Alvo');
        $n = $this->nota($alvo);
        $disco = Storage::disk('fotos');
        foreach (["{$n->id}.jpg", "mini/{$n->id}.jpg", "espera/{$n->id}.pdf", 'perfil.jpg', 'km-1.jpg'] as $f) {
            $disco->put("{$alvo->id}/{$f}", 'x');
        }
        $disco->put("{$gestor->id}/outro.jpg", 'x');

        $this->excluir($gestor, $alvo)->assertOk();

        $this->assertSame(["{$gestor->id}/outro.jpg"], $disco->allFiles());
    }

    public function test_excluir_o_dono_antigo_nao_apaga_o_anexo_da_nota_que_mudou_de_dono(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora');
        $alvo = $this->pessoa('colaborador', 'Alvo');
        $novo = $this->pessoa('colaborador', 'Novo');
        $disco = Storage::disk('fotos');
        $id = (string) Str::uuid();
        $dados = ['tipo' => 'RDM', 'subtipo' => 'Outros', 'valor' => 10, 'data' => '2026-03-10', 'mes' => 3, 'ano' => 2026, 'razao_social' => 'X'];
        $disco->put("{$alvo->id}/{$id}.jpg", 'COMPROVANTE');
        $daLixeira = $this->nota($novo, deleted: true);
        $daLixeira->forceFill(['foto_path' => "{$alvo->id}/{$daLixeira->id}.pdf"])->save();
        $disco->put($daLixeira->foto_path, 'NA LIXEIRA');
        $doExcluido = $this->nota($alvo);
        $disco->put("{$alvo->id}/{$doExcluido->id}.jpg", 'x');
        $disco->put("{$alvo->id}/mini/{$doExcluido->id}.jpg", 'x');

        /* o PUT troca o dono, mas o arquivo fica na pasta do dono antigo */
        Sanctum::actingAs($gestor);
        $this->putJson("/api/notas/{$id}", ['user_id' => $alvo->id] + $dados)->assertSuccessful();
        $this->putJson("/api/notas/{$id}", ['user_id' => $novo->id] + $dados)->assertSuccessful();
        $this->assertSame("{$alvo->id}/{$id}.jpg", Nota::find($id)->foto_path);

        $this->excluir($gestor, $alvo)->assertOk();

        $this->assertSame('COMPROVANTE', $disco->get(Nota::find($id)->foto_path), 'a nota continua viva: o anexo fica');
        $this->assertSame('NA LIXEIRA', $disco->get($daLixeira->foto_path), 'nota na lixeira ainda pode ser restaurada');
        $this->assertEqualsCanonicalizing(["{$alvo->id}/{$id}.jpg", $daLixeira->foto_path], $disco->allFiles(), 'o resto da pasta sai');
    }

    /* Hoje o Histórico mostra uma linha por lápide. O agrupamento proposto usa este carimbo único da exclusão. */
    public function test_lapides_de_uma_exclusao_tem_o_mesmo_carimbo(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora');
        $alvo = $this->pessoa('colaborador', 'Alvo');
        foreach (range(1, 205) as $_) {   // passa de um lote
            $this->nota($alvo);
        }

        $this->excluir($gestor, $alvo)->assertOk();

        $this->assertSame(205, DB::table('notas_apagadas')->count());
        $this->assertSame(1, DB::table('notas_apagadas')->distinct()->count('apagada_em'));
    }

    public function test_excluir_nao_deixa_aviso_justificativa_nem_inscricao_de_celular_para_tras(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora');
        $outro = $this->pessoa('colaborador', 'Outro');
        $alvo = $this->pessoa('colaborador', 'Alvo');
        $n = $this->nota($alvo);
        $base = ['created_at' => now(), 'updated_at' => now()];
        DB::table('justificativas')->insert(['id' => 'j1', 'colaborador_id' => $alvo->id, 'motivo' => 'x'] + $base);
        DB::table('avisos_correcao')->insert(['id' => 'a1', 'nota_id' => $n->id, 'colaborador_id' => $alvo->id, 'motivos' => '[]'] + $base);
        /* a nota mudou de dono depois do aviso: ele está no nome de outra pessoa, mas a nota some junto */
        DB::table('avisos_correcao')->insert(['id' => 'a2', 'nota_id' => $n->id, 'colaborador_id' => $outro->id, 'motivos' => '[]'] + $base);
        /* quem pediu é o excluído: o aviso é do outro e fica */
        $notaOutro = $this->nota($outro);
        DB::table('avisos_correcao')->insert(['id' => 'a3', 'nota_id' => $notaOutro->id, 'colaborador_id' => $outro->id, 'pedido_por' => $alvo->id, 'motivos' => '[]'] + $base);
        PushSubscription::create(['user_id' => $alvo->id, 'endpoint' => 'https://push/1', 'endpoint_hash' => hash('sha256', 'https://push/1'), 'p256dh' => 'p', 'auth' => 'a']);
        (new KmRegistro(['id' => (string) Str::uuid(), 'veiculo_id' => (string) Str::uuid(), 'user_id' => $alvo->id, 'data' => '2026-03-10', 'odometro' => 10]))->save();

        $this->excluir($gestor, $alvo)->assertOk();

        $this->assertSame(0, DB::table('justificativas')->count());
        $this->assertSame(['a3'], DB::table('avisos_correcao')->pluck('id')->all());
        $this->assertSame(0, PushSubscription::count());
        $this->assertSame(0, KmRegistro::count());

        /* o aviso que sobrou, com autor que já não existe, continua abrindo */
        Sanctum::actingAs($outro);
        $this->getJson('/api/avisos-correcao/sino')->assertOk();
    }

    /* ── 2) Cadastro ──────────────────────────────────────────── */

    public function test_cadastro_com_email_existente_em_maiusculas_da_422_e_nao_500(): void
    {
        $this->pessoa('colaborador', 'Cleiton');

        foreach (['CLEITON@TESTE.LOCAL', 'Cleiton@Teste.Local', '  cleiton@teste.local  '] as $email) {
            $this->postJson('/api/auth/register', ['nome' => 'X', 'email' => $email, 'password' => 'senhaforte1'])
                ->assertStatus(422)->assertJsonValidationErrors('email');
        }
        $this->assertSame(1, Colaborador::count());
    }

    public function test_cadastro_novo_em_maiusculas_grava_em_minusculas_e_entra(): void
    {
        $this->postJson('/api/auth/register', ['nome' => 'Nova', 'email' => '  NOVA@Teste.Local ', 'password' => 'senhaforte1'])->assertCreated();

        $this->assertSame('nova@teste.local', Colaborador::firstOrFail()->email);
        $this->postJson('/api/auth/login', ['email' => 'Nova@TESTE.local', 'password' => 'senhaforte1'])->assertOk();
    }

    public function test_cadastro_com_email_que_nao_e_texto_continua_sendo_erro_de_validacao(): void
    {
        $this->postJson('/api/auth/register', ['email' => ['a@b.c'], 'password' => 'senhaforte1'])
            ->assertStatus(422)->assertJsonValidationErrors('email');
    }

    public function test_esqueci_e_redefinir_senha_aceitam_email_em_maiusculas(): void
    {
        Notification::fake();
        $c = $this->pessoa('colaborador', 'Cleiton');

        $this->postJson('/api/auth/forgot', ['email' => 'CLEITON@Teste.Local'])->assertOk();
        Notification::assertSentTo($c, \App\Notifications\RedefinirSenha::class);

        $token = Password::createToken($c);
        $this->postJson('/api/auth/reset', ['email' => 'CLEITON@Teste.Local', 'token' => $token, 'password' => 'senhanova12'])->assertOk();
        $this->assertTrue(Hash::check('senhanova12', $c->fresh()->password));
    }

    /* ── 3) Troca de anexo ────────────────────────────────────── */

    private function arquivo(string $nome, string $conteudo): UploadedFile
    {
        return UploadedFile::fake()->createWithContent($nome, $conteudo);
    }

    /** Disco que falha na operação pedida; o resto funciona de verdade. */
    private function discoQueFalhaEm(string $metodo): void
    {
        $disco = Mockery::mock(Storage::disk('fotos'));
        $disco->shouldReceive($metodo)->andThrow(new RuntimeException('disco cheio'));
        Storage::set('fotos', $disco);
    }

    public static function operacoesDeGravacao(): array
    {
        return ['falha ao gravar' => ['putFileAs'], 'falha ao mover para o nome final' => ['move']];
    }

    #[DataProvider('operacoesDeGravacao')]
    public function test_troca_de_anexo_que_falha_mantem_o_comprovante_antigo(string $metodo): void
    {
        $f = app(FotoStorage::class);
        Storage::disk('fotos')->put('u1/nota.pdf', 'ANTIGO');
        Storage::disk('fotos')->put('u1/mini/nota.jpg', 'MINI');
        $this->discoQueFalhaEm($metodo);

        try {
            $f->salvarPara('u1', 'nota', $this->arquivo('novo.jpg', 'NOVO'));
            $this->fail('a falha precisa chegar a quem chamou: o app tenta de novo');
        } catch (RuntimeException $e) {
            $this->assertSame('disco cheio', $e->getMessage());
        }

        $this->assertSame('ANTIGO', Storage::disk('fotos')->get('u1/nota.pdf'));
        $this->assertEqualsCanonicalizing(['u1/nota.pdf', 'u1/mini/nota.jpg'], Storage::disk('fotos')->allFiles(), 'nenhum temporário sobra');
    }

    public function test_troca_de_formato_deixa_so_o_novo_e_tira_a_miniatura(): void
    {
        $f = app(FotoStorage::class);
        Storage::disk('fotos')->put('u1/nota.pdf', 'ANTIGO');
        Storage::disk('fotos')->put('u1/mini/nota.jpg', 'MINI VELHA');

        $this->assertSame('u1/nota.jpg', $f->salvarPara('u1', 'nota', $this->arquivo('novo.jpg', 'NOVO')));

        $this->assertSame(['u1/nota.jpg'], Storage::disk('fotos')->allFiles());
        $this->assertSame('NOVO', Storage::disk('fotos')->get('u1/nota.jpg'));
    }

    public function test_troca_com_a_mesma_extensao_nao_apaga_o_arquivo_novo(): void
    {
        $f = app(FotoStorage::class);
        Storage::disk('fotos')->put('u1/nota.jpg', 'ANTIGO');
        Storage::disk('fotos')->put('u1/mini/nota.jpg', 'MINI VELHA');

        $f->salvarPara('u1', 'nota', $this->arquivo('novo.jpg', 'NOVO'));

        $this->assertSame(['u1/nota.jpg'], Storage::disk('fotos')->allFiles());
        $this->assertSame('NOVO', Storage::disk('fotos')->get('u1/nota.jpg'));
    }

    public function test_foto_e_endireitada_antes_de_virar_o_anexo_e_o_temporario_nao_passa_por_anexo(): void
    {
        $visto = (object) [];
        $f = new class($visto) extends FotoStorage
        {
            public function __construct(private object $visto) {}

            public function endireitar(string $path): bool
            {
                $this->visto->path = $path;
                $this->visto->existe = $this->existe($path);
                $this->visto->anexo = $this->arquivoDaNota('u1', 'nota');

                return false;
            }
        };
        Storage::disk('fotos')->put('u1/nota.jpg', 'ANTIGO');

        $f->salvarPara('u1', 'nota', $this->arquivo('novo.jpg', 'NOVO'));

        $this->assertTrue($visto->existe);
        $this->assertSame('jpg', pathinfo($visto->path, PATHINFO_EXTENSION), 'endireitar decide pela extensão');
        $this->assertNotSame('u1/nota.jpg', $visto->path);
        $this->assertSame('u1/nota.jpg', $visto->anexo, 'enquanto grava, o anexo da nota é o antigo');
        $this->assertSame(['u1/nota.jpg'], Storage::disk('fotos')->allFiles());
    }

    public function test_temporario_nao_e_anexo_nem_sai_por_url(): void
    {
        $f = app(FotoStorage::class);
        Storage::disk('fotos')->put('u1/.tmp-nota-abc.jpg', 'x');

        $this->assertNull($f->arquivoDaNota('u1', 'nota'), 'senão nota nova entraria com arquivo pela metade');
        $this->expectException(\InvalidArgumentException::class);
        $f->validarCaminho('u1/.tmp-nota-abc.jpg');
    }

    public function test_temporario_de_gravacao_interrompida_nao_fica_orfao(): void
    {
        $f = app(FotoStorage::class);
        $disco = Storage::disk('fotos');
        $disco->put('u1/.tmp-nota-morto.jpg', 'x');
        touch($disco->path('u1/.tmp-nota-morto.jpg'), time() - 7200);
        $disco->put('u1/.tmp-nota-agora.jpg', 'gravação em andamento');
        $disco->put('u1/.tmp-outranota-morto.jpg', 'x');
        touch($disco->path('u1/.tmp-outranota-morto.jpg'), time() - 7200);

        $f->salvarPara('u1', 'nota', $this->arquivo('novo.jpg', 'NOVO'));
        $this->assertEqualsCanonicalizing(
            ['u1/nota.jpg', 'u1/.tmp-nota-agora.jpg', 'u1/.tmp-outranota-morto.jpg'],
            $disco->allFiles(),
            'o velho sai; o de agora pode ser de outro envio em andamento; o de outra nota não é daqui',
        );

        $f->apagarVersoesDe('u1', 'nota');
        $this->assertSame(['u1/.tmp-outranota-morto.jpg'], $disco->allFiles(), 'apagar o anexo leva tudo da nota');
    }

    public function test_promover_espera_que_falha_mantem_o_antigo_e_o_que_esperava(): void
    {
        $f = app(FotoStorage::class);
        Storage::disk('fotos')->put('u1/nota.pdf', 'ANTIGO');
        Storage::disk('fotos')->put('u1/espera/nota.jpg', 'NOVO');
        $this->discoQueFalhaEm('move');

        try {
            $f->promoverEspera('u1', 'nota');
            $this->fail('sem o erro a edição seria gravada apontando para arquivo que não existe');
        } catch (RuntimeException) {
        }

        $this->assertSame('ANTIGO', Storage::disk('fotos')->get('u1/nota.pdf'));
        $this->assertSame('NOVO', Storage::disk('fotos')->get('u1/espera/nota.jpg'));
    }

    public function test_promover_espera_troca_o_anexo_e_a_miniatura(): void
    {
        $f = app(FotoStorage::class);
        Storage::disk('fotos')->put('u1/nota.pdf', 'ANTIGO');
        Storage::disk('fotos')->put('u1/mini/nota.jpg', 'MINI VELHA');
        Storage::disk('fotos')->put('u1/espera/nota.jpg', 'NOVO');

        $this->assertSame('u1/nota.jpg', $f->promoverEspera('u1', 'nota'));

        $this->assertSame(['u1/nota.jpg'], Storage::disk('fotos')->allFiles(), '"NOVO" não é imagem: a miniatura velha sai e nenhuma nasce');
    }

    /* ── 4) Aviso do cartão ───────────────────────────────────── */

    /** Roda o comando e devolve os avisos que iriam para o gestor. */
    private function verificarCartoes(): array
    {
        $avisos = [];
        $this->mock(PushService::class, function ($m) use (&$avisos) {
            $m->shouldReceive('avisarGestores')->andReturnUsing(function ($titulo, $corpo) use (&$avisos) {
                $avisos[] = $corpo;

                return 1;
            });
        });
        Artisan::call('cartoes:verificar');

        return $avisos;
    }

    /** O número que a tela Arquivos mostra: mesma conta da ficha C.V. e da planilha. */
    private function saldoNoApp(Colaborador $gestor, Colaborador $c, int $ano = 2026): float
    {
        Sanctum::actingAs($gestor);
        $linha = collect($this->getJson("/api/arquivos/resumo?ano={$ano}")->assertOk()->json('colaboradores'))->firstWhere('user_id', $c->id);

        return (float) $linha['saldo']['cartao_saldo'];
    }

    /* 04/11/2026: regra nova do dono, o saldo acumula de um ano para o outro. Este teste fixava o contrário (o rombo de 2025
       não contava); agora o rombo vem como saldo do ano anterior e o aviso sai, com o mesmo número do app. */
    public function test_aviso_do_cartao_soma_o_saldo_do_ano_anterior(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-11-04 12:00:00', PontoCalculo::TZ));
        $gestor = $this->pessoa('gestor', 'Gestora');
        $c = $this->pessoa('colaborador', 'Edson', 'cv');
        $this->repasse($c, 100, 2025);
        $this->nota($c, 5000, 'cartao', 2025);
        $this->repasse($c, 2000);
        $this->nota($c, 500, 'cartao');

        $avisos = $this->verificarCartoes();

        $this->assertCount(1, $avisos);
        $this->assertStringContainsString('R$ -3.400,00', $avisos[0]);
        $this->assertStringContainsString(number_format($this->saldoNoApp($gestor, $c), 2, '.', ''), Artisan::output());
    }

    public function test_sobra_do_ano_anterior_segura_o_aviso_do_cartao(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-11-04 12:00:00', PontoCalculo::TZ));
        $this->pessoa('gestor', 'Gestora');
        $c = $this->pessoa('colaborador', 'Edson', 'cv');
        $this->repasse($c, 9000, 2025);
        $this->repasse($c, 1000);
        $this->nota($c, 900, 'cartao');

        $this->assertSame([], $this->verificarCartoes(), 'sobram 9.100 no cartão: não há o que avisar');
    }

    public function test_aviso_do_cartao_sai_com_o_mesmo_numero_do_app(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-11-04 12:00:00', PontoCalculo::TZ));
        $gestor = $this->pessoa('gestor', 'Gestora');
        $c = $this->pessoa('colaborador', 'Edson', 'cv');
        $this->repasse($c, 1000);
        $this->nota($c, 700.5, 'cartao');
        $this->nota($c, 199.5, null);                         // nota antiga, sem pagamento gravado, é do cartão

        /* nada disto entra em nenhum dos dois lados */
        $this->nota($c, 50, 'carteira');
        $this->nota($c, 60, 'empresa');
        $this->nota($c, 70, 'cartao', deleted: true);
        $this->repasse($c, 300, outros: ['kind' => 'requested']);
        $this->repasse($c, 310, outros: ['confirmado_em' => null]);
        $this->repasse($c, 320, outros: ['deleted' => true]);
        $this->repasse($c, 330, outros: ['destino' => 'carteira']);

        $avisos = $this->verificarCartoes();

        $this->assertEquals(100, $this->saldoNoApp($gestor, $c));
        $this->assertCount(1, $avisos);
        $this->assertStringContainsString('R$ 100,00', $avisos[0]);
    }

    public function test_aviso_do_cartao_usa_o_ano_de_brasilia_na_virada(): void
    {
        /* 31/12 às 22h em Brasília já é 2027 em UTC, o fuso do servidor */
        Carbon::setTestNow(Carbon::parse('2026-12-31 22:00:00', PontoCalculo::TZ));
        $this->pessoa('gestor', 'Gestora');
        $c = $this->pessoa('colaborador', 'Edson', 'cv');
        $this->repasse($c, 1000);
        $this->nota($c, 900, 'cartao');

        $avisos = $this->verificarCartoes();

        $this->assertCount(1, $avisos);
        $this->assertStringContainsString('R$ 100,00', $avisos[0]);
    }

    /* 04/11/2026: recarga de ano passado agora faz parte do saldo, então só fica de fora quem nunca teve recarga. */
    public function test_sem_recarga_nenhuma_o_cartao_fica_de_fora_do_aviso(): void
    {
        Carbon::setTestNow(Carbon::parse('2027-01-05 12:00:00', PontoCalculo::TZ));
        $this->pessoa('gestor', 'Gestora');
        $c = $this->pessoa('colaborador', 'Edson', 'cv');
        $this->nota($c, 50, 'cartao', 2026);
        $this->nota($c, 50, 'cartao', 2027);

        $this->assertSame([], $this->verificarCartoes(), 'sem recarga nunca não se sabe o saldo; o alarme seria falso');
    }

    public function test_recarga_de_ano_anterior_basta_para_o_cartao_entrar_no_aviso(): void
    {
        Carbon::setTestNow(Carbon::parse('2027-01-05 12:00:00', PontoCalculo::TZ));
        $this->pessoa('gestor', 'Gestora');
        $c = $this->pessoa('colaborador', 'Edson', 'cv');
        $this->repasse($c, 1000, 2026);
        $this->nota($c, 900, 'cartao', 2027);

        $avisos = $this->verificarCartoes();

        $this->assertCount(1, $avisos);
        $this->assertStringContainsString('R$ 100,00', $avisos[0]);
    }
}
