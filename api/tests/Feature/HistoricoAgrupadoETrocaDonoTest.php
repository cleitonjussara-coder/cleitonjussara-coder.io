<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Mockery;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\TestCase;

/**
 * 04/11/2026. Duas frentes:
 *   Histórico: excluir um colaborador grava uma lápide por nota; 500 delas enchiam a janela do detalhe e escondiam os
 *   apagamentos antigos. O detalhe agora agrupa; a rota do sync segue devolvendo todos os ids.
 *   Anexo: o PUT que troca o dono deixava o arquivo na pasta antiga, onde o novo dono não abre e de onde apagar a nota não
 *   tira. Agora o arquivo muda junto, e nenhuma falha no caminho perde o comprovante nem troca o dono pela metade.
 */
class HistoricoAgrupadoETrocaDonoTest extends TestCase
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

    private function pessoa(string $role, string $nome): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome, 'email' => Str::slug($nome).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['regime' => 'rdm_rda', 'ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    /** Nota com anexo de verdade em <dono>/<id>.<ext>, ou na pasta geral quando não tem dono. */
    private function notaComAnexo(?Colaborador $dono, string $ext = 'jpg', ?string $pasta = null): Nota
    {
        $id = (string) Str::uuid();
        $pasta ??= $dono?->id ?? Nota::PASTA_GERAL;
        Storage::disk('fotos')->put("{$pasta}/{$id}.{$ext}", 'COMPROVANTE');
        $n = new Nota(['id' => $id, 'foto_path' => "{$pasta}/{$id}.{$ext}"] + $this->dados($dono?->id, $dono === null ? ['pagamento' => 'empresa'] : []));
        $n->save();

        return $n;
    }

    private function dados(?string $dono, array $troca = []): array
    {
        return array_replace([
            'user_id' => $dono, 'tipo' => 'RDM', 'subtipo' => 'Outros', 'valor' => 10, 'data' => '2026-03-10',
            'mes' => 3, 'ano' => 2026, 'razao_social' => 'X',
        ], $troca);
    }

    private function trocarDono(Colaborador $quem, Nota $n, ?string $novo, array $troca = [])
    {
        Sanctum::actingAs($quem);

        return $this->putJson("/api/notas/{$n->id}", $this->dados($novo, $troca));
    }

    private function lapide(string $dono, string $por, string $em, ?string $id = null): void
    {
        DB::table('notas_apagadas')->insert(['id' => $id ?? (string) Str::uuid(), 'user_id' => $dono, 'apagada_por' => $por, 'apagada_em' => $em]);
    }

    private function lapides(string $dono, string $por, string $em, int $n): void
    {
        foreach (array_chunk(range(1, $n), 200) as $lote) {
            DB::table('notas_apagadas')->insert(array_map(
                fn () => ['id' => (string) Str::uuid(), 'user_id' => $dono, 'apagada_por' => $por, 'apagada_em' => $em], $lote,
            ));
        }
    }

    private function discoQueFalhaEm(string $metodo): void
    {
        $disco = Mockery::mock(Storage::disk('fotos'));
        $disco->shouldReceive($metodo)->andThrow(new RuntimeException('disco cheio'));
        Storage::set('fotos', $disco);
    }

    /* ── Histórico ───────────────────────────────────────────── */

    public function test_exclusao_grande_vira_uma_linha_e_nao_esconde_o_apagamento_antigo(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $paulo = $this->pessoa('colaborador', 'Paulo');
        $alvo = (string) Str::uuid();   // já excluído: não está mais em colaboradores
        $this->lapide($paulo->id, $g->id, '2026-10-01 10:00:00', 'antiga');
        $this->lapides($alvo, $g->id, '2026-11-01 10:00:00', 600);
        Sanctum::actingAs($g);

        $linhas = $this->getJson('/api/notas/apagadas?detalhe=1')->assertOk()->assertJsonCount(2)->json();

        $this->assertSame(600, $linhas[0]['quantidade']);
        $this->assertTrue($linhas[0]['colaborador_excluido']);
        $this->assertSame($alvo, $linhas[0]['user_id']);
        $this->assertSame('antiga', $linhas[1]['id'], 'o apagamento antigo continua aparecendo');
        $this->assertSame(1, $linhas[1]['quantidade']);
    }

    public function test_exclusao_de_verdade_e_reconhecida_e_o_apagamento_anterior_da_mesma_pessoa_nao(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $alvo = $this->pessoa('colaborador', 'Alvo');
        $this->lapide($alvo->id, $g->id, '2026-10-01 10:00:00', 'de-antes');
        foreach (range(1, 3) as $_) {
            (new Nota(['id' => (string) Str::uuid()] + $this->dados($alvo->id)))->save();
        }
        Sanctum::actingAs($g);
        $this->postJson("/api/colaboradores/{$alvo->id}/excluir", ['confirmacao' => 'EXCLUIR'])->assertOk();

        $linhas = $this->getJson('/api/notas/apagadas?detalhe=1')->assertOk()->assertJsonCount(2)->json();

        $this->assertSame(3, $linhas[0]['quantidade']);
        $this->assertTrue($linhas[0]['colaborador_excluido']);
        $this->assertSame('de-antes', $linhas[1]['id']);
        $this->assertFalse($linhas[1]['colaborador_excluido'], 'este foi um apagamento comum, antes da exclusão');
    }

    public function test_lapide_unica_segue_com_os_campos_de_antes(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $this->lapide($g->id, $g->id, '2026-10-17 00:57:00', 'nota-1');
        Sanctum::actingAs($g);

        $this->getJson('/api/notas/apagadas?detalhe=1')->assertOk()->assertExactJson([[
            'id' => 'nota-1', 'user_id' => $g->id, 'apagada_por' => $g->id, 'apagada_em' => '2026-10-17T00:57:00.000000Z',
            'quantidade' => 1, 'colaborador_excluido' => false,
        ]]);
    }

    public function test_lixeira_esvaziada_no_mesmo_segundo_agrupa_sem_dizer_que_excluiu_colaborador(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $paulo = $this->pessoa('colaborador', 'Paulo');
        $this->lapides($paulo->id, $g->id, '2026-11-01 10:00:00', 4);
        Sanctum::actingAs($g);

        $linha = $this->getJson('/api/notas/apagadas?detalhe=1')->assertOk()->assertJsonCount(1)->json(0);

        $this->assertSame(4, $linha['quantidade']);
        $this->assertFalse($linha['colaborador_excluido'], 'o Paulo continua na equipe');
    }

    public function test_grupos_separam_por_dono_por_quem_apagou_e_por_instante(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $a = $this->pessoa('admin', 'Admin');
        $paulo = $this->pessoa('colaborador', 'Paulo');
        $em = '2026-11-01 10:00:00';
        $this->lapide($paulo->id, $g->id, $em);
        $this->lapide($paulo->id, $a->id, $em);
        $this->lapide($g->id, $g->id, $em);
        $this->lapide($paulo->id, $g->id, '2026-11-01 10:00:01');
        DB::table('notas_apagadas')->insert([
            ['id' => 'sem-dono-1', 'user_id' => null, 'apagada_por' => $g->id, 'apagada_em' => $em],
            ['id' => 'sem-dono-2', 'user_id' => null, 'apagada_por' => $g->id, 'apagada_em' => $em],
        ]);
        Sanctum::actingAs($g);

        $linhas = collect($this->getJson('/api/notas/apagadas?detalhe=1')->assertOk()->assertJsonCount(5)->json());

        $semDono = $linhas->firstWhere('user_id', null);
        $this->assertSame(2, $semDono['quantidade'], 'Faturamento sem colaborador também agrupa');
        $this->assertFalse($semDono['colaborador_excluido']);
    }

    public function test_limite_conta_grupos_e_mantem_os_mais_novos(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $base = Carbon::parse('2026-01-01 00:00:00', 'UTC');
        foreach (array_chunk(range(0, 500), 200) as $lote) {
            DB::table('notas_apagadas')->insert(array_map(fn ($i) => [
                'id' => "n{$i}", 'user_id' => $g->id, 'apagada_por' => $g->id, 'apagada_em' => $base->copy()->addMinutes($i)->format('Y-m-d H:i:s'),
            ], $lote));
        }
        Sanctum::actingAs($g);

        $linhas = $this->getJson('/api/notas/apagadas?detalhe=1')->assertOk()->assertJsonCount(500)->json();

        $this->assertSame('n500', $linhas[0]['id']);
        $this->assertSame('n1', $linhas[499]['id'], 'só a mais velha ficou de fora');
    }

    public function test_since_continua_filtrando_o_detalhe(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $this->lapides($g->id, $g->id, '2026-10-01 10:00:00', 3);
        $this->lapides($g->id, $g->id, '2026-11-01 10:00:00', 2);
        Sanctum::actingAs($g);

        $this->getJson('/api/notas/apagadas?detalhe=1&since='.urlencode('2026-10-15T00:00:00.000Z'))
            ->assertOk()->assertJsonCount(1)->assertJsonPath('0.quantidade', 2);
    }

    public function test_rota_do_sync_nao_agrupa(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $this->lapides($g->id, $g->id, '2026-11-01 10:00:00', 600);
        Sanctum::actingAs($g);

        $ids = $this->getJson('/api/notas/apagadas')->assertOk()->assertJsonCount(600)->json();

        $this->assertIsString($ids[0], 'só os ids, um por nota');
    }

    public function test_colaborador_so_ve_os_grupos_dele_e_contador_segue_barrado_no_detalhe(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $paulo = $this->pessoa('colaborador', 'Paulo');
        $contador = $this->pessoa('contabilidade', 'Contador');
        $em = '2026-11-01 10:00:00';
        $this->lapides($paulo->id, $g->id, $em, 2);
        $this->lapides($g->id, $g->id, $em, 3);

        Sanctum::actingAs($paulo);
        $this->getJson('/api/notas/apagadas?detalhe=1')->assertOk()->assertJsonCount(1)->assertJsonPath('0.quantidade', 2);

        Sanctum::actingAs($contador);
        $this->getJson('/api/notas/apagadas?detalhe=1')->assertForbidden();
        $this->getJson('/api/notas/apagadas')->assertOk()->assertJsonCount(5);
    }

    /* ── Anexo ao trocar o dono ──────────────────────────────── */

    public function test_trocar_dono_leva_anexo_e_miniatura_e_o_novo_dono_abre(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $n = $this->notaComAnexo($velho);
        $disco = Storage::disk('fotos');
        $disco->put("{$velho->id}/mini/{$n->id}.jpg", 'MINI');

        $this->trocarDono($g, $n, $novo->id)->assertOk()->assertJsonPath('foto_path', "{$novo->id}/{$n->id}.jpg");

        $this->assertSame('COMPROVANTE', $disco->get("{$novo->id}/{$n->id}.jpg"));
        $this->assertSame('MINI', $disco->get("{$novo->id}/mini/{$n->id}.jpg"));
        $this->assertEqualsCanonicalizing(["{$novo->id}/{$n->id}.jpg", "{$novo->id}/mini/{$n->id}.jpg"], $disco->allFiles(), 'nada fica na pasta antiga');

        Sanctum::actingAs($novo);
        $url = $this->postJson('/api/fotos/urls', ['paths' => [$n->fresh()->foto_path]])->assertOk()->json('0.url');
        $this->assertNotNull($url, 'o acesso vale pela pasta: o novo dono tem de conseguir abrir');
    }

    public function test_nota_que_fica_sem_colaborador_vai_para_a_pasta_geral_e_volta(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $dono = $this->pessoa('colaborador', 'Dono');
        $n = $this->notaComAnexo($dono, 'pdf');
        $disco = Storage::disk('fotos');

        $this->trocarDono($g, $n, null, ['pagamento' => 'empresa'])->assertOk();
        $this->assertSame(Nota::PASTA_GERAL."/{$n->id}.pdf", $n->fresh()->foto_path);
        $this->assertSame([Nota::PASTA_GERAL."/{$n->id}.pdf"], $disco->allFiles());

        $this->trocarDono($g, $n, $dono->id, ['pagamento' => 'empresa'])->assertOk();
        $this->assertSame("{$dono->id}/{$n->id}.pdf", $n->fresh()->foto_path);
        $this->assertSame(["{$dono->id}/{$n->id}.pdf"], $disco->allFiles());
    }

    public function test_nota_sem_anexo_so_troca_o_dono(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $n = new Nota(['id' => (string) Str::uuid()] + $this->dados($velho->id));
        $n->save();

        $this->trocarDono($g, $n, $novo->id)->assertOk()->assertJsonPath('user_id', $novo->id)->assertJsonPath('foto_path', null);

        $this->assertSame([], Storage::disk('fotos')->allFiles());
    }

    public function test_nota_que_perdeu_a_referencia_leva_o_arquivo_achado_na_pasta_do_dono(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $n = $this->notaComAnexo($velho);
        DB::table('notas')->where('id', $n->id)->update(['foto_path' => null]);

        $this->trocarDono($g, $n->fresh(), $novo->id)->assertOk()->assertJsonPath('foto_path', "{$novo->id}/{$n->id}.jpg");
    }

    public function test_edicao_sem_troca_de_dono_nao_mexe_no_arquivo(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $dono = $this->pessoa('colaborador', 'Dono');
        $n = $this->notaComAnexo($dono);

        $this->trocarDono($g, $n, $dono->id, ['valor' => 20])->assertOk();

        $this->assertSame("{$dono->id}/{$n->id}.jpg", $n->fresh()->foto_path);
        $this->assertSame(["{$dono->id}/{$n->id}.jpg"], Storage::disk('fotos')->allFiles());
    }

    public function test_caminho_mandado_pelo_cliente_nao_decide_o_que_e_movido(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $n = $this->notaComAnexo($velho);
        $alheia = $this->notaComAnexo($g);

        $this->trocarDono($g, $n, $novo->id, ['foto_path' => $alheia->foto_path])->assertOk()
            ->assertJsonPath('foto_path', "{$novo->id}/{$n->id}.jpg");

        $this->assertSame('COMPROVANTE', Storage::disk('fotos')->get($alheia->foto_path), 'o arquivo de outra nota fica onde está');
    }

    public function test_foto_path_antigo_de_outra_nota_nao_arrasta_o_arquivo_dela(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $alheia = $this->notaComAnexo($g);
        $n = new Nota(['id' => (string) Str::uuid(), 'foto_path' => $alheia->foto_path] + $this->dados($velho->id));
        $n->save();

        $this->trocarDono($g, $n, $novo->id)->assertOk();

        $this->assertSame([$alheia->foto_path], Storage::disk('fotos')->allFiles());
    }

    public function test_nota_legada_com_anexo_em_pasta_antiga_e_movida_de_onde_esta(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $primeiro = $this->pessoa('colaborador', 'Primeiro');
        $segundo = $this->pessoa('colaborador', 'Segundo');
        $terceiro = $this->pessoa('colaborador', 'Terceiro');
        $n = $this->notaComAnexo($segundo, pasta: $primeiro->id);   // trocou de dono antes desta correção

        $this->trocarDono($g, $n, $terceiro->id)->assertOk()->assertJsonPath('foto_path', "{$terceiro->id}/{$n->id}.jpg");

        $this->assertSame(["{$terceiro->id}/{$n->id}.jpg"], Storage::disk('fotos')->allFiles());
    }

    public function test_nota_legada_voltando_ao_dono_da_pasta_nao_perde_o_arquivo(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $primeiro = $this->pessoa('colaborador', 'Primeiro');
        $segundo = $this->pessoa('colaborador', 'Segundo');
        $n = $this->notaComAnexo($segundo, pasta: $primeiro->id);

        $this->trocarDono($g, $n, $primeiro->id)->assertOk()->assertJsonPath('foto_path', "{$primeiro->id}/{$n->id}.jpg");

        $this->assertSame('COMPROVANTE', Storage::disk('fotos')->get("{$primeiro->id}/{$n->id}.jpg"));
    }

    public function test_sobra_de_outro_formato_no_destino_nao_fica_orfa(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $n = $this->notaComAnexo($velho, 'pdf');
        Storage::disk('fotos')->put("{$novo->id}/{$n->id}.jpg", 'SOBRA');

        $this->trocarDono($g, $n, $novo->id)->assertOk();

        $this->assertSame(["{$novo->id}/{$n->id}.pdf"], Storage::disk('fotos')->allFiles());
    }

    public static function falhasAoCopiar(): array
    {
        return ['falha ao copiar' => ['copy'], 'falha ao dar o nome final' => ['move'], 'falha ao conferir' => ['size']];
    }

    #[DataProvider('falhasAoCopiar')]
    public function test_falha_ao_copiar_nao_troca_o_dono_nem_perde_o_comprovante(string $metodo): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $n = $this->notaComAnexo($velho);
        Storage::disk('fotos')->put("{$velho->id}/mini/{$n->id}.jpg", 'MINI');
        $this->discoQueFalhaEm($metodo);

        $this->trocarDono($g, $n, $novo->id, ['valor' => 99])->assertStatus(503)
            ->assertJsonPath('message', fn ($m) => str_contains($m, 'Nada foi alterado'));

        $depois = $n->fresh();
        $this->assertSame($velho->id, $depois->user_id);
        $this->assertSame("{$velho->id}/{$n->id}.jpg", $depois->foto_path);
        $this->assertEquals(10, $depois->valor, 'nada da edição entra pela metade');
        $this->assertEqualsCanonicalizing(["{$velho->id}/{$n->id}.jpg", "{$velho->id}/mini/{$n->id}.jpg"], Storage::disk('fotos')->allFiles(), 'nenhuma cópia ou temporário sobra');
    }

    public function test_falha_ao_levar_a_espera_desfaz_a_copia_do_anexo(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $n = $this->notaComAnexo($velho);
        $disco = Storage::disk('fotos');
        $disco->put("{$velho->id}/espera/{$n->id}.pdf", 'ESPERANDO');
        $falsa = Mockery::mock($disco);
        $falsa->shouldReceive('copy')->andReturnUsing(function ($de, $para) use ($disco) {
            if (str_contains($de, '/espera/')) {
                throw new RuntimeException('disco cheio');
            }

            return $disco->copy($de, $para);
        });
        Storage::set('fotos', $falsa);

        $this->trocarDono($g, $n, $novo->id)->assertStatus(503);

        $this->assertSame($velho->id, $n->fresh()->user_id);
        $this->assertEqualsCanonicalizing(["{$velho->id}/{$n->id}.jpg", "{$velho->id}/espera/{$n->id}.pdf"], $disco->allFiles());
    }

    public function test_falha_ao_gravar_a_nota_tira_a_copia_e_mantem_a_origem(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $n = $this->notaComAnexo($velho);
        DB::unprepared("CREATE TRIGGER trava_nota BEFORE UPDATE ON notas BEGIN SELECT RAISE(ABORT, 'falha simulada'); END");

        $this->trocarDono($g, $n, $novo->id)->assertStatus(500);

        DB::unprepared('DROP TRIGGER trava_nota');
        $this->assertSame("{$velho->id}/{$n->id}.jpg", $n->fresh()->foto_path);
        $this->assertSame(["{$velho->id}/{$n->id}.jpg"], Storage::disk('fotos')->allFiles(), 'o arquivo fica só onde a nota aponta');
    }

    public function test_falha_ao_apagar_a_origem_nao_derruba_a_troca(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $n = $this->notaComAnexo($velho);
        $this->discoQueFalhaEm('delete');
        Log::spy();

        $this->trocarDono($g, $n, $novo->id)->assertOk()->assertJsonPath('foto_path', "{$novo->id}/{$n->id}.jpg");

        $this->assertSame('COMPROVANTE', Storage::disk('fotos')->get("{$novo->id}/{$n->id}.jpg"));
        Log::shouldHaveReceived('warning')->withArgs(fn ($msg) => str_contains($msg, 'origem não apagada'))->once();
    }

    public function test_anexo_sumido_do_disco_nao_impede_a_troca(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $n = $this->notaComAnexo($velho);
        Storage::disk('fotos')->delete($n->foto_path);

        $this->trocarDono($g, $n, $novo->id)->assertOk()->assertJsonPath('user_id', $novo->id);
    }

    public function test_contador_e_colaborador_nao_trocam_dono_e_o_arquivo_fica(): void
    {
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $contador = $this->pessoa('contabilidade', 'Contador');
        $n = $this->notaComAnexo($velho);

        $this->trocarDono($contador, $n, $novo->id)->assertForbidden();
        $this->trocarDono($velho, $n, $novo->id)->assertForbidden();

        $this->assertSame($velho->id, $n->fresh()->user_id);
        $this->assertSame(["{$velho->id}/{$n->id}.jpg"], Storage::disk('fotos')->allFiles());
    }

    /** Arquivos que o dono anterior deixou esperando e que seguem guardados, sem chance de virar anexo. */
    private function herdadas(string $pasta): array
    {
        return Storage::disk('fotos')->files("{$pasta}/espera-herdada");
    }

    public function test_anexo_em_espera_acompanha_a_nota_guardado_e_o_409_do_novo_dono_nao_o_apaga(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        Carbon::setTestNow('2026-11-01 12:00:00');
        $n = $this->notaComAnexo($velho);
        $disco = Storage::disk('fotos');
        $disco->put("{$velho->id}/espera/{$n->id}.pdf", 'ESPERANDO');

        Carbon::setTestNow('2026-11-02 12:00:00');
        $this->trocarDono($g, $n, $novo->id)->assertOk();
        $this->assertCount(1, $this->herdadas($novo->id));
        $this->assertSame('ESPERANDO', $disco->get($this->herdadas($novo->id)[0]));
        $this->assertFalse($disco->exists("{$velho->id}/espera/{$n->id}.pdf"), 'na pasta antiga ninguém mais a alcançaria');
        $this->assertFalse($disco->exists("{$novo->id}/espera/{$n->id}.pdf"), 'na espera do novo dono o próximo PUT dele a promoveria');

        Sanctum::actingAs($novo);
        $this->putJson("/api/notas/{$n->id}", $this->dados($novo->id, ['base_updated_at' => '2026-11-01T12:00:00.000Z']))
            ->assertStatus(409)->assertJsonPath('conflito', true);

        $this->assertSame('COMPROVANTE', $disco->get("{$novo->id}/{$n->id}.jpg"));
        $this->assertCount(1, $this->herdadas($novo->id), 'o 409 é da edição do novo dono, não do arquivo do anterior');
    }

    /* Achado do revisor (04/11/2026): o PUT do dono antigo toma 403, então a espera dele nunca é resolvida; levada para a
       espera do novo dono, o primeiro PUT aceito dele a promovia e apagava o comprovante que a gestão tinha levado. */
    public function test_put_do_novo_dono_nao_troca_o_comprovante_pelo_arquivo_do_dono_antigo(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        Carbon::setTestNow('2026-11-01 12:00:00');
        $n = $this->notaComAnexo($velho);
        $disco = Storage::disk('fotos');
        $disco->put("{$velho->id}/espera/{$n->id}.pdf", 'DO-DONO-ANTIGO');

        Carbon::setTestNow('2026-11-02 12:00:00');
        $v = $this->trocarDono($g, $n, $novo->id)->assertOk()->json();

        Carbon::setTestNow('2026-11-03 12:00:00');
        Sanctum::actingAs($novo);
        $this->putJson("/api/notas/{$n->id}", $this->dados($novo->id, ['razao_social' => 'corrigi', 'base_updated_at' => $v['updated_at']]))
            ->assertOk()->assertJsonPath('foto_path', "{$novo->id}/{$n->id}.jpg");

        $this->assertSame('COMPROVANTE', $disco->get("{$novo->id}/{$n->id}.jpg"));
        $this->assertSame('DO-DONO-ANTIGO', $disco->get($this->herdadas($novo->id)[0]), 'o arquivo do dono antigo também não se perde');
    }

    public function test_volta_ao_dono_antigo_tambem_nao_promove_a_espera_dele(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        Carbon::setTestNow('2026-11-01 12:00:00');
        $n = $this->notaComAnexo($velho);
        $disco = Storage::disk('fotos');
        $disco->put("{$velho->id}/espera/{$n->id}.pdf", 'DO-DONO-ANTIGO');

        Carbon::setTestNow('2026-11-02 12:00:00');
        $this->trocarDono($g, $n, $novo->id)->assertOk();
        Carbon::setTestNow('2026-11-02 13:00:00');
        $v = $this->trocarDono($g, $n, $velho->id)->assertOk()->json();

        Carbon::setTestNow('2026-11-03 12:00:00');
        Sanctum::actingAs($velho);
        $this->putJson("/api/notas/{$n->id}", $this->dados($velho->id, ['base_updated_at' => $v['updated_at']]))
            ->assertOk()->assertJsonPath('foto_path', "{$velho->id}/{$n->id}.jpg");

        $this->assertSame('COMPROVANTE', $disco->get("{$velho->id}/{$n->id}.jpg"));
        $this->assertCount(1, $this->herdadas($velho->id));
        $this->assertSame([], $this->herdadas($novo->id));
    }

    public function test_anexo_que_o_novo_dono_sobe_depois_da_troca_segue_valendo(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        Carbon::setTestNow('2026-11-01 12:00:00');
        $n = $this->notaComAnexo($velho);
        $disco = Storage::disk('fotos');
        $disco->put("{$velho->id}/espera/{$n->id}.pdf", 'DO-DONO-ANTIGO');

        Carbon::setTestNow('2026-11-02 12:00:00');
        $v = $this->trocarDono($g, $n, $novo->id)->assertOk()->json();

        Carbon::setTestNow('2026-11-03 12:00:00');
        Sanctum::actingAs($novo);
        $this->post("/api/notas/{$n->id}/foto", ['file' => UploadedFile::fake()->create('nova.pdf', 1, 'application/pdf'), 'ext' => 'pdf'])->assertOk();
        $this->assertSame("{$novo->id}/{$n->id}.jpg", $n->fresh()->foto_path, 'última edição da gestão: o arquivo dele espera o PUT');
        $this->putJson("/api/notas/{$n->id}", $this->dados($novo->id, ['base_updated_at' => $v['updated_at']]))
            ->assertOk()->assertJsonPath('foto_path', "{$novo->id}/{$n->id}.pdf");

        $this->assertFalse($disco->exists("{$novo->id}/{$n->id}.jpg"), 'troca pedida pelo dono: o anexo anterior sai, como sempre');
        $this->assertSame('DO-DONO-ANTIGO', $disco->get($this->herdadas($novo->id)[0]));
    }

    public function test_duas_esperas_do_mesmo_formato_nao_se_sobrescrevem_em_trocas_seguidas(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $a = $this->pessoa('colaborador', 'A');
        $b = $this->pessoa('colaborador', 'B');
        $c = $this->pessoa('colaborador', 'C');
        $n = $this->notaComAnexo($a);
        $disco = Storage::disk('fotos');
        $disco->put("{$a->id}/espera/{$n->id}.pdf", 'PRIMEIRA');
        $this->trocarDono($g, $n, $b->id)->assertOk();
        $disco->put("{$b->id}/espera/{$n->id}.pdf", 'SEGUNDA');

        $this->trocarDono($g, $n, $c->id)->assertOk();

        $conteudos = array_map(fn ($f) => $disco->get($f), $this->herdadas($c->id));
        $this->assertEqualsCanonicalizing(['PRIMEIRA', 'SEGUNDA'], $conteudos);
        $this->assertSame([], $this->herdadas($b->id));
    }

    public function test_espera_herdada_nao_sai_por_url_e_some_com_a_nota(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $n = $this->notaComAnexo($velho);
        Storage::disk('fotos')->put("{$velho->id}/espera/{$n->id}.pdf", 'ESPERANDO');
        $this->trocarDono($g, $n, $novo->id)->assertOk();

        $caminho = $this->herdadas($novo->id)[0];
        $this->assertNull($this->postJson('/api/fotos/urls', ['paths' => [$caminho]])->assertOk()->json('0.url'));

        $this->trocarDono($g, $n, $novo->id, ['deleted' => true])->assertOk();
        $this->deleteJson("/api/notas/{$n->id}")->assertOk();

        $this->assertSame([], Storage::disk('fotos')->allFiles());
    }

    public function test_anexo_em_espera_sem_anexo_atual_tambem_e_levado(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $n = new Nota(['id' => (string) Str::uuid()] + $this->dados($velho->id));
        $n->save();
        Storage::disk('fotos')->put("{$velho->id}/espera/{$n->id}.pdf", 'ESPERANDO');

        $this->trocarDono($g, $n, $novo->id)->assertOk()->assertJsonPath('foto_path', null);

        $this->assertSame($this->herdadas($novo->id), Storage::disk('fotos')->allFiles());
        $this->assertCount(1, $this->herdadas($novo->id));
    }

    public function test_apagar_a_nota_depois_da_troca_nao_deixa_orfao_e_a_fila_antiga_toma_410(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $n = $this->notaComAnexo($velho);
        $this->trocarDono($g, $n, $novo->id)->assertOk();

        $this->trocarDono($g, $n, $novo->id, ['deleted' => true])->assertOk();
        $this->deleteJson("/api/notas/{$n->id}")->assertOk();

        $this->assertSame([], Storage::disk('fotos')->allFiles());
        $this->trocarDono($g, $n, $velho->id)->assertStatus(410);
        $this->assertSame([], Storage::disk('fotos')->allFiles());
    }

    public function test_apagar_nota_legada_tira_o_arquivo_da_pasta_antiga(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $primeiro = $this->pessoa('colaborador', 'Primeiro');
        $segundo = $this->pessoa('colaborador', 'Segundo');
        $n = $this->notaComAnexo($segundo, pasta: $primeiro->id);
        $n->forceFill(['deleted' => true])->save();
        Storage::disk('fotos')->put("{$primeiro->id}/mini/{$n->id}.jpg", 'MINI');
        Storage::disk('fotos')->put("{$primeiro->id}/outra.jpg", 'DE OUTRA NOTA');
        Sanctum::actingAs($g);

        $this->deleteJson("/api/notas/{$n->id}")->assertOk();

        $this->assertSame(["{$primeiro->id}/outra.jpg"], Storage::disk('fotos')->allFiles());
    }

    public function test_excluir_o_dono_antigo_depois_da_troca_nao_toca_no_comprovante(): void
    {
        $g = $this->pessoa('gestor', 'Gestora');
        $velho = $this->pessoa('colaborador', 'Velho');
        $novo = $this->pessoa('colaborador', 'Novo');
        $n = $this->notaComAnexo($velho);
        $this->trocarDono($g, $n, $novo->id)->assertOk();

        $this->postJson("/api/colaboradores/{$velho->id}/excluir", ['confirmacao' => 'EXCLUIR'])->assertOk();

        $this->assertSame('COMPROVANTE', Storage::disk('fotos')->get($n->fresh()->foto_path));
    }
}
