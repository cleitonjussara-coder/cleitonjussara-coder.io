<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use App\Services\RelatorioCv;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * 16/10/2026 — "quebrar essa coluna para o valor": na faixa do topo das abas CARTÃO CORPORATIVO e CV REEMBOLSO o
 * "TOTAL RECEBIDO" era um rótulo mesclado em G2:J2 com o valor em K2, coluna OCULTA do modelo — o valor não aparecia —, e o
 * SALDO (=D2-H2) apontava para células vazias e dava sempre R$ 0,00. Agora o rótulo ocupa G2:I2, o valor fica em J2
 * (visível) e o SALDO é recebido − gasto, com o recebido de cada aba (o mesmo do PDF).
 */
class RelatorioCvFaixaTopoTest extends TestCase
{
    use RefreshDatabase;

    private const ANO = 2026;

    private function colaboradorCv(): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => 'Jamil CV', 'email' => 'jamil.cv@teste.local',
            'password' => 'segredo123', 'role' => 'colaborador',
        ]);
        $c->forceFill(['regime' => 'cv', 'ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(Colaborador $c, float $valor, string $pagamento): void
    {
        (new Nota([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => 'RDM', 'subtipo' => 'Abastecimento', 'valor' => $valor,
            'data' => self::ANO.'-03-10', 'mes' => 3, 'ano' => self::ANO, 'razao_social' => 'FORNECEDOR',
            'pagamento' => $pagamento, 'deleted' => false,
        ]))->save();
    }

    private function repasse(Colaborador $c, float $valor, string $destino): void
    {
        $r = new Repasse([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => 'RDM', 'valor' => $valor,
            'data' => self::ANO.'-03-05', 'mes' => 3, 'ano' => self::ANO, 'kind' => 'received', 'destino' => $destino, 'deleted' => false,
        ]);
        $r->forceFill(['confirmado_em' => now()])->save();
    }

    /** Cartão: gasto 120 (100 + 20), recarga 500. Carteira: gasto 7,50, reembolso pago 5,00. */
    private function cenario(): Colaborador
    {
        $c = $this->colaboradorCv();
        $this->nota($c, 100.00, 'cv');
        $this->nota($c, 20.00, 'cv');
        $this->nota($c, 7.50, 'carteira');
        $this->nota($c, 999.00, 'empresa');           // Faturamento: fora das duas abas
        $this->repasse($c, 500.00, 'recarga');
        $this->repasse($c, 5.00, 'carteira');

        return $c;
    }

    public function test_valor_do_total_recebido_sai_da_coluna_oculta_e_vai_para_a_coluna_visivel(): void
    {
        $ss = app(RelatorioCv::class)->gerar($this->cenario(), self::ANO);

        foreach ([RelatorioCv::ABA_CARTAO, 'CV REEMBOLSO'] as $nome) {
            $ws = $ss->getSheetByName($nome);
            $this->assertNotNull($ws, "a aba $nome precisa existir");

            $mescladas = array_values($ws->getMergeCells());
            $this->assertContains('G2:I2', $mescladas, "$nome: o rótulo TOTAL RECEBIDO encolhe para G2:I2");
            $this->assertNotContains('G2:J2', $mescladas, "$nome: o rótulo não cobre mais a coluna do valor");
            $this->assertSame('TOTAL RECEBIDO', $ws->getCell('G2')->getValue());

            $this->assertTrue($ws->getColumnDimension('K')->getVisible() === false, "$nome: a coluna K segue oculta (é Nº DA NOTA)");
            $this->assertTrue($ws->getColumnDimension('J')->getVisible(), "$nome: o valor fica na coluna J, visível");
            $this->assertNull($ws->getCell('K2')->getValue(), "$nome: nada mais na coluna oculta");
            $this->assertSame('=J2-F2', $ws->getCell('P2')->getValue(), "$nome: SALDO = recebido − gasto");

            $fmt = $ws->getStyle('J2')->getNumberFormat()->getFormatCode();
            $this->assertSame($ws->getStyle('F2')->getNumberFormat()->getFormatCode(), $fmt, "$nome: mesmo formato de moeda dos outros valores");
            $this->assertTrue($ws->getStyle('J2')->getFont()->getBold(), "$nome: o valor em negrito, como os outros");
        }

        $this->assertSame("='BANCO DE DADOS'!C95", $ss->getSheetByName(RelatorioCv::ABA_CARTAO)->getCell('J2')->getValue(), 'cartão: recebido = recargas');
        $this->assertSame("='BANCO DE DADOS'!J95", $ss->getSheetByName('CV REEMBOLSO')->getCell('J2')->getValue(), 'carteira: recebido = reembolsos pagos');
        $ss->disconnectWorksheets();
    }

    public function test_totais_e_saldo_batem_com_o_que_o_colaborador_gastou_e_recebeu(): void
    {
        $ss = app(RelatorioCv::class)->gerar($this->cenario(), self::ANO);

        $cartao = $ss->getSheetByName(RelatorioCv::ABA_CARTAO);
        $this->assertEqualsWithDelta(120.00, (float) $cartao->getCell('F2')->getCalculatedValue(), 0.001, 'gasto no cartão');
        $this->assertEqualsWithDelta(500.00, (float) $cartao->getCell('J2')->getCalculatedValue(), 0.001, 'recarga recebida');
        $this->assertEqualsWithDelta(380.00, (float) $cartao->getCell('P2')->getCalculatedValue(), 0.001, 'saldo do cartão = 500 − 120');

        $reemb = $ss->getSheetByName('CV REEMBOLSO');
        $this->assertEqualsWithDelta(7.50, (float) $reemb->getCell('F2')->getCalculatedValue(), 0.001, 'gasto da carteira');
        $this->assertEqualsWithDelta(5.00, (float) $reemb->getCell('J2')->getCalculatedValue(), 0.001, 'reembolso pago');
        $this->assertEqualsWithDelta(-2.50, (float) $reemb->getCell('P2')->getCalculatedValue(), 0.001, 'ainda falta reembolsar 2,50');
        $ss->disconnectWorksheets();
    }
}
