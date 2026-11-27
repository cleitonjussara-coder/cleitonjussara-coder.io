<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Conferencia;
use App\Models\Nota;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 27/11/2026 — conferir em lote (verificação de 26/11, fase 3 item 2): o gestor marca de uma vez as notas sem pendência.
 * O servidor confere de novo a regra: nota apagada, sem anexo ou sem valor não é marcada.
 */
class ConferenciaLoteTest extends TestCase
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

    private function nota(Colaborador $dono, array $extra = []): Nota
    {
        $n = new Nota(array_merge(['id' => (string) Str::uuid(), 'user_id' => $dono->id, 'tipo' => 'RDM', 'valor' => 180,
            'data' => '2026-11-05', 'mes' => 11, 'ano' => 2026, 'razao_social' => 'POSTO SHELL', 'deleted' => false], $extra));
        $n->forceFill(['foto_path' => $extra['foto_path'] ?? 'u/x.jpg'])->save();

        return $n->fresh();
    }

    protected function tearDown(): void
    {
        Conferencia::esquecerTabela();
        parent::tearDown();
    }

    public function test_gestor_confere_em_lote_e_o_servidor_pula_as_com_pendencia(): void
    {
        $ana = $this->pessoa('Ana');
        $gestor = $this->pessoa('Gil Gestor', 'gestor');
        $boa1 = $this->nota($ana);
        $boa2 = $this->nota($ana, ['valor' => 12.345]);
        $semFoto = $this->nota($ana, ['foto_path' => '']);
        $semValor = $this->nota($ana, ['valor' => 0]);
        $apagada = $this->nota($ana, ['deleted' => true]);
        $antes = $boa1->updated_at;

        Sanctum::actingAs($gestor);
        $r = $this->putJson('/api/conferencias/lote', ['registro_ids' => [$boa1->id, $boa2->id, $semFoto->id, $semValor->id, $apagada->id, 'nao-existe']]);
        $r->assertOk();
        $this->assertCount(2, $r->json('conferidas'));
        $this->assertEqualsCanonicalizing([$semFoto->id, $semValor->id, $apagada->id, 'nao-existe'], $r->json('pulados'));
        $this->assertTrue(Conferencia::where('registro_id', $boa1->id)->first()->conferida());
        $this->assertSame($ana->id, Conferencia::where('registro_id', $boa2->id)->value('dono_id'));
        $this->assertNull(Conferencia::where('registro_id', $semFoto->id)->first());
        $this->assertEquals($antes, $boa1->fresh()->updated_at, 'conferir não mexe na nota');
    }

    public function test_nota_ja_conferida_mantem_quem_conferiu(): void
    {
        $ana = $this->pessoa('Ana');
        $g1 = $this->pessoa('Gil Gestor', 'gestor');
        $g2 = $this->pessoa('Ada Admin', 'admin');
        $n = $this->nota($ana);
        Sanctum::actingAs($g1);
        $this->putJson('/api/conferencias', ['tipo' => 'nota', 'registro_id' => $n->id, 'conferido' => true])->assertOk();
        Sanctum::actingAs($g2);
        $this->putJson('/api/conferencias/lote', ['registro_ids' => [$n->id]])->assertOk();
        $this->assertSame($g1->id, Conferencia::where('registro_id', $n->id)->value('conferido_por'));
    }

    public function test_colaborador_e_contador_nao_conferem_em_lote(): void
    {
        $ana = $this->pessoa('Ana');
        $n = $this->nota($ana);
        foreach ([$ana, $this->pessoa('Cris Contador', 'contabilidade')] as $quem) {
            Sanctum::actingAs($quem);
            $this->putJson('/api/conferencias/lote', ['registro_ids' => [$n->id]])->assertForbidden();
        }
        $this->assertSame(0, Conferencia::count());
    }

    public function test_lote_vazio_ou_grande_demais_recusa(): void
    {
        Sanctum::actingAs($this->pessoa('Gil Gestor', 'gestor'));
        $this->putJson('/api/conferencias/lote', ['registro_ids' => []])->assertStatus(422);
        $this->putJson('/api/conferencias/lote', ['registro_ids' => array_map(fn ($i) => "id$i", range(1, 501))])->assertStatus(422);
    }
    public function test_faltam_conta_por_pessoa_e_mes_so_deste_mes_e_do_anterior(): void
    {
        \Illuminate\Support\Carbon::setTestNow('2026-11-27 15:00:00');
        $ana = $this->pessoa('Ana');
        $ze = $this->pessoa('Ze');
        $gestor = $this->pessoa('Gil Gestor', 'gestor');
        $a1 = $this->nota($ana, ['valor' => 10.5]);
        $this->nota($ana, ['valor' => 20, 'foto_path' => '']);
        $this->nota($ana, ['mes' => 10, 'data' => '2026-10-10', 'valor' => 5]);
        $this->nota($ze, ['mes' => 9, 'data' => '2026-09-10']);   // mês antigo: fica de fora
        $this->nota($ze, ['deleted' => true]);
        Sanctum::actingAs($gestor);
        $this->putJson('/api/conferencias', ['tipo' => 'nota', 'registro_id' => $a1->id, 'conferido' => true])->assertOk();

        $r = $this->getJson('/api/conferencias/faltam')->assertOk()->json();
        \Illuminate\Support\Carbon::setTestNow();
        $this->assertCount(2, $r);
        $nov = collect($r)->firstWhere('mes', 11);
        $this->assertSame(['dono_id' => $ana->id, 'nome' => 'Ana', 'ano' => 2026, 'mes' => 11, 'notas' => 1, 'valor' => 20, 'sem_pendencia' => 0],
            array_intersect_key($nov, array_flip(['dono_id', 'nome', 'ano', 'mes', 'notas', 'valor', 'sem_pendencia'])));
        $this->assertSame(1, collect($r)->firstWhere('mes', 10)['sem_pendencia']);

        Sanctum::actingAs($ana);
        $this->getJson('/api/conferencias/faltam')->assertForbidden();
    }
}
