<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use App\Services\RelatorioCv;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 03/11/2026 — aba "Repasses e recargas" da Equipe: o gestor corrige grupo (RDM, RDA, Cartão RDM, Cartão RDA), valor e
 * data. A recarga passou a ter RDM/RDA, mas o saldo do cartão continua um só: trocar o tipo não pode mexer nele.
 */
class RepasseEdicaoGrupoTest extends TestCase
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

    private function nota(Colaborador $c, float $valor, ?string $pagamento): void
    {
        (new Nota([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => 'RDM', 'subtipo' => 'Outros', 'valor' => $valor,
            'data' => self::ANO.'-03-10', 'mes' => 3, 'ano' => self::ANO, 'razao_social' => 'X',
            'pagamento' => $pagamento, 'deleted' => false,
        ]))->save();
    }

    private function lancar(Colaborador $gestor, Colaborador $c, string $tipo, float $valor, ?string $destino): string
    {
        $id = (string) Str::uuid();
        Sanctum::actingAs($gestor);
        $this->putJson("/api/repasses/$id", [
            'user_id' => $c->id, 'tipo' => $tipo, 'valor' => $valor, 'data' => self::ANO.'-03-15', 'mes' => 3, 'ano' => self::ANO,
            'kind' => 'received', 'destino' => $destino, 'deleted' => false,
        ])->assertOk();

        return $id;
    }

    private function corrigir(string $id, array $troca)
    {
        $r = Repasse::findOrFail($id);

        return $this->putJson("/api/repasses/$id", array_replace([
            'user_id' => $r->user_id, 'tipo' => $r->tipo, 'valor' => (float) $r->valor, 'data' => $r->data->format('Y-m-d'),
            'mes' => (int) $r->mes, 'ano' => (int) $r->ano, 'descricao' => $r->descricao, 'kind' => $r->kind,
            'destino' => $r->destino, 'deleted' => false,
        ], $troca));
    }

    private function saldoDe(string $id): array
    {
        return collect($this->getJson('/api/arquivos/resumo?ano='.self::ANO)->assertOk()->json('colaboradores'))->firstWhere('user_id', $id)['saldo'];
    }

    public function test_trocar_recarga_de_rdm_para_rda_nao_muda_saldo_nem_a_divida(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestor');
        $cv = $this->pessoa('colaborador', 'Cartao', 'cv');
        $this->nota($cv, 200, null);        // cartão
        $this->nota($cv, 80, 'carteira');   // do bolso
        $id = $this->lancar($gestor, $cv, 'RDM', 500, 'recarga');

        $antes = $this->saldoDe($cv->id);
        $this->assertEqualsWithDelta(300, $antes['cartao_saldo'], 0.001);
        $this->corrigir($id, ['tipo' => 'RDA'])->assertOk();

        $this->assertSame('RDA', Repasse::find($id)->tipo);
        $this->assertSame('recarga', Repasse::find($id)->destino);
        $this->assertEquals($antes, $this->saldoDe($cv->id));

        /* planilha C.V.: continua no extrato de recarga (B/C), fora do de reembolso (I/J) */
        $bd = app(RelatorioCv::class)->gerar($cv->fresh(), self::ANO)->getSheetByName('BANCO DE DADOS');
        $this->assertEqualsWithDelta(500, (float) $bd->getCell('C15')->getValue(), 0.001);
        $this->assertEmpty($bd->getCell('J15')->getValue());
    }

    public function test_passar_repasse_para_o_cartao_move_o_dinheiro_e_data_manda_no_mes(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestor');
        $cv = $this->pessoa('colaborador', 'Cartao', 'cv');
        $id = $this->lancar($gestor, $cv, 'RDM', 300, 'carteira');
        $antes = $this->saldoDe($cv->id);

        $this->corrigir($id, ['tipo' => 'RDA', 'destino' => 'recarga', 'valor' => 350, 'data' => self::ANO.'-04-02'])->assertOk();

        $r = Repasse::find($id);
        $this->assertSame([4, 'recarga', 350.0], [$r->mes, $r->destino, $r->valor]);
        $this->assertEqualsWithDelta($antes['cartao_saldo'] + 350, $this->saldoDe($cv->id)['cartao_saldo'], 0.001);
    }

    public function test_so_gestor_ou_admin_troca_o_que_foi_lancado_pelo_gestor(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestor');
        $colab = $this->pessoa('colaborador', 'Colab', 'cv');
        $contador = $this->pessoa('contabilidade', 'Contador');
        $id = $this->lancar($gestor, $colab, 'RDM', 500, 'recarga');

        Sanctum::actingAs($colab);
        $this->corrigir($id, ['destino' => 'carteira'])->assertForbidden();
        Sanctum::actingAs($contador);
        $this->corrigir($id, ['tipo' => 'RDA'])->assertForbidden();

        Sanctum::actingAs($this->pessoa('admin', 'Admin'));
        $this->corrigir($id, ['tipo' => 'RDA'])->assertOk();
    }
}
