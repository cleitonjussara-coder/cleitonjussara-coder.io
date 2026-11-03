<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use App\Services\RelatorioCv;
use App\Services\RelatorioCvPdf;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * 03/11/2026 — no BANCO DE DADOS da Planilha C.V., o reembolso sai separado em RDM (I/J) e RDA (L/M): cada um com o seu
 * "REEMBOLSO DE" e o seu total pago. A soma dos dois alimenta a faixa da aba CV REEMBOLSO.
 */
class RelatorioCvReembolsoSeparadoTest extends TestCase
{
    use RefreshDatabase;

    private const ANO = 2026;

    private function cv(): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => 'Vinicius', 'email' => 'v@teste.local', 'password' => 'segredo123', 'role' => 'colaborador',
        ]);
        $c->forceFill(['regime' => 'cv', 'ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(Colaborador $c, string $tipo, string $subtipo, float $valor, ?string $pagamento, int $mes): void
    {
        (new Nota([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => $tipo, 'subtipo' => $subtipo, 'valor' => $valor,
            'data' => sprintf('%d-%02d-10', self::ANO, $mes), 'mes' => $mes, 'ano' => self::ANO, 'razao_social' => 'X',
            'pagamento' => $pagamento, 'deleted' => false,
        ]))->save();
    }

    private function repasse(Colaborador $c, string $tipo, float $valor, ?string $destino, int $mes): void
    {
        $r = new Repasse([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => $tipo, 'valor' => $valor,
            'data' => sprintf('%d-%02d-15', self::ANO, $mes), 'mes' => $mes, 'ano' => self::ANO, 'kind' => 'received',
            'destino' => $destino, 'deleted' => false,
        ]);
        $r->forceFill(['confirmado_em' => now()])->save();
    }

    private function cenario(): Colaborador
    {
        $c = $this->cv();
        $this->nota($c, 'RDM', 'Abastecimento', 1000, 'carteira', 3);
        $this->nota($c, 'RDM', 'Hospedagem', 400, 'carteira', 12);
        $this->nota($c, 'RDM', 'Outros', 100, 'carteira', 9);
        $this->nota($c, 'RDA', 'Alimentação', 250, 'carteira', 3);
        $this->nota($c, 'RDM', 'Abastecimento', 9999, null, 3);     // no cartão: fora do reembolso
        $this->repasse($c, 'RDM', 600, 'carteira', 4);
        $this->repasse($c, 'RDA', 70, 'carteira', 4);
        $this->repasse($c, 'RDA', 30, 'carteira', 5);
        $this->repasse($c, 'RDA', 5000, 'recarga', 4);              // recarga RDA não é reembolso

        return $c;
    }

    public function test_planilha_separa_extrato_e_totais_de_rdm_e_rda(): void
    {
        $ss = app(RelatorioCv::class)->gerar($this->cenario()->fresh(), self::ANO);
        $bd = $ss->getSheetByName('BANCO DE DADOS');
        $calc = fn (string $a) => (float) $bd->getCell($a)->getCalculatedValue();

        $this->assertSame('REEMBOLSO RDM DE:', $bd->getCell('I13')->getValue());
        $this->assertSame('REEMBOLSO RDA DE:', $bd->getCell('L13')->getValue());

        $this->assertEqualsWithDelta(600, (float) $bd->getCell('J15')->getValue(), 0.001);
        $this->assertEmpty($bd->getCell('J16')->getValue(), 'RDA não entra no bloco RDM');
        $this->assertEqualsWithDelta(70, (float) $bd->getCell('M15')->getValue(), 0.001);
        $this->assertEqualsWithDelta(30, (float) $bd->getCell('M16')->getValue(), 0.001);
        $this->assertEmpty($bd->getCell('M17')->getValue(), 'a recarga RDA fica fora do reembolso');

        $this->assertEqualsWithDelta(600, $calc('J95'), 0.001);
        $this->assertEqualsWithDelta(100, $calc('M95'), 0.001);
        $this->assertEqualsWithDelta(700, $calc('J96'), 0.001);
        $this->assertEqualsWithDelta(900, $calc('J13'), 0.001, 'RDM: 1500 do bolso − 600 pagos');
        $this->assertEqualsWithDelta(150, $calc('M13'), 0.001, 'RDA: 250 do bolso − 100 pagos');

        $this->assertEqualsWithDelta(700, (float) $ss->getSheetByName('CV REEMBOLSO')->getCell('J2')->getCalculatedValue(), 0.001);
        $this->assertEqualsWithDelta(5000, $calc('C95'), 0.001, 'a recarga continua no extrato do cartão');
        $ss->disconnectWorksheets();
    }

    public function test_arquivo_unico_da_equipe_mantem_as_formulas_nas_abas_renomeadas(): void
    {
        $ss = app(RelatorioCv::class)->gerarUnico([$this->cenario()->fresh()], self::ANO);
        $bd = $ss->getSheetByName('Vinicius_BANCO DE DADOS');

        $this->assertEqualsWithDelta(900, (float) $bd->getCell('J13')->getCalculatedValue(), 0.001);
        $this->assertEqualsWithDelta(150, (float) $bd->getCell('M13')->getCalculatedValue(), 0.001);
        $this->assertEqualsWithDelta(700, (float) $ss->getSheetByName('Vinicius_CV REEMBOLSO')->getCell('J2')->getCalculatedValue(), 0.001);
        if ($arq = getenv('CV_AMOSTRA')) {
            app(RelatorioCv::class)->xlsx($ss, $arq);
        }
        $ss->disconnectWorksheets();
    }

    public function test_bloco_rda_tem_o_mesmo_visual_do_rdm(): void
    {
        $ss = app(RelatorioCv::class)->gerar($this->cv()->fresh(), self::ANO);
        $bd = $ss->getSheetByName('BANCO DE DADOS');
        foreach (['I' => 'L', 'J' => 'M'] as $de => $para) {
            foreach ([13, 14, 15, 95] as $linha) {
                $this->assertSame($bd->getStyle("$de$linha")->getHashCode(), $bd->getStyle("$para$linha")->getHashCode(), "$para$linha");
            }
        }
        $ss->disconnectWorksheets();
    }

    public function test_pdf_separa_igual_e_bate_com_a_planilha(): void
    {
        $html = app(RelatorioCvPdf::class)->html($this->cenario()->fresh(), self::ANO);

        $this->assertStringContainsString('REEMBOLSO RDM DE: <span class="num">R$ 900,00</span>', $html);
        $this->assertStringContainsString('REEMBOLSO RDA DE: <span class="num">R$ 150,00</span>', $html);
        $this->assertStringContainsString('TOTAL PAGO RDM</td><td class="num">R$ 600,00', $html);
        $this->assertStringContainsString('TOTAL PAGO RDA</td><td class="num">R$ 100,00', $html);
        $this->assertStringContainsString('RDM R$ 900,00 · RDA R$ 150,00', $html);
    }
}
