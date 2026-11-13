<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 13/11/2026 (pedido do Cleiton): gestor, admin e o dono ajustam a foto de uma nota já enviada. A primeira troca guarda a foto
 * de antes em <pasta>/original/, as seguintes não mexem nela, e dá para voltar a ela. O Contador fica de fora.
 */
class FotoOriginalTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('fotos');
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

    private function notaComAnexo(?Colaborador $dono, string $conteudo = 'FOTO DO COLABORADOR'): Nota
    {
        $id = (string) Str::uuid();
        $pasta = $dono?->id ?? Nota::PASTA_GERAL;
        Storage::disk('fotos')->put("{$pasta}/{$id}.jpg", $conteudo);
        $n = new Nota(['id' => $id, 'foto_path' => "{$pasta}/{$id}.jpg", 'user_id' => $dono?->id, 'tipo' => 'RDM', 'subtipo' => 'Outros',
            'valor' => 10, 'data' => '2026-03-10', 'mes' => 3, 'ano' => 2026, 'razao_social' => 'X', 'pagamento' => $dono ? null : 'empresa']);
        $n->save();

        return $n;
    }

    private function enviar(Nota $n, string $conteudo)
    {
        return $this->post("/api/notas/{$n->id}/foto", ['file' => UploadedFile::fake()->createWithContent('f.jpg', $conteudo), 'ext' => 'jpg']);
    }

    private function disco()
    {
        return Storage::disk('fotos');
    }

    public function test_gestor_ajusta_a_foto_e_a_original_fica_guardada_so_a_primeira(): void
    {
        $dono = $this->pessoa('colaborador', 'Paulo');
        $gestor = $this->pessoa('gestor', 'Ana');
        $n = $this->notaComAnexo($dono);
        Sanctum::actingAs($gestor);

        $this->getJson("/api/notas/{$n->id}/foto/original")->assertOk()->assertJsonPath('tem_original', false);
        $this->enviar($n, 'AJUSTE 1')->assertOk();
        $this->enviar($n, 'AJUSTE 2')->assertOk();

        $this->assertSame('AJUSTE 2', $this->disco()->get("{$dono->id}/{$n->id}.jpg"));
        $this->assertSame('FOTO DO COLABORADOR', $this->disco()->get("{$dono->id}/original/{$n->id}.jpg"));
        $this->getJson("/api/notas/{$n->id}/foto/original")->assertOk()->assertJsonPath('tem_original', true);
    }

    public function test_reenvio_do_mesmo_arquivo_nao_guarda_original(): void
    {
        $dono = $this->pessoa('colaborador', 'Paulo');
        $n = $this->notaComAnexo($dono);
        Sanctum::actingAs($dono);

        $this->enviar($n, 'FOTO DO COLABORADOR')->assertOk();

        $this->assertFalse($this->disco()->exists("{$dono->id}/original/{$n->id}.jpg"));
    }

    public function test_voltar_a_original_troca_o_anexo_registra_historico_e_mantem_a_original(): void
    {
        $dono = $this->pessoa('colaborador', 'Paulo');
        $gestor = $this->pessoa('gestor', 'Ana');
        $n = $this->notaComAnexo($dono);
        Sanctum::actingAs($gestor);
        $this->enviar($n, 'AJUSTADA')->assertOk();

        $this->postJson("/api/notas/{$n->id}/foto/original")->assertOk()->assertJsonPath('foto_path', "{$dono->id}/{$n->id}.jpg");

        $this->assertSame('FOTO DO COLABORADOR', $this->disco()->get("{$dono->id}/{$n->id}.jpg"));
        $this->assertTrue($this->disco()->exists("{$dono->id}/original/{$n->id}.jpg"), 'a original continua guardada');
        $this->assertSame($gestor->id, $n->fresh()->updated_by);
        if (DB::getSchemaBuilder()->hasTable('notas_historico')) {
            $this->assertTrue(DB::table('notas_historico')->where('nota_id', $n->id)->where('campos', 'like', '%foto original restaurada%')->exists());
        }
    }

    public function test_dono_ajusta_e_volta_a_original_da_propria_nota(): void
    {
        $dono = $this->pessoa('colaborador', 'Paulo');
        $n = $this->notaComAnexo($dono);
        Sanctum::actingAs($dono);

        $this->enviar($n, 'AJUSTADA')->assertOk();
        $this->postJson("/api/notas/{$n->id}/foto/original")->assertOk();

        $this->assertSame('FOTO DO COLABORADOR', $this->disco()->get("{$dono->id}/{$n->id}.jpg"));
    }

    public function test_outro_colaborador_e_contador_nao_mexem_na_original(): void
    {
        $dono = $this->pessoa('colaborador', 'Paulo');
        $gestor = $this->pessoa('gestor', 'Ana');
        $n = $this->notaComAnexo($dono);
        Sanctum::actingAs($gestor);
        $this->enviar($n, 'AJUSTADA')->assertOk();

        Sanctum::actingAs($this->pessoa('colaborador', 'Outro'));
        $this->getJson("/api/notas/{$n->id}/foto/original")->assertForbidden();
        $this->postJson("/api/notas/{$n->id}/foto/original")->assertForbidden();

        Sanctum::actingAs($this->pessoa('contabilidade', 'Contador'));
        $this->getJson("/api/notas/{$n->id}/foto/original")->assertForbidden();
        $this->postJson("/api/notas/{$n->id}/foto/original")->assertForbidden();

        $this->assertSame('AJUSTADA', $this->disco()->get("{$dono->id}/{$n->id}.jpg"));
    }

    public function test_sem_original_responde_404(): void
    {
        $dono = $this->pessoa('colaborador', 'Paulo');
        $n = $this->notaComAnexo($dono);
        Sanctum::actingAs($this->pessoa('admin', 'Cleiton'));

        $this->postJson("/api/notas/{$n->id}/foto/original")->assertNotFound();
    }

    public function test_faturamento_sem_colaborador_guarda_original_na_pasta_geral(): void
    {
        $gestor = $this->pessoa('gestor', 'Ana');
        $n = $this->notaComAnexo(null);
        Sanctum::actingAs($gestor);

        $this->enviar($n, 'AJUSTADA')->assertOk();

        $this->assertSame('FOTO DO COLABORADOR', $this->disco()->get(Nota::PASTA_GERAL."/original/{$n->id}.jpg"));
    }

    public function test_original_acompanha_a_troca_de_dono_e_sai_quando_a_nota_e_apagada(): void
    {
        $dono = $this->pessoa('colaborador', 'Paulo');
        $novo = $this->pessoa('colaborador', 'Maria');
        $gestor = $this->pessoa('gestor', 'Ana');
        $n = $this->notaComAnexo($dono);
        Sanctum::actingAs($gestor);
        $this->enviar($n, 'AJUSTADA')->assertOk();

        $this->putJson("/api/notas/{$n->id}", ['user_id' => $novo->id, 'tipo' => 'RDM', 'subtipo' => 'Outros', 'valor' => 10,
            'data' => '2026-03-10', 'mes' => 3, 'ano' => 2026, 'razao_social' => 'X'])->assertOk();

        $this->assertFalse($this->disco()->exists("{$dono->id}/original/{$n->id}.jpg"));
        $this->assertSame('FOTO DO COLABORADOR', $this->disco()->get("{$novo->id}/original/{$n->id}.jpg"));

        app(\App\Services\FotoStorage::class)->apagarTodasVersoes($n->fresh());
        $this->assertFalse($this->disco()->exists("{$novo->id}/original/{$n->id}.jpg"));
    }

    public function test_original_nao_sai_por_url(): void
    {
        $dono = $this->pessoa('colaborador', 'Paulo');
        $n = $this->notaComAnexo($dono);
        Sanctum::actingAs($dono);
        $this->enviar($n, 'AJUSTADA')->assertOk();

        $this->expectException(\InvalidArgumentException::class);
        app(\App\Services\FotoStorage::class)->validarCaminho("{$dono->id}/original/{$n->id}.jpg");
    }
}
