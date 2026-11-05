<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use App\Services\RelatorioCv;
use App\Services\RelatorioCvPdf;
use App\Services\RelatorioRdmRda;
use App\Services\RelatorioRdmRdaPdf;
use App\Services\SaldoAnterior;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use PhpOffice\PhpSpreadsheet\IOFactory;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use Tests\TestCase;

/**
 * 04/11/2026 — "valores acumulativo de um ano, acumula para o ano posterior, com especificação de saldo de ano anterior".
 * Saldo por ano = saldo do ano anterior + entradas do ano − saídas do ano, com o anterior escrito em linha própria.
 * As planilhas são conferidas calculando as fórmulas de verdade (getCalculatedValue), inclusive depois de salvar e reabrir.
 */
class SaldoAnteriorTest extends TestCase
{
    use RefreshDatabase;

    private const ANO = 2026;

    protected function setUp(): void
    {
        parent::setUp();
        @ini_set('memory_limit', '3072M');   // na suíte completa a memória se acumula: com 768M o PHP morria no meio (Premature end of PHP process)
    }

    private function pessoa(string $nome, string $regime = 'rdm_rda', string $role = 'colaborador'): Colaborador
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

    private function nota(Colaborador $c, string $tipo, float $valor, ?string $pagamento, int $ano = self::ANO, bool $deleted = false): void
    {
        (new Nota([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => $tipo, 'subtipo' => $tipo === 'RDA' ? 'Alimentação' : 'Abastecimento',
            'valor' => $valor, 'data' => "{$ano}-03-10", 'mes' => 3, 'ano' => $ano, 'razao_social' => 'X', 'pagamento' => $pagamento, 'deleted' => $deleted,
        ]))->save();
    }

    private function repasse(Colaborador $c, string $tipo, float $valor, ?string $destino, int $ano = self::ANO, array $outros = []): void
    {
        $r = new Repasse([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => $tipo, 'valor' => $valor, 'data' => "{$ano}-03-15", 'mes' => 3, 'ano' => $ano,
            'kind' => $outros['kind'] ?? 'received', 'destino' => $destino, 'deleted' => $outros['deleted'] ?? false,
        ]);
        $r->forceFill(['confirmado_em' => array_key_exists('confirmado_em', $outros) ? $outros['confirmado_em'] : now()])->save();
    }

    private function saldo(Colaborador $c, int $ano = self::ANO): array
    {
        return app(SaldoAnterior::class)->de($c, $ano);
    }

    private function resumo(Colaborador $gestor, Colaborador $c, int $ano = self::ANO): array
    {
        Sanctum::actingAs($gestor);

        return collect($this->getJson("/api/arquivos/resumo?ano={$ano}")->assertOk()->json('colaboradores'))->firstWhere('user_id', $c->id)['saldo'];
    }

    private function valor(Spreadsheet $ss, string $aba, string $celula): float
    {
        return (float) $ss->getSheetByName($aba)->getCell($celula)->getCalculatedValue();
    }

    /**
     * C.V. em dois anos. 2025: cartão 1000 − 1300 = −300; reembolso RDM 50 − 200 = −150, RDA 70 − 10 = +60.
     * 2026: recarga 500, cartão 100, bolso RDM 40 e RDA 30, reembolso pago RDM 25 e RDA 5.
     */
    private function cvDoisAnos(): Colaborador
    {
        $c = $this->pessoa('Ana', 'cv');
        $this->repasse($c, 'RDM', 1000, 'recarga', 2025);
        $this->nota($c, 'RDM', 1300, 'cartao', 2025);
        $this->nota($c, 'RDM', 200, 'carteira', 2025);
        $this->nota($c, 'RDA', 10, 'carteira', 2025);
        $this->repasse($c, 'RDM', 50, 'carteira', 2025);
        $this->repasse($c, 'RDA', 70, 'carteira', 2025);

        $this->repasse($c, 'RDA', 500, 'recarga');
        $this->nota($c, 'RDM', 100, 'cartao');
        $this->nota($c, 'RDM', 40, 'carteira');
        $this->nota($c, 'RDA', 30, 'carteira');
        $this->repasse($c, 'RDM', 25, 'carteira');
        $this->repasse($c, 'RDA', 5, 'carteira');

        return $c->fresh();
    }

    /** RDM/RDA em dois anos. 2025: RDM 1000 − 1250 = −250; RDA 400 − 100 = +300. 2026: RDM 600 − 200; RDA 50 − 80. */
    private function rdmDoisAnos(): Colaborador
    {
        $c = $this->pessoa('Beto');
        $this->repasse($c, 'RDM', 1000, null, 2025);
        $this->nota($c, 'RDM', 1250, null, 2025);
        $this->repasse($c, 'RDA', 400, null, 2025);
        $this->nota($c, 'RDA', 100, null, 2025);

        $this->repasse($c, 'RDM', 600, null);
        $this->nota($c, 'RDM', 200, null);
        $this->repasse($c, 'RDA', 50, null);
        $this->nota($c, 'RDA', 80, null);

        return $c->fresh();
    }

    /* ── O serviço ────────────────────────────────────────────── */

    /* Achado no cruzamento das superfícies (04/11/2026): o PDF mensal da equipe perdia o repasse de kind vazio dos meses anteriores. */
    public function test_relatorio_da_equipe_conta_repasse_de_kind_vazio_nos_meses_anteriores(): void
    {
        $c = $this->pessoa('Rita');
        $this->repasse($c, 'RDM', 250.25, null, 2025, ['kind' => '']);
        $this->nota($c, 'RDM', 50, null, 2025);

        $this->assertEqualsWithDelta(200.25, app(\App\Services\RelatorioEquipePdf::class)->saldoAnterior(self::ANO, 1, [$c->id])[$c->id]['RDM'], 0.001);
    }

    public function test_sem_historico_o_anterior_e_zero(): void
    {
        $c = $this->pessoa('Nova', 'cv');
        $this->repasse($c, 'RDM', 500, 'recarga');
        $this->nota($c, 'RDM', 100, 'cartao');

        $s = $this->saldo($c);
        $this->assertSame(SaldoAnterior::zerado(), $s);
        $this->assertSame([], app(SaldoAnterior::class)->deTodos(self::ANO), 'quem só tem o ano em foco não traz nada');
    }

    public function test_soma_todos_os_anos_anteriores_e_nunca_os_seguintes(): void
    {
        $c = $this->pessoa('Ana', 'cv');
        foreach ([2023 => [1000, 100], 2024 => [50, 300], 2025 => [200, 20]] as $ano => [$recarga, $gasto]) {
            $this->repasse($c, 'RDM', $recarga, 'recarga', $ano);
            $this->nota($c, 'RDM', $gasto, 'cartao', $ano);
        }
        $this->repasse($c, 'RDM', 7777, 'recarga', 2026);
        $this->nota($c, 'RDM', 8888, 'cartao', 2027);

        $this->assertEquals(830, $this->saldo($c, 2026)['cartao'], '900 − 250 + 180: três anos, não só o último');
        $this->assertEquals(650, $this->saldo($c, 2025)['cartao'], 'em foco 2025: 2025 em diante não conta');
        $this->assertEquals(900, $this->saldo($c, 2024)['cartao']);
        $this->assertEquals(0, $this->saldo($c, 2023)['cartao']);
    }

    public function test_o_que_nao_conta_fica_de_fora(): void
    {
        $c = $this->pessoa('Ana', 'cv');
        $this->nota($c, 'RDM', 10, 'cartao', 2025);
        $this->nota($c, 'RDM', 20, null, 2025);                          // nota antiga, sem pagamento gravado, é do cartão
        $this->nota($c, 'RDM', 40, 'carteira', 2025);
        $this->nota($c, 'RDA', 80, 'carteira', 2025);

        /* nada disto entra */
        $this->nota($c, 'RDM', 1000, 'cartao', 2025, deleted: true);
        $this->nota($c, 'RDM', 1100, 'carteira', 2025, deleted: true);
        $this->nota($c, 'RDM', 1200, 'empresa', 2025);
        $this->repasse($c, 'RDM', 1300, 'recarga', 2025, ['deleted' => true]);
        $this->repasse($c, 'RDM', 1400, 'carteira', 2025, ['kind' => 'requested']);
        $this->repasse($c, 'RDM', 1500, 'carteira', 2025, ['confirmado_em' => null]);

        $s = $this->saldo($c);
        $this->assertEquals(-30, $s['cartao']);
        $this->assertEquals(['RDM' => -40, 'RDA' => -80], $s['reembolso']);
        $this->assertEquals(['RDM' => -70, 'RDA' => -80], $s['saldo'], 'gasto inteiro sem Faturamento');
    }

    public function test_recarga_e_do_cartao_e_nao_separa_rdm_de_rda(): void
    {
        $c = $this->pessoa('Ana', 'cv');
        $this->repasse($c, 'RDM', 100, 'recarga', 2025);
        $this->repasse($c, 'RDA', 200, 'recarga', 2025);

        $s = $this->saldo($c);
        $this->assertEquals(300, $s['cartao']);
        $this->assertEquals(['RDM' => 0, 'RDA' => 0], $s['reembolso'], 'recarga não é recebido');
        $this->assertEquals(['RDM' => 0, 'RDA' => 0], $s['saldo']);
    }

    public function test_repasse_antigo_com_kind_vazio_conta_como_recebido(): void
    {
        $c = $this->pessoa('Beto');
        $this->repasse($c, 'RDM', 100, null, 2025, ['kind' => '']);
        $this->repasse($c, 'RDA', 30, null, 2025);

        $this->assertEquals(['RDM' => 100, 'RDA' => 30], $this->saldo($c)['saldo']);
    }

    public function test_mudanca_de_regime_le_a_conta_do_regime_atual(): void
    {
        $c = $this->pessoa('Ana', 'cv');
        $this->repasse($c, 'RDM', 1000, 'recarga', 2025);
        $this->nota($c, 'RDM', 300, 'cartao', 2025);
        $this->nota($c, 'RDM', 40, 'carteira', 2025);
        $svc = app(SaldoAnterior::class);

        $this->assertEquals(['RDM' => -40, 'RDA' => 0], $svc->porTipo($c, $this->saldo($c)));

        $c->forceFill(['regime' => 'rdm_rda'])->save();
        $this->assertEquals(['RDM' => -340, 'RDA' => 0], $svc->porTipo($c->fresh(), $this->saldo($c)), 'a mesma conta da ficha: gasto inteiro, recarga fora');

        $ss = app(RelatorioRdmRda::class)->gerar($c->fresh(), self::ANO);
        $this->assertEquals(-340, $this->valor($ss, 'BANCO DE DADOS', 'B11'));
        $ss->disconnectWorksheets();
        $this->assertStringContainsString('R$ -340,00', app(RelatorioRdmRdaPdf::class)->html($c->fresh(), self::ANO));
    }

    public function test_recarga_de_quem_saiu_do_cv_nao_vira_recebido_na_planilha(): void
    {
        $c = $this->pessoa('Beto');
        $this->repasse($c, 'RDM', 900, 'recarga');
        $this->repasse($c, 'RDM', 100, null);

        $ss = app(RelatorioRdmRda::class)->gerar($c->fresh(), self::ANO);
        $this->assertEquals(100, $this->valor($ss, 'BANCO DE DADOS', 'B7'), 'é o número da tela Arquivos');
        $ss->disconnectWorksheets();
        $this->assertStringNotContainsString('R$ 1.000,00', app(RelatorioRdmRdaPdf::class)->html($c->fresh(), self::ANO));
    }

    /* ── Arquivos ─────────────────────────────────────────────── */

    public function test_arquivos_cv_inclui_o_anterior_no_cartao_e_escreve_cada_anterior(): void
    {
        $gestor = $this->pessoa('Gestora', 'rdm_rda', 'gestor');
        $c = $this->cvDoisAnos();

        $s = $this->resumo($gestor, $c);
        $this->assertEquals(-300, $s['cartao_anterior']);
        $this->assertEquals(100, $s['cartao_saldo'], '−300 + 500 − 100');
        $this->assertEquals(100, $s['cartao_gasto'], 'o gasto segue sendo o do ano');
        $this->assertEquals(150, $s['rdm_anterior'], 'no sinal de deve: positivo = a empresa deve');
        $this->assertEquals(-60, $s['rda_anterior']);
        $this->assertEquals(90, $s['deve_anterior']);
        $this->assertEquals(130, $s['deve'], '240 + 40 do bolso − 120 + 30 repassados');
    }

    public function test_arquivos_rdm_rda_escreve_o_anterior_de_cada_tipo(): void
    {
        $gestor = $this->pessoa('Gestora', 'rdm_rda', 'gestor');
        $c = $this->rdmDoisAnos();

        $s = $this->resumo($gestor, $c);
        $this->assertEquals(250, $s['rdm_anterior']);
        $this->assertEquals(-300, $s['rda_anterior']);
        $this->assertEquals(250, $s['deve_anterior'], 'crédito de um tipo não paga a dívida do outro');
        $this->assertEquals(-150, $s['rdm'], '250 + 200 − 600');
        $this->assertEquals(-270, $s['rda'], '−300 + 80 − 50');
        $this->assertNull($s['cartao_anterior']);
    }

    public function test_arquivos_sem_historico_tem_o_numero_de_antes(): void
    {
        $gestor = $this->pessoa('Gestora', 'rdm_rda', 'gestor');
        $c = $this->pessoa('Nova', 'cv');
        $this->repasse($c, 'RDM', 1000, 'recarga');
        $this->nota($c, 'RDM', 300, 'cartao');

        $s = $this->resumo($gestor, $c);
        $this->assertEquals(0, $s['cartao_anterior']);
        $this->assertEquals(700, $s['cartao_saldo']);
    }

    public function test_arquivos_em_ano_antigo_nao_ve_o_futuro(): void
    {
        $gestor = $this->pessoa('Gestora', 'rdm_rda', 'gestor');
        $c = $this->cvDoisAnos();

        $s = $this->resumo($gestor, $c, 2025);
        $this->assertEquals(0, $s['cartao_anterior']);
        $this->assertEquals(-300, $s['cartao_saldo']);
        $this->assertEquals(1300, $s['cartao_gasto']);
    }

    /* ── Planilha C.V. ────────────────────────────────────────── */

    public function test_planilha_cv_calcula_saldo_final_com_o_anterior(): void
    {
        $ss = app(RelatorioCv::class)->gerar($this->cvDoisAnos(), self::ANO);
        $bd = 'BANCO DE DADOS';

        $this->assertSame('SALDO DO ANO ANTERIOR (CARTÃO)', $ss->getSheetByName($bd)->getCell('I6')->getValue());
        $this->assertEquals(-300, $this->valor($ss, $bd, 'I7'));
        $this->assertEquals(100, $this->valor($ss, $bd, 'B11'), 'saldo do cartão: −300 + 500 − 100');
        $this->assertSame('SALDO DO ANO ANTERIOR RDM', $ss->getSheetByName($bd)->getCell('I12')->getValue());
        $this->assertSame('SALDO DO ANO ANTERIOR RDA', $ss->getSheetByName($bd)->getCell('L12')->getValue());
        $this->assertEquals(-150, $this->valor($ss, $bd, 'J12'));
        $this->assertEquals(60, $this->valor($ss, $bd, 'M12'));
        $this->assertEquals(165, $this->valor($ss, $bd, 'J13'), 'reembolso RDM: 40 − 25 + 150 que vieram');
        $this->assertEquals(-35, $this->valor($ss, $bd, 'M13'), 'reembolso RDA: 30 − 5 − 60 de crédito');

        foreach (['CARTÃO CORPORATIVO' => [-300, 100], 'CV REEMBOLSO' => [-90, -130]] as $aba => [$anterior, $saldo]) {
            $this->assertSame('SALDO DO ANO ANTERIOR', $ss->getSheetByName($aba)->getCell('L1')->getValue(), $aba);
            $this->assertEquals($anterior, $this->valor($ss, $aba, 'P1'), $aba);
            $this->assertEquals($saldo, $this->valor($ss, $aba, 'P2'), $aba);
        }
        $ss->disconnectWorksheets();
    }

    public function test_planilha_cv_bate_com_o_pdf_e_com_arquivos(): void
    {
        $gestor = $this->pessoa('Gestora', 'rdm_rda', 'gestor');
        $c = $this->cvDoisAnos();
        $ss = app(RelatorioCv::class)->gerar($c, self::ANO);
        $html = app(RelatorioCvPdf::class)->html($c, self::ANO);

        $this->assertEquals($this->resumo($gestor, $c)['cartao_saldo'], $this->valor($ss, 'BANCO DE DADOS', 'B11'));
        $this->assertEquals(0 - $this->resumo($gestor, $c)['deve'], $this->valor($ss, 'CV REEMBOLSO', 'P2'));
        $ss->disconnectWorksheets();

        $this->assertStringContainsString('<b>SALDO DO ANO ANTERIOR (CARTÃO)</b><br><span class="big vermelho">R$ -300,00', $html);
        $this->assertStringContainsString('<b>SALDO DO ANO ANTERIOR (REEMBOLSO)</b><br><span class="big vermelho">R$ -90,00', $html);
        $this->assertStringContainsString('RDM R$ -150,00 · RDA R$ 60,00', $html);
        $this->assertStringContainsString('<b>SALDO DE C.V. RECEBIDO</b><br><span class="big ">R$ 100,00', $html);
        $this->assertStringContainsString('REEMBOLSO RDM DE: <span class="num">R$ 165,00', $html);
        $this->assertStringContainsString('REEMBOLSO RDA DE: <span class="num">R$ -35,00', $html);
        $this->assertStringContainsString('SALDO DO ANO ANTERIOR RDM</td><td class="num">R$ -150,00', $html);
        $this->assertStringContainsString('<b>SALDO DO ANO ANTERIOR</b> <span class="vermelho">R$ -300,00</span></td><td><b>SALDO</b> <span class="">R$ 100,00', $html);
        $this->assertStringContainsString('<b>SALDO DO ANO ANTERIOR</b> <span class="vermelho">R$ -90,00</span></td><td><b>SALDO</b> <span class="vermelho">R$ -130,00', $html);
    }

    /* Bug achado ao bater os dois: o SALDO DE C.V. do PDF descontava também o gasto do bolso, e o Excel (B9) só o do cartão. */
    public function test_saldo_de_cv_do_pdf_desconta_so_o_cartao_como_o_excel(): void
    {
        $c = $this->pessoa('Ana', 'cv');
        $this->repasse($c, 'RDM', 500, 'recarga');
        $this->nota($c, 'RDM', 100, 'cartao');
        $this->nota($c, 'RDM', 40, 'carteira');
        $ss = app(RelatorioCv::class)->gerar($c->fresh(), self::ANO);

        $this->assertEquals(400, $this->valor($ss, 'BANCO DE DADOS', 'B11'));
        $ss->disconnectWorksheets();
        $this->assertStringContainsString('<b>SALDO DE C.V. RECEBIDO</b><br><span class="big ">R$ 400,00', app(RelatorioCvPdf::class)->html($c->fresh(), self::ANO));
    }

    public function test_planilha_cv_sem_historico_tem_o_numero_de_antes_e_a_linha_escrita(): void
    {
        $c = $this->pessoa('Nova', 'cv');
        $this->repasse($c, 'RDM', 500, 'recarga');
        $this->nota($c, 'RDM', 100, 'cartao');
        $this->nota($c, 'RDM', 40, 'carteira');
        $this->repasse($c, 'RDM', 15, 'carteira');
        $ss = app(RelatorioCv::class)->gerar($c->fresh(), self::ANO);

        $this->assertEquals(0, $this->valor($ss, 'BANCO DE DADOS', 'I7'));
        $this->assertEquals(400, $this->valor($ss, 'BANCO DE DADOS', 'B11'));
        $this->assertEquals(25, $this->valor($ss, 'BANCO DE DADOS', 'J13'));
        $this->assertEquals(400, $this->valor($ss, 'CARTÃO CORPORATIVO', 'P2'));
        $this->assertEquals(-25, $this->valor($ss, 'CV REEMBOLSO', 'P2'));
        $ss->disconnectWorksheets();
    }

    public function test_planilha_cv_em_ano_antigo_nao_conta_o_ano_seguinte(): void
    {
        $ss = app(RelatorioCv::class)->gerar($this->cvDoisAnos(), 2025);

        $this->assertEquals(0, $this->valor($ss, 'BANCO DE DADOS', 'I7'));
        $this->assertEquals(-300, $this->valor($ss, 'BANCO DE DADOS', 'B11'));
        $ss->disconnectWorksheets();
    }

    public function test_planilha_cv_salva_e_reaberta_calcula_igual(): void
    {
        $svc = app(RelatorioCv::class);
        $ss = $svc->gerar($this->cvDoisAnos(), self::ANO);
        $arq = tempnam(sys_get_temp_dir(), 'cv').'.xlsx';
        $svc->xlsx($ss, $arq);
        $ss->disconnectWorksheets();

        $lido = IOFactory::load($arq);
        $this->assertEquals(100, $this->valor($lido, 'BANCO DE DADOS', 'B11'));
        $this->assertEquals(-130, $this->valor($lido, 'CV REEMBOLSO', 'P2'));
        $this->assertTrue(isset($lido->getSheetByName('CV REEMBOLSO')->getMergeCells()['L1:O1']));
        $lido->disconnectWorksheets();
        @unlink($arq);
    }

    public function test_quem_nao_e_do_cartao_na_planilha_cv_soma_rdm_e_rda(): void
    {
        $ss = app(RelatorioCv::class)->gerar($this->rdmDoisAnos(), self::ANO);

        $this->assertSame('SALDO DO ANO ANTERIOR', $ss->getSheetByName('BANCO DE DADOS')->getCell('I6')->getValue());
        $this->assertEquals(50, $this->valor($ss, 'BANCO DE DADOS', 'I7'), '−250 + 300');
        $this->assertEquals(-250, $this->valor($ss, 'BANCO DE DADOS', 'J12'));
        $this->assertEquals(300, $this->valor($ss, 'BANCO DE DADOS', 'M12'));
        $ss->disconnectWorksheets();
    }

    /* ── Planilha RDM/RDA ─────────────────────────────────────── */

    public function test_planilha_rdm_rda_calcula_saldo_final_com_o_anterior(): void
    {
        $c = $this->rdmDoisAnos();
        $ss = app(RelatorioRdmRda::class)->gerar($c, self::ANO);
        $bd = $ss->getSheetByName('BANCO DE DADOS');

        $this->assertSame('SALDO DO ANO ANTERIOR RDM', $bd->getCell('L13')->getValue());
        $this->assertSame('SALDO DO ANO ANTERIOR RDA', $bd->getCell('L14')->getValue());
        $this->assertEquals(-250, $this->valor($ss, 'BANCO DE DADOS', 'S13'));
        $this->assertEquals(300, $this->valor($ss, 'BANCO DE DADOS', 'S14'));
        $this->assertEquals(150, $this->valor($ss, 'BANCO DE DADOS', 'B11'), 'RDM: −250 + 600 − 200');
        $this->assertEquals(270, $this->valor($ss, 'BANCO DE DADOS', 'F11'), 'RDA: 300 + 50 − 80');

        $this->assertSame('SALDO DO ANO ANTERIOR', $bd->getCell('F29')->getValue());
        $this->assertEquals(300, $this->valor($ss, 'BANCO DE DADOS', 'H29'));
        $this->assertSame('SALDO', $bd->getCell('F30')->getValue());
        $this->assertEquals(270, $this->valor($ss, 'BANCO DE DADOS', 'H30'));
        $this->assertEquals(50, $this->valor($ss, 'BANCO DE DADOS', 'H27'), 'TOTAL e CONSUMIDO continuam só do ano');
        $this->assertEquals(80, $this->valor($ss, 'BANCO DE DADOS', 'H28'));

        $this->assertSame('SALDO DO ANO ANTERIOR', $ss->getSheetByName('R.D.M.')->getCell('K1')->getValue());
        $this->assertEquals(-250, $this->valor($ss, 'R.D.M.', 'K2'));
        $this->assertEquals(150, $this->valor($ss, 'R.D.M.', 'J2'));
        $ss->disconnectWorksheets();

        $html = app(RelatorioRdmRdaPdf::class)->html($c, self::ANO);
        $this->assertStringContainsString('<b>SALDO DO ANO ANTERIOR RDM</b><br><span class="big vermelho">R$ -250,00', $html);
        $this->assertStringContainsString('<b>SALDO DO ANO ANTERIOR RDA</b><br><span class="big ">R$ 300,00', $html);
        $this->assertStringContainsString('<b>SALDO DE RDM RECEBIDO</b><br><span class="big ">R$ 150,00', $html);
        $this->assertStringContainsString('<b>SALDO DE RDA RECEBIDO</b><br><span class="big ">R$ 270,00', $html);
        $this->assertStringContainsString('<b>SALDO DO ANO ANTERIOR</b> <span class="vermelho">R$ -250,00</span></td><td><b>SALDO</b> <span class="">R$ 150,00', $html);
        $this->assertStringContainsString('<b>SALDO DO ANO ANTERIOR</b> <span class="">R$ 300,00</span></td><td><b>SALDO</b> <span class="">R$ 270,00', $html);
    }

    public function test_planilha_rdm_rda_sem_historico_tem_o_numero_de_antes(): void
    {
        $c = $this->pessoa('Nova');
        $this->repasse($c, 'RDM', 600, null);
        $this->nota($c, 'RDM', 200, null);
        $ss = app(RelatorioRdmRda::class)->gerar($c->fresh(), self::ANO);

        $this->assertEquals(0, $this->valor($ss, 'BANCO DE DADOS', 'S13'));
        $this->assertEquals(400, $this->valor($ss, 'BANCO DE DADOS', 'B11'));
        $this->assertEquals(400, $this->valor($ss, 'R.D.M.', 'J2'));
        $this->assertEquals(0, $this->valor($ss, 'BANCO DE DADOS', 'H30'));
        $ss->disconnectWorksheets();
    }

    public function test_planilha_rdm_rda_com_bloco_aberto_mantem_a_conta(): void
    {
        $c = $this->rdmDoisAnos();
        foreach (range(1, 46) as $_) {   // março tem 44 linhas: o bloco ganha linhas e as fórmulas descem
            $this->nota($c, 'RDM', 1, null);
        }
        $ss = app(RelatorioRdmRda::class)->gerar($c->fresh(), self::ANO);

        $this->assertEquals(104, $this->valor($ss, 'R.D.M.', 'J2'), '−250 + 600 − 246');
        $this->assertEquals(104, $this->valor($ss, 'BANCO DE DADOS', 'B11'));
        $ss->disconnectWorksheets();
    }

    /* Revisão de 04/11/2026: o extrato do RDA tem 12 linhas no modelo e o 13º repasse sumia da planilha, mas não do PDF nem de
       Arquivos. Com parcelas nos dias 5 e 20, 24 repasses no ano é normal: o saldo final deixava de ser o anterior do ano seguinte. */
    public function test_extrato_de_rda_com_24_repasses_nao_perde_nenhum(): void
    {
        $gestor = $this->pessoa('Gestora', 'rdm_rda', 'gestor');
        $c = $this->pessoa('Beto');
        $this->repasse($c, 'RDA', 50, null, 2025);
        foreach (range(1, 24) as $_) {
            $this->repasse($c, 'RDA', 100, null);
        }
        $this->nota($c, 'RDA', 300, null);
        $svc = app(RelatorioRdmRda::class);
        $ss = $svc->gerar($c->fresh(), self::ANO);
        $arq = tempnam(sys_get_temp_dir(), 'rda').'.xlsx';
        $svc->xlsx($ss, $arq);
        $ss->disconnectWorksheets();

        $lido = IOFactory::load($arq);
        $bd = $lido->getSheetByName('BANCO DE DADOS');
        $this->assertEquals(100, $this->valor($lido, 'BANCO DE DADOS', 'H38'), 'o 24º repasse fica na linha 38');
        $this->assertSame('TOTAL', $bd->getCell('F39')->getValue());
        $this->assertEquals(2400, $this->valor($lido, 'BANCO DE DADOS', 'H39'));
        $this->assertSame('CONSUMIDO', $bd->getCell('F40')->getValue());
        $this->assertEquals(300, $this->valor($lido, 'BANCO DE DADOS', 'H40'));
        $this->assertSame('SALDO DO ANO ANTERIOR', $bd->getCell('F41')->getValue());
        $this->assertEquals(50, $this->valor($lido, 'BANCO DE DADOS', 'H41'));
        $this->assertSame('SALDO', $bd->getCell('F42')->getValue());
        $this->assertEquals(2150, $this->valor($lido, 'BANCO DE DADOS', 'H42'));
        $this->assertEquals(2400, $this->valor($lido, 'BANCO DE DADOS', 'F7'));
        $this->assertEquals(2150, $this->valor($lido, 'BANCO DE DADOS', 'F11'));
        $this->assertTrue(isset($bd->getMergeCells()['F38:G38']));
        $this->assertTrue(isset($bd->getMergeCells()['F42:G42']));
        $lido->disconnectWorksheets();
        @unlink($arq);

        $this->assertStringContainsString('<b>SALDO DE RDA RECEBIDO</b><br><span class="big ">R$ 2.150,00', app(RelatorioRdmRdaPdf::class)->html($c->fresh(), self::ANO));
        $this->assertEquals(-2150, $this->resumo($gestor, $c)['rda'], 'Arquivos: mesmo número, no sinal de deve');
        $this->assertEquals(2150, $this->saldo($c, self::ANO + 1)['saldo']['RDA'], 'o saldo final é o anterior do ano seguinte');
    }

    /* Com 1 linha a mais, cada linha do bloco cai em cima da de baixo: é o caso em que a ordem de mover o bloco importa. */
    public function test_extrato_de_rda_com_13_repasses_desce_o_bloco_uma_linha(): void
    {
        $c = $this->pessoa('Beto');
        foreach (range(1, 13) as $_) {
            $this->repasse($c, 'RDA', 10, null);
        }
        $this->nota($c, 'RDA', 30, null);
        $ss = app(RelatorioRdmRda::class)->gerar($c->fresh(), self::ANO);
        $bd = $ss->getSheetByName('BANCO DE DADOS');

        $this->assertEquals(10, $this->valor($ss, 'BANCO DE DADOS', 'H27'), 'a linha 27 virou dado');
        $this->assertSame('TOTAL', $bd->getCell('F28')->getValue());
        $this->assertEquals(130, $this->valor($ss, 'BANCO DE DADOS', 'H28'));
        $this->assertEquals(30, $this->valor($ss, 'BANCO DE DADOS', 'H29'));
        $this->assertEquals(0, $this->valor($ss, 'BANCO DE DADOS', 'H30'));
        $this->assertEquals(100, $this->valor($ss, 'BANCO DE DADOS', 'H31'));
        $this->assertEquals(100, $this->valor($ss, 'BANCO DE DADOS', 'F11'));
        $ss->disconnectWorksheets();
    }

    /* O extrato do RDM tem 80 linhas e divide as linhas com o do RDA: não abre. O que passar disso ao menos não some calado. */
    public function test_repasse_rdm_que_nao_cabe_no_extrato_avisa_no_cabecalho(): void
    {
        $c = $this->pessoa('Beto');
        foreach (range(1, 81) as $_) {
            $this->repasse($c, 'RDM', 10, null);
        }
        $ss = app(RelatorioRdmRda::class)->gerar($c->fresh(), self::ANO);

        $this->assertStringContainsString('1 repasse(s) de RDM', (string) $ss->getSheetByName('CABEÇALHO')->getCell('A10')->getValue());
        $ss->disconnectWorksheets();
    }

    /* ── Arquivo único da equipe ──────────────────────────────── */

    /* Revisão de 04/11/2026: a seleção olhava só o ano, e quem só carrega saldo (janeiro, quase todo mundo) ficava fora do
       RESUMO, que saía menor que a dívida real. O PDF da equipe já fazia assim: quem só carrega saldo aparece. */
    public function test_planilhas_da_equipe_trazem_quem_so_carrega_saldo(): void
    {
        $gestor = $this->pessoa('Gestora', 'rdm_rda', 'gestor');
        $ativo = $this->pessoa('Ativo');
        $this->nota($ativo, 'RDM', 10, null);
        $this->nota($this->pessoa('SoCarrega'), 'RDM', 5000, null, 2025);
        $zerado = $this->pessoa('Zerado');
        $this->nota($zerado, 'RDM', 100, null, 2025);
        $this->repasse($zerado, 'RDM', 100, null, 2025);

        Sanctum::actingAs($gestor);
        $arq = $this->get('/api/relatorio/cv-equipe?ano=2026&modo=unico')->assertOk()->baseResponse->getFile()->getPathname();

        $lido = IOFactory::load($arq);
        $linhas = $lido->getSheetByName('RESUMO')->toArray(null, false, false);
        $lido->disconnectWorksheets();
        @unlink($arq);
        $this->assertStringContainsString('2 colaborador(es)', $linhas[1][0]);
        $this->assertEquals(-5000, collect($linhas)->firstWhere(0, 'SoCarrega')[7]);
        $this->assertNull(collect($linhas)->firstWhere(0, 'Zerado'), 'saldo zerado não é motivo para gerar planilha vazia');
    }

    public function test_quem_carrega_saldo_olha_cada_conta_do_regime_atual(): void
    {
        $tipos = $this->pessoa('Tipos');                 // +100 no RDA e −100 no RDM não se anulam
        $this->repasse($tipos, 'RDA', 100, null, 2025);
        $this->nota($tipos, 'RDM', 100, null, 2025);
        $cartao = $this->pessoa('Cartao', 'cv');         // só o cartão
        $this->repasse($cartao, 'RDM', 100, 'recarga', 2025);
        $recarga = $this->pessoa('Saiu');                // recarga antiga de quem hoje é RDM/RDA não é saldo dele
        $this->repasse($recarga, 'RDM', 100, 'recarga', 2025);
        $novo = $this->pessoa('Novo');                   // o ano em foco não é anterior
        $this->nota($novo, 'RDM', 100, null);

        $ids = app(SaldoAnterior::class)->quemCarrega(self::ANO);
        sort($ids);
        $esperado = [$tipos->id, $cartao->id];
        sort($esperado);
        $this->assertSame($esperado, $ids);
    }

    /* Revisão de 04/11/2026: no RESUMO a recarga de quem está no RDM/RDA caía em Recebido, e o Saldo não fechava com a aba dele. */
    public function test_resumo_nao_conta_recarga_como_recebido_de_quem_e_rdm_rda(): void
    {
        $gestor = $this->pessoa('Gestora', 'rdm_rda', 'gestor');
        $beto = $this->pessoa('Beto');
        $this->repasse($beto, 'RDM', 900, 'recarga');
        $this->repasse($beto, 'RDM', 100, null);
        $this->nota($beto, 'RDM', 50, null);
        $ana = $this->pessoa('Ana', 'cv');
        $this->repasse($ana, 'RDM', 500, 'recarga');
        $this->nota($ana, 'RDM', 40, 'cartao');

        $ss = new Spreadsheet();
        $ss->removeSheetByIndex(0);
        app(RelatorioCv::class)->abaResumo($ss, [$ana->fresh(), $beto->fresh()], self::ANO);
        $linhas = collect($ss->getSheetByName('RESUMO')->toArray(null, true, false));
        $ss->disconnectWorksheets();

        /* colunas: 6 Recebido, 7 Recargas do cartão, 9 Cartão: saldo, 13 RDM/RDA: saldo */
        $this->assertEquals(100, $linhas->firstWhere(0, 'Beto')[6]);
        $this->assertEquals(50, $linhas->firstWhere(0, 'Beto')[13]);
        $this->assertEquals(0, $linhas->firstWhere(0, 'Ana')[6], 'desde 04/11/2026 a recarga do C.V. tem coluna própria');
        $this->assertEquals(500, $linhas->firstWhere(0, 'Ana')[7]);
        $this->assertEquals(460, $linhas->firstWhere(0, 'Ana')[9]);
        $this->assertEquals(100, $linhas->firstWhere(0, 'Mar')[6], 'o quadro por mês usa o mesmo recebido');
        $this->assertEquals(500, $linhas->firstWhere(0, 'Mar')[7], 'e a mesma recarga');

        $ss = app(RelatorioRdmRda::class)->gerar($beto->fresh(), self::ANO);
        $this->assertEquals(50, $this->valor($ss, 'BANCO DE DADOS', 'B11'), 'fecha com a planilha dele');
        $ss->disconnectWorksheets();
        $this->assertEquals(-50, $this->resumo($gestor, $beto)['rdm'], 'e com Arquivos');
    }

    public function test_arquivo_da_equipe_mantem_as_contas_e_o_resumo_soma_o_anterior_conta_por_conta(): void
    {
        $cv = $this->cvDoisAnos();
        $rdm = $this->rdmDoisAnos();
        $ss = app(RelatorioCv::class)->gerarUnico([$cv, $rdm], self::ANO);

        $this->assertEquals(100, $this->valor($ss, 'Ana_BANCO DE DADOS', 'B11'));
        $this->assertEquals(-90, $this->valor($ss, 'Ana_CV REEMBOLSO', 'P1'));
        $this->assertEquals(-130, $this->valor($ss, 'Ana_CV REEMBOLSO', 'P2'));
        $this->assertEquals(-250, $this->valor($ss, 'Beto_R.D.M.', 'K2'));
        $this->assertEquals(150, $this->valor($ss, 'Beto_R.D.M.', 'J2'));
        $this->assertEquals(150, $this->valor($ss, 'Beto_BANCO DE DADOS', 'B11'));
        $this->assertEquals(270, $this->valor($ss, 'Beto_BANCO DE DADOS', 'F11'));

        /* 04/11/2026: cada conta na sua coluna, nos números das abas acima. Quadro 1: 8/9 cartão, 10/11 reembolso, 12/13 RDM/RDA (anterior/saldo) */
        $linhas = $ss->getSheetByName('RESUMO')->toArray(null, true, false);
        $ana = collect($linhas)->firstWhere(0, 'Ana');
        $beto = collect($linhas)->firstWhere(0, 'Beto');
        $this->assertContains('Cartão C.V.: saldo do ano anterior', $linhas[4]);
        $this->assertEquals(-300, $ana[8]);
        $this->assertEquals(100, $ana[9]);
        $this->assertEquals(-90, $ana[10]);
        $this->assertEquals(-130, $ana[11]);
        $this->assertEquals(50, $beto[12]);
        $this->assertEquals(420, $beto[13]);
        $saldoGeral = collect($linhas)->where(0, 'TOTAL GERAL')->values();
        $this->assertEquals([100, -130, 420], [$saldoGeral[0][9], $saldoGeral[0][11], $saldoGeral[0][13]], 'quadro 1');
        $this->assertEquals([-300, -90, 50], array_slice(collect($linhas)->firstWhere(0, 'Saldo do ano anterior'), 8, 3));
        $this->assertEquals([100, -130, 420], array_slice($saldoGeral[1], 8, 3), 'quadro 2 fecha com o quadro 1');
        $ss->disconnectWorksheets();
    }
}
