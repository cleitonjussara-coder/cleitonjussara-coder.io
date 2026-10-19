<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\RelatorioRdmRda;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * 15/10/2026 — "na planilha de Excel do Edson, em RDA, onde só há lançamento de outubro, apareceram lançamentos de outros meses".
 * O modelo PLANILHA_RDM_RDA.xlsx veio com notas de EXEMPLO de outra pessoa. O R.D.A de março a dezembro começa os dados logo
 * abaixo do rótulo do mês (janeiro e fevereiro têm uma linha de cabeçalho a mais); o gerador limpava a partir de "rótulo + 2" e
 * deixava a linha de exemplo de março a setembro. O que a planilha entrega tem de ser só o que o colaborador lançou.
 */
class RelatorioRdmRdaAmostraTest extends TestCase
{
    use RefreshDatabase;

    private const ANO = 2026;

    /** [linha do rótulo, linha do TOTAL] de cada mês no R.D.A do modelo (fixo: é o arquivo da empresa) */
    private const RDA = [
        1 => [4, 21], 2 => [22, 38], 3 => [39, 55], 4 => [56, 72], 5 => [73, 89], 6 => [90, 106],
        7 => [107, 123], 8 => [124, 140], 9 => [141, 157], 10 => [158, 174], 11 => [175, 191], 12 => [192, 208],
    ];

    /** [linha do rótulo, linha do TOTAL] de cada mês no R.D.M. do modelo */
    private const RDM = [
        1 => [5, 37], 2 => [39, 84], 3 => [86, 131], 4 => [133, 178], 5 => [180, 225], 6 => [227, 272],
        7 => [274, 319], 8 => [321, 366], 9 => [368, 413], 10 => [415, 460], 11 => [462, 507], 12 => [509, 554],
    ];

    protected function setUp(): void
    {
        parent::setUp();
        @ini_set('memory_limit', '768M');   // o mesmo teto que o controller usa para gerar esta planilha (o modelo é pesado)
    }

    private function colaborador(): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => 'Edson Teste', 'email' => 'edson@teste.local',
            'password' => 'segredo123', 'role' => 'colaborador',
        ]);
        $c->forceFill(['regime' => 'rdm_rda', 'ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function notaRda(Colaborador $c, int $mes, int $dia, float $valor, string $cnpj = '12345678000199'): void
    {
        (new Nota([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => 'RDA', 'subtipo' => null, 'valor' => $valor,
            'data' => sprintf('%d-%02d-%02d', self::ANO, $mes, $dia), 'mes' => $mes, 'ano' => self::ANO,
            'razao_social' => 'EMPRESA TESTE', 'cnpj' => $cnpj, 'pagamento' => null, 'deleted' => false,
        ]))->save();
    }

    /** quantas células com DADO (data, CNPJ, valor) há nas colunas B–G do bloco do mês, fora rótulo, cabeçalho e fórmulas */
    private function celulasDeDados($ss, int $mes): int
    {
        $ws = $ss->getSheetByName('R.D.A');
        [$ini, $tot] = self::RDA[$mes];
        $n = 0;
        for ($r = $ini + 1; $r < $tot; $r++) {
            for ($c = 2; $c <= 7; $c++) {
                $v = $ws->getCell([$c, $r])->getValue();
                if ($v === null || $v === '') {
                    continue;
                }
                if (is_string($v) && in_array(mb_strtolower(trim($v)), ['data', 'cnpj', 'r$', 'valor total (r$)'], true)) {
                    continue;   // cabeçalho de janeiro/fevereiro
                }
                $n++;
            }
        }

        return $n;
    }

    public function test_so_outubro_lancado_nao_deixa_nada_de_exemplo_nos_outros_meses(): void
    {
        $c = $this->colaborador();
        for ($i = 1; $i <= 22; $i++) {
            $this->notaRda($c, 10, 1 + ($i % 13), 10 + $i);
        }
        $ss = app(RelatorioRdmRda::class)->gerar($c, self::ANO);

        foreach (range(1, 12) as $mes) {
            if ($mes === 10) {
                continue;
            }
            $this->assertSame(0, $this->celulasDeDados($ss, $mes), "mês $mes do R.D.A tem lançamento que o colaborador não fez");
        }
        $this->assertSame(22 * 3, $this->celulasDeDados($ss, 10), 'outubro: 22 notas × (data, CNPJ, valor)');

        /* e o R.D.M. não ganha nada de quem só lançou RDA: nenhuma linha de dados em nenhum dos 12 blocos */
        $rdm = $ss->getSheetByName('R.D.M.');
        $achou = [];
        foreach (self::RDM as $mes => [$ini, $tot]) {
            for ($r = $ini + 1; $r < $tot; $r++) {
                for ($col = 2; $col <= 10; $col++) {
                    $v = $rdm->getCell([$col, $r])->getValue();
                    if ($v !== null && $v !== '') {
                        $achou[] = "mês $mes L$r C$col=$v";
                    }
                }
            }
        }
        $this->assertSame([], $achou, 'R.D.M. deveria estar vazio');
        $ss->disconnectWorksheets();
    }

    public function test_cada_nota_cai_na_primeira_linha_certa_do_bloco_do_mes(): void
    {
        $c = $this->colaborador();
        $this->notaRda($c, 1, 5, 11.11);    // janeiro: cabeçalho em 5, dados a partir de 6
        $this->notaRda($c, 2, 5, 22.22);    // fevereiro: cabeçalho em 23, dados a partir de 24
        $this->notaRda($c, 3, 5, 33.33);    // março em diante: dados logo abaixo do rótulo (40)
        $this->notaRda($c, 10, 5, 44.44);   // outubro: 159
        $ss = app(RelatorioRdmRda::class)->gerar($c, self::ANO);
        $ws = $ss->getSheetByName('R.D.A');

        $this->assertEquals(11.11, $ws->getCell('D6')->getValue());
        $this->assertEquals(22.22, $ws->getCell('D24')->getValue());
        $this->assertEquals(33.33, $ws->getCell('D40')->getValue());
        $this->assertEquals(44.44, $ws->getCell('D159')->getValue());

        /* os cabeçalhos de janeiro e fevereiro continuam onde estavam */
        $this->assertSame('DATA', $ws->getCell('B5')->getValue());
        $this->assertSame('Data', $ws->getCell('B23')->getValue());
        $ss->disconnectWorksheets();
    }

    public function test_linhas_em_branco_ficam_ocultas(): void
    {
        $c = $this->colaborador();
        for ($i = 1; $i <= 17; $i++) {
            $this->notaRda($c, 10, 1 + ($i % 13), 10 + $i);   // 15 na 1ª coluna + 2 na 2ª: bloco inteiro visível
        }
        $this->notaRda($c, 3, 5, 10.00);                       // março: 1 nota
        $ss = app(RelatorioRdmRda::class)->gerar($c, self::ANO);
        $ws = $ss->getSheetByName('R.D.A');

        $this->assertTrue($ws->getRowDimension(40)->getVisible(), 'linha usada de março');
        $this->assertFalse($ws->getRowDimension(41)->getVisible(), 'linha vazia de março');
        $this->assertFalse($ws->getRowDimension(6)->getVisible(), 'janeiro sem notas');
        $this->assertTrue($ws->getRowDimension(5)->getVisible(), 'cabeçalho de janeiro continua');
        $this->assertTrue($ws->getRowDimension(55)->getVisible(), 'TOTAL de março continua');
        $this->assertTrue($ws->getRowDimension(173)->getVisible(), 'outubro cheio');
        $ss->disconnectWorksheets();
    }

    public function test_lancamento_a_mais_que_as_linhas_do_modelo_cria_linhas(): void
    {
        $c = $this->colaborador();
        $soma = 0;
        for ($i = 1; $i <= 34; $i++) {              // março cabe 30 (15 × 2): 4 a mais → 2 linhas novas
            $this->notaRda($c, 3, 1 + ($i % 28), 10);
            $soma += 10;
        }
        $this->notaRda($c, 4, 5, 7.00);             // abril desce 2 linhas e continua certo
        for ($i = 1; $i <= 50; $i++) {              // R.D.M. janeiro: 31 linhas por categoria; 50 outros → 19 novas
            (new Nota([
                'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => 'RDM', 'subtipo' => 'outros', 'valor' => 1,
                'data' => '2026-01-05', 'mes' => 1, 'ano' => self::ANO, 'razao_social' => 'X', 'cnpj' => '12345678000199',
                'pagamento' => null, 'deleted' => false,
            ]))->save();
        }
        $ss = app(RelatorioRdmRda::class)->gerar($c, self::ANO);
        $ws = $ss->getSheetByName('R.D.A');

        $this->assertNull($ss->getSheetByName('CABEÇALHO')->getCell('A10')->getValue(), 'nada deve ser descartado');
        /* março: rótulo 39, dados 40–54 + 2 novas (55, 56), TOTAL desce de 55 para 57 */
        $this->assertSame(340.0, (float) $ws->getCell('G57')->getCalculatedValue() - 0.0);
        $this->assertSame('=SUM(D40:D56,G40:G56)', $ws->getCell('G57')->getValue());
        $this->assertEquals(10, $ws->getCell('D56')->getValue(), 'a 17ª nota da 1ª coluna usa a linha nova');
        $this->assertTrue($ws->getRowDimension(56)->getVisible());
        /* abril desceu 2: rótulo 58, total 74 */
        $this->assertEquals(7, $ws->getCell('D59')->getValue());
        $this->assertEqualsWithDelta(7.0, (float) $ws->getCell('G74')->getCalculatedValue(), 0.001);
        /* a aba BANCO DE DADOS acompanha o total deslocado */
        $this->assertSame('=R.D.A!G57', $ss->getSheetByName('BANCO DE DADOS')->getCell('O8')->getValue());
        $this->assertSame('=R.D.A!G74', $ss->getSheetByName('BANCO DE DADOS')->getCell('P8')->getValue());

        $rdm = $ss->getSheetByName('R.D.M.');
        $this->assertEqualsWithDelta(50.0, (float) $rdm->getCell('J56')->getCalculatedValue(), 0.001);   // TOTAL de janeiro desceu 19
        $this->assertSame('=R.D.M.!E57', $ss->getSheetByName('BANCO DE DADOS')->getCell('M6')->getValue());
        $ss->disconnectWorksheets();
    }

    public function test_saldo_do_rdm_e_recebido_menos_gasto(): void
    {
        $c = $this->colaborador();
        $ss = app(RelatorioRdmRda::class)->gerar($c, self::ANO);

        $this->assertSame('=G2-D2', $ss->getSheetByName('R.D.M.')->getCell('J2')->getValue());
        $ss->disconnectWorksheets();
    }

    public function test_o_total_do_mes_continua_somando_o_que_foi_lancado(): void
    {
        $c = $this->colaborador();
        $this->notaRda($c, 3, 5, 10.00);
        $this->notaRda($c, 3, 6, 20.50);
        $ss = app(RelatorioRdmRda::class)->gerar($c, self::ANO);
        $ws = $ss->getSheetByName('R.D.A');

        /* a fórmula do TOTAL de março (=SUM(D40:D54,G40:G54)) tem de enxergar as duas notas */
        $this->assertSame('=SUM(D40:D54,G40:G54)', $ws->getCell('G55')->getValue());
        $this->assertEqualsWithDelta(30.50, (float) $ws->getCell('G55')->getCalculatedValue(), 0.001);
        $ss->disconnectWorksheets();
    }
}
