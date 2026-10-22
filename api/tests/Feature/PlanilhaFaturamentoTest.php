<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\RelatorioFaturamentoXlsx;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use PhpOffice\PhpSpreadsheet\IOFactory;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use Tests\TestCase;

/**
 * 22/10/2026 — Planilha própria de Faturamento: só as notas pagas direto pela empresa (pagamento='empresa'), do ano
 * pedido, de qualquer colaborador ou sem colaborador. RESUMO com os totais + uma aba por mês com uma linha por nota.
 */
class PlanilhaFaturamentoTest extends TestCase
{
    use RefreshDatabase;

    private const ANO = 2026;

    private function pessoa(string $role, string $nome): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome, 'email' => Str::slug($nome).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['regime' => 'rdm_rda', 'ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(?Colaborador $dono, array $campos, ?Colaborador $lancou = null): Nota
    {
        $mes = $campos['mes'] ?? 3;
        $ano = $campos['ano'] ?? self::ANO;
        $n = new Nota(array_merge([
            'id' => (string) Str::uuid(), 'user_id' => $dono?->id, 'tipo' => 'RDM', 'subtipo' => 'Hospedagem', 'valor' => 100,
            'data' => sprintf('%d-%02d-10', $ano, $mes), 'mes' => $mes, 'ano' => $ano, 'razao_social' => 'FORNECEDOR',
            'pagamento' => 'empresa', 'deleted' => false,
        ], $campos));
        $n->forceFill(['created_by' => $lancou?->id ?? $dono?->id, 'foto_path' => $campos['foto_path'] ?? null])->save();

        return $n;
    }

    /** linhas da aba com os valores crus já calculados (fórmulas resolvidas; data = número de série do Excel) */
    private function linhas(Spreadsheet $ss, string $aba): array
    {
        $ws = $ss->getSheetByName($aba);
        $this->assertNotNull($ws, "aba {$aba}");

        return $ws->toArray(null, true, false, false);
    }

    private function linhaQueComeca(array $linhas, string $inicio): ?array
    {
        foreach ($linhas as $l) {
            if (($l[0] ?? null) === $inicio) {
                return $l;
            }
        }

        return null;
    }

    public function test_so_entram_as_notas_da_empresa_do_ano_e_nao_apagadas(): void
    {
        Storage::fake('fotos');
        $gestor = $this->pessoa('gestor', 'Gestora Ana');
        $paulo = $this->pessoa('colaborador', 'Paulo Silva');
        Storage::disk('fotos')->put('x/a.jpg', 'jpg');
        $this->nota($paulo, ['razao_social' => 'HOTEL EMPRESA', 'valor' => 300, 'cnpj' => '12345678000199', 'documento' => 'nfse', 'numero' => '000123', 'foto_path' => 'x/a.jpg'], $gestor);
        $this->nota(null, ['razao_social' => 'POSTO SEM DONO', 'valor' => 200, 'subtipo' => 'Abastecimento', 'cnpj' => '00000000000000', 'mes' => 4], $gestor);
        $this->nota($paulo, ['razao_social' => 'RESTAURANTE RDA', 'valor' => 50.5, 'tipo' => 'RDA', 'subtipo' => null, 'mes' => 4], $gestor);
        $this->nota($paulo, ['razao_social' => 'DO BOLSO', 'valor' => 999, 'pagamento' => null]);
        $this->nota($paulo, ['razao_social' => 'APAGADA', 'valor' => 999, 'deleted' => true], $gestor);
        $this->nota($paulo, ['razao_social' => 'OUTRO ANO', 'valor' => 999, 'ano' => self::ANO - 1], $gestor);

        $ss = app(RelatorioFaturamentoXlsx::class)->gerar(self::ANO, $gestor);
        $this->assertSame(['RESUMO', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'], $ss->getSheetNames());

        /* aba de março: a nota do Paulo, com tudo que a contabilidade precisa */
        $mar = $this->linhas($ss, 'Mar');
        $this->assertSame(['Data', 'Colaborador', 'Tipo', 'Categoria', 'Fornecedor', 'CNPJ', 'Documento', 'Número', 'Valor (R$)', 'Lançado por', 'Observação', 'Anexo'], $mar[3]);
        $l = $mar[4];
        $this->assertSame('2026-03-10', \PhpOffice\PhpSpreadsheet\Shared\Date::excelToDateTimeObject($l[0])->format('Y-m-d'));
        $this->assertSame('dd/mm/yyyy', $ss->getSheetByName('Mar')->getStyle('A5')->getNumberFormat()->getFormatCode());
        $this->assertSame(['Paulo Silva', 'RDM', 'Hospedagem', 'HOTEL EMPRESA', '12.345.678/0001-99', 'NFS-e', '000123'], array_slice($l, 1, 7));
        $this->assertSame(['Gestora Ana', null, 'Sim'], array_slice($l, 9, 3));
        $this->assertEqualsWithDelta(300, $l[8], 0.001);
        $this->assertSame('TOTAL', $mar[5][0]);
        $this->assertEqualsWithDelta(300, $mar[5][8], 0.001);

        /* abril: sem dono vira "Sem colaborador específico", os 14 zeros NÃO viram CNPJ, RDA é Alimentação */
        $abr = $this->linhas($ss, 'Abr');
        $porForn = collect(array_slice($abr, 4, 2))->keyBy(4);
        $this->assertSame('Sem colaborador específico', $porForn['POSTO SEM DONO'][1]);
        $this->assertSame('Abastecimento', $porForn['POSTO SEM DONO'][3]);
        $this->assertNull($porForn['POSTO SEM DONO'][5]);
        $this->assertSame('Alimentação', $porForn['RESTAURANTE RDA'][3]);
        $this->assertSame('Não', $porForn['RESTAURANTE RDA'][11]);

        /* nada de fora entra em lugar nenhum */
        $tudo = json_encode(array_map(fn ($a) => $this->linhas($ss, $a), $ss->getSheetNames()), JSON_UNESCAPED_UNICODE);
        foreach (['DO BOLSO', 'APAGADA', 'OUTRO ANO', '999', '00.000.000/0000-00', '00000000000000'] as $fora) {
            $this->assertStringNotContainsString($fora, $tudo, "{$fora} não pode aparecer");
        }

        /* RESUMO: por mês, por colaborador e total geral batem com as notas */
        $res = $this->linhas($ss, 'RESUMO');
        $marco = $this->linhaQueComeca($res, 'Março');
        $this->assertEqualsWithDelta(300, $marco[3], 0.001);   // Hospedagem
        $this->assertEqualsWithDelta(300, $marco[5], 0.001);   // Total
        $this->assertSame(1, (int) $marco[6]);
        $abril = $this->linhaQueComeca($res, 'Abril');
        $this->assertEqualsWithDelta(50.5, $abril[1], 0.001);  // Alimentação (RDA)
        $this->assertEqualsWithDelta(200, $abril[2], 0.001);   // Abastecimento
        $this->assertEqualsWithDelta(250.5, $abril[5], 0.001);
        $this->assertSame(2, (int) $abril[6]);
        $paulo = $this->linhaQueComeca($res, 'Paulo Silva');
        $this->assertEqualsWithDelta(350.5, $paulo[5], 0.001);
        $this->assertSame(2, (int) $paulo[6]);
        $semDono = $this->linhaQueComeca($res, 'Sem colaborador específico');
        $this->assertEqualsWithDelta(200, $semDono[5], 0.001);
        /* três quadros, três TOTAL GERAL: por mês e por colaborador (Total na coluna F, Notas na G); colaborador × mês (Total na N) */
        $totais = array_values(array_filter($res, fn ($l) => $l[0] === 'TOTAL GERAL'));
        $this->assertCount(3, $totais);
        $this->assertEqualsWithDelta(550.5, $totais[0][5], 0.001);
        $this->assertSame(3, (int) $totais[0][6]);
        $this->assertEqualsWithDelta(550.5, $totais[1][5], 0.001);
        $this->assertSame(3, (int) $totais[1][6]);
        $this->assertEqualsWithDelta(550.5, $totais[2][13], 0.001);
        $ss->disconnectWorksheets();
    }

    public function test_homonimos_nao_se_fundem_no_resumo(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora Ana');
        $a = $this->pessoa('colaborador', 'João Silva');
        $b = new Colaborador(['id' => (string) Str::uuid(), 'nome' => 'João Silva', 'email' => 'joao.outro@teste.local', 'password' => 'segredo123', 'role' => 'colaborador']);
        $b->forceFill(['regime' => 'rdm_rda', 'ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $b->forceFill(['confirmado_em' => now()]);
        }
        $b->save();
        $this->nota($a, ['valor' => 10], $gestor);
        $this->nota($a, ['valor' => 5, 'mes' => 4], $gestor);
        $this->nota($b, ['valor' => 20], $gestor);

        $ss = app(RelatorioFaturamentoXlsx::class)->gerar(self::ANO, $gestor);
        $res = $this->linhas($ss, 'RESUMO');
        $linhaA = $this->linhaQueComeca($res, 'João Silva ('.$a->email.')');
        $linhaB = $this->linhaQueComeca($res, 'João Silva (joao.outro@teste.local)');
        $this->assertNotNull($linhaA, 'cada cadastro com a sua linha');
        $this->assertNotNull($linhaB);
        $this->assertEqualsWithDelta(15, $linhaA[5], 0.001);
        $this->assertSame(2, (int) $linhaA[6]);
        $this->assertEqualsWithDelta(20, $linhaB[5], 0.001);
        $this->assertNull($this->linhaQueComeca($res, 'João Silva'), 'nenhuma linha com os dois somados');
        /* nas abas de mês também dá para saber de quem é cada nota */
        $this->assertContains('João Silva (joao.outro@teste.local)', array_column($this->linhas($ss, 'Mar'), 1));
        $ss->disconnectWorksheets();
    }

    /** Achado da revisão de 22/10/2026: o RESUMO da Planilha de C.V. da equipe somava as notas pagas pela empresa no gasto e no saldo. */
    public function test_resumo_da_planilha_da_equipe_nao_conta_o_faturamento_como_gasto_do_colaborador(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora Ana');
        $paulo = $this->pessoa('colaborador', 'Paulo Silva');
        $this->nota($paulo, ['valor' => 300], $gestor);                              // empresa pagou
        $this->nota($paulo, ['valor' => 50, 'pagamento' => 'carteira']);            // do bolso dele
        $this->nota($paulo, ['valor' => 7, 'pagamento' => null, 'mes' => 4]);       // nota antiga sem pagamento: continua contando

        $ss = new Spreadsheet();
        $ss->removeSheetByIndex(0);
        app(\App\Services\RelatorioCv::class)->abaResumo($ss, [$paulo], self::ANO);
        $res = $this->linhas($ss, 'RESUMO');
        $linha = $this->linhaQueComeca($res, 'Paulo Silva');   // quadro 1: Colaborador, 4 categorias, Total gasto, Recebido, Saldo
        $this->assertEqualsWithDelta(57, $linha[5], 0.001, 'Total gasto sem os R$ 300 da empresa');
        $this->assertEqualsWithDelta(-57, $linha[7], 0.001, 'Saldo sem os R$ 300 da empresa');
        $ss->disconnectWorksheets();
    }

    public function test_ano_sem_faturamento_gera_planilha_vazia_sem_erro(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora Ana');
        $ss = app(RelatorioFaturamentoXlsx::class)->gerar(self::ANO, $gestor);
        $this->assertCount(13, $ss->getSheetNames());
        $this->assertStringContainsString('Nenhuma nota de Faturamento', json_encode($this->linhas($ss, 'Jan'), JSON_UNESCAPED_UNICODE));
        $ss->disconnectWorksheets();
    }

    public function test_endpoint_entrega_o_xlsx_para_quem_ve_tudo_e_barra_colaborador(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora Ana');
        $contador = $this->pessoa('contabilidade', 'Contador Beto');
        $paulo = $this->pessoa('colaborador', 'Paulo Silva');
        $this->nota($paulo, ['razao_social' => 'HOTEL EMPRESA', 'valor' => 300], $gestor);

        foreach ([$gestor, $contador] as $quem) {
            Sanctum::actingAs($quem);
            $resp = $this->get('/api/relatorio/faturamento?formato=xlsx&ano='.self::ANO);
            $resp->assertOk();
            $this->assertStringContainsString('Planilha_Faturamento_2026.xlsx', (string) $resp->headers->get('content-disposition'));
            $ss = IOFactory::load($resp->baseResponse->getFile()->getPathname());
            $this->assertSame('RESUMO', $ss->getSheetNames()[0]);
            $ss->disconnectWorksheets();
        }

        /* o PDF continua o padrão quando não se pede formato */
        Sanctum::actingAs($gestor);
        $this->assertStringContainsString('.pdf', (string) $this->get('/api/relatorio/faturamento?ano='.self::ANO.'&mes=3')->headers->get('content-disposition'));

        Sanctum::actingAs($paulo);
        $this->get('/api/relatorio/faturamento?formato=xlsx&ano='.self::ANO)->assertForbidden();
    }
}
