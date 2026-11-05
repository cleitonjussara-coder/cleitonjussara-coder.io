<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Repasse;
use App\Services\PushService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Mockery;
use Tests\TestCase;

/**
 * 05/11/2026 — o gestor registrava o pagamento, o colaborador registrava o recebimento, e o
 * mesmo dinheiro entrava duas vezes. Decisão do Cleiton: só o gestor registra repasse e recarga;
 * o colaborador pede, e o que ele registrou antes continua sendo dele para corrigir.
 */
class RepasseMesmoDinheiroTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->app->instance(PushService::class, Mockery::spy(PushService::class));
    }

    private function pessoa(string $role): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(),
            'nome' => ucfirst($role), 'email' => $role.Str::random(6).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function corpo(Colaborador $dono, array $troca = []): array
    {
        $h = now('America/Sao_Paulo');

        return array_replace([
            'user_id' => $dono->id, 'tipo' => 'RDM', 'valor' => 500, 'data' => $h->format('Y-m-d'),
            'mes' => (int) $h->format('n'), 'ano' => (int) $h->format('Y'),
            'kind' => 'received', 'destino' => null, 'deleted' => false,
        ], $troca);
    }

    private function enviar(Colaborador $quem, Colaborador $dono, array $troca = [], ?string $id = null)
    {
        Sanctum::actingAs($quem);

        return $this->putJson('/api/repasses/'.($id ?? Str::uuid()), $this->corpo($dono, $troca));
    }

    private function recebidos(Colaborador $dono): int
    {
        return Repasse::where('user_id', $dono->id)->where('kind', 'received')->count();
    }

    public function test_colaborador_nao_registra_repasse_recebido(): void
    {
        $colab = $this->pessoa('colaborador');

        $this->enviar($colab, $colab)->assertForbidden();

        $this->assertSame(0, $this->recebidos($colab));
    }

    public function test_colaborador_nao_registra_recarga_recebida(): void
    {
        $colab = $this->pessoa('colaborador');

        $this->enviar($colab, $colab, ['destino' => 'recarga'])->assertForbidden();

        $this->assertSame(0, $this->recebidos($colab));
    }

    public function test_registro_sem_kind_conta_como_recebido_e_tambem_e_recusado(): void
    {
        $colab = $this->pessoa('colaborador');

        $this->enviar($colab, $colab, ['kind' => null])->assertForbidden();
    }

    public function test_colaborador_nao_transforma_o_proprio_pedido_em_recebido(): void
    {
        $colab = $this->pessoa('colaborador');
        $id = (string) Str::uuid();
        $this->enviar($colab, $colab, ['kind' => 'requested'], $id)->assertOk();

        $this->enviar($colab, $colab, [], $id)->assertForbidden();

        $this->assertSame('requested', Repasse::find($id)->kind);
    }

    public function test_recebi_em_pedido_aberto_e_recusado_e_o_pedido_segue_aberto(): void
    {
        $colab = $this->pessoa('colaborador');
        $id = (string) Str::uuid();
        $this->enviar($colab, $colab, ['kind' => 'requested'], $id)->assertOk();

        $this->patchJson("/api/repasses/$id/recebi")->assertForbidden();

        $this->assertNull(Repasse::find($id)->atendido_em);
        $this->assertSame(0, $this->recebidos($colab));
    }

    public function test_recebi_de_app_antigo_em_pedido_ja_pago_responde_sem_criar_outro(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $id = (string) Str::uuid();
        $this->enviar($colab, $colab, ['kind' => 'requested'], $id)->assertOk();

        Sanctum::actingAs($gestor);
        $this->patchJson("/api/repasses/$id/atendido")->assertOk();

        Sanctum::actingAs($colab);
        $this->patchJson("/api/repasses/$id/recebi")->assertOk()->assertJsonPath('ja_estava', true);

        $this->assertSame(1, $this->recebidos($colab));
    }

    public function test_colaborador_segue_pedindo_repasse_e_recarga(): void
    {
        $colab = $this->pessoa('colaborador');

        $this->enviar($colab, $colab, ['kind' => 'requested', 'destino' => 'recarga'])->assertOk();
    }

    public function test_gestor_e_admin_seguem_lancando_para_o_colaborador(): void
    {
        $colab = $this->pessoa('colaborador');

        $this->enviar($this->pessoa('gestor'), $colab)->assertOk();
        $this->enviar($this->pessoa('admin'), $colab, ['destino' => 'recarga'])->assertOk();

        $this->assertSame(2, $this->recebidos($colab));
    }

    public function test_o_que_o_colaborador_ja_registrou_ele_ainda_corrige_e_apaga(): void
    {
        $colab = $this->pessoa('colaborador');
        $id = (string) Str::uuid();
        $antigo = new Repasse(['id' => $id] + $this->corpo($colab));
        $antigo->created_by = $colab->id;
        $antigo->updated_by = $colab->id;
        $antigo->save();

        $this->enviar($colab, $colab, ['valor' => 450], $id)->assertOk();
        $this->enviar($colab, $colab, ['valor' => 450, 'deleted' => true], $id)->assertOk();

        $this->assertTrue((bool) Repasse::find($id)->deleted);
    }
}
