<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Repasse;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 24/10/2026 — regime C.V.: um pedido aberto por vez, e o próprio colaborador
 * confirma o recebimento (podendo mudar o valor depositado).
 */
class PedidoCvRecebiTest extends TestCase
{
    use RefreshDatabase;

    private function pessoa(string $role, string $regime = 'rdm_rda'): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(),
            'nome' => ucfirst($role), 'email' => $role.$regime.'@teste.local',
            'password' => 'segredo123', 'role' => $role, 'regime' => $regime,
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function pedir(Colaborador $c, float $valor = 500)
    {
        $h = now('America/Sao_Paulo');

        return $this->putJson('/api/repasses/'.Str::uuid(), [
            'user_id' => $c->id, 'tipo' => 'RDM', 'valor' => $valor, 'data' => $h->format('Y-m-d'),
            'mes' => (int) $h->format('n'), 'ano' => (int) $h->format('Y'),
            'kind' => 'requested', 'destino' => 'recarga', 'deleted' => false,
        ]);
    }

    public function test_cv_nao_abre_segundo_pedido_enquanto_ha_um_pendente(): void
    {
        $this->pessoa('gestor');
        $cv = $this->pessoa('colaborador', 'cv');
        Sanctum::actingAs($cv);
        $this->pedir($cv)->assertOk();
        $this->pedir($cv)->assertStatus(422);
    }

    public function test_rdm_rda_tambem_nao_abre_segundo_pedido(): void
    {
        $this->pessoa('gestor');
        $c = $this->pessoa('colaborador');
        Sanctum::actingAs($c);
        $this->pedir($c)->assertOk();
        $this->pedir($c)->assertStatus(422);
    }

    public function test_cv_confirma_recebimento_com_valor_diferente_e_libera_novo_pedido(): void
    {
        $this->pessoa('gestor');
        $cv = $this->pessoa('colaborador', 'cv');
        Sanctum::actingAs($cv);
        $id = $this->pedir($cv, 500)->assertOk()->json('id');

        $this->patchJson("/api/repasses/$id/recebi", ['valor' => 450])->assertOk()->assertJsonPath('ja_estava', false);

        $pedido = Repasse::findOrFail($id);
        $this->assertNotNull($pedido->atendido_em);
        $rec = Repasse::where('pedido_id', $id)->firstOrFail();
        $this->assertEquals(450.0, (float) $rec->valor);
        $this->assertSame('received', $rec->kind);
        $this->assertSame('recarga', $rec->destino);
        $this->assertNotNull($rec->confirmado_em);

        // idempotente: segunda chamada não duplica
        $this->patchJson("/api/repasses/$id/recebi", ['valor' => 450])->assertOk()->assertJsonPath('ja_estava', true);
        $this->assertSame(1, Repasse::where('pedido_id', $id)->count());

        // pedido resolvido: pode pedir outro
        $this->pedir($cv)->assertOk();
    }

    public function test_outro_colaborador_nao_confirma_pedido_alheio(): void
    {
        $this->pessoa('gestor');
        $cv = $this->pessoa('colaborador', 'cv');
        Sanctum::actingAs($cv);
        $id = $this->pedir($cv)->assertOk()->json('id');

        $outro = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => 'Outro', 'email' => 'outro@teste.local',
            'password' => 'segredo123', 'role' => 'colaborador', 'regime' => 'cv',
        ]);
        if (Colaborador::temConfirmacao()) {
            $outro->forceFill(['confirmado_em' => now()]);
        }
        $outro->save();
        Sanctum::actingAs($outro);
        $this->patchJson("/api/repasses/$id/recebi", ['valor' => 500])->assertStatus(403);
    }

    public function test_cancelar_o_pedido_libera_outro(): void
    {
        $this->pessoa('gestor');
        $cv = $this->pessoa('colaborador', 'cv');
        Sanctum::actingAs($cv);
        $id = $this->pedir($cv)->assertOk()->json('id');
        $rep = Repasse::findOrFail($id);
        $this->putJson("/api/repasses/$id", [
            'user_id' => $cv->id, 'tipo' => 'RDM', 'valor' => 500, 'data' => $rep->data->format('Y-m-d'),
            'mes' => (int) $rep->mes, 'ano' => (int) $rep->ano, 'kind' => 'requested', 'destino' => 'recarga', 'deleted' => true,
        ])->assertOk();
        $this->pedir($cv)->assertOk();
    }

    public function test_gestor_lancando_o_pagamento_encerra_o_pedido_aberto(): void
    {
        $gestor = $this->pessoa('gestor');
        $cv = $this->pessoa('colaborador', 'cv');
        Sanctum::actingAs($cv);
        $id = $this->pedir($cv, 500)->assertOk()->json('id');

        Sanctum::actingAs($gestor);
        $h = now('America/Sao_Paulo');
        $this->putJson('/api/repasses/'.Str::uuid(), [
            'user_id' => $cv->id, 'tipo' => 'RDM', 'valor' => 500, 'data' => $h->format('Y-m-d'),
            'mes' => (int) $h->format('n'), 'ano' => (int) $h->format('Y'),
            'kind' => 'received', 'destino' => 'recarga', 'deleted' => false,
        ])->assertOk();
        $this->assertNotNull(Repasse::findOrFail($id)->atendido_em);

        Sanctum::actingAs($cv);
        $this->patchJson("/api/repasses/$id/recebi", ['valor' => 500])->assertOk()->assertJsonPath('ja_estava', true);
        $this->pedir($cv)->assertOk();
    }

    public function test_recebido_identico_em_seguida_e_recusado(): void
    {
        $this->pessoa('gestor');
        $c = $this->pessoa('colaborador');
        Sanctum::actingAs($c);
        $h = now('America/Sao_Paulo');
        $corpo = fn () => [
            'user_id' => $c->id, 'tipo' => 'RDM', 'valor' => 300, 'data' => $h->format('Y-m-d'),
            'mes' => (int) $h->format('n'), 'ano' => (int) $h->format('Y'), 'kind' => 'received', 'deleted' => false,
        ];
        $this->putJson('/api/repasses/'.Str::uuid(), $corpo())->assertOk();
        $this->putJson('/api/repasses/'.Str::uuid(), $corpo())->assertStatus(422);
        $this->assertSame(1, Repasse::where('user_id', $c->id)->count());
    }
}
