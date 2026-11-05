<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Repasse;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 01/10/2026 — o gestor relatou repasse/recarga "sumindo". O dono do registro
 * podia gravar deleted=true num repasse que o gestor pagou. Agora só gestor
 * ou admin cancela/altera dinheiro registrado.
 */
class RepasseProtegidoTest extends TestCase
{
    use RefreshDatabase;

    private function pessoa(string $role): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) \Illuminate\Support\Str::uuid(),
            'nome' => ucfirst($role), 'email' => $role.'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function payload(Repasse $r, array $troca = []): array
    {
        return array_replace([
            'user_id' => $r->user_id, 'tipo' => $r->tipo, 'valor' => (float) $r->valor,
            'data' => $r->data->format('Y-m-d'), 'mes' => (int) $r->mes, 'ano' => (int) $r->ano,
            'descricao' => $r->descricao, 'kind' => $r->kind, 'destino' => $r->destino, 'deleted' => false,
        ], $troca);
    }

    private function lancadoPeloGestor(Colaborador $gestor, Colaborador $colab, string $destino = 'recarga'): Repasse
    {
        $id = (string) \Illuminate\Support\Str::uuid();
        Sanctum::actingAs($gestor);
        $this->putJson("/api/repasses/$id", [
            'user_id' => $colab->id, 'tipo' => 'RDM', 'valor' => 500, 'data' => now('America/Sao_Paulo')->format('Y-m-d'),
            'mes' => (int) now('America/Sao_Paulo')->format('n'), 'ano' => (int) now('America/Sao_Paulo')->format('Y'),
            'kind' => 'received', 'destino' => $destino, 'deleted' => false,
        ])->assertOk();

        return Repasse::findOrFail($id);
    }

    public function test_colaborador_nao_apaga_recarga_lancada_pelo_gestor(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $rep = $this->lancadoPeloGestor($gestor, $colab);

        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['deleted' => true]))->assertStatus(403);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['valor' => 1]))->assertStatus(403);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['destino' => 'carteira']))->assertStatus(403);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['kind' => 'requested']))->assertStatus(403);

        $rep->refresh();
        $this->assertFalse((bool) $rep->deleted);
        $this->assertEquals(500, (float) $rep->valor);
    }

    public function test_colaborador_reenviar_o_mesmo_registro_continua_funcionando(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $rep = $this->lancadoPeloGestor($gestor, $colab, 'carteira');

        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['descricao' => 'conferido']))->assertOk();
    }

    public function test_gestor_ainda_cancela(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $rep = $this->lancadoPeloGestor($gestor, $colab);

        Sanctum::actingAs($gestor);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['deleted' => true]))->assertOk();
        $this->assertTrue((bool) $rep->fresh()->deleted);
    }

    public function test_colaborador_cancela_o_proprio_pedido_nao_atendido(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $id = (string) \Illuminate\Support\Str::uuid();
        $hoje = now('America/Sao_Paulo');
        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/$id", [
            'user_id' => $colab->id, 'tipo' => 'RDM', 'valor' => 200, 'data' => $hoje->format('Y-m-d'),
            'mes' => (int) $hoje->format('n'), 'ano' => (int) $hoje->format('Y'), 'kind' => 'requested', 'deleted' => false,
        ])->assertOk();
        $rep = Repasse::findOrFail($id);
        $this->putJson("/api/repasses/$id", $this->payload($rep, ['deleted' => true]))->assertOk();
        $this->assertTrue((bool) $rep->fresh()->deleted);
    }

    public function test_pedido_ja_pago_nao_some_pelo_colaborador(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $id = (string) \Illuminate\Support\Str::uuid();
        $hoje = now('America/Sao_Paulo');
        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/$id", [
            'user_id' => $colab->id, 'tipo' => 'RDM', 'valor' => 200, 'data' => $hoje->format('Y-m-d'),
            'mes' => (int) $hoje->format('n'), 'ano' => (int) $hoje->format('Y'), 'kind' => 'requested', 'deleted' => false,
        ])->assertOk();
        Sanctum::actingAs($gestor);
        $this->patchJson("/api/repasses/$id/atendido")->assertOk();

        Sanctum::actingAs($colab);
        $rep = Repasse::findOrFail($id);
        $this->putJson("/api/repasses/$id", $this->payload($rep, ['deleted' => true]))->assertStatus(403);
        $recebido = Repasse::where('pedido_id', $id)->firstOrFail();
        $this->putJson("/api/repasses/{$recebido->id}", $this->payload($recebido, ['deleted' => true]))->assertStatus(403);
    }

    public function test_data_muito_no_futuro_e_recusada(): void
    {
        $colab = $this->pessoa('colaborador');
        Sanctum::actingAs($colab);
        $this->putJson('/api/repasses/'.\Illuminate\Support\Str::uuid(), [
            'user_id' => $colab->id, 'tipo' => 'RDM', 'valor' => 10, 'data' => '2045-01-01',
            'mes' => 1, 'ano' => 2045, 'kind' => 'requested', 'deleted' => false,
        ])->assertStatus(422);
    }
}
