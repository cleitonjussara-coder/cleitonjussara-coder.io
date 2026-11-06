<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\NotaHistorico;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 06/11/2026 — pedido do dono: em cada nota, quem mudou o quê, com antes e depois. Cada caminho que muda nota grava; reenvio
 * idêntico do aparelho, 409, 410 e 403 não; e o histórico nunca derruba um lançamento, nem com a tabela fora do ar.
 */
class NotaHistoricoTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('fotos');
        NotaHistorico::esquecerTabela();
    }

    protected function tearDown(): void
    {
        NotaHistorico::esquecerTabela();
        parent::tearDown();
    }

    private function pessoa(string $role, string $sufixo = ''): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(),
            'nome' => ucfirst($role).$sufixo, 'email' => $role.$sufixo.'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function corpo(Colaborador $dono, array $campos = []): array
    {
        return array_replace([
            'user_id' => $dono->id, 'tipo' => 'RDM', 'subtipo' => 'Outros', 'valor' => 100,
            'data' => '2026-10-20', 'mes' => 10, 'ano' => 2026,
            'cnpj' => '12345678000195', 'razao_social' => 'POSTO BOM', 'observacao' => 'almoço',
        ], $campos);
    }

    /** Sobe o anexo e grava a nota pelo caminho de verdade do app. */
    private function lancar(Colaborador $quem, array $campos = []): string
    {
        $id = (string) Str::uuid();
        Sanctum::actingAs($quem);
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->create('n.jpg', 10, 'image/jpeg'), 'ext' => 'jpg', 'user_id' => $quem->id])->assertOk();
        $this->putJson("/api/notas/{$id}", $this->corpo($quem, $campos))->assertOk();

        return $id;
    }

    private function linhas(string $id): \Illuminate\Support\Collection
    {
        return NotaHistorico::where('nota_id', $id)->orderBy('id')->get();
    }

    private function ultima(string $id): NotaHistorico
    {
        return NotaHistorico::where('nota_id', $id)->orderByDesc('id')->firstOrFail();
    }

    public function test_criacao_grava_os_campos_que_a_nota_trouxe(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);

        $this->assertCount(1, $this->linhas($id));
        $h = $this->ultima($id);
        $this->assertSame('criacao', $h->acao);
        $this->assertSame($dono->id, $h->alterado_por);
        $this->assertSame('colaborador', $h->alterado_papel);
        $this->assertEqualsWithDelta(100, $h->campos['valor']['depois'], 0.001);
        $this->assertNull($h->campos['valor']['antes']);
        $this->assertArrayNotHasKey('deleted', $h->campos);
        $this->assertArrayNotHasKey('placa', $h->campos);
    }

    public function test_edicao_grava_so_o_campo_que_mudou(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);

        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 120.5]))->assertOk();

        $h = $this->ultima($id);
        $this->assertSame('edicao', $h->acao);
        $this->assertSame(['valor'], array_keys($h->campos));
        $this->assertEqualsWithDelta(100, $h->campos['valor']['antes'], 0.001);
        $this->assertEqualsWithDelta(120.5, $h->campos['valor']['depois'], 0.001);
    }

    public function test_reenvio_identico_do_aparelho_nao_grava(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono, ['valor' => 120.5]);

        /* o mesmo PUT, com as diferenças de forma que a fila do aparelho produz */
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 120.5]))->assertOk();
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, [
            'valor' => '120.50', 'cnpj' => '12.345.678/0001-95', 'razao_social' => 'POSTO BOM ', 'observacao' => ' almoço',
            'updated_at' => '2030-01-01T00:00:00Z', 'metodo_captura' => 'qr',
        ]))->assertOk();

        $this->assertCount(1, $this->linhas($id));
    }

    public function test_cnpj_de_zeros_e_vazio_nao_contam_como_mudanca(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono, ['cnpj' => null]);
        DB::table('notas')->where('id', $id)->update(['cnpj' => '00000000000000', 'observacao' => '']);

        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['cnpj' => null, 'observacao' => null]))->assertOk();

        $this->assertCount(1, $this->linhas($id));
    }

    public function test_corrigir_tipo_grava_e_sem_mudanca_nao(): void
    {
        $dono = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        $id = $this->lancar($dono);
        Sanctum::actingAs($gestor);

        $this->patchJson("/api/notas/{$id}/tipo", ['tipo' => 'RDM', 'subtipo' => 'Outros'])->assertOk()->assertJsonPath('mudou', false);
        $this->assertCount(1, $this->linhas($id));

        $this->patchJson("/api/notas/{$id}/tipo", ['tipo' => 'RDA'])->assertOk()->assertJsonPath('mudou', true);
        $h = $this->ultima($id);
        $this->assertSame('tipo', $h->acao);
        $this->assertSame(['antes' => 'RDM', 'depois' => 'RDA'], $h->campos['tipo']);
        $this->assertSame(['antes' => 'Outros', 'depois' => null], $h->campos['subtipo']);
        $this->assertSame('gestor', $h->alterado_papel);
    }

    public function test_lixeira_pelo_servidor_grava_enviar_e_restaurar_e_repetir_nao(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        Sanctum::actingAs($this->pessoa('gestor'));

        $this->patchJson("/api/notas/{$id}/lixeira", ['deleted' => true])->assertOk();
        $this->assertSame('lixeira', $this->ultima($id)->acao);
        $this->patchJson("/api/notas/{$id}/lixeira", ['deleted' => true])->assertOk();
        $this->assertCount(2, $this->linhas($id));

        $this->patchJson("/api/notas/{$id}/lixeira", ['deleted' => false])->assertOk();
        $this->assertSame('restaurada', $this->ultima($id)->acao);
        $this->assertCount(3, $this->linhas($id));
    }

    public function test_lixeira_pelo_put_do_aparelho_tambem_grava(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);

        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['deleted' => true]))->assertOk();
        $this->assertSame('lixeira', $this->ultima($id)->acao);

        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['deleted' => false]))->assertOk();
        $this->assertSame('restaurada', $this->ultima($id)->acao);
    }

    public function test_troca_de_anexo_grava_sem_o_caminho_e_reenvio_do_mesmo_arquivo_nao(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $arquivo = UploadedFile::fake()->createWithContent('novo.jpg', 'conteudo novo do comprovante');

        $this->post("/api/notas/{$id}/foto", ['file' => $arquivo, 'ext' => 'jpg'])->assertOk();
        $this->assertCount(2, $this->linhas($id));
        $this->assertSame('anexo', $this->ultima($id)->acao);

        $bruto = (string) DB::table('notas_historico')->where('nota_id', $id)->orderByDesc('id')->value('campos');
        $this->assertStringContainsString('anexo trocado', $bruto);
        $this->assertStringNotContainsString($dono->id, $bruto);
        $this->assertStringNotContainsString('.jpg', $bruto);

        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->createWithContent('novo.jpg', 'conteudo novo do comprovante'), 'ext' => 'jpg'])->assertOk();
        $this->assertCount(2, $this->linhas($id));

        $resposta = $this->getJson("/api/notas/{$id}/historico")->assertOk();
        $this->assertStringNotContainsString('.jpg', $resposta->getContent());
        $this->assertStringNotContainsString('foto_path', $resposta->getContent());
    }

    public function test_anexo_em_espera_so_grava_quando_a_edicao_o_promove(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 200]))->assertOk();
        $this->assertCount(2, $this->linhas($id));

        Sanctum::actingAs($dono);
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->createWithContent('n.jpg', 'outro comprovante'), 'ext' => 'jpg'])->assertOk();
        $this->assertCount(2, $this->linhas($id));

        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 200]))->assertOk();
        $this->assertCount(3, $this->linhas($id));
        $h = $this->ultima($id);
        $this->assertSame('anexo', $h->acao);
        $this->assertSame(['anexo'], array_keys($h->campos));
    }

    /* 06/11/2026, achado do revisor: a promoção não comparava, então o reenvio do mesmo arquivo depois de a gestão mexer na
       nota aparecia como troca de anexo por quem não trocou nada. */
    public function test_anexo_em_espera_identico_ao_atual_nao_conta_como_troca(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $bytes = fn () => ['file' => UploadedFile::fake()->createWithContent('n.jpg', 'CONTEUDO-FIXO-123'), 'ext' => 'jpg'];
        $this->post("/api/notas/{$id}/foto", $bytes())->assertOk();
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->patchJson("/api/notas/{$id}/tipo", ['tipo' => 'RDA', 'subtipo' => 'Outros'])->assertOk();
        $antes = $this->linhas($id)->count();

        Sanctum::actingAs($dono);
        $this->post("/api/notas/{$id}/foto", $bytes())->assertOk();
        $this->assertTrue(Storage::disk('fotos')->exists("{$dono->id}/espera/{$id}.jpg"));
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['tipo' => 'RDA', 'subtipo' => null]))->assertOk();

        $this->assertCount($antes, $this->linhas($id));
        $this->assertFalse(Storage::disk('fotos')->exists("{$dono->id}/espera/{$id}.jpg"), 'a espera continua sendo consumida');
        $this->assertSame('CONTEUDO-FIXO-123', Storage::disk('fotos')->get(Nota::find($id)->foto_path));

        /* e a edição que veio junto continua registrada, só sem o anexo */
        Sanctum::actingAs($this->pessoa('gestor', '2'));
        $this->patchJson("/api/notas/{$id}/tipo", ['tipo' => 'RDM', 'subtipo' => 'Outros'])->assertOk();
        Sanctum::actingAs($dono);
        $this->post("/api/notas/{$id}/foto", $bytes())->assertOk();
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 321]))->assertOk();
        $this->assertSame('edicao', $this->ultima($id)->acao);
        $this->assertSame(['valor'], array_keys($this->ultima($id)->campos));
    }

    /* O servidor regrava o JPEG com rotação no EXIF, e o guardado deixa de ter os bytes do enviado. O PHP local não tem exif,
       então o endireitar de verdade não roda aqui: o substituto faz o mesmo papel, uma regravação determinística. */
    public function test_reenvio_de_arquivo_que_o_servidor_regrava_nao_conta_como_troca(): void
    {
        $this->app->instance(\App\Services\FotoStorage::class, new class extends \App\Services\FotoStorage
        {
            public function endireitar(string $path): bool
            {
                $this->disk()->put($path, 'endireitado:'.$this->disk()->get($path));

                return true;
            }
        });
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $bytes = fn () => ['file' => UploadedFile::fake()->createWithContent('n.jpg', 'JPEG-COM-EXIF'), 'ext' => 'jpg'];
        $this->post("/api/notas/{$id}/foto", $bytes())->assertOk();
        $linhas = $this->linhas($id)->count();
        $this->assertSame('anexo', $this->ultima($id)->acao);

        /* pelo caminho direto */
        $this->post("/api/notas/{$id}/foto", $bytes())->assertOk();
        $this->assertCount($linhas, $this->linhas($id));

        /* pela espera */
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->patchJson("/api/notas/{$id}/tipo", ['tipo' => 'RDA', 'subtipo' => 'Outros'])->assertOk();
        Sanctum::actingAs($dono);
        $this->post("/api/notas/{$id}/foto", $bytes())->assertOk();
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['tipo' => 'RDA', 'subtipo' => null]))->assertOk();
        $this->assertCount($linhas + 1, $this->linhas($id));
        $this->assertSame('tipo', $this->ultima($id)->acao);
    }

    public function test_troca_de_dono_grava_e_mostra_nome_no_lugar_do_id(): void
    {
        $dono = $this->pessoa('colaborador', 'A');
        $outro = $this->pessoa('colaborador', 'B');
        $id = $this->lancar($dono);
        Sanctum::actingAs($this->pessoa('gestor'));

        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['user_id' => $outro->id]))->assertOk();

        $h = $this->ultima($id);
        $this->assertSame('dono', $h->acao);
        $this->assertSame(['antes' => $dono->id, 'depois' => $outro->id], $h->campos['user_id']);

        $resposta = $this->getJson("/api/notas/{$id}/historico")->assertOk();
        $resposta->assertJsonPath('registros.0.campos.0.rotulo', 'Colaborador')
            ->assertJsonPath('registros.0.campos.0.antes', 'ColaboradorA')
            ->assertJsonPath('registros.0.campos.0.depois', 'ColaboradorB');
        $this->assertStringNotContainsString($dono->id, $resposta->getContent());
    }

    public function test_exclusao_definitiva_mantem_o_historico_e_so_quem_ve_tudo_le(): void
    {
        $dono = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        $id = $this->lancar($dono, ['deleted' => false]);
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['deleted' => true]))->assertOk();

        Sanctum::actingAs($gestor);
        $this->deleteJson("/api/notas/{$id}")->assertOk();

        $this->assertNull(Nota::find($id));
        $this->assertCount(3, $this->linhas($id));
        $h = $this->ultima($id);
        $this->assertSame('exclusao', $h->acao);
        $this->assertSame($gestor->id, $h->alterado_por);
        $this->assertEqualsWithDelta(100, $h->campos['valor']['antes'], 0.001);

        $this->getJson("/api/notas/{$id}/historico")->assertOk()
            ->assertJsonCount(3, 'registros')
            ->assertJsonPath('registros.0.acao', 'exclusao')
            ->assertJsonPath('registros.0.por_nome', 'Gestor');

        Sanctum::actingAs($this->pessoa('contabilidade'));
        $this->getJson("/api/notas/{$id}/historico")->assertOk();

        Sanctum::actingAs($dono);
        $this->getJson("/api/notas/{$id}/historico")->assertNotFound();
    }

    public function test_reparar_fotos_grava_sem_o_caminho(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        DB::table('notas')->where('id', $id)->update(['foto_path' => null]);

        $this->postJson('/api/notas/reparar-fotos')->assertOk()->assertJsonPath('recuperadas', 1);

        $h = $this->ultima($id);
        $this->assertSame('anexo', $h->acao);
        $this->assertSame('anexo religado', $h->campos['anexo']['depois']);
    }

    public function test_409_nao_grava(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 200]))->assertOk();
        $this->assertCount(2, $this->linhas($id));

        Sanctum::actingAs($dono);
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 300, 'base_updated_at' => '2020-01-01T00:00:00Z']))->assertStatus(409);

        $this->assertCount(2, $this->linhas($id));
    }

    public function test_409_da_exclusao_definitiva_nao_grava(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        Sanctum::actingAs($this->pessoa('gestor'));

        $this->deleteJson("/api/notas/{$id}")->assertStatus(409);

        $this->assertCount(1, $this->linhas($id));
    }

    public function test_410_nao_grava(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $this->deleteJson("/api/notas/{$id}")->assertOk();
        $this->assertCount(2, $this->linhas($id));

        $this->putJson("/api/notas/{$id}", $this->corpo($dono))->assertStatus(410);
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->create('n.jpg', 10, 'image/jpeg'), 'ext' => 'jpg'])->assertStatus(410);

        $this->assertCount(2, $this->linhas($id));
    }

    public function test_403_nao_grava(): void
    {
        $dono = $this->pessoa('colaborador', 'A');
        $id = $this->lancar($dono);
        Sanctum::actingAs($this->pessoa('colaborador', 'B'));

        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 999]))->assertForbidden();
        $this->patchJson("/api/notas/{$id}/tipo", ['tipo' => 'RDA'])->assertForbidden();
        $this->patchJson("/api/notas/{$id}/lixeira", ['deleted' => true])->assertForbidden();
        $this->deleteJson("/api/notas/{$id}")->assertForbidden();

        /* contador não manda para a lixeira */
        Sanctum::actingAs($this->pessoa('contabilidade'));
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['deleted' => true]))->assertForbidden();

        $this->assertCount(1, $this->linhas($id));
    }

    public function test_falha_ao_gravar_o_historico_nao_derruba_o_put(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $this->assertTrue(NotaHistorico::tabelaExiste());   // memorizado: o insert vai tentar e quebrar
        Schema::drop('notas_historico');

        Log::spy();
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 777]))->assertOk()->assertJsonPath('valor', 777);

        $this->assertEqualsWithDelta(777, Nota::find($id)->valor, 0.001);
        Log::shouldHaveReceived('warning')->withArgs(fn ($msg) => $msg === 'histórico da nota não gravado')->once();
    }

    public function test_tabela_ausente_nao_quebra_nenhum_caminho(): void
    {
        $dono = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        Schema::drop('notas_historico');
        NotaHistorico::esquecerTabela();

        $id = $this->lancar($dono);
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 150]))->assertOk();
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->createWithContent('n.jpg', 'x'), 'ext' => 'jpg'])->assertOk();
        $this->getJson("/api/notas/{$id}/historico")->assertOk()
            ->assertJsonPath('disponivel', false)->assertJsonCount(0, 'registros');

        Sanctum::actingAs($gestor);
        $this->patchJson("/api/notas/{$id}/tipo", ['tipo' => 'RDA'])->assertOk();
        $this->patchJson("/api/notas/{$id}/lixeira", ['deleted' => true])->assertOk();
        $this->deleteJson("/api/notas/{$id}")->assertOk();

        $this->postJson("/api/colaboradores/{$dono->id}/excluir", ['confirmacao' => 'EXCLUIR'])->assertOk();
    }

    public function test_permissoes_dos_quatro_papeis(): void
    {
        $dono = $this->pessoa('colaborador', 'A');
        $id = $this->lancar($dono);

        $this->getJson("/api/notas/{$id}/historico")->assertOk()->assertJsonCount(1, 'registros');
        foreach (['gestor', 'admin', 'contabilidade'] as $papel) {
            Sanctum::actingAs($this->pessoa($papel));
            $this->getJson("/api/notas/{$id}/historico")->assertOk()->assertJsonCount(1, 'registros');
        }

        /* outro colaborador recebe a MESMA resposta de uma nota que não existe: não dá para testar se um id existe */
        Sanctum::actingAs($this->pessoa('colaborador', 'B'));
        $deNota = $this->getJson("/api/notas/{$id}/historico")->assertNotFound();
        $inexistente = $this->getJson('/api/notas/'.Str::uuid().'/historico')->assertNotFound();
        $this->assertSame($inexistente->json('message'), $deNota->json('message'));
    }

    public function test_nota_sem_dono_nao_abre_para_colaborador(): void
    {
        $gestor = $this->pessoa('gestor');
        $id = (string) Str::uuid();
        Sanctum::actingAs($gestor);
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->create('n.jpg', 10, 'image/jpeg'), 'ext' => 'jpg', 'sem_colaborador' => 1])->assertOk();
        $this->putJson("/api/notas/{$id}", $this->corpo($gestor, ['user_id' => null, 'pagamento' => 'empresa']))->assertOk();
        $this->getJson("/api/notas/{$id}/historico")->assertOk()->assertJsonCount(1, 'registros');

        Sanctum::actingAs($this->pessoa('colaborador'));
        $this->getJson("/api/notas/{$id}/historico")->assertNotFound();
    }

    public function test_id_que_nunca_existiu_e_404_mesmo_para_o_gestor(): void
    {
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->getJson('/api/notas/'.Str::uuid().'/historico')->assertNotFound();
    }

    public function test_nota_apagada_antes_do_historico_abre_vazia_para_o_gestor(): void
    {
        $id = (string) Str::uuid();
        DB::table('notas_apagadas')->insert(['id' => $id, 'user_id' => null, 'apagada_por' => null, 'apagada_em' => now()]);
        Sanctum::actingAs($this->pessoa('gestor'));

        $this->getJson("/api/notas/{$id}/historico")->assertOk()->assertJsonCount(0, 'registros');
    }

    public function test_contador_corrigindo_aparece_como_contador_e_o_papel_fica_o_da_epoca(): void
    {
        $dono = $this->pessoa('colaborador');
        $contador = $this->pessoa('contabilidade');
        $id = $this->lancar($dono);
        Sanctum::actingAs($contador);

        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 80]))->assertOk();
        $this->getJson("/api/notas/{$id}/historico")->assertOk()
            ->assertJsonPath('registros.0.por_nome', 'Contabilidade')
            ->assertJsonPath('registros.0.por_papel', 'contabilidade')
            ->assertJsonPath('registros.0.papel_rotulo', 'Contador');

        /* mudar de papel depois não reescreve o passado */
        $contador->forceFill(['role' => 'colaborador'])->save();
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->getJson("/api/notas/{$id}/historico")->assertOk()->assertJsonPath('registros.0.papel_rotulo', 'Contador');
    }

    public function test_leitura_traz_rotulos_legiveis(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono, ['valor' => 1234.5, 'documento' => 'nfce', 'pagamento' => 'cv']);

        $this->putJson("/api/notas/{$id}", $this->corpo($dono, [
            'valor' => 10, 'data' => '2026-10-21', 'documento' => 'nfse', 'pagamento' => 'carteira', 'cnpj' => '11222333000181',
        ]))->assertOk();

        $campos = collect($this->getJson("/api/notas/{$id}/historico")->assertOk()->json('registros.0.campos'))->keyBy('campo');
        $this->assertSame(['R$ 1.234,50', 'R$ 10,00'], [$campos['valor']['antes'], $campos['valor']['depois']]);
        $this->assertSame(['20/10/2026', '21/10/2026'], [$campos['data']['antes'], $campos['data']['depois']]);
        $this->assertSame(['NFC-e', 'NFS-e'], [$campos['documento']['antes'], $campos['documento']['depois']]);
        $this->assertSame(['Cartão', 'Carteira'], [$campos['pagamento']['antes'], $campos['pagamento']['depois']]);
        $this->assertSame('11.222.333/0001-81', $campos['cnpj']['depois']);
        $this->assertSame('Valor', $campos['valor']['rotulo']);
    }

    public function test_leitura_vem_do_mais_novo_com_limite_de_200(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $agora = now();
        $linhas = [];
        for ($i = 1; $i <= 205; $i++) {
            $linhas[] = ['nota_id' => $id, 'acao' => 'edicao', 'campos' => '{"valor":{"antes":'.$i.',"depois":'.($i + 1).'}}',
                'alterado_por' => $dono->id, 'alterado_papel' => 'colaborador', 'alterado_em' => $agora->copy()->addMinutes($i)];
        }
        DB::table('notas_historico')->insert($linhas);

        $r = $this->getJson("/api/notas/{$id}/historico")->assertOk()->assertJsonCount(200, 'registros');
        $r->assertJsonPath('registros.0.campos.0.depois', 'R$ 206,00');
    }

    public function test_excluir_colaborador_limpa_o_historico_das_notas_dele_e_preserva_o_dos_outros(): void
    {
        $alvo = $this->pessoa('colaborador', 'A');
        $outro = $this->pessoa('colaborador', 'B');
        $gestor = $this->pessoa('gestor');
        $viva = $this->lancar($alvo);
        $naLixeira = $this->lancar($alvo, ['deleted' => false]);
        $this->putJson("/api/notas/{$naLixeira}", $this->corpo($alvo, ['deleted' => true]))->assertOk();
        $apagadaAntes = $this->lancar($alvo);
        $this->deleteJson("/api/notas/{$apagadaAntes}")->assertOk();
        $doOutro = $this->lancar($outro);
        $this->assertCount(2, $this->linhas($apagadaAntes));

        /* passada de dono: a nota é do outro agora, e o histórico cita o excluído */
        $passada = $this->lancar($alvo);
        Sanctum::actingAs($gestor);
        $this->putJson("/api/notas/{$passada}", $this->corpo($alvo, ['user_id' => $outro->id]))->assertOk();

        $this->postJson("/api/colaboradores/{$alvo->id}/excluir", ['confirmacao' => 'EXCLUIR'])->assertOk()
            ->assertJsonPath('historico_notas', 5);

        $this->assertCount(0, $this->linhas($viva));
        $this->assertCount(0, $this->linhas($naLixeira));
        $this->assertCount(0, $this->linhas($apagadaAntes));
        $this->assertCount(1, $this->linhas($doOutro));
        $this->assertCount(2, $this->linhas($passada));

        /* o que ficou não carrega mais o nome de quem saiu */
        $r = $this->getJson("/api/notas/{$passada}/historico")->assertOk();
        $r->assertJsonPath('registros.0.campos.0.antes', 'Colaborador excluído')
            ->assertJsonPath('registros.1.por_nome', 'Colaborador excluído');
        $this->assertStringNotContainsString('ColaboradorA', $r->getContent());
    }

    /* 06/11/2026, achado do revisor: lápide antiga em nome do excluído, de nota que renasceu antes de 03/11/2026 e hoje é de
       outra pessoa (ou do Faturamento sem colaborador). A auditoria dessa nota viva não é dado dele. */
    public function test_excluir_colaborador_nao_apaga_o_historico_de_nota_viva_de_outro_dono(): void
    {
        $alvo = $this->pessoa('colaborador', 'A');
        $outro = $this->pessoa('colaborador', 'B');
        $gestor = $this->pessoa('gestor');
        $deOutro = $this->lancar($outro);
        $semDono = $this->lancar($outro);
        DB::table('notas')->where('id', $semDono)->update(['user_id' => null]);
        $apagadaDele = $this->lancar($alvo);
        $this->deleteJson("/api/notas/{$apagadaDele}")->assertOk();
        foreach ([$deOutro, $semDono] as $id) {
            DB::table('notas_apagadas')->insert(['id' => $id, 'user_id' => $alvo->id, 'apagada_por' => $alvo->id, 'apagada_em' => now()]);
        }

        Sanctum::actingAs($gestor);
        $this->postJson("/api/colaboradores/{$alvo->id}/excluir", ['confirmacao' => 'EXCLUIR'])->assertOk()
            ->assertJsonPath('historico_notas', 2);

        $this->assertNotNull(Nota::find($deOutro));
        $this->assertCount(1, $this->linhas($deOutro));
        $this->assertCount(1, $this->linhas($semDono));
        $this->assertCount(0, $this->linhas($apagadaDele));
    }
}
