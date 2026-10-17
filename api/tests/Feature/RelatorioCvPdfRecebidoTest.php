<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use App\Services\RelatorioCvPdf;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * 16/10/2026 — "aplicar a mesma separação em PDF": o recebido da planilha CV em PDF aparece aberto em RDM e RDA, e a
 * recarga do cartão fica separada do repasse (reembolso) — no resumo do BANCO DE DADOS, no extrato (coluna TIPO) e na
 * faixa do topo de cada aba —, como já está na ficha da Equipe e nas telas do colaborador.
 */
class RelatorioCvPdfRecebidoTest extends TestCase
{
    use RefreshDatabase;

    private const ANO = 2026;

    private function colaborador(?string $regime): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => 'Pessoa Teste', 'email' => Str::random(8).'@teste.local',
            'password' => 'segredo123', 'role' => 'colaborador',
        ]);
        $c->forceFill(['regime' => $regime ?? 'rdm_rda', 'ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(Colaborador $c, float $valor, ?string $pagamento): void
    {
        (new Nota([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => 'RDM', 'subtipo' => 'Abastecimento', 'valor' => $valor,
            'data' => self::ANO.'-03-10', 'mes' => 3, 'ano' => self::ANO, 'razao_social' => 'FORNECEDOR',
            'pagamento' => $pagamento, 'deleted' => false,
        ]))->save();
    }

    private function repasse(Colaborador $c, string $tipo, float $valor, ?string $destino): void
    {
        $r = new Repasse([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => $tipo, 'valor' => $valor,
            'data' => self::ANO.'-03-05', 'mes' => 3, 'ano' => self::ANO, 'kind' => 'received', 'destino' => $destino, 'deleted' => false,
        ]);
        $r->forceFill(['confirmado_em' => now()])->save();
    }

    /** As duas páginas de gasto, separadas pelo título (o BANCO DE DADOS vem antes). */
    private function paginas(string $html): array
    {
        $ini = strpos($html, '— CARTÃO CORPORATIVO —');
        $meio = strpos($html, '— CV REEMBOLSO —');
        $this->assertNotFalse($ini, 'página CARTÃO CORPORATIVO');
        $this->assertNotFalse($meio, 'página CV REEMBOLSO');

        return [substr($html, 0, $ini), substr($html, $ini, $meio - $ini), substr($html, $meio)];
    }

    public function test_cv_recarga_e_repasse_separados_cada_um_com_rdm_e_rda(): void
    {
        $c = $this->colaborador('cv');
        $this->nota($c, 100.00, 'cv');
        $this->nota($c, 7.50, 'carteira');
        $this->repasse($c, 'RDM', 500.00, 'recarga');
        $this->repasse($c, 'RDA', 200.00, 'recarga');
        $this->repasse($c, 'RDM', 5.00, 'carteira');
        $this->repasse($c, 'RDA', 3.00, 'carteira');

        [$banco, $cartao, $reemb] = $this->paginas(app(RelatorioCvPdf::class)->html($c, self::ANO));

        // BANCO DE DADOS: o total de recarga e o total pago, cada um aberto em RDM e RDA
        $this->assertStringContainsString('RDM R$ 500,00 · RDA R$ 200,00', $banco, 'recarga do cartão aberta em RDM e RDA');
        $this->assertStringContainsString('RDM R$ 5,00 · RDA R$ 3,00', $banco, 'reembolso pago aberto em RDM e RDA');
        $this->assertStringContainsString('<th>TIPO</th>', $banco, 'o extrato ganhou a coluna TIPO');
        $this->assertStringContainsString('<td class="tipo">RDA</td>', $banco);

        // faixa do topo de cada aba: só o recebido DELA
        $this->assertStringContainsString('RDM R$ 500,00 · RDA R$ 200,00', $cartao, 'cartão: recarga');
        $this->assertStringNotContainsString('RDM R$ 5,00 · RDA R$ 3,00', $cartao, 'o reembolso não entra na faixa do cartão');
        $this->assertStringContainsString('RDM R$ 5,00 · RDA R$ 3,00', $reemb, 'carteira: reembolso pago');
        $this->assertStringNotContainsString('RDM R$ 500,00', $reemb, 'a recarga não entra na faixa da carteira');
    }

    public function test_quem_nao_e_do_cartao_ve_o_recebido_aberto_em_rdm_e_rda_nas_duas_abas(): void
    {
        $c = $this->colaborador('rdm_rda');
        $this->nota($c, 50.00, null);
        $this->repasse($c, 'RDM', 300.00, null);
        $this->repasse($c, 'RDA', 120.50, null);

        $html = app(RelatorioCvPdf::class)->html($c, self::ANO);
        $this->assertGreaterThanOrEqual(3, substr_count($html, 'RDM R$ 300,00 · RDA R$ 120,50'), 'resumo + as duas abas');
        $this->assertStringContainsString('RDM_RDA', $html);
        $this->assertStringNotContainsString('— CARTÃO CORPORATIVO —', $html, 'quem não é do cartão não tem a aba do cartão');
    }
}
