<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Ponto;
use App\Models\Repasse;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 24/10/2026 — a mesma brecha que o NotaIdUuidTest fecha para notas, achada pela revisão independente em repasses e ponto:
 * o servidor aceitava QUALQUER texto como id de registro novo, e o app põe o id dentro de onclick (sino, lista de repasses,
 * ponto). Um colaborador podia plantar um id com aspas e fazer código rodar na tela do gestor. Registro NOVO só entra com
 * UUID (o app gera com crypto.randomUUID()); o que já existe segue como está.
 */
class RepasseEPontoIdUuidTest extends TestCase
{
    use RefreshDatabase;

    private function colaborador(): Colaborador
    {
        $c = new Colaborador(['id' => (string) Str::uuid(), 'nome' => 'Ana', 'email' => 'ana@teste.local', 'password' => 'segredo123', 'role' => 'colaborador']);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function corpoRepasse(Colaborador $dono): array
    {
        $hoje = now('America/Sao_Paulo');

        return ['user_id' => $dono->id, 'tipo' => 'RDM', 'valor' => 100, 'data' => $hoje->format('Y-m-d'),
            'mes' => (int) $hoje->format('n'), 'ano' => (int) $hoje->format('Y'), 'kind' => 'received', 'descricao' => 'teste'];
    }

    public function test_repasse_novo_com_id_que_nao_e_uuid_e_recusado(): void
    {
        $ana = $this->colaborador();
        Sanctum::actingAs($ana);

        foreach (['x"><img src=1 onerror=alert(1)>', "a'b", 'repasse-1', str_repeat('a', 36)] as $ruim) {
            $this->putJson('/api/repasses/'.rawurlencode($ruim), $this->corpoRepasse($ana))->assertStatus(422)->assertJsonPath('message', 'Identificador de repasse inválido.');
        }
        $this->assertSame(0, Repasse::count());
    }

    public function test_repasse_novo_com_uuid_continua_entrando_e_o_antigo_segue_editavel(): void
    {
        $ana = $this->colaborador();
        Sanctum::actingAs($ana);
        $id = (string) Str::uuid();

        $this->putJson("/api/repasses/$id", $this->corpoRepasse($ana))->assertOk();
        $this->assertNotNull(Repasse::find($id));

        $legado = new Repasse(['id' => 'legado-1'] + $this->corpoRepasse($ana));
        $legado->forceFill(['created_by' => $ana->id])->save();   // registro do próprio colaborador: ele ainda pode editar
        $this->putJson('/api/repasses/legado-1', array_replace($this->corpoRepasse($ana), ['valor' => 120]))->assertOk();
        $this->assertEquals(120, Repasse::find('legado-1')->valor);
    }

    public function test_ponto_novo_com_id_que_nao_e_uuid_e_recusado(): void
    {
        $ana = $this->colaborador();
        Sanctum::actingAs($ana);
        $hoje = now('America/Sao_Paulo')->format('Y-m-d');

        foreach (['x"onmouseover="alert(1)', "a'b", 'ponto-1'] as $ruim) {
            $this->putJson('/api/ponto/'.rawurlencode($ruim), ['data' => $hoje, 'entrada' => '08:00'])->assertStatus(422)->assertJsonPath('message', 'Identificador de ponto inválido.');
        }
        $this->assertSame(0, Ponto::count());

        $this->putJson('/api/ponto/'.Str::uuid(), ['data' => $hoje, 'entrada' => '08:00'])->assertOk();
        $this->assertSame(1, Ponto::count());
    }
}
