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
 * 14/10/2026 — "na aba CV ALELO (cartão corporativo) e CV REEMBOLSO (carteira do colaborador, a empresa repõe com
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

        $alelo = $this->textoDaAba($ss, 'CV ALELO');
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

        $ini = strpos($html, '— CV ALELO —');
        $meio = strpos($html, '— CV REEMBOLSO —');
        $this->assertNotFalse($ini, 'página CV ALELO');
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
}
