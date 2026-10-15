<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\RelatorioRdmRda;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 14/10/2026 — "no Excel, tanto para CV quanto para RDM/RDA, a minha e a do Jamil (que é CV) estão parecidas".
 * O ZIP de Arquivos (e o endpoint /relatorio/cv) montava SEMPRE a Planilha de CV, também para quem é RDM/RDA: nesse
 * caso as abas CV ALELO e CV REEMBOLSO repetiam as mesmas notas. Agora cada um recebe a planilha do seu regime.
 */
class PlanilhaPorRegimeTest extends TestCase
{
    use RefreshDatabase;

    private const ANO = 2026;

    private function colaborador(string $regime, string $nome): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome, 'email' => Str::slug($nome).'@teste.local',
            'password' => 'segredo123', 'role' => 'colaborador',
        ]);
        $c->forceFill(['regime' => $regime, 'ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(Colaborador $c, string $razao, float $valor, string $tipo, ?string $pagamento = null, ?string $subtipo = null): void
    {
        (new Nota([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => $tipo, 'subtipo' => $subtipo, 'valor' => $valor,
            'data' => self::ANO.'-03-10', 'mes' => 3, 'ano' => self::ANO, 'razao_social' => $razao,
            'pagamento' => $pagamento, 'deleted' => false,
        ]))->save();
    }

    /** nomes dos arquivos dentro do ZIP devolvido pela API */
    private function arquivosDoZip($resposta): array
    {
        $caminho = $resposta->baseResponse->getFile()->getPathname();
        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($caminho) === true, 'o ZIP precisa abrir');
        $nomes = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $nomes[] = $zip->getNameIndex($i);
        }
        $zip->close();

        return $nomes;
    }

    public function test_zip_de_quem_e_cv_leva_a_planilha_de_cv(): void
    {
        $c = $this->colaborador('cv', 'Jamil CV');
        $this->nota($c, 'POSTO CARTAO', 100, 'RDM', 'cv', 'Abastecimento');
        Sanctum::actingAs($c);

        $nomes = $this->arquivosDoZip($this->get('/api/arquivos/zip?ano='.self::ANO));
        $this->assertNotEmpty(array_filter($nomes, fn ($n) => str_ends_with($n, 'Planilha_CV_'.self::ANO.'.xlsx')), implode(', ', $nomes));
        $this->assertEmpty(array_filter($nomes, fn ($n) => str_contains($n, 'Planilha_RDM_RDA')));
    }

    public function test_zip_de_quem_e_rdm_rda_leva_a_planilha_de_rdm_rda_e_nao_a_de_cv(): void
    {
        $c = $this->colaborador('rdm_rda', 'Cleiton RDM');
        $this->nota($c, 'POSTO RDM', 100, 'RDM', null, 'Abastecimento');
        $this->nota($c, 'PADARIA RDA', 20, 'RDA');
        Sanctum::actingAs($c);

        $nomes = $this->arquivosDoZip($this->get('/api/arquivos/zip?ano='.self::ANO));
        $this->assertNotEmpty(array_filter($nomes, fn ($n) => str_ends_with($n, 'Planilha_RDM_RDA_'.self::ANO.'.xlsx')), implode(', ', $nomes));
        $this->assertEmpty(array_filter($nomes, fn ($n) => str_contains($n, 'Planilha_CV_')), 'quem é RDM/RDA não recebe a planilha de CV');
    }

    public function test_endpoint_de_cv_entrega_a_planilha_do_regime_de_quem_nao_e_cv(): void
    {
        $c = $this->colaborador('rdm_rda', 'Cleiton RDM');
        $this->nota($c, 'POSTO RDM', 100, 'RDM', null, 'Abastecimento');
        Sanctum::actingAs($c);

        $resp = $this->get('/api/relatorio/cv?ano='.self::ANO);
        $resp->assertOk();
        $this->assertStringContainsString('Planilha_RDM_RDA_', (string) $resp->headers->get('content-disposition'));
    }

    public function test_excel_rdm_rda_cada_nota_so_na_aba_dela(): void
    {
        $c = $this->colaborador('rdm_rda', 'Cleiton RDM');
        $this->nota($c, 'POSTO SO NA ABA RDM', 100, 'RDM', null, 'Abastecimento');
        $this->nota($c, 'PADARIA SO NA ABA RDA', 20, 'RDA');
        $ss = app(RelatorioRdmRda::class)->gerar($c, self::ANO);

        $texto = function (string $aba) use ($ss) {
            $ws = $ss->getSheetByName($aba);
            $this->assertNotNull($ws, "aba $aba");
            $t = [];
            foreach ($ws->toArray(null, false, false, false) as $linha) {
                foreach ($linha as $v) {
                    if (is_string($v) && $v !== '' && $v[0] !== '=') {
                        $t[] = $v;
                    }
                }
            }

            return implode('|', $t);
        };
        $rdm = $texto('R.D.M.');
        $rda = $texto('R.D.A');

        $this->assertStringContainsString('POSTO SO NA ABA RDM', $rdm);
        $this->assertStringNotContainsString('PADARIA SO NA ABA RDA', $rdm);
        $this->assertStringContainsString('PADARIA SO NA ABA RDA', $rda);
        $this->assertStringNotContainsString('POSTO SO NA ABA RDM', $rda);
        $ss->disconnectWorksheets();
    }
}
