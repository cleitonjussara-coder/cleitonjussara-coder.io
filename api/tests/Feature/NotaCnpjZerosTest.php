<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\RelatorioCv;
use App\Services\RelatorioRdmRda;
use App\Services\RelatorioRdmRdaPdf;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 21/10/2026 — recibo sem CNPJ. O app antigo gravava "00000000000000" (BrasilAPI.limpar('') devolve 14 zeros) e a planilha
 * o escrevia como se fosse CNPJ (00.000.000/0000-00). Zero não é CNPJ: sem CNPJ (vazio ou só zeros) a planilha mostra a razão
 * social, se a nota tiver (como já fazia), ou fica em branco. O Cleiton chegou a pedir a palavra "recibo" no lugar do CNPJ e
 * depois desistiu: a palavra NÃO é escrita em lugar nenhum.
 */
class NotaCnpjZerosTest extends TestCase
{
    use RefreshDatabase;

    private const ANO = 2026;

    protected function setUp(): void
    {
        parent::setUp();
        @ini_set('memory_limit', '768M');
    }

    private function colaborador(string $regime = 'rdm_rda'): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => 'Zeros Teste', 'email' => $regime.'@zeros.local',
            'password' => 'segredo123', 'role' => 'colaborador',
        ]);
        $c->forceFill(['regime' => $regime, 'ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(Colaborador $c, string $tipo, ?string $cnpj, ?string $razao = null, float $valor = 24.95, string $mes = '10'): Nota
    {
        $n = new Nota([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => $tipo, 'subtipo' => $tipo === 'RDM' ? 'Outros' : null,
            'documento' => 'outro', 'numero' => '2460', 'valor' => $valor, 'data' => self::ANO."-$mes-14", 'mes' => (int) $mes, 'ano' => self::ANO,
            'razao_social' => $razao, 'cnpj' => $cnpj, 'pagamento' => 'carteira', 'deleted' => false,
        ]);
        $n->save();

        return $n;
    }

    public function test_zeros_nao_sao_cnpj_e_a_palavra_recibo_nao_e_escrita(): void
    {
        $c = $this->colaborador();
        $this->assertSame('', (new Nota(['cnpj' => null]))->cnpjParaPlanilha());
        $this->assertSame('', (new Nota(['cnpj' => '']))->cnpjParaPlanilha());
        $this->assertSame('', (new Nota(['cnpj' => '00000000000000']))->cnpjParaPlanilha());
        $this->assertSame('', (new Nota(['cnpj' => '00.000.000/0000-00']))->cnpjParaPlanilha());
        $this->assertSame('', (new Nota(['cnpj' => '00000000000000', 'razao_social' => '  ']))->cnpjParaPlanilha());
        $this->assertSame('PADARIA DO ZE', $this->nota($c, 'RDA', null, 'PADARIA DO ZE')->cnpjParaPlanilha(), 'sem CNPJ mas com razão social: a planilha segue mostrando a razão');
        $this->assertSame('PADARIA DO ZE', (new Nota(['cnpj' => '00000000000000', 'razao_social' => 'PADARIA DO ZE']))->cnpjParaPlanilha(), 'os zeros também não são CNPJ');
        $this->assertSame('05.764.979/0001-98', (new Nota(['cnpj' => '05764979000198', 'razao_social' => 'X']))->cnpjParaPlanilha(), 'com CNPJ real o CNPJ formatado');
        $this->assertFalse((new Nota(['cnpj' => '00000000000000']))->temCnpj());
        $this->assertTrue((new Nota(['cnpj' => '05764979000198']))->temCnpj());
    }

    public function test_planilha_rdm_rda_nao_mostra_zeros_como_cnpj_nem_escreve_recibo(): void
    {
        $c = $this->colaborador();
        $this->nota($c, 'RDM', '00000000000000');                    // o caso do print: RDM · Outros · 14 zeros
        $this->nota($c, 'RDM', null, null, 11.11, '03');              // sem CNPJ nenhum (março)
        $this->nota($c, 'RDA', null, null, 24.95, '10');              // RDA sem CNPJ e sem razão social
        $this->nota($c, 'RDA', '', 'LANCHONETE', 30.00);              // RDA com só a razão social
        $this->nota($c, 'RDA', '05764979000198', 'POSTO', 60.00);     // CNPJ real

        $ss = app(RelatorioRdmRda::class)->gerar($c, self::ANO);
        $rdm = $ss->getSheetByName('R.D.M.');
        $rda = $ss->getSheetByName('R.D.A');

        $this->assertSame('', (string) $rdm->getCell('I416')->getValue(), 'outubro, Outros: 14 zeros → célula em branco, não 00.000.000/0000-00');
        $this->assertEquals(24.95, $rdm->getCell('J416')->getValue(), 'a nota está na linha e o valor entra');
        $this->assertSame('', (string) $rdm->getCell('I87')->getValue(), 'março, Outros: sem CNPJ → em branco');
        $this->assertSame('', (string) $rda->getCell('C159')->getValue(), 'RDA sem CNPJ e sem razão social → em branco');
        $this->assertSame('LANCHONETE', $rda->getCell('C160')->getValue(), 'sem CNPJ mas com razão social: a razão, como sempre');
        $this->assertSame('05.764.979/0001-98', $rda->getCell('C161')->getValue(), 'com CNPJ real continua o CNPJ formatado');
        $ss->disconnectWorksheets();
    }

    public function test_pdf_rdm_rda_nao_mostra_zeros_nem_recibo(): void
    {
        $c = $this->colaborador();
        $this->nota($c, 'RDM', '00000000000000');
        $this->nota($c, 'RDA', null);
        $this->nota($c, 'RDA', '05764979000198', null, 60.00);
        $this->nota($c, 'RDA', '', 'LANCHONETE', 30.00);

        $html = app(RelatorioRdmRdaPdf::class)->html($c, self::ANO);

        $this->assertStringNotContainsString('00.000.000/0000-00', $html);
        $this->assertStringNotContainsString('recibo', mb_strtolower($html));
        $this->assertStringContainsString('<td class="cnpj">LANCHONETE</td>', $html);
        $this->assertStringContainsString('05.764.979/0001-98', $html);
    }

    public function test_planilha_cv_nao_mostra_zeros_como_cnpj(): void
    {
        $c = $this->colaborador('cv');
        $this->nota($c, 'RDM', '00000000000000');
        $this->nota($c, 'RDM', '00000000000000', 'POSTO SEM CNPJ', 10.00, '03');
        $ss = app(RelatorioCv::class)->gerar($c, self::ANO);

        $zeros = [];
        $razao = 0;
        foreach (['CARTÃO CORPORATIVO', 'CV REEMBOLSO'] as $aba) {
            $ws = $ss->getSheetByName($aba);
            foreach (range(1, 712) as $linha) {
                foreach (range(1, 16) as $col) {
                    $v = $ws->getCell([$col, $linha])->getValue();
                    $this->assertNotSame('recibo', $v, 'a palavra recibo não é escrita');
                    if (is_numeric($v) && (float) $v === 0.0 && str_contains((string) $ws->getCell([$col, $linha])->getFormattedValue(), '00.000.000')) {
                        $zeros[] = "$aba L$linha C$col";
                    }
                    if ($v === 'POSTO SEM CNPJ') {
                        $razao++;
                    }
                }
            }
        }
        $this->assertSame([], $zeros, 'nenhuma célula pode mostrar o CNPJ 00.000.000/0000-00');
        $this->assertSame(1, $razao, 'sem CNPJ, a razão social segue aparecendo');
        $ss->disconnectWorksheets();
    }

    public function test_cnpj_de_zeros_chega_do_app_e_o_servidor_grava_vazio(): void
    {
        $c = $this->colaborador();
        Sanctum::actingAs($c);
        $base = ['user_id' => $c->id, 'tipo' => 'RDM', 'subtipo' => 'Outros', 'valor' => 24.95, 'data' => '2026-10-14', 'mes' => 10, 'ano' => 2026, 'pagamento' => 'carteira', 'deleted' => false];

        /* nota nova exige anexo no disco; o caso real é abrir uma nota que já existe (Editar Nota) e salvar */
        $nota = $this->nota($c, 'RDM', '05764979000198');

        foreach (['00000000000000', '00.000.000/0000-00'] as $i => $zeros) {
            $this->putJson("/api/notas/{$nota->id}", $base + ['cnpj' => $zeros])->assertOk();
            $this->assertNull($nota->fresh()->cnpj, "variante $i: zeros não são CNPJ");
        }

        $this->putJson("/api/notas/{$nota->id}", $base + ['cnpj' => '05.764.979/0001-98'])->assertOk();
        $this->assertSame('05764979000198', $nota->fresh()->cnpj, 'CNPJ real segue gravado só com dígitos');
    }
}
