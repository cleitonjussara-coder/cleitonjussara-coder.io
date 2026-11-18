<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Repasse;
use App\Services\PushService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 18/11/2026 — Lote 3 da revisão do gestor: recusar um pedido deixa rastro (quem, quando, motivo) e avisa o colaborador.
 * O pedido continua fora do saldo e das pendências (deleted=true), como antes.
 */
class PedidoRecusadoTest extends TestCase
{
    use RefreshDatabase;

    private array $envios = [];

    protected function setUp(): void
    {
        parent::setUp();
        $this->mock(PushService::class, function ($m) {
            $m->shouldReceive('enviar')->andReturnUsing(function (...$a) {
                $this->envios[] = $a;

                return 1;
            });
            $m->shouldReceive('avisarGestores')->andReturn(0);
        });
    }

    private function pessoa(string $role): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => ucfirst($role), 'email' => $role.'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function pedido(Colaborador $dono, array $extra = []): Repasse
    {
        $p = new Repasse(['id' => (string) Str::uuid(), 'user_id' => $dono->id, 'tipo' => 'RDM', 'valor' => 300,
            'data' => now()->toDateString(), 'mes' => (int) now()->month, 'ano' => (int) now()->year, 'kind' => 'requested', 'deleted' => false]);
        $p->forceFill($extra)->save();

        return $p;
    }

    public function test_gestor_recusa_com_motivo_e_colaborador_e_avisado(): void
    {
        $colab = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        $p = $this->pedido($colab);
        Sanctum::actingAs($gestor);

        $this->patchJson("/api/repasses/{$p->id}/recusar", ['motivo' => 'Já pago em dinheiro dia 10'])
            ->assertOk()->assertJsonPath('ja_estava', false);

        $p->refresh();
        $this->assertTrue($p->deleted);
        $this->assertNotNull($p->recusado_em);
        $this->assertSame($gestor->id, $p->recusado_por);
        $this->assertSame('Já pago em dinheiro dia 10', $p->motivo_recusa);
        $this->assertSame($gestor->id, $p->updated_by);
        $this->assertCount(1, $this->envios);
        $this->assertSame($colab->id, $this->envios[0][0]);
        $this->assertStringContainsString('Já pago em dinheiro dia 10', $this->envios[0][2]);

        /* de novo: não avisa duas vezes */
        $this->patchJson("/api/repasses/{$p->id}/recusar", ['motivo' => 'outro'])->assertOk()->assertJsonPath('ja_estava', true);
        $this->assertCount(1, $this->envios);
        $this->assertSame('Já pago em dinheiro dia 10', $p->fresh()->motivo_recusa);
    }

    public function test_motivo_e_opcional(): void
    {
        $colab = $this->pessoa('colaborador');
        $p = $this->pedido($colab);
        Sanctum::actingAs($this->pessoa('admin'));
        $this->patchJson("/api/repasses/{$p->id}/recusar")->assertOk();
        $this->assertNull($p->fresh()->motivo_recusa);
        $this->assertTrue($p->fresh()->deleted);
    }

    public function test_colaborador_e_contador_nao_recusam(): void
    {
        $colab = $this->pessoa('colaborador');
        $p = $this->pedido($colab);
        Sanctum::actingAs($colab);
        $this->patchJson("/api/repasses/{$p->id}/recusar")->assertForbidden();
        Sanctum::actingAs($this->pessoa('contabilidade'));
        $this->patchJson("/api/repasses/{$p->id}/recusar")->assertForbidden();
        $this->assertFalse($p->fresh()->deleted);
    }

    public function test_pedido_pago_ou_repasse_comum_nao_se_recusa(): void
    {
        $colab = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        $pago = $this->pedido($colab, ['atendido_em' => now(), 'atendido_por' => $gestor->id]);
        $comum = $this->pedido($colab, ['kind' => 'received']);
        Sanctum::actingAs($gestor);
        $this->patchJson("/api/repasses/{$pago->id}/recusar")->assertStatus(409);
        $this->patchJson("/api/repasses/{$comum->id}/recusar")->assertStatus(422);
        $this->assertFalse($pago->fresh()->deleted);
        $this->assertCount(0, $this->envios);
    }

    public function test_recusa_aparece_na_lista_do_gestor(): void
    {
        $colab = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        $p = $this->pedido($colab);
        Sanctum::actingAs($gestor);
        $this->patchJson("/api/repasses/{$p->id}/recusar", ['motivo' => 'Pedido em dobro'])->assertOk();
        $lista = $this->getJson('/api/repasses?deleted=1')->assertOk()->json();
        $item = collect($lista['data'] ?? $lista)->firstWhere('id', $p->id);
        $this->assertSame('Pedido em dobro', $item['motivo_recusa'] ?? null);
        $this->assertSame($gestor->id, $item['recusado_por'] ?? null);
    }

    /* 18/11/2026: o sino do colaborador mostra a recusa — ela chega na lista normal dele (sem ?deleted), com o nome
       de quem recusou, porque o app do colaborador não tem a lista da equipe. */
    public function test_colaborador_recebe_a_recusa_com_o_nome_de_quem_recusou(): void
    {
        $colab = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        $p = $this->pedido($colab);
        Sanctum::actingAs($gestor);
        $this->patchJson("/api/repasses/{$p->id}/recusar", ['motivo' => 'Valor errado'])->assertOk();
        Sanctum::actingAs($colab);
        $lista = $this->getJson('/api/repasses')->assertOk()->json();
        $item = collect($lista['data'] ?? $lista)->firstWhere('id', $p->id);
        $this->assertNotNull($item, 'a recusa precisa chegar ao aparelho do colaborador');
        $this->assertTrue($item['deleted']);
        $this->assertSame('Valor errado', $item['motivo_recusa']);
        $this->assertSame($gestor->nome, $item['recusado_por_nome']);
        $this->assertNotEmpty($item['recusado_em']);
        $outro = collect($lista['data'] ?? $lista)->firstWhere('recusado_por', null);
        $this->assertTrue($outro === null || array_key_exists('recusado_por_nome', $outro));
    }
}
