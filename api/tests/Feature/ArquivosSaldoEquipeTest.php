<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 28/10/2026 — cartão do colaborador na tela Arquivos mostra quanto a empresa deve (saldo por RDM/RDA, bolso e
 * cartão do C.V.). Mesma conta do app (_devedorDe, _cartaoPorTipo) e do PDF da equipe.
 */
class ArquivosSaldoEquipeTest extends TestCase
{
    use RefreshDatabase;

    private const ANO = 2026;

    private function pessoa(string $role, string $nome, string $regime = 'rdm_rda'): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome, 'email' => Str::slug($nome).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['regime' => $regime, 'ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(Colaborador $c, string $tipo, float $valor, ?string $pagamento, int $mes = 3, int $ano = self::ANO): void
    {
        (new Nota([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => $tipo, 'subtipo' => 'Outros', 'valor' => $valor,
            'data' => sprintf('%d-%02d-10', $ano, $mes), 'mes' => $mes, 'ano' => $ano, 'razao_social' => 'X',
            'pagamento' => $pagamento, 'deleted' => false,
        ]))->save();
    }

    private function repasse(Colaborador $c, string $tipo, float $valor, ?string $destino, int $mes = 3, int $ano = self::ANO): void
    {
        $r = new Repasse([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => $tipo, 'valor' => $valor,
            'data' => sprintf('%d-%02d-15', $ano, $mes), 'mes' => $mes, 'ano' => $ano, 'kind' => 'received',
            'destino' => $destino, 'deleted' => false,
        ]);
        $r->forceFill(['confirmado_em' => now()])->save();
    }

    private function saldoDe(string $id): array
    {
        $c = collect($this->getJson('/api/arquivos/resumo?ano='.self::ANO)->assertOk()->json('colaboradores'))->firstWhere('user_id', $id);

        return $c['saldo'];
    }

    public function test_rdm_rda_deve_gasto_menos_recebido_por_tipo_sem_faturamento(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora');
        $edson = $this->pessoa('colaborador', 'Edson');
        $this->nota($edson, 'RDM', 1000, null);
        $this->nota($edson, 'RDA', 400, null, 2, self::ANO - 1);   // saldo de ano anterior acumula
        $this->nota($edson, 'RDM', 999, 'empresa');                // Faturamento não é dívida
        $this->repasse($edson, 'RDM', 300, 'carteira');
        Sanctum::actingAs($gestor);

        $s = $this->saldoDe($edson->id);
        $this->assertFalse($s['cv']);
        $this->assertEquals(700, $s['rdm']);
        $this->assertEquals(400, $s['rda']);
        $this->assertEquals(1100, $s['deve']);
        $this->assertNull($s['cartao_gasto']);
    }

    public function test_credito_em_um_tipo_nao_abate_a_divida_do_outro(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora');
        $dani = $this->pessoa('colaborador', 'Dani');
        $this->nota($dani, 'RDA', 100, null);
        $this->repasse($dani, 'RDM', 136, 'carteira');   // RDM −136, RDA +100
        Sanctum::actingAs($gestor);

        $s = $this->saldoDe($dani->id);
        $this->assertEquals(-136, $s['rdm']);
        $this->assertEquals(100, $s['rda']);
        $this->assertEquals(100, $s['deve']);
    }

    public function test_cv_deve_bolso_menos_repasse_e_cartao_e_recarga_do_ano(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora');
        $ana = $this->pessoa('colaborador', 'Ana', 'cv');
        $this->nota($ana, 'RDM', 500, 'carteira');
        $this->nota($ana, 'RDA', 200, 'carteira');
        $this->nota($ana, 'RDM', 300, 'cartao');
        $this->nota($ana, 'RDM', 50, 'empresa');
        $this->repasse($ana, 'RDM', 100, 'carteira');
        $this->repasse($ana, 'RDM', 1000, 'recarga');
        Sanctum::actingAs($gestor);

        $s = $this->saldoDe($ana->id);
        $this->assertTrue($s['cv']);
        $this->assertEquals(600, $s['deve']);            // bolso 700 − repasse 100; recarga fica fora
        $this->assertEquals(500, $s['rdm']);
        $this->assertEquals(200, $s['rda']);
        $this->assertEquals(300, $s['cartao_gasto']);
        $this->assertEquals(700, $s['cartao_saldo']);    // recarga 1000 − cartão 300
        $this->assertEquals(700, $s['carteira']);
    }

    public function test_colaborador_nao_recebe_saldo_da_equipe(): void
    {
        $edson = $this->pessoa('colaborador', 'Edson');
        $this->nota($edson, 'RDM', 100, null);
        Sanctum::actingAs($edson);

        $c = collect($this->getJson('/api/arquivos/resumo?ano='.self::ANO)->assertOk()->json('colaboradores'))->firstWhere('user_id', $edson->id);
        $this->assertNull($c['saldo']);
    }
}
