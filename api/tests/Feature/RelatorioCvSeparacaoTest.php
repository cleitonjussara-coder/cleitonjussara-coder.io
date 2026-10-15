<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\RelatorioCv;
use App\Services\RelatorioCvPdf;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * 14/10/2026 — "na aba CV ALELO (cartão corporativo, hoje CARTÃO CORPORATIVO) e CV REEMBOLSO (carteira do colaborador, a empresa repõe com
 * depósito) a planilha está listando tudo junto". A planilha em Excel já separava no regime CV, mas o PDF desenhava as
 * duas páginas com as MESMAS notas. Aqui os dois formatos têm de listar cada nota só na aba dela, e o Faturamento
 * (pago direto pela empresa) em nenhuma.
 */
class RelatorioCvSeparacaoTest extends TestCase
{
    use RefreshDatabase;

    private const ANO = 2026;

    private function colaboradorCv(): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => 'Paulo CV', 'email' => 'paulo.cv@teste.local',
            'password' => 'segredo123', 'role' => 'colaborador',
        ]);
        $c->forceFill(['regime' => 'cv', 'ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(Colaborador $c, string $razao, float $valor, ?string $pagamento, string $tipo = 'RDM', ?string $subtipo = 'Abastecimento'): void
    {
        (new Nota([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => $tipo, 'subtipo' => $subtipo, 'valor' => $valor,
            'data' => self::ANO.'-03-10', 'mes' => 3, 'ano' => self::ANO, 'razao_social' => $razao,
            'pagamento' => $pagamento, 'deleted' => false,
        ]))->save();
    }

    private function cenario(): Colaborador
    {
        $c = $this->colaboradorCv();
        $this->nota($c, 'POSTO NO CARTAO', 100.00, 'cv');
        $this->nota($c, 'MERCADO SEM FORMA', 20.00, null, 'RDA', null);          // nota antiga, sem forma de pagamento: conta como cartão
        $this->nota($c, 'PADARIA DA CARTEIRA', 7.50, 'carteira', 'RDA', null);   // do bolso do colaborador
        $this->nota($c, 'FATURAMENTO DA EMPRESA', 999.00, 'empresa');             // pago direto pela empresa: nenhuma aba

        return $c;
    }

    /** Todo texto de uma aba do Excel. */
    private function textoDaAba($ss, string $aba): string
    {
        $ws = $ss->getSheetByName($aba);
        $this->assertNotNull($ws, "a aba $aba precisa existir no modelo");
        $t = [];
        foreach (range(1, 712) as $linha) {
            foreach (range(1, 16) as $col) {
                $v = $ws->getCell([$col, $linha])->getValue();
                if (is_string($v) && $v !== '' && $v[0] !== '=') {
                    $t[] = $v;
                }
            }
        }

        return implode('|', $t);
    }

    public function test_excel_cada_nota_so_na_aba_dela(): void
    {
        $c = $this->cenario();
        $ss = app(RelatorioCv::class)->gerar($c, self::ANO);

        $this->assertNull($ss->getSheetByName('CV ALELO'), 'a aba CV ALELO passou a se chamar CARTÃO CORPORATIVO');
        $alelo = $this->textoDaAba($ss, 'CARTÃO CORPORATIVO');
        $reemb = $this->textoDaAba($ss, 'CV REEMBOLSO');

        $this->assertStringContainsString('POSTO NO CARTAO', $alelo);
        $this->assertStringContainsString('MERCADO SEM FORMA', $alelo);
        $this->assertStringNotContainsString('PADARIA DA CARTEIRA', $alelo);

        $this->assertStringContainsString('PADARIA DA CARTEIRA', $reemb);
        $this->assertStringNotContainsString('POSTO NO CARTAO', $reemb);
        $this->assertStringNotContainsString('MERCADO SEM FORMA', $reemb);

        foreach ([$alelo, $reemb] as $aba) {
            $this->assertStringNotContainsString('FATURAMENTO DA EMPRESA', $aba, 'Faturamento não entra em nenhuma aba do colaborador');
        }
        $ss->disconnectWorksheets();
    }

    public function test_pdf_cada_pagina_lista_so_as_notas_dela_e_o_total_dela(): void
    {
        $c = $this->cenario();
        $html = app(RelatorioCvPdf::class)->html($c, self::ANO);

        $this->assertStringNotContainsString('CV ALELO', $html, 'o nome antigo não aparece mais no PDF');
        $ini = strpos($html, '— CARTÃO CORPORATIVO —');
        $meio = strpos($html, '— CV REEMBOLSO —');
        $this->assertNotFalse($ini, 'página CARTÃO CORPORATIVO');
        $this->assertNotFalse($meio, 'página CV REEMBOLSO');
        $this->assertLessThan($meio, $ini);
        $alelo = substr($html, $ini, $meio - $ini);
        $reemb = substr($html, $meio);

        $this->assertStringContainsString('POSTO NO CARTAO', $alelo);
        $this->assertStringContainsString('MERCADO SEM FORMA', $alelo);
        $this->assertStringContainsString('120,00', $alelo, 'gasto do cartão = 100,00 + 20,00');
        $this->assertStringNotContainsString('PADARIA', $alelo);
        $this->assertStringNotContainsString('7,50', $alelo);

        $this->assertStringContainsString('7,50', $reemb, 'gasto da carteira');
        $this->assertStringNotContainsString('POSTO', $reemb);
        $this->assertStringNotContainsString('MERCADO', $reemb);
        $this->assertStringNotContainsString('120,00', $reemb);

        $this->assertStringNotContainsString('999,00', $html, 'Faturamento fica fora do PDF do colaborador');
    }

    /** 15/10/2026: "RECARGA ALELO" → "RECARGA DE CARTÃO", nos dois formatos. */
    public function test_extrato_de_recarga_nao_cita_mais_a_marca_do_cartao(): void
    {
        $c = $this->cenario();

        $ss = app(RelatorioCv::class)->gerar($c, self::ANO);
        $rotulo = (string) $ss->getSheetByName('BANCO DE DADOS')->getCell('B13')->getValue();
        $this->assertSame('EXTRATO DE VALOR RECEBIDO/RECARGA DE CARTÃO', $rotulo);
        $this->assertTrue($ss->getSheetByName('BANCO DE DADOS')->getStyle('B13')->getAlignment()->getShrinkToFit(), 'o título ficou 2 letras maior: tem de encolher, não cortar');
        $ss->disconnectWorksheets();

        $html = app(RelatorioCvPdf::class)->html($c, self::ANO);
        $this->assertStringContainsString('EXTRATO DE VALOR RECEBIDO/RECARGA DE CARTÃO', $html);
        $this->assertStringNotContainsString('RECARGA ALELO', $html);
    }

    /** A fórmula do BANCO DE DADOS que lê o saldo do cartão tem de seguir a aba renomeada (senão o Excel mostra #REF!). */
    public function test_formula_do_banco_de_dados_segue_a_aba_renomeada(): void
    {
        $ss = app(RelatorioCv::class)->gerar($this->cenario(), self::ANO);

        $this->assertSame("='CARTÃO CORPORATIVO'!F2", $ss->getSheetByName('BANCO DE DADOS')->getCell('B9')->getValue());
        $ss->disconnectWorksheets();
    }

    /**
     * Excel único da equipe: cada aba leva o primeiro nome na frente, e o Excel só aceita 31 caracteres.
     * "CARTÃO CORPORATIVO" tem 18 — um primeiro nome comprido não pode estourar (o setTitle lançaria exceção).
     */
    public function test_excel_unico_da_equipe_nao_estoura_31_caracteres_na_aba_do_cartao(): void
    {
        $c = $this->cenario();
        $c->forceFill(['nome' => 'Anastacianoalberto Silva'])->save();

        $ss = app(RelatorioCv::class)->gerarUnico([$c], self::ANO);
        $titulos = array_map(fn ($w) => $w->getTitle(), $ss->getAllSheets());

        foreach ($titulos as $t) {
            $this->assertLessThanOrEqual(31, mb_strlen($t), "aba '$t' passa de 31 caracteres");
        }
        $cartao = array_values(array_filter($titulos, fn ($t) => str_ends_with($t, '_CARTÃO CORPORATIVO')));
        $this->assertCount(1, $cartao, implode(' | ', $titulos));
        $this->assertSame("='".$cartao[0]."'!F2", $ss->getSheetByName(str_replace('CARTÃO CORPORATIVO', 'BANCO DE DADOS', $cartao[0]))->getCell('B9')->getValue());
        $ss->disconnectWorksheets();
    }
}
