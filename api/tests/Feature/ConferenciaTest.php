<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Conferencia;
use App\Models\Nota;
use App\Models\Repasse;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 18/11/2026 — "✓ conferido" (Lote 3 da revisão do gestor): gestor/admin marca nota e repasse conferidos na ficha.
 * A marca fica no servidor, numa tabela própria — conferir não mexe na nota nem no repasse.
 */
class ConferenciaTest extends TestCase
{
    use RefreshDatabase;

    private function pessoa(string $nome, string $role = 'colaborador'): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome, 'email' => strtolower(str_replace(' ', '', $nome)).'@teste.local',
            'password' => 'segredo123', 'role' => $role, 'ativo' => true,
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(Colaborador $dono): Nota
    {
        $n = new Nota(['id' => (string) Str::uuid(), 'user_id' => $dono->id, 'tipo' => 'RDM', 'valor' => 180,
            'data' => '2026-11-05', 'mes' => 11, 'ano' => 2026, 'razao_social' => 'POSTO SHELL', 'deleted' => false]);
        $n->save();

        return $n->fresh();
    }

    private function repasse(Colaborador $dono): Repasse
    {
        $r = new Repasse(['id' => (string) Str::uuid(), 'user_id' => $dono->id, 'tipo' => 'RDM', 'kind' => 'received', 'valor' => 150,
            'data' => '2026-11-17', 'mes' => 11, 'ano' => 2026, 'deleted' => false]);
        $r->save();

        return $r->fresh();
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        Conferencia::esquecerTabela();
        parent::tearDown();
    }

    public function test_gestor_marca_e_desmarca_nota_sem_mexer_na_nota(): void
    {
        $gestor = $this->pessoa('Paulo Gestor', 'gestor');
        $dono = $this->pessoa('Romario');
        $nota = $this->nota($dono);
        $antes = $nota->updated_at->toIso8601String();

        Sanctum::actingAs($gestor);
        Carbon::setTestNow('2026-11-18 12:00:00');
        $this->putJson('/api/conferencias', ['tipo' => 'nota', 'registro_id' => $nota->id, 'conferido' => true])
            ->assertOk()->assertJson(['conferido' => true, 'conferido_por' => $gestor->id, 'conferido_por_nome' => 'Paulo Gestor', 'dono_id' => $dono->id]);
        $this->assertSame($antes, $nota->fresh()->updated_at->toIso8601String(), 'conferir não pode mudar o updated_at da nota');

        $this->getJson('/api/conferencias?dono_id='.$dono->id)->assertOk()
            ->assertJsonCount(1)->assertJsonPath('0.registro_id', $nota->id)->assertJsonPath('0.conferido', true);

        Carbon::setTestNow('2026-11-18 13:00:00');
        $this->putJson('/api/conferencias', ['tipo' => 'nota', 'registro_id' => $nota->id, 'conferido' => false])
            ->assertOk()->assertJson(['conferido' => false, 'desmarcado_por' => $gestor->id]);
        $this->assertSame(1, Conferencia::count(), 'desmarcar guarda o rastro na mesma linha');

        $this->putJson('/api/conferencias', ['tipo' => 'nota', 'registro_id' => $nota->id, 'conferido' => true])
            ->assertOk()->assertJson(['conferido' => true, 'desmarcado_em' => null]);
    }

    public function test_repasse_e_historico_por_since(): void
    {
        $admin = $this->pessoa('Cleiton Admin', 'admin');
        $dono = $this->pessoa('Jose');
        $rep = $this->repasse($dono);
        Sanctum::actingAs($admin);
        Carbon::setTestNow('2026-11-18 12:00:00');
        $this->putJson('/api/conferencias', ['tipo' => 'repasse', 'registro_id' => $rep->id, 'conferido' => true])->assertOk();

        $this->getJson('/api/conferencias?since=2026-11-18T11:00:00Z')->assertOk()->assertJsonCount(1)->assertJsonPath('0.tipo', 'repasse');
        $this->getJson('/api/conferencias?since=2026-11-18T12:30:00Z')->assertOk()->assertJsonCount(0);
    }

    public function test_colaborador_e_contador_nao_conferem(): void
    {
        $dono = $this->pessoa('Romario');
        $nota = $this->nota($dono);
        foreach ([$dono, $this->pessoa('Contador', 'contabilidade')] as $quem) {
            Sanctum::actingAs($quem);
            $this->putJson('/api/conferencias', ['tipo' => 'nota', 'registro_id' => $nota->id, 'conferido' => true])->assertForbidden();
            $this->getJson('/api/conferencias?dono_id='.$dono->id)->assertForbidden();
        }
        $this->assertSame(0, Conferencia::count());
    }

    public function test_registro_inexistente_e_tipo_invalido(): void
    {
        Sanctum::actingAs($this->pessoa('Paulo Gestor', 'gestor'));
        $this->putJson('/api/conferencias', ['tipo' => 'nota', 'registro_id' => 'nao-existe', 'conferido' => true])->assertNotFound();
        $this->putJson('/api/conferencias', ['tipo' => 'outro', 'registro_id' => 'x', 'conferido' => true])->assertStatus(422);
        $this->getJson('/api/conferencias')->assertStatus(422);
    }

    public function test_desmarcar_o_que_nunca_foi_marcado_nao_cria_linha(): void
    {
        Sanctum::actingAs($this->pessoa('Paulo Gestor', 'gestor'));
        $nota = $this->nota($this->pessoa('Romario'));
        $this->putJson('/api/conferencias', ['tipo' => 'nota', 'registro_id' => $nota->id, 'conferido' => false])
            ->assertOk()->assertJson(['conferido' => false]);
        $this->assertSame(0, Conferencia::count());
    }
}
