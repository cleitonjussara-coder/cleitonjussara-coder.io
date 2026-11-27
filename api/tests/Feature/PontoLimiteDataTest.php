<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Ponto;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 27/11/2026 — verificação de 26/11, item 2.3: o limite "hoje e ontem" do colaborador olhava só a data enviada
 * (dava para reescrever um dia antigo pelo id) e o "bater" aceitava qualquer hora e trocava marcação já feita.
 */
class PontoLimiteDataTest extends TestCase
{
    use RefreshDatabase;

    private function pessoa(string $role = 'colaborador'): Colaborador
    {
        $c = new Colaborador(['id' => (string) Str::uuid(), 'nome' => 'Ana '.$role, 'email' => $role.'@teste.local', 'password' => 'segredo123', 'role' => $role]);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    protected function setUp(): void
    {
        parent::setUp();
        Carbon::setTestNow(Carbon::parse('2026-11-27 15:00:00', 'America/Sao_Paulo'));
    }

    public function test_editar_dia_antigo_mandando_a_data_de_hoje_e_recusado(): void
    {
        $ana = $this->pessoa();
        $antigo = Ponto::create(['id' => (string) Str::uuid(), 'user_id' => $ana->id, 'data' => '2026-11-10', 'tipo_dia' => 'trabalho',
            'entrada' => Carbon::parse('2026-11-10 08:00', 'America/Sao_Paulo')]);
        Sanctum::actingAs($ana);

        $this->putJson('/api/ponto/'.$antigo->id, ['data' => '2026-11-27', 'entrada' => '07:00'])->assertStatus(422);
        $this->putJson('/api/ponto/'.$antigo->id, ['data' => '2026-11-10', 'entrada' => '07:00'])->assertStatus(403);
        $this->assertSame('08:00', $antigo->fresh()->entrada->format('H:i'));
        $this->assertSame('2026-11-10', $antigo->fresh()->data->format('Y-m-d'));
    }

    public function test_editar_hoje_continua_funcionando(): void
    {
        $ana = $this->pessoa();
        Sanctum::actingAs($ana);
        $id = (string) Str::uuid();
        $this->putJson('/api/ponto/'.$id, ['data' => '2026-11-27', 'entrada' => '08:00'])->assertOk();
        $this->putJson('/api/ponto/'.$id, ['data' => '2026-11-27', 'entrada' => '08:05', 'saida_intervalo' => '12:00'])->assertOk();
        $this->assertSame('08:05', Ponto::find($id)->entrada->format('H:i'));
    }

    public function test_bater_com_hora_antiga_ou_no_futuro_e_recusado(): void
    {
        Sanctum::actingAs($this->pessoa());
        $this->postJson('/api/ponto/bater', ['marcacao' => 'entrada', 'hora' => '2026-11-20T11:00:00Z'])->assertStatus(422);
        $this->postJson('/api/ponto/bater', ['marcacao' => 'entrada', 'hora' => '2026-11-27T20:00:00Z'])->assertStatus(422);   // 17:00 em Brasília, 2 h à frente
        $this->assertSame(0, Ponto::count());
        $this->postJson('/api/ponto/bater', ['marcacao' => 'entrada', 'hora' => '2026-11-26T11:00:00Z'])->assertOk();          // ontem (fila offline)
    }

    public function test_bater_nao_troca_marcacao_feita_e_reenvio_igual_so_confirma(): void
    {
        Sanctum::actingAs($this->pessoa());
        $this->postJson('/api/ponto/bater', ['marcacao' => 'entrada', 'hora' => '2026-11-27T11:00:00Z'])->assertOk();         // 08:00
        $this->postJson('/api/ponto/bater', ['marcacao' => 'entrada', 'hora' => '2026-11-27T11:00:30Z'])->assertOk();         // reenvio da fila
        $this->postJson('/api/ponto/bater', ['marcacao' => 'entrada', 'hora' => '2026-11-27T12:30:00Z'])
            ->assertStatus(422)->assertJsonPath('message', 'Essa marcação já foi feita às 08:00. Para corrigir, edite o dia.');
        $this->assertSame('08:00', Ponto::first()->entrada->format('H:i'));
    }

    public function test_gestao_continua_livre(): void
    {
        $ana = $this->pessoa();
        $antigo = Ponto::create(['id' => (string) Str::uuid(), 'user_id' => $ana->id, 'data' => '2026-11-10', 'tipo_dia' => 'trabalho']);
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->putJson('/api/ponto/'.$antigo->id, ['data' => '2026-11-10', 'user_id' => $ana->id, 'entrada' => '07:30'])->assertOk();
        $this->postJson('/api/ponto/bater', ['marcacao' => 'entrada', 'hora' => '2026-11-20T11:00:00Z'])->assertOk();
    }
}
