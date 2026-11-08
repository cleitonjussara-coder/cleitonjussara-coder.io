<?php

namespace Tests\Feature;

use App\Models\AtividadeCampo;
use App\Models\Colaborador;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 08/11/2026 — atividade em campo: início/fim por fazenda e campo, com localização, liberada pelo gestor por pessoa.
 */
class AtividadeCampoTest extends TestCase
{
    use RefreshDatabase;

    private function pessoa(string $nome, string $role = 'colaborador', bool $campo = false): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome, 'email' => strtolower($nome).'@teste.local',
            'password' => 'segredo123', 'role' => $role, 'atividade_campo' => $campo,
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c->fresh();
    }

    private function iniciar(array $extra = []): \Illuminate\Testing\TestResponse
    {
        return $this->postJson('/api/atividades-campo/iniciar', $extra + [
            'id' => (string) Str::uuid(), 'fazenda' => 'Faz. São José', 'campo' => 'brcb147a-b',
            'lat' => -16.7654321, 'lng' => -47.6123456, 'precisao' => 12.4,
        ]);
    }

    public function test_sem_a_funcao_ligada_nao_registra(): void
    {
        Sanctum::actingAs($this->pessoa('Ana'));
        $this->iniciar()->assertForbidden();
        $this->assertSame(0, AtividadeCampo::count());
    }

    public function test_inicia_com_localizacao_e_finaliza(): void
    {
        $romario = $this->pessoa('Romario', 'colaborador', true);
        Sanctum::actingAs($romario);
        $id = (string) Str::uuid();

        $this->iniciar(['id' => $id])->assertCreated()
            ->assertJsonPath('campo', 'BRCB147A-B')->assertJsonPath('em_campo', true)
            ->assertJsonPath('lat_inicio', -16.7654321)->assertJsonPath('precisao_inicio', 12);

        $this->postJson("/api/atividades-campo/{$id}/finalizar", ['lat' => -16.77, 'lng' => -47.61, 'precisao' => 8])
            ->assertOk()->assertJsonPath('em_campo', false)->assertJsonPath('fim_automatico', false)
            ->assertJsonPath('lat_fim', -16.77);
    }

    public function test_reenvio_do_mesmo_toque_nao_duplica(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id])->assertCreated();
        $this->iniciar(['id' => $id])->assertOk();
        $this->assertSame(1, AtividadeCampo::count());
    }

    public function test_iniciar_outro_campo_fecha_o_anterior_sozinho(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $primeiro = (string) Str::uuid();
        $this->iniciar(['id' => $primeiro, 'hora' => Carbon::now()->subHours(3)->toIso8601String()])->assertCreated();
        $this->iniciar(['campo' => 'BRCB148'])->assertCreated();

        $a = AtividadeCampo::find($primeiro);
        $this->assertNotNull($a->fim);
        $this->assertTrue($a->fim_automatico);
        $this->assertSame(1, AtividadeCampo::whereNull('fim')->count());
    }

    public function test_marcacao_offline_usa_a_hora_do_aparelho_e_recusa_futuro(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $hora = Carbon::now('America/Sao_Paulo')->subMinutes(40)->startOfMinute();
        $this->iniciar(['hora' => $hora->toIso8601String()])->assertCreated()
            ->assertJsonPath('inicio', $hora->toIso8601String());

        $this->iniciar(['hora' => Carbon::now()->addHour()->toIso8601String()])->assertStatus(422);
    }

    public function test_fim_antes_do_inicio_e_recusado(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id])->assertCreated();
        $this->postJson("/api/atividades-campo/{$id}/finalizar", ['hora' => Carbon::now()->subDay()->toIso8601String()])->assertStatus(422);
    }

    public function test_so_o_dono_finaliza_e_ve_so_as_proprias(): void
    {
        $dono = $this->pessoa('Romario', 'colaborador', true);
        $outro = $this->pessoa('Joao', 'colaborador', true);
        Sanctum::actingAs($dono);
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id])->assertCreated();

        Sanctum::actingAs($outro);
        $this->postJson("/api/atividades-campo/{$id}/finalizar")->assertForbidden();
        $this->getJson('/api/atividades-campo')->assertOk()->assertJsonCount(0);
        $this->getJson('/api/atividades-campo/equipe')->assertForbidden();

        Sanctum::actingAs($this->pessoa('Gestor', 'gestor'));
        $this->getJson('/api/atividades-campo')->assertOk()->assertJsonCount(1);
    }

    public function test_gestor_ve_ultimo_registro_de_cada_pessoa_ligada(): void
    {
        $romario = $this->pessoa('Romario', 'colaborador', true);
        $this->pessoa('Joao', 'colaborador', true);
        $this->pessoa('Sem Funcao');
        Sanctum::actingAs($romario);
        $this->iniciar(['campo' => 'BRCB147A-B', 'hora' => Carbon::now()->subHours(2)->toIso8601String()]);
        $this->iniciar(['campo' => 'BRCB148']);

        Sanctum::actingAs($this->pessoa('Gestor', 'gestor'));
        $r = $this->getJson('/api/atividades-campo/equipe')->assertOk()->assertJsonCount(2)->json();
        $porNome = collect($r)->keyBy('nome');
        $this->assertSame('BRCB148', $porNome['Romario']['ultima']['campo']);
        $this->assertTrue($porNome['Romario']['ultima']['em_campo']);
        $this->assertNull($porNome['Joao']['ultima']);
    }

    public function test_so_gestor_liga_a_funcao_e_fica_no_historico(): void
    {
        $gestor = $this->pessoa('Gestor', 'gestor');
        $ana = $this->pessoa('Ana');

        Sanctum::actingAs($ana);
        $this->patchJson("/api/colaboradores/{$ana->id}", ['atividade_campo' => true])->assertOk();
        $this->assertFalse($ana->fresh()->registraAtividadeCampo());

        Sanctum::actingAs($gestor);
        $this->patchJson("/api/colaboradores/{$ana->id}", ['atividade_campo' => true])->assertOk()->assertJsonPath('atividade_campo', true);
        $this->assertTrue($ana->fresh()->registraAtividadeCampo());
        $this->assertSame(1, DB::table('colaboradores_historico')->where('colaborador_id', $ana->id)->where('campo', 'atividade_campo')->where('para', 'sim')->count());

        /* o gestor também liga para si mesmo */
        $this->patchJson("/api/colaboradores/{$gestor->id}", ['atividade_campo' => true])->assertOk();
        $this->assertTrue($gestor->fresh()->registraAtividadeCampo());
    }

    public function test_buscador_lista_campos_da_equipe_sem_repetir(): void
    {
        $romario = $this->pessoa('Romario', 'colaborador', true);
        $joao = $this->pessoa('Joao', 'colaborador', true);
        Sanctum::actingAs($joao);
        $this->iniciar(['fazenda' => 'Arco Verde', 'campo' => 'BRAE4305', 'hora' => Carbon::now()->subHours(5)->toIso8601String()]);
        Sanctum::actingAs($romario);
        $this->iniciar(['fazenda' => 'Faz. São José', 'campo' => 'BRCB147A-B', 'hora' => Carbon::now()->subHours(3)->toIso8601String()]);
        $this->iniciar(['fazenda' => 'São José', 'campo' => 'brcb147a-b']);   // mesmo campo escrito de outro jeito

        $r = collect($this->getJson('/api/atividades-campo/campos')->assertOk()->assertJsonCount(2)->json())->keyBy('campo');
        $this->assertSame(2, $r['BRCB147A-B']['usos']);
        $this->assertSame(2, $r['BRCB147A-B']['meus']);
        $this->assertSame(0, $r['BRAE4305']['meus']);      // do colega: aparece, sem dizer quem foi
        $this->assertArrayNotHasKey('lat_inicio', $r['BRAE4305']);

        Sanctum::actingAs($this->pessoa('Sem Funcao'));
        $this->getJson('/api/atividades-campo/campos')->assertForbidden();
    }

    public function test_contador_nao_registra(): void
    {
        Sanctum::actingAs($this->pessoa('Contador', 'contabilidade', true));
        $this->iniciar()->assertForbidden();
    }
}
