<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\MesFechado;
use App\Models\MesFechadoHistorico;
use App\Models\Nota;
use App\Models\NotaHistorico;
use App\Models\Repasse;
use App\Services\PushService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 06/11/2026 — decisão do dono: mês fechado vale para a empresa inteira. Nota nova que chega do aparelho entra marcada e avisa
 * a gestão; alterar ou apagar o que existe é 423 para todos até reabrir; reenvio idêntico não prende a fila.
 */
class FechamentoMesTest extends TestCase
{
    use RefreshDatabase;

    private array $envios = [];

    protected function setUp(): void
    {
        parent::setUp();
        Carbon::setTestNow(Carbon::parse('2026-11-06 15:00:00', 'UTC'));
        Storage::fake('fotos');
        MesFechado::esquecerTabela();
        Nota::esquecerForaFechamento();
        $this->mock(PushService::class, function ($m) {
            $m->shouldReceive('enviar')->andReturnUsing(function (...$a) {
                $this->envios[] = $a;

                return 1;
            });
            $m->shouldReceive('avisarGestores')->andReturn(0);
        });
    }

    protected function tearDown(): void
    {
        MesFechado::esquecerTabela();
        Nota::esquecerForaFechamento();
        Carbon::setTestNow();
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
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->create('n.jpg', 10, 'image/jpeg'), 'ext' => 'jpg', 'user_id' => $quem->id], ['Accept' => 'application/json'])->assertOk();
        $this->putJson("/api/notas/{$id}", $this->corpo($quem, $campos))->assertOk();

        return $id;
    }

    private function fechar(int $ano = 2026, int $mes = 10): void
    {
        Sanctum::actingAs($this->pessoa('gestor', Str::random(5)));
        $this->postJson('/api/fechamento/fechar', ['ano' => $ano, 'mes' => $mes])->assertOk();
    }

    private function reabrir(int $ano = 2026, int $mes = 10): void
    {
        Sanctum::actingAs($this->pessoa('gestor', Str::random(5)));
        $this->postJson('/api/fechamento/reabrir', ['ano' => $ano, 'mes' => $mes, 'motivo' => 'corrigir valor'])->assertOk();
    }

    private function repasse(Colaborador $dono, array $campos = []): array
    {
        return array_replace([
            'user_id' => $dono->id, 'tipo' => 'RDM', 'valor' => 500, 'data' => '2026-10-10', 'mes' => 10, 'ano' => 2026, 'kind' => 'received', 'descricao' => 'pix',
        ], $campos);
    }

    private function bloqueado(\Illuminate\Testing\TestResponse $r, string $id, string $chave = 'nota'): void
    {
        $r->assertStatus(423)->assertJsonPath('mes_fechado', true)->assertJsonPath("{$chave}.id", $id);
        $this->assertNotEmpty($r->json('message'));
    }

    private function historicoDe(string $id): int
    {
        return NotaHistorico::where('nota_id', $id)->count();
    }

    /* ── rotas do fechamento ────────────────────────────────────────── */

    public function test_so_gestor_e_admin_fecham_e_reabrem(): void
    {
        Sanctum::actingAs($this->pessoa('colaborador'));
        $this->postJson('/api/fechamento/fechar', ['ano' => 2026, 'mes' => 10])->assertForbidden();
        $this->postJson('/api/fechamento/reabrir', ['ano' => 2026, 'mes' => 10, 'motivo' => 'teste'])->assertForbidden();

        Sanctum::actingAs($this->pessoa('contabilidade'));
        $this->postJson('/api/fechamento/fechar', ['ano' => 2026, 'mes' => 10])->assertForbidden()->assertJsonPath('somente_leitura', true);
        $this->postJson('/api/fechamento/reabrir', ['ano' => 2026, 'mes' => 10, 'motivo' => 'teste'])->assertForbidden()->assertJsonPath('somente_leitura', true);
        $this->assertSame(0, MesFechado::count());

        foreach (['gestor', 'admin'] as $papel) {
            $u = $this->pessoa($papel);
            Sanctum::actingAs($u);
            $this->postJson('/api/fechamento/fechar', ['ano' => 2026, 'mes' => 10])->assertOk()->assertJsonPath('ja_estava', false);
            $h = MesFechadoHistorico::orderByDesc('id')->first();
            $this->assertSame(['fechar', $u->id, $papel], [$h->acao, $h->feito_por, $h->feito_papel]);
            $this->postJson('/api/fechamento/reabrir', ['ano' => 2026, 'mes' => 10, 'motivo' => 'revisão'])->assertOk()->assertJsonPath('ja_estava', false);
            $h = MesFechadoHistorico::orderByDesc('id')->first();
            $this->assertSame(['reabrir', 'revisão', $u->id], [$h->acao, $h->motivo, $h->feito_por]);
        }
    }

    public function test_mes_corrente_e_futuro_nao_fecham(): void
    {
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->postJson('/api/fechamento/fechar', ['ano' => 2026, 'mes' => 11])->assertStatus(422);
        $this->postJson('/api/fechamento/fechar', ['ano' => 2026, 'mes' => 12])->assertStatus(422);
        $this->postJson('/api/fechamento/fechar', ['ano' => 2027, 'mes' => 1])->assertStatus(422);
        $this->assertSame(0, MesFechado::count());
        $this->postJson('/api/fechamento/fechar', ['ano' => 2026, 'mes' => 10])->assertOk();
    }

    public function test_mes_corrente_e_o_de_brasilia_na_virada(): void
    {
        /* 02:00 UTC do dia 1º ainda é dia 31 em Brasília: outubro segue corrente */
        Carbon::setTestNow(Carbon::parse('2026-11-01 02:00:00', 'UTC'));
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->postJson('/api/fechamento/fechar', ['ano' => 2026, 'mes' => 10])->assertStatus(422);
    }

    public function test_fechar_de_novo_e_idempotente(): void
    {
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->postJson('/api/fechamento/fechar', ['ano' => 2026, 'mes' => 10])->assertOk();
        $this->postJson('/api/fechamento/fechar', ['ano' => 2026, 'mes' => 10])->assertOk()->assertJsonPath('ja_estava', true);
        $this->assertSame(1, MesFechado::count());
        $this->assertSame(1, MesFechadoHistorico::count());
    }

    public function test_reabrir_sem_motivo_e_recusado(): void
    {
        $this->fechar();
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->postJson('/api/fechamento/reabrir', ['ano' => 2026, 'mes' => 10])->assertStatus(422);
        $this->postJson('/api/fechamento/reabrir', ['ano' => 2026, 'mes' => 10, 'motivo' => '   '])->assertStatus(422);
        $this->assertSame(1, MesFechado::count());
        $this->assertSame(1, MesFechadoHistorico::count());
    }

    public function test_reabrir_mes_aberto_nao_grava_historico(): void
    {
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->postJson('/api/fechamento/reabrir', ['ano' => 2026, 'mes' => 10, 'motivo' => 'toque duplo'])->assertOk()->assertJsonPath('ja_estava', true);
        $this->assertSame(0, MesFechadoHistorico::count());
    }

    public function test_colaborador_le_so_quais_meses_fecharam_e_contador_ve_o_estado(): void
    {
        $this->fechar();
        Sanctum::actingAs($this->pessoa('colaborador'));
        $r = $this->getJson('/api/fechamento')->assertOk()->assertJsonPath('fechados.0.mes', 10);
        $this->assertArrayNotHasKey('historico', $r->json());
        $this->assertArrayNotHasKey('fora', $r->json());

        Sanctum::actingAs($this->pessoa('contabilidade'));
        $r = $this->getJson('/api/fechamento')->assertOk()->assertJsonPath('pode_alterar', false);
        $outubro = collect($r->json('meses'))->firstWhere('mes', 10);
        $this->assertTrue($outubro['fechado']);
        $this->assertSame('outubro/2026', $outubro['rotulo']);
        $this->assertFalse(collect($r->json('meses'))->firstWhere('mes', 11)['pode_fechar']);
        $this->assertTrue(collect($r->json('meses'))->firstWhere('mes', 9)['pode_fechar']);
        $this->assertSame('fechar', $r->json('historico.0.acao'));
    }

    /* ── cada rota de escrita, para cada papel ──────────────────────── */

    public function test_put_de_nota_existente_e_bloqueado_para_todos(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $this->fechar();
        $antes = $this->historicoDe($id);
        $atualizada = Nota::find($id)->updated_at;
        Carbon::setTestNow(now()->addHour());

        foreach ([$dono, $this->pessoa('gestor'), $this->pessoa('admin'), $this->pessoa('contabilidade')] as $u) {
            Sanctum::actingAs($u);
            $this->bloqueado($this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 999])), $id);
        }
        $this->assertSame(100.0, (float) Nota::find($id)->valor);
        $this->assertEquals($atualizada, Nota::find($id)->updated_at);
        $this->assertSame($antes, $this->historicoDe($id), 'operação recusada não grava histórico');
    }

    public function test_patch_tipo_bloqueado_e_colaborador_segue_com_403(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $this->fechar();

        foreach (['gestor', 'admin', 'contabilidade'] as $papel) {
            Sanctum::actingAs($this->pessoa($papel));
            $this->bloqueado($this->patchJson("/api/notas/{$id}/tipo", ['tipo' => 'RDA']), $id);
            $this->patchJson("/api/notas/{$id}/tipo", ['tipo' => 'RDM', 'subtipo' => 'Outros'])->assertOk()->assertJsonPath('mudou', false);
        }
        Sanctum::actingAs($dono);
        $this->patchJson("/api/notas/{$id}/tipo", ['tipo' => 'RDA'])->assertForbidden();
        $this->assertSame('RDM', Nota::find($id)->tipo);
    }

    public function test_patch_lixeira_bloqueado(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $this->fechar();

        foreach (['gestor', 'admin'] as $papel) {
            Sanctum::actingAs($this->pessoa($papel));
            $this->bloqueado($this->patchJson("/api/notas/{$id}/lixeira", ['deleted' => true]), $id);
            $this->patchJson("/api/notas/{$id}/lixeira", ['deleted' => false])->assertOk();   // nada a mudar: não é bloqueio
        }
        Sanctum::actingAs($dono);
        $this->patchJson("/api/notas/{$id}/lixeira", ['deleted' => true])->assertForbidden();
        Sanctum::actingAs($this->pessoa('contabilidade'));
        $this->patchJson("/api/notas/{$id}/lixeira", ['deleted' => true])->assertForbidden();
        $this->assertFalse((bool) Nota::find($id)->deleted);
    }

    public function test_nota_na_lixeira_nao_volta_nem_some_em_mes_fechado(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        Sanctum::actingAs($this->pessoa('gestor', 'antes'));
        $this->patchJson("/api/notas/{$id}/lixeira", ['deleted' => true])->assertOk();
        $this->fechar();

        foreach (['gestor', 'admin'] as $papel) {
            Sanctum::actingAs($this->pessoa($papel));
            $this->bloqueado($this->patchJson("/api/notas/{$id}/lixeira", ['deleted' => false]), $id);
            $this->bloqueado($this->deleteJson("/api/notas/{$id}"), $id);
        }
        Sanctum::actingAs($dono);
        $this->bloqueado($this->putJson("/api/notas/{$id}", $this->corpo($dono, ['deleted' => false])), $id);
        $this->bloqueado($this->deleteJson("/api/notas/{$id}"), $id);
        $this->assertTrue((bool) Nota::find($id)->deleted);
    }

    public function test_delete_bloqueado_e_vem_antes_do_409(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $this->fechar();

        Sanctum::actingAs($this->pessoa('contabilidade'));
        $this->deleteJson("/api/notas/{$id}")->assertForbidden();
        Sanctum::actingAs($this->pessoa('colaborador', 'outro'));
        $this->deleteJson("/api/notas/{$id}")->assertForbidden();   // permissão primeiro

        /* nota viva e gestor que não é o dono: seria 409, mas o mês é o que continua valendo */
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->bloqueado($this->deleteJson("/api/notas/{$id}"), $id);
        $this->assertNotNull(Nota::find($id));
        $this->assertSame(0, DB::table('notas_apagadas')->count());
    }

    public function test_foto_de_nota_existente_bloqueada_e_mesmo_arquivo_passa(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $path = Nota::find($id)->foto_path;
        Storage::disk('fotos')->put($path, 'conteúdo original');
        $this->fechar();

        foreach ([$dono, $this->pessoa('gestor'), $this->pessoa('admin'), $this->pessoa('contabilidade')] as $u) {
            Sanctum::actingAs($u);
            $this->bloqueado($this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->createWithContent('n.jpg', 'outro arquivo'), 'ext' => 'jpg'], ['Accept' => 'application/json']), $id);
        }
        $this->assertSame('conteúdo original', Storage::disk('fotos')->get($path));

        Sanctum::actingAs($dono);
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->createWithContent('n.jpg', 'conteúdo original'), 'ext' => 'jpg'], ['Accept' => 'application/json'])
            ->assertOk()->assertJsonPath('foto_path', $path);
    }

    public function test_troca_de_dono_bloqueada(): void
    {
        $dono = $this->pessoa('colaborador');
        $novo = $this->pessoa('colaborador', 'novo');
        $id = $this->lancar($dono);
        $this->fechar();
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->bloqueado($this->putJson("/api/notas/{$id}", $this->corpo($novo)), $id);
        $this->assertSame($dono->id, Nota::find($id)->user_id);
    }

    public function test_mover_data_entre_meses(): void
    {
        $dono = $this->pessoa('colaborador');
        $fechada = $this->lancar($dono);
        $aberta = $this->lancar($dono, ['data' => '2026-09-15', 'mes' => 9, 'ano' => 2026]);
        $this->fechar();
        Sanctum::actingAs($dono);

        /* de mês fechado para aberto */
        $this->bloqueado($this->putJson("/api/notas/{$fechada}", $this->corpo($dono, ['data' => '2026-09-15', 'mes' => 9])), $fechada);
        /* de mês aberto para fechado */
        $r = $this->putJson("/api/notas/{$aberta}", $this->corpo($dono, ['data' => '2026-10-15', 'mes' => 10]));
        $this->bloqueado($r, $aberta);
        $r->assertJsonPath('mes_rotulo', 'outubro/2026');
        $this->assertSame('2026-09-15', Nota::find($aberta)->data->format('Y-m-d'));
        /* mes/ano mentindo no corpo não escapam: a data manda */
        $this->bloqueado($this->putJson("/api/notas/{$aberta}", $this->corpo($dono, ['data' => '2026-10-15', 'mes' => 9])), $aberta);
    }

    public function test_reenvio_identico_responde_200_sem_gravar(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $this->fechar();
        $antes = Nota::find($id);
        $linhas = $this->historicoDe($id);
        Carbon::setTestNow(now()->addHour());

        Sanctum::actingAs($dono);
        /* como o aparelho manda: valor em texto, CNPJ com máscara, campos a mais que o servidor ignora */
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => '100.00', 'cnpj' => '12.345.678/0001-95', 'metodo_captura' => 'foto', 'base_updated_at' => '2026-01-01T00:00:00Z']))
            ->assertOk()->assertJsonPath('id', $id);
        $this->assertEquals($antes->updated_at, Nota::find($id)->updated_at);
        $this->assertSame($linhas, $this->historicoDe($id));

        /* qualquer campo diferente já é alteração */
        $this->bloqueado($this->putJson("/api/notas/{$id}", $this->corpo($dono, ['observacao' => 'outra'])), $id);
        $this->bloqueado($this->putJson("/api/notas/{$id}", $this->corpo($dono, ['qr_url' => 'https://x.br/q'])), $id);
    }

    /* ── ordem das checagens ────────────────────────────────────────── */

    public function test_permissao_vem_antes_e_410_segue_valendo(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $this->fechar();
        Sanctum::actingAs($this->pessoa('colaborador', 'outro'));
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 1]))->assertForbidden();

        $apagada = (string) Str::uuid();
        DB::table('notas_apagadas')->insert(['id' => $apagada, 'user_id' => $dono->id, 'apagada_por' => $dono->id, 'apagada_em' => now()]);
        Sanctum::actingAs($dono);
        $this->putJson("/api/notas/{$apagada}", $this->corpo($dono))->assertStatus(410)->assertJsonPath('apagada', true);
    }

    public function test_423_vem_antes_do_409(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $base = Nota::find($id)->updated_at->toISOString();
        Carbon::setTestNow(now()->addMinute());
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 120]))->assertOk();
        $this->fechar();

        Sanctum::actingAs($dono);
        $r = $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 130, 'base_updated_at' => $base]));
        $this->bloqueado($r, $id);
        $r->assertJsonPath('nota.valor', 120);
    }

    public function test_colaborador_em_nota_de_faturamento_recebe_423_e_nao_403(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['pagamento' => 'empresa']))->assertOk();
        $this->fechar();
        Sanctum::actingAs($dono);
        $this->bloqueado($this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 1])), $id);
    }

    /* ── nota nova ──────────────────────────────────────────────────── */

    public function test_nota_nova_entra_marcada_e_avisa_uma_vez(): void
    {
        $gestor = $this->pessoa('gestor', 'fixo');
        $this->fechar();
        $dono = $this->pessoa('colaborador');

        $ids = [$this->lancar($dono), $this->lancar($dono, ['valor' => 50]), $this->lancar($dono, ['valor' => 60])];
        foreach ($ids as $id) {
            $n = Nota::find($id);
            $this->assertNotNull($n->fora_fechamento_em);
            $this->assertNull($n->fora_conferida_em);
            $this->assertSame('fora_fechamento', NotaHistorico::where('nota_id', $id)->orderByDesc('id')->value('acao'));
        }

        $this->assertCount(1, $this->envios, 'a fila que descarrega três notas toca o celular uma vez');
        [$destino, $titulo, $corpo, $url, $tag] = $this->envios[0];
        $this->assertTrue($destino->contains('id', $gestor->id));
        $this->assertFalse($destino->contains('id', $dono->id));
        $this->assertStringContainsString('outubro/2026', $corpo);
        $this->assertSame('fora-fechamento', $tag);
        $this->assertSame('./?abrir=fechamento', $url);

        Sanctum::actingAs($gestor);
        $r = $this->getJson('/api/fechamento')->assertOk();
        $this->assertCount(3, $r->json('fora'));
        $this->assertSame(3, collect($r->json('meses'))->firstWhere('mes', 10)['fora']);
        $this->assertSame('Colaborador', $r->json('fora.0.dono_nome'));

        /* depois da janela, a próxima nota avisa de novo, com o total pendente */
        Carbon::setTestNow(now()->addMinutes(61));
        $this->lancar($dono, ['valor' => 70]);
        $this->assertCount(2, $this->envios);
        $this->assertStringContainsString('4 notas', $this->envios[1][2]);
    }

    public function test_quem_lanca_nao_recebe_o_proprio_aviso(): void
    {
        $this->fechar();
        $eu = $this->pessoa('gestor', 'lancador');
        $this->lancar($eu);
        $this->assertFalse($this->envios[0][0]->contains('id', $eu->id));
    }

    public function test_push_fora_do_ar_nao_derruba_a_nota(): void
    {
        $this->fechar();
        $this->mock(PushService::class, fn ($m) => $m->shouldReceive('enviar')->andThrow(new \RuntimeException('fora do ar')));
        $id = $this->lancar($this->pessoa('colaborador'));
        $this->assertNotNull(Nota::find($id)->fora_fechamento_em);
    }

    public function test_nota_de_mes_aberto_e_a_que_nasce_na_lixeira_nao_sao_marcadas(): void
    {
        $this->fechar();
        $dono = $this->pessoa('colaborador');
        $aberta = $this->lancar($dono, ['data' => '2026-09-15', 'mes' => 9]);
        $this->assertNull(Nota::find($aberta)->fora_fechamento_em);

        $lixo = (string) Str::uuid();
        Sanctum::actingAs($dono);
        $this->putJson("/api/notas/{$lixo}", $this->corpo($dono, ['deleted' => true]))->assertOk();
        $this->assertNull(Nota::find($lixo)->fora_fechamento_em);
        $this->assertCount(0, $this->envios);
    }

    public function test_nota_que_entrou_fora_tambem_fica_travada_e_reenvio_nao_prende(): void
    {
        $this->fechar();
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        Sanctum::actingAs($dono);
        $this->putJson("/api/notas/{$id}", $this->corpo($dono))->assertOk();   // resposta perdida, a fila repete
        $this->bloqueado($this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 5])), $id);
    }

    public function test_conferir(): void
    {
        $this->fechar();
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $n = Nota::find($id);
        Carbon::setTestNow(now()->addHour());

        Sanctum::actingAs($dono);
        $this->postJson("/api/fechamento/fora/{$id}/conferir")->assertForbidden();
        Sanctum::actingAs($this->pessoa('contabilidade'));
        $this->postJson("/api/fechamento/fora/{$id}/conferir")->assertForbidden();

        $g = $this->pessoa('gestor', 'conf');
        Sanctum::actingAs($g);
        $this->postJson("/api/fechamento/fora/{$id}/conferir")->assertOk()->assertJsonCount(0, 'fora');
        $this->postJson("/api/fechamento/fora/{$id}/conferir")->assertOk();
        $depois = Nota::find($id);
        $this->assertSame($g->id, $depois->fora_conferida_por);
        $this->assertEquals($n->updated_at, $depois->updated_at, 'conferir não é editar: o aparelho do dono não pode ver conflito');
        $this->assertSame($n->updated_by, $depois->updated_by);
        $this->assertSame(1, NotaHistorico::where('nota_id', $id)->where('acao', 'conferida')->count());

        $normal = $this->lancar($dono, ['data' => '2026-09-15', 'mes' => 9]);
        Sanctum::actingAs($g);
        $this->postJson("/api/fechamento/fora/{$normal}/conferir")->assertStatus(422);
    }

    /* ── reabrir ────────────────────────────────────────────────────── */

    public function test_reabrir_devolve_a_edicao(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $this->fechar();
        Sanctum::actingAs($dono);
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 200]))->assertStatus(423);
        $this->reabrir();
        Sanctum::actingAs($dono);
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 200]))->assertOk();
        $this->assertSame(200.0, (float) Nota::find($id)->valor);
        Sanctum::actingAs($this->pessoa('contabilidade'));
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 210]))->assertOk();
    }

    public function test_anexo_em_espera_nao_sobrevive_a_recusa(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 120]))->assertOk();
        /* a gestão foi a última a mexer: o anexo do dono fica em espera */
        Sanctum::actingAs($dono);
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->createWithContent('n.jpg', 'novo'), 'ext' => 'jpg'], ['Accept' => 'application/json'])->assertOk();
        $this->fechar();
        Sanctum::actingAs($dono);
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 130]))->assertStatus(423);
        $this->reabrir();
        Sanctum::actingAs($dono);
        $original = Storage::disk('fotos')->get(Nota::find($id)->foto_path);
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 130]))->assertOk();
        $this->assertSame($original, Storage::disk('fotos')->get(Nota::find($id)->foto_path));
    }

    /* 06/11/2026: campos iguais com anexo novo em espera não é reenvio: o aparelho apagaria o arquivo sem saber que ele não entrou */
    public function test_put_identico_com_anexo_novo_em_espera_e_recusado(): void
    {
        $dono = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor', 'esp');
        $id = $this->lancar($dono);
        Sanctum::actingAs($gestor);
        $this->patchJson("/api/notas/{$id}/tipo", ['tipo' => 'RDA'])->assertOk();
        $campos = ['tipo' => 'RDA', 'subtipo' => null];
        Sanctum::actingAs($dono);
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->createWithContent('n.jpg', 'novo'), 'ext' => 'jpg'], ['Accept' => 'application/json'])->assertOk();
        $this->fechar();
        $original = Storage::disk('fotos')->get(Nota::find($id)->foto_path);
        $fotos = app(\App\Services\FotoStorage::class);

        /* gestor mandando os mesmos campos não decide pelo anexo do colaborador */
        Sanctum::actingAs($gestor);
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, $campos))->assertOk();
        $this->assertTrue($fotos->temEspera($dono->id, $id));

        Sanctum::actingAs($dono);
        $this->bloqueado($this->putJson("/api/notas/{$id}", $this->corpo($dono, $campos)), $id);
        $this->assertFalse($fotos->temEspera($dono->id, $id));

        /* depois de reabrir, a próxima edição não traz aquele anexo junto */
        $this->reabrir();
        Sanctum::actingAs($dono);
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, $campos + ['observacao' => 'outra coisa']))->assertOk();
        $this->assertSame($original, Storage::disk('fotos')->get(Nota::find($id)->foto_path));
    }

    public function test_put_identico_com_o_mesmo_anexo_em_espera_segue_sendo_reenvio(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $original = Storage::disk('fotos')->get(Nota::find($id)->foto_path);
        Sanctum::actingAs($this->pessoa('gestor', 'esp'));
        $this->patchJson("/api/notas/{$id}/tipo", ['tipo' => 'RDA'])->assertOk();
        Sanctum::actingAs($dono);
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->createWithContent('n.jpg', $original), 'ext' => 'jpg'], ['Accept' => 'application/json'])->assertOk();
        $this->fechar();
        Sanctum::actingAs($dono);
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['tipo' => 'RDA', 'subtipo' => null]))->assertOk();
        $this->assertFalse(app(\App\Services\FotoStorage::class)->temEspera($dono->id, $id));
    }

    /* 06/11/2026: mover para mês fechado trocando o anexo. O anexo sobe antes do PUT, e gravá-lo apagaria o comprovante original */
    public function test_anexo_da_edicao_que_vai_para_mes_fechado_nao_troca_o_comprovante(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono, ['data' => '2026-11-03', 'mes' => 11]);
        $original = Storage::disk('fotos')->get(Nota::find($id)->foto_path);
        $this->fechar();
        Sanctum::actingAs($dono);
        $r = $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->createWithContent('n.jpg', 'novo'), 'ext' => 'jpg', 'data' => '2026-10-20'], ['Accept' => 'application/json']);
        $this->bloqueado($r, $id);
        $this->assertSame($original, Storage::disk('fotos')->get(Nota::find($id)->foto_path));

        /* a mesma nota, com edição que fica em mês aberto, troca normalmente */
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->createWithContent('n.jpg', 'novo'), 'ext' => 'jpg', 'data' => '2026-11-04'], ['Accept' => 'application/json'])->assertOk();
        $this->assertSame('novo', Storage::disk('fotos')->get(Nota::find($id)->foto_path));
    }

    /* ── aviso agrupado (06/11/2026) ────────────────────────────────── */

    private function avisar(): void
    {
        $this->artisan('fechamento:avisar')->assertSuccessful();
    }

    public function test_gestor_unico_lancando_nao_gasta_a_janela(): void
    {
        $gestor = $this->pessoa('gestor', 'unico');
        Sanctum::actingAs($gestor);
        $this->postJson('/api/fechamento/fechar', ['ano' => 2026, 'mes' => 10])->assertOk();
        $this->lancar($gestor);
        $this->assertCount(0, $this->envios, 'ninguém para avisar: nada sai');

        Carbon::setTestNow(now()->addMinutes(10));
        $this->lancar($this->pessoa('colaborador'));
        $this->assertCount(1, $this->envios, 'a nota do colaborador toca o celular do gestor que lançou a dele');
        $this->assertTrue($this->envios[0][0]->contains('id', $gestor->id));
        $this->assertStringContainsString('2 notas', $this->envios[0][2]);
    }

    public function test_aviso_que_nao_chegou_a_ninguem_nao_gasta_a_janela(): void
    {
        $this->fechar();
        $dono = $this->pessoa('colaborador');
        $this->mock(PushService::class, function ($m) {
            $m->shouldReceive('enviar')->once()->andReturn(0);
            $m->shouldReceive('avisarGestores')->andReturn(0);
        });
        $id = $this->lancar($dono);
        $this->assertNull(Nota::find($id)->fora_avisada_em);

        $this->mock(PushService::class, function ($m) {
            $m->shouldReceive('enviar')->once()->andReturn(1);
            $m->shouldReceive('avisarGestores')->andReturn(0);
        });
        $this->avisar();
        $this->assertNotNull(Nota::find($id)->fora_avisada_em);
    }

    public function test_nota_dentro_da_janela_sai_no_aviso_seguinte_sem_outra_nota(): void
    {
        $this->fechar();
        $dono = $this->pessoa('colaborador');
        $this->lancar($dono);
        $this->assertCount(1, $this->envios);

        Carbon::setTestNow(now()->addMinutes(30));
        $this->lancar($dono, ['valor' => 40]);
        $this->avisar();
        $this->assertCount(1, $this->envios, 'dentro da janela o relógio não toca');

        Carbon::setTestNow(now()->addMinutes(31));
        $this->avisar();
        $this->assertCount(2, $this->envios);
        $this->assertStringContainsString('2 notas', $this->envios[1][2], 'a contagem é o que falta conferir');

        Carbon::setTestNow(now()->addDays(2));
        $this->avisar();
        $this->assertCount(2, $this->envios, 'sem nota nova não repete');
    }

    public function test_rajada_termina_com_a_contagem_certa(): void
    {
        $this->fechar();
        $dono = $this->pessoa('colaborador');
        foreach (range(1, 5) as $i) {
            $this->lancar($dono, ['valor' => $i]);
        }
        $this->assertCount(1, $this->envios);
        Carbon::setTestNow(now()->addMinutes(61));
        $this->avisar();
        $this->assertCount(2, $this->envios);
        $this->assertStringContainsString('5 notas', $this->envios[1][2]);
    }

    public function test_gestor_conferiu_e_chega_outra_nota(): void
    {
        $this->fechar();
        $dono = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor', 'confere');
        $primeira = $this->lancar($dono);
        Sanctum::actingAs($gestor);
        $this->postJson("/api/fechamento/fora/{$primeira}/conferir")->assertOk();

        Carbon::setTestNow(now()->addMinutes(30));
        $this->lancar($dono, ['valor' => 40]);
        Carbon::setTestNow(now()->addMinutes(31));
        $this->avisar();
        $this->assertCount(2, $this->envios);
        $this->assertStringContainsString('1 nota aguarda', $this->envios[1][2]);
    }

    public function test_nota_conferida_antes_do_aviso_nao_toca_o_celular(): void
    {
        $this->fechar();
        $dono = $this->pessoa('colaborador');
        $this->lancar($dono);
        $segunda = $this->lancar($dono, ['valor' => 40]);
        Sanctum::actingAs($this->pessoa('gestor', 'confere'));
        $this->postJson("/api/fechamento/fora/{$segunda}/conferir")->assertOk();
        Carbon::setTestNow(now()->addMinutes(61));
        $this->avisar();
        $this->assertCount(1, $this->envios);
    }

    public function test_avisar_nao_mexe_na_versao_da_nota(): void
    {
        $this->fechar();
        $dono = $this->pessoa('colaborador');
        $this->lancar($dono);
        Carbon::setTestNow(now()->addMinutes(30));
        $id = $this->lancar($dono, ['valor' => 40]);
        $antes = (string) Nota::find($id)->getRawOriginal('updated_at');
        Carbon::setTestNow(now()->addMinutes(31));
        $this->avisar();
        $this->assertNotNull(Nota::find($id)->fora_avisada_em);
        $this->assertSame($antes, (string) Nota::find($id)->getRawOriginal('updated_at'));
    }

    public function test_avisar_sem_a_coluna_nao_quebra(): void
    {
        \Illuminate\Support\Facades\Schema::table('notas', function ($t) {
            $t->dropIndex(['fora_fechamento_em']);
            $t->dropColumn('fora_fechamento_em');
        });
        Nota::esquecerForaFechamento();
        $this->avisar();
        $this->assertCount(0, $this->envios);
    }

    /* ── repasse ────────────────────────────────────────────────────── */

    public function test_repasse_existente_de_mes_fechado(): void
    {
        $dono = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor', 'rep');
        $id = (string) Str::uuid();
        Sanctum::actingAs($gestor);
        $this->putJson("/api/repasses/{$id}", $this->repasse($dono))->assertOk();
        $this->fechar();

        foreach (['gestor', 'admin'] as $papel) {
            Sanctum::actingAs($this->pessoa($papel, 'r'));
            $this->bloqueado($this->putJson("/api/repasses/{$id}", $this->repasse($dono, ['valor' => 600])), $id, 'repasse');
            $this->bloqueado($this->putJson("/api/repasses/{$id}", $this->repasse($dono, ['deleted' => true])), $id, 'repasse');
            $this->bloqueado($this->putJson("/api/repasses/{$id}", $this->repasse($dono, ['data' => '2026-09-10', 'mes' => 9])), $id, 'repasse');
        }
        /* colaborador segue com o 403 de sempre, e Contador nem chega ao controller de repasse */
        Sanctum::actingAs($dono);
        $this->putJson("/api/repasses/{$id}", $this->repasse($dono, ['valor' => 600]))->assertForbidden();
        Sanctum::actingAs($this->pessoa('contabilidade'));
        $this->putJson("/api/repasses/{$id}", $this->repasse($dono, ['valor' => 600]))->assertForbidden();

        $rep = Repasse::find($id);
        $this->assertSame(500.0, (float) $rep->valor);
        $this->assertFalse((bool) $rep->deleted);
    }

    public function test_repasse_mover_data_para_mes_fechado_e_reenvio_identico(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = (string) Str::uuid();
        Sanctum::actingAs($this->pessoa('gestor', 'rep'));
        $this->putJson("/api/repasses/{$id}", $this->repasse($dono, ['data' => '2026-09-10', 'mes' => 9]))->assertOk();
        $this->fechar();

        Sanctum::actingAs($this->pessoa('gestor', 'rep2'));
        $this->bloqueado($this->putJson("/api/repasses/{$id}", $this->repasse($dono, ['data' => '2026-10-10', 'mes' => 10])), $id, 'repasse');

        $outro = (string) Str::uuid();
        $this->reabrir();
        Sanctum::actingAs($this->pessoa('gestor', 'rep3'));
        $this->putJson("/api/repasses/{$outro}", $this->repasse($dono))->assertOk();
        $this->fechar();
        $atualizado = Repasse::find($outro)->updated_at;
        Carbon::setTestNow(now()->addHour());
        Sanctum::actingAs($this->pessoa('gestor', 'rep4'));
        $this->putJson("/api/repasses/{$outro}", $this->repasse($dono, ['valor' => '500.00']))->assertOk();
        $this->assertEquals($atualizado, Repasse::find($outro)->updated_at);
    }

    public function test_repasse_novo_de_mes_fechado_pede_para_reabrir(): void
    {
        $dono = $this->pessoa('colaborador');
        $this->fechar();
        $id = (string) Str::uuid();
        Sanctum::actingAs($this->pessoa('gestor', 'novo'));
        $r = $this->putJson("/api/repasses/{$id}", $this->repasse($dono));
        $r->assertStatus(423)->assertJsonPath('mes_fechado', true)->assertJsonPath('repasse', null);
        $this->assertStringContainsString('reabra', $r->json('message'));
        $this->assertNull(Repasse::find($id));

        $this->reabrir();
        Sanctum::actingAs($this->pessoa('gestor', 'novo2'));
        $this->putJson("/api/repasses/{$id}", $this->repasse($dono))->assertOk();
    }

    public function test_pedido_novo_entra_e_atendido_usa_a_data_de_hoje(): void
    {
        $dono = $this->pessoa('colaborador');
        $this->fechar();
        $id = (string) Str::uuid();
        Sanctum::actingAs($dono);
        $this->putJson("/api/repasses/{$id}", $this->repasse($dono, ['kind' => 'requested']))->assertOk();

        Sanctum::actingAs($this->pessoa('gestor', 'paga'));
        $r = $this->patchJson("/api/repasses/{$id}/atendido")->assertOk();
        $this->assertSame('2026-11-06', substr($r->json('recebido.data'), 0, 10));
    }

    public function test_recebi_segue_em_pedido_de_mes_fechado(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = (string) Str::uuid();
        Sanctum::actingAs($dono);
        $this->putJson("/api/repasses/{$id}", $this->repasse($dono, ['kind' => 'requested']))->assertOk();
        Sanctum::actingAs($this->pessoa('gestor', 'paga'));
        $this->patchJson("/api/repasses/{$id}/atendido")->assertOk();
        $this->fechar();
        Sanctum::actingAs($dono);
        $this->patchJson("/api/repasses/{$id}/recebi")->assertOk()->assertJsonPath('ja_estava', true);
    }

    public function test_confirmar_repasse_antigo_de_mes_fechado_e_bloqueado(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = (string) Str::uuid();
        Sanctum::actingAs($this->pessoa('gestor', 'rep'));
        $this->putJson("/api/repasses/{$id}", $this->repasse($dono))->assertOk();
        Repasse::whereKey($id)->update(['confirmado_em' => null]);
        $this->fechar();
        Sanctum::actingAs($dono);
        $this->bloqueado($this->patchJson("/api/repasses/{$id}/confirmar"), $id, 'repasse');
        $this->assertNull(Repasse::find($id)->confirmado_em);
    }

    /* ── excluir colaborador ────────────────────────────────────────── */

    public function test_excluir_colaborador_com_mes_fechado_e_recusado_dizendo_os_meses(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $setembro = (string) Str::uuid();
        Sanctum::actingAs($this->pessoa('gestor', 'rep'));
        $this->putJson("/api/repasses/{$setembro}", $this->repasse($dono, ['data' => '2026-09-10', 'mes' => 9]))->assertOk();
        $this->fechar(2026, 9);
        $this->fechar(2026, 10);
        $this->fechar(2026, 8);

        $g = $this->pessoa('gestor', 'exclui');
        Sanctum::actingAs($g);
        $r = $this->postJson("/api/colaboradores/{$dono->id}/excluir", ['confirmacao' => 'EXCLUIR']);
        $r->assertStatus(423)->assertJsonPath('mes_fechado', true)->assertJsonCount(2, 'meses');
        $this->assertStringContainsString('setembro/2026', $r->json('message'));
        $this->assertStringContainsString('outubro/2026', $r->json('message'));
        $this->assertStringNotContainsString('agosto', $r->json('message'));
        $this->assertNotNull(Colaborador::find($dono->id));
        $this->assertNotNull(Nota::find($id));

        $this->reabrir(2026, 9);
        $this->reabrir(2026, 10);
        Sanctum::actingAs($g);
        $this->postJson("/api/colaboradores/{$dono->id}/excluir", ['confirmacao' => 'EXCLUIR'])->assertOk();
        $this->assertNull(Colaborador::find($dono->id));
    }

    public function test_lancamento_na_lixeira_nao_impede_excluir_colaborador(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $g = $this->pessoa('gestor', 'exclui');
        Sanctum::actingAs($g);
        $this->patchJson("/api/notas/{$id}/lixeira", ['deleted' => true])->assertOk();
        $this->fechar();
        Sanctum::actingAs($g);
        $this->postJson("/api/colaboradores/{$dono->id}/excluir", ['confirmacao' => 'EXCLUIR'])->assertOk();
    }

    /* ── API publicada antes da migração ────────────────────────────── */

    public function test_sem_as_tabelas_funciona_como_sem_fechamento(): void
    {
        $dono = $this->pessoa('colaborador');
        $id = $this->lancar($dono);
        $rep = (string) Str::uuid();

        Schema::drop('meses_fechados_historico');
        Schema::drop('meses_fechados');
        Schema::table('notas', function ($t) {
            $t->dropIndex(['fora_fechamento_em']);
            $t->dropColumn(['fora_fechamento_em', 'fora_conferida_em', 'fora_conferida_por']);
        });
        MesFechado::esquecerTabela();
        Nota::esquecerForaFechamento();

        Sanctum::actingAs($dono);
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 150]))->assertOk();
        $nova = $this->lancar($dono);
        $this->assertNotNull(Nota::find($nova));
        Sanctum::actingAs($dono);
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->create('n.jpg', 10, 'image/jpeg'), 'ext' => 'jpg'], ['Accept' => 'application/json'])->assertOk();

        $g = $this->pessoa('gestor', 'semtabela');
        Sanctum::actingAs($g);
        $this->patchJson("/api/notas/{$id}/tipo", ['tipo' => 'RDA'])->assertOk();
        $this->patchJson("/api/notas/{$id}/lixeira", ['deleted' => true])->assertOk();
        $this->putJson("/api/repasses/{$rep}", $this->repasse($dono))->assertOk();
        $this->getJson('/api/fechamento')->assertOk()->assertJsonPath('disponivel', false);
        $this->postJson('/api/fechamento/fechar', ['ano' => 2026, 'mes' => 10])->assertStatus(503);
        $this->postJson("/api/colaboradores/{$dono->id}/excluir", ['confirmacao' => 'EXCLUIR'])->assertOk();
    }

    public function test_migracao_volta_atras(): void
    {
        $migracao = require database_path('migrations/2026_11_06_000002_create_fechamento_de_mes.php');
        $migracao->down();
        $this->assertFalse(Schema::hasTable('meses_fechados'));
        $this->assertFalse(Schema::hasColumn('notas', 'fora_fechamento_em'));
        $migracao->up();
        $this->assertTrue(Schema::hasTable('meses_fechados_historico'));
        $this->assertTrue(Schema::hasColumn('notas', 'fora_conferida_por'));
    }
}
