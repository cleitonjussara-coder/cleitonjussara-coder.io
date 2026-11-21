<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 21/11/2026 — ✏️ na lista das pastas de Arquivos. A lista das pastas traz só parte dos campos; o app busca a nota
 * inteira por GET /notas?id=… antes de abrir o formulário (salvar com a lista apagaria chave, série etc.).
 */
class NotaListaPorIdTest extends TestCase
{
    use RefreshDatabase;

    private function pessoa(string $role): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(),
            'nome' => ucfirst($role), 'email' => $role.'-'.Str::random(6).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(?Colaborador $c, array $campos = []): Nota
    {
        $n = new Nota(array_replace([
            'id' => (string) Str::uuid(), 'user_id' => $c?->id, 'tipo' => 'RDM', 'subtipo' => 'Abastecimento', 'valor' => 100,
            'data' => '2026-10-20', 'mes' => 10, 'ano' => 2026, 'razao_social' => 'POSTO', 'deleted' => false,
        ], $campos));
        $n->save();

        return $n;
    }

    public function test_gestor_busca_a_nota_inteira_pelo_id_inclusive_a_do_faturamento_sem_colaborador(): void
    {
        $gestor = $this->pessoa('gestor');
        $fat = $this->nota(null, ['pagamento' => 'empresa', 'chave_nfce' => '52261011222333000181650010000001231000001234', 'serie' => '1']);
        $this->nota(null, ['pagamento' => 'empresa']);
        Sanctum::actingAs($gestor);

        $lista = $this->getJson('/api/notas?id='.$fat->id)->assertOk()->json();
        $lista = $lista['data'] ?? $lista;
        $this->assertCount(1, $lista, 'só a nota pedida');
        $this->assertSame($fat->id, $lista[0]['id']);
        $this->assertSame('52261011222333000181650010000001231000001234', $lista[0]['chave_nfce']);
    }

    public function test_colaborador_nao_ve_nota_de_outro_pelo_id(): void
    {
        $dono = $this->pessoa('colaborador');
        $outro = $this->pessoa('colaborador');
        $n = $this->nota($dono);
        Sanctum::actingAs($outro);

        $lista = $this->getJson('/api/notas?id='.$n->id)->assertOk()->json();
        $this->assertCount(0, $lista['data'] ?? $lista);
    }
}
