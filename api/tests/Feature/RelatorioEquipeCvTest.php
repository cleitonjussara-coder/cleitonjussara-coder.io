<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use App\Services\RelatorioCv;
use App\Services\RelatorioEquipePdf;
use App\Services\SaldoAnterior;
use Dompdf\Dompdf;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use Tests\TestCase;

/**
 * 04/11/2026, decisão do dono: no C.V. o PDF da equipe mostra Cartão e Reembolso separados, com os números da planilha e
 * de Arquivos. Antes mostrava recebido − gasto sem a recarga (−2.593,73 contra cartão −34,15 e reembolso −158,33), uma dívida
 * que não existe. O corte é o fim do mês do relatório. RDM/RDA continua como estava.
 */
class RelatorioEquipeCvTest extends TestCase
{
    use RefreshDatabase;

    private const ANO = 2026;

    private function pessoa(string $nome, string $regime = 'cv', string $role = 'colaborador'): Colaborador
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

    private function nota(Colaborador $c, int $ano, int $mes, float $valor, string $tipo = 'RDM', ?string $pagamento = null, bool $deleted = false): void
    {
        (new Nota(['id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => $tipo, 'subtipo' => $tipo === 'RDA' ? 'Alimentação' : 'Outros', 'valor' => $valor,
            'data' => sprintf('%d-%02d-10', $ano, $mes), 'mes' => $mes, 'ano' => $ano, 'razao_social' => 'Fornecedor', 'pagamento' => $pagamento, 'deleted' => $deleted]))->save();
    }

    private function repasse(Colaborador $c, int $ano, int $mes, float $valor, string $tipo = 'RDM', ?string $destino = null, string $kind = 'received', bool $confirmado = true): void
    {
        $r = new Repasse(['id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => $tipo, 'valor' => $valor,
            'data' => sprintf('%d-%02d-05', $ano, $mes), 'mes' => $mes, 'ano' => $ano, 'kind' => $kind, 'destino' => $destino, 'deleted' => false]);
        $r->forceFill(['confirmado_em' => $confirmado ? now() : null])->save();
    }

    /** Ana: traz cartão −50, reembolso RDM −30 e RDA +20; em outubro fecha com cartão −34,15 e reembolso −158,33. */
    private function ana(): Colaborador
    {
        $c = $this->pessoa('Ana Cartao');
        $this->repasse($c, 2025, 6, 100, 'RDM', 'recarga');
        $this->nota($c, 2025, 7, 150, 'RDM', 'cartao');
        $this->nota($c, 2025, 7, 30, 'RDM', 'carteira');
        $this->repasse($c, 2025, 8, 20, 'RDA');

        $this->repasse($c, self::ANO, 2, 2000, 'RDM', 'recarga');
        $this->nota($c, self::ANO, 3, 1500, 'RDM', 'cartao');
        $this->nota($c, self::ANO, 10, 300.10, 'RDA', null);          // sem pagamento gravado = cartão
        $this->repasse($c, self::ANO, 10, 200, 'RDA', 'recarga');
        $this->nota($c, self::ANO, 10, 384.05, 'RDM', 'cartao');
        $this->nota($c, self::ANO, 4, 100, 'RDM', 'carteira');
        $this->nota($c, self::ANO, 10, 88.33, 'RDA', 'carteira');
        $this->repasse($c, self::ANO, 10, 40, 'RDM');

        return $c;
    }

    public function test_cv_mostra_cartao_e_reembolso_e_nao_o_saldo_sem_recarga(): void
    {
        $c = $this->ana();

        $conta = (new RelatorioEquipePdf)->contasCv(self::ANO, 10)[$c->id];
        $this->assertEqualsWithDelta(-50.0, $conta['anterior']['cartao'], 0.001);
        $this->assertEqualsWithDelta(-34.15, $conta['saldo']['cartao'], 0.001);
        $this->assertEqualsWithDelta(-30.0, $conta['anterior']['reembolso']['RDM'], 0.001);
        $this->assertEqualsWithDelta(20.0, $conta['anterior']['reembolso']['RDA'], 0.001);
        $this->assertEqualsWithDelta(-90.0, $conta['saldo']['reembolso']['RDM'], 0.001);
        $this->assertEqualsWithDelta(-68.33, $conta['saldo']['reembolso']['RDA'], 0.001);

        $html = (new RelatorioEquipePdf)->html(self::ANO, 10);
        $this->assertStringContainsString('R$ -34,15', $html);
        $this->assertStringContainsString('R$ -158,33', $html);
        $this->assertStringContainsString('Saldo do ano anterior', $html);
        // a conta antiga: anterior −60 + 40 recebido − 772,48 do mês
        $this->assertStringNotContainsString('R$ -792,48', $html, 'o saldo sem recarga não pode voltar');
        $this->assertStringNotContainsString('fora do saldo', $html, 'a recarga entra no cartão');
    }

    public function test_corte_e_o_fim_do_mes_do_relatorio(): void
    {
        $c = $this->pessoa('Bia Corte');
        $this->repasse($c, self::ANO, 3, 500, 'RDM', 'recarga');
        $this->nota($c, self::ANO, 5, 100, 'RDM', 'cartao');
        $this->nota($c, self::ANO, 5, 10, 'RDA', 'carteira');
        // tudo depois de maio fica fora do relatório de maio
        $this->nota($c, self::ANO, 6, 77, 'RDM', 'cartao');
        $this->nota($c, self::ANO, 6, 11, 'RDA', 'carteira');
        $this->repasse($c, self::ANO, 6, 99, 'RDM', 'recarga');
        $this->repasse($c, self::ANO, 6, 5, 'RDA');

        $maio = (new RelatorioEquipePdf)->contasCv(self::ANO, 5)[$c->id];
        $this->assertEqualsWithDelta(400.0, $maio['saldo']['cartao'], 0.001);
        $this->assertEqualsWithDelta(-10.0, $maio['saldo']['reembolso']['RDA'], 0.001);

        $abril = (new RelatorioEquipePdf)->contasCv(self::ANO, 4)[$c->id];
        $this->assertEqualsWithDelta(500.0, $abril['saldo']['cartao'], 0.001);
        $this->assertEqualsWithDelta(0.0, $abril['saldo']['reembolso']['RDA'], 0.001);

        $this->assertEquals((new SaldoAnterior)->deTodos(self::ANO + 1)[$c->id], (new SaldoAnterior)->ateMes(self::ANO, 12)[$c->id], 'dezembro é o mesmo que pedir o anterior do ano seguinte');
    }

    public function test_dezembro_bate_com_planilha_arquivos_e_resumo(): void
    {
        $gestor = $this->pessoa('Gestora', 'rdm_rda', 'gestor');
        $c = $this->ana();
        $conta = (new RelatorioEquipePdf)->contasCv(self::ANO, 12)[$c->id];

        Sanctum::actingAs($gestor);
        $arq = collect($this->getJson('/api/arquivos/resumo?ano='.self::ANO)->assertOk()->json('colaboradores'))->firstWhere('user_id', $c->id)['saldo'];
        $this->assertEqualsWithDelta($arq['cartao_saldo'], $conta['saldo']['cartao'], 0.001);
        $this->assertEqualsWithDelta($arq['cartao_anterior'], $conta['anterior']['cartao'], 0.001);
        $this->assertEqualsWithDelta(-$arq['deve'], $conta['saldo']['reembolsoTotal'], 0.001);
        $this->assertEqualsWithDelta(-$arq['deve_anterior'], $conta['anterior']['reembolsoTotal'], 0.001);

        $ss = app(RelatorioCv::class)->gerar($c->fresh(), self::ANO);
        $bd = $ss->getSheetByName('BANCO DE DADOS');
        $reemb = $ss->getSheetByName('CV REEMBOLSO');
        $this->assertEqualsWithDelta($bd->getCell('I7')->getCalculatedValue(), $conta['anterior']['cartao'], 0.001);
        $this->assertEqualsWithDelta($bd->getCell('B11')->getCalculatedValue(), $conta['saldo']['cartao'], 0.001);
        $this->assertEqualsWithDelta($bd->getCell('J12')->getCalculatedValue(), $conta['anterior']['reembolso']['RDM'], 0.001);
        $this->assertEqualsWithDelta($bd->getCell('M12')->getCalculatedValue(), $conta['anterior']['reembolso']['RDA'], 0.001);
        $this->assertEqualsWithDelta($reemb->getCell('P1')->getCalculatedValue(), $conta['anterior']['reembolsoTotal'], 0.001);
        $this->assertEqualsWithDelta($reemb->getCell('P2')->getCalculatedValue(), $conta['saldo']['reembolsoTotal'], 0.001);
        $ss->disconnectWorksheets();

        // o RESUMO do arquivo único traz as duas contas, cada uma com o número da planilha
        [$linhas, $col] = $this->resumo([$c->fresh()]);
        $linha = $linhas->firstWhere(0, 'Ana Cartao');
        $this->assertEqualsWithDelta($conta['anterior']['cartao'], $linha[$col('Cartão C.V.: saldo do ano anterior')], 0.001);
        $this->assertEqualsWithDelta($conta['saldo']['cartao'], $linha[$col('Cartão C.V.: saldo')], 0.001);
        $this->assertEqualsWithDelta($conta['anterior']['reembolsoTotal'], $linha[$col('Reembolso C.V.: saldo do ano anterior')], 0.001);
        $this->assertEqualsWithDelta($conta['saldo']['reembolsoTotal'], $linha[$col('Reembolso C.V.: saldo')], 0.001);
    }

    /** As linhas do RESUMO e um localizador de coluna do quadro 1, pelo título. */
    private function resumo(iterable $colabs): array
    {
        $ss = new Spreadsheet;
        $ss->removeSheetByIndex(0);
        app(RelatorioCv::class)->abaResumo($ss, $colabs, self::ANO);
        $linhas = collect($ss->getSheetByName('RESUMO')->toArray(null, true, false));
        $ss->disconnectWorksheets();
        $titulos = $linhas->firstWhere(0, 'Colaborador');

        return [$linhas, function (string $titulo) use ($titulos) {
            $i = array_search($titulo, $titulos, true);
            $this->assertNotFalse($i, "coluna {$titulo}");

            return $i;
        }];
    }

    /* Revisão de 04/11/2026: o RESUMO somava cartão e reembolso num Saldo só, e o crédito do cartão escondia o reembolso que a
       empresa deve; o TOTAL GERAL ainda juntava C.V. com RDM/RDA. */
    public function test_resumo_separa_as_contas_e_nao_mistura_regimes(): void
    {
        $ana = $this->pessoa('Ana Cv');
        $this->repasse($ana, self::ANO, 2, 500, 'RDM', 'recarga');
        $this->nota($ana, self::ANO, 3, 80, 'RDM', 'carteira');
        $rui = $this->pessoa('Rui Rdm', 'rdm_rda');
        $this->nota($rui, self::ANO, 3, 1000);

        [$linhas, $col] = $this->resumo([$ana->fresh(), $rui->fresh()]);
        $a = $linhas->firstWhere(0, 'Ana Cv');
        $r = $linhas->firstWhere(0, 'Rui Rdm');
        $total = $linhas->firstWhere(0, 'TOTAL GERAL');

        $this->assertEquals(500, $a[$col('Cartão C.V.: saldo')]);
        $this->assertEquals(-80, $a[$col('Reembolso C.V.: saldo')], 'a empresa deve, mesmo com crédito no cartão');
        $this->assertNull($a[$col('RDM/RDA: saldo')], 'quem é C.V. não tem esta conta');
        $this->assertEquals(-1000, $r[$col('RDM/RDA: saldo')]);
        $this->assertNull($r[$col('Cartão C.V.: saldo')], 'quem é RDM/RDA não tem cartão');
        $this->assertNull($r[$col('Reembolso C.V.: saldo')]);
        $this->assertEquals(500, $total[$col('Cartão C.V.: saldo')], 'total só de cartões');
        $this->assertEquals(-80, $total[$col('Reembolso C.V.: saldo')], 'total só de reembolsos');
        $this->assertEquals(-1000, $total[$col('RDM/RDA: saldo')], 'total só do RDM/RDA');
        $this->assertEquals(0, $a[$col('Recebido')], 'recarga não é dinheiro recebido');
        $this->assertEquals(500, $a[$col('Recargas do cartão')]);
        $this->assertNotContains('Saldo', $linhas->firstWhere(0, 'Colaborador'), 'não existe mais uma coluna que some tudo');
        $this->assertStringContainsString('não se somam', $linhas[1][0]);
        $this->assertStringNotContainsString('a reembolsar', $linhas[1][0]);
    }

    public function test_resumo_por_mes_fecha_conta_por_conta_com_o_quadro_por_colaborador(): void
    {
        $c = $this->ana();
        $r = $this->pessoa('Rui Rdm', 'rdm_rda');
        $this->nota($r, 2025, 3, 50);
        $this->nota($r, self::ANO, 3, 1000);
        $this->repasse($r, self::ANO, 3, 300);

        [$linhas, $col] = $this->resumo([$c->fresh(), $r->fresh()]);
        $q1 = $linhas->firstWhere(0, 'TOTAL GERAL');
        $titulos2 = $linhas->firstWhere(0, 'Mês');
        $anterior = $linhas->firstWhere(0, 'Saldo do ano anterior');
        $meses = $linhas->filter(fn ($l) => in_array($l[0], ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'], true));

        foreach (['RDM/RDA' => -750.0, 'Cartão C.V.' => -34.15, 'Reembolso C.V.' => -158.33] as $conta => $saldo) {
            $i = array_search("{$conta}: saldo", $titulos2, true);
            $this->assertNotFalse($i, $conta);
            $this->assertEqualsWithDelta($saldo, $q1[$col("{$conta}: saldo")], 0.001, $conta);
            $this->assertEqualsWithDelta($q1[$col("{$conta}: saldo do ano anterior")], $anterior[$i], 0.001, $conta);
            $this->assertEqualsWithDelta($saldo, $anterior[$i] + $meses->sum(fn ($l) => $l[$i]), 0.001, "{$conta}: meses + anterior");
        }
    }

    public function test_resumo_mostra_o_sentido_por_extenso_nos_saldos(): void
    {
        $c = $this->pessoa('Edu Sinais');
        $this->repasse($c, self::ANO, 2, 500, 'RDM', 'recarga');
        $this->nota($c, self::ANO, 3, 80, 'RDM', 'carteira');

        $ss = new Spreadsheet;
        $ss->removeSheetByIndex(0);
        app(RelatorioCv::class)->abaResumo($ss, [$c->fresh()], self::ANO);
        $ws = $ss->getSheetByName('RESUMO');
        $linha = collect(range(1, 20))->first(fn ($r) => $ws->getCell([1, $r])->getValue() === 'Edu Sinais');
        $junto = implode(' | ', array_map(fn ($i) => $ws->getCell([$i, $linha])->getFormattedValue(), range(8, 14)));
        $ss->disconnectWorksheets();

        $this->assertStringContainsString('a favor da empresa', $junto, $junto);
        $this->assertStringContainsString('a empresa deve', $junto, $junto);
    }

    public function test_resumo_sem_ninguem_do_cv_continua_igual(): void
    {
        $r = $this->pessoa('Rui Rdm', 'rdm_rda');
        $this->nota($r, 2025, 3, 50);
        $this->nota($r, self::ANO, 3, 1000);
        $this->repasse($r, self::ANO, 3, 300);
        $this->repasse($r, self::ANO, 3, 999, 'RDM', 'recarga');

        [$linhas] = $this->resumo([$r->fresh()]);

        $this->assertSame(['Colaborador', 'Abastecimento', 'Hospedagem', 'Alimentação (RDA)', 'Outros', 'Total gasto', 'Recebido', 'Saldo do ano anterior', 'Saldo'], array_slice($linhas->firstWhere(0, 'Colaborador'), 0, 9));
        $this->assertNull($linhas->firstWhere(0, 'Colaborador')[9], 'nenhuma coluna a mais');
        $this->assertSame([1000.0, 300.0, -50.0, -750.0], array_map('floatval', array_slice($linhas->firstWhere(0, 'Rui Rdm'), 5, 4)));
        $this->assertSame(['Mês', 'Abastecimento', 'Hospedagem', 'Alimentação (RDA)', 'Outros', 'Total gasto', 'Recebido', 'Saldo'], array_slice($linhas->firstWhere(0, 'Mês'), 0, 8));
        $this->assertEquals(-50, $linhas->firstWhere(0, 'Saldo do ano anterior')[7]);
        $this->assertStringContainsString('negativo = a reembolsar', $linhas[1][0]);
    }

    public function test_quem_so_carrega_saldo_de_cartao_aparece(): void
    {
        $so = $this->pessoa('Caio Credito');
        $this->repasse($so, 2025, 6, 100, 'RDM', 'recarga');   // no ano passado só recarregou: reembolso zero, cartão +100
        $nada = $this->pessoa('Nina Zerada');
        $this->repasse($nada, 2025, 6, 100, 'RDM', 'recarga');
        $this->nota($nada, 2025, 7, 100, 'RDM', 'cartao');     // zerou: não carrega nada

        $html = (new RelatorioEquipePdf)->html(self::ANO, 10);

        $this->assertStringContainsString('Caio Credito', $html);
        $this->assertStringContainsString('sem lançamento no mês', $html);
        $this->assertStringContainsString('R$ 100,00', $html);
        $this->assertStringNotContainsString('Nina Zerada', $html);
    }

    public function test_faturamento_apagado_e_pedido_pendente_ficam_fora_das_contas(): void
    {
        $c = $this->pessoa('Davi Fora');
        $this->repasse($c, self::ANO, 2, 100, 'RDM', 'recarga');
        $this->nota($c, self::ANO, 3, 900, 'RDM', 'empresa');
        $this->nota($c, self::ANO, 3, 800, 'RDM', 'cartao', true);
        $this->nota($c, self::ANO, 3, 700, 'RDA', 'carteira', true);
        $this->repasse($c, self::ANO, 3, 600, 'RDM', null, 'requested', false);

        $conta = (new RelatorioEquipePdf)->contasCv(self::ANO, 3)[$c->id];

        $this->assertEqualsWithDelta(100.0, $conta['saldo']['cartao'], 0.001);
        $this->assertEqualsWithDelta(0.0, $conta['saldo']['reembolsoTotal'], 0.001);
    }

    public function test_sinais_diferentes_vem_com_o_sentido_por_extenso(): void
    {
        $c = $this->pessoa('Edu Sinais');
        $this->repasse($c, self::ANO, 2, 500, 'RDM', 'recarga');   // cartão +500: a favor da empresa
        $this->nota($c, self::ANO, 3, 80, 'RDM', 'carteira');      // reembolso −80: a empresa deve

        $html = (new RelatorioEquipePdf)->html(self::ANO, 3);

        $this->assertStringContainsString('a favor da empresa', $html);
        $this->assertStringContainsString('a empresa deve', $html);
    }

    public function test_totais_nao_misturam_contas_nem_regimes(): void
    {
        $a = $this->pessoa('Ana Cv');
        $this->repasse($a, self::ANO, 2, 500, 'RDM', 'recarga');
        $this->nota($a, self::ANO, 3, 80, 'RDM', 'carteira');
        $b = $this->pessoa('Beto Cv');
        $this->repasse($b, self::ANO, 2, 30, 'RDM', 'recarga');
        $this->nota($b, self::ANO, 3, 7, 'RDA', 'carteira');
        $r = $this->pessoa('Rui Rdm', 'rdm_rda');
        $this->nota($r, self::ANO, 3, 1000.5);

        $html = (new RelatorioEquipePdf)->html(self::ANO, 3);

        $this->assertStringContainsString('R$ 530,00', $html, 'total do cartão, só cartões');
        $this->assertStringContainsString('R$ -87,00', $html, 'total do reembolso, só reembolsos');
        $this->assertStringContainsString('R$ -1.000,50', $html, 'total do RDM/RDA, sem o C.V.');
        $this->assertStringContainsString('não se somam', $html, 'o PDF diz que as contas são separadas');
        foreach (['R$ 443,00', 'R$ -557,50'] as $misturado) {   // cartão + reembolso; tudo junto
            $this->assertStringNotContainsString($misturado, $html);
        }
    }

    /* Revisão de 04/11/2026: nas páginas seguintes as colunas de valores saíam sem título, e não dava para saber o que era cartão. */
    public function test_quadro_cv_repete_o_cabecalho_em_cada_pagina(): void
    {
        ini_set('memory_limit', '3072M');   // o limite do php da linha de comando é 128M; a suíte completa e o Dompdf passam disso
        for ($i = 0; $i < 14; $i++) {
            $c = $this->pessoa("Colaborador {$i}");
            $this->repasse($c, self::ANO, 10, 1000, 'RDM', 'recarga');
            $this->nota($c, self::ANO, 10, 20, 'RDA', 'carteira');
        }

        // ao terminar o PDF a árvore já foi descartada: anota a página de cada título e de cada pessoa enquanto desenha
        $comTitulo = $comPessoa = [];
        $d = new Dompdf(['isRemoteEnabled' => false, 'defaultFont' => 'DejaVu Sans']);
        $d->setPaper('A4', 'landscape');
        $d->setCallbacks([['event' => 'end_frame', 'f' => function ($f, $canvas) use (&$comTitulo, &$comPessoa) {
            $no = $f->get_node();
            $texto = trim((string) $no->textContent);
            if ($no->nodeName === 'th' && $texto === 'Cartão (R$)') {
                $comTitulo[$canvas->get_page_number()] = true;
            }
            if ($no->nodeName === 'td' && ($texto === 'TOTAL' || (str_starts_with($texto, 'Colaborador ') && str_contains($texto, '@teste.local')))) {
                $comPessoa[$canvas->get_page_number()] = true;   // a linha TOTAL também vale: pode cair sozinha na última página, com título
            }
        }]]);
        $d->loadHtml((new RelatorioEquipePdf)->html(self::ANO, 10));
        $d->render();

        $this->assertGreaterThan(1, count($comPessoa), 'o quadro precisa passar de uma página para o teste valer');
        $this->assertSame(array_keys($comPessoa), array_keys($comTitulo), 'toda página do quadro tem título, e título nunca fica sem pessoa embaixo');
    }

    /* Revisão de 04/11/2026: a frase faltava logo onde sinais diferentes convivem: anterior e parcelas do topo, parcelas do quadro e TOTAL. */
    public function test_sentido_tambem_no_topo_nas_parcelas_e_no_total(): void
    {
        $c = $this->pessoa('Sofia Sinais');
        $this->repasse($c, 2025, 6, 1000, 'RDM', 'recarga');      // cartão anterior +1000
        $this->nota($c, 2025, 7, 50, 'RDM', 'carteira');          // RDM anterior −50
        $this->repasse($c, 2025, 8, 70, 'RDA');                   // RDA anterior +70
        $this->nota($c, self::ANO, 3, 1500, 'RDM', 'cartao');     // cartão −500

        $html = (new RelatorioEquipePdf)->html(self::ANO, 3);

        $topo = substr($html, strpos($html, 'class="kpis'), strpos($html, 'Regime C.V.') - strpos($html, 'class="kpis'));
        $this->assertMatchesRegularExpression('~Saldo do ano anterior<br>.{0,60}R[$] 1[.]000,00.{0,40}a favor da empresa~su', $topo);
        $this->assertMatchesRegularExpression('~RDM .{0,40}R[$] -50,00.{0,40}a empresa deve~su', $topo);
        $this->assertMatchesRegularExpression('~RDA .{0,40}R[$] 70,00.{0,40}a favor da empresa~su', $topo);

        $quadro = substr($html, strpos($html, 'quadro-cv'), strpos($html, 'class="bloco"') - strpos($html, 'quadro-cv'));
        $this->assertMatchesRegularExpression('~RDM R[$] -50,00.{0,40}a empresa deve~su', $quadro);
        $this->assertMatchesRegularExpression('~RDA R[$] 70,00.{0,40}a favor da empresa~su', $quadro);

        $total = substr($quadro, strpos($quadro, '<tr class="tot">'));
        $this->assertMatchesRegularExpression('~R[$] 1[.]000,00.{0,40}a favor da empresa~su', $total, 'saldo anterior do cartão, no total');
        $this->assertMatchesRegularExpression('~R[$] -500,00.{0,40}a empresa deve~su', $total, 'saldo do cartão, no total');
    }

    public function test_rdm_rda_continua_igual(): void
    {
        $c = $this->pessoa('Rita Regime', 'rdm_rda');
        $this->nota($c, self::ANO, 9, 100.5);
        $this->repasse($c, self::ANO, 9, 40);
        $this->nota($c, self::ANO, 10, 60, 'RDA');
        $this->repasse($c, self::ANO, 10, 20, 'RDA');
        $this->repasse($c, self::ANO, 10, 999, 'RDM', 'recarga');   // no RDM/RDA a recarga fica fora

        $html = (new RelatorioEquipePdf)->html(self::ANO, 10);

        $this->assertStringContainsString('<th>Saldo anterior (R$)</th><th>Recebido (R$)</th><th>Saldo acumulado (R$)</th>', $html);
        $this->assertStringContainsString('<td class="num vermelho">R$ -60,50</td><td class="num">R$ 20,00</td><td class="num vermelho"><b>R$ -100,50</b></td>', $html);
        $this->assertStringContainsString('Anterior RDM R$ -60,50 · RDA R$ 0,00 · Gasto R$ 60,00 · Recebido R$ 20,00 · Saldo acumulado', $html);
        $this->assertStringContainsString('recarga do cartão (fora do saldo)', $html);
        $this->assertStringNotContainsString('Reembolso', $html);
        $this->assertArrayNotHasKey($c->id, (new RelatorioEquipePdf)->contasCv(self::ANO, 10));
    }

    public function test_pdf_real_sai_com_cv_e_rdm_rda_juntos(): void
    {
        $this->ana();
        $r = $this->pessoa('Rui Rdm', 'rdm_rda');
        $this->nota($r, self::ANO, 10, 10);

        $arq = tempnam(sys_get_temp_dir(), 'eq').'.pdf';
        (new RelatorioEquipePdf)->gerar(self::ANO, 10, $arq);

        $this->assertStringStartsWith('%PDF', (string) file_get_contents($arq, false, null, 0, 4));
        @unlink($arq);
    }
}
