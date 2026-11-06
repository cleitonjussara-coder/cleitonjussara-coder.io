<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\MesFechado;
use App\Models\Nota;
use App\Models\Repasse;
use App\Services\FechamentoMes;
use App\Services\NotasAguardando;
use App\Services\PushService;
use App\Services\RelatorioCv;
use App\Services\RelatorioCvPdf;
use App\Services\RelatorioEquipePdf;
use App\Services\RelatorioFaturamentoPdf;
use App\Services\RelatorioFaturamentoXlsx;
use App\Services\RelatorioRdmRda;
use App\Services\RelatorioRdmRdaPdf;
use App\Services\SaldoAnterior;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use Tests\TestCase;

/**
 * 06/11/2026 — decisão do dono: nota que entrou com o mês já fechado só aparece na planilha do mês depois de conferida. O arquivo
 * diz que ela existe, com quantidade e valor. As telas seguem com o dinheiro real.
 */
class FechamentoRelatorioTest extends TestCase
{
    use RefreshDatabase;

    private const ANO = 2026;

    private const AVISO_DUAS = '2 notas (R$ 287,49) aguardam conferência e não entram nesta planilha';

    protected function setUp(): void
    {
        parent::setUp();
        Carbon::setTestNow(Carbon::parse('2026-11-06 15:00:00', 'UTC'));
        Storage::fake('fotos');
        MesFechado::esquecerTabela();
        Nota::esquecerForaFechamento();
        $this->mock(PushService::class, function ($m) {
            $m->shouldReceive('enviar')->andReturn(1);
            $m->shouldReceive('avisarGestores')->andReturn(0);
        });
    }

    protected function tearDown(): void
    {
        MesFechado::esquecerTabela();
        Nota::esquecerForaFechamento();
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function pessoa(string $regime = 'rdm_rda', string $role = 'colaborador'): Colaborador
    {
        $sufixo = Str::random(6);
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => 'Pessoa '.$sufixo, 'email' => $sufixo.'@teste.local', 'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['regime' => $regime, 'ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(?Colaborador $c, float $valor, array $campos = []): Nota
    {
        $data = $campos['data'] ?? '2026-10-20';
        $n = new Nota(array_replace([
            'id' => (string) Str::uuid(), 'user_id' => $c?->id, 'tipo' => 'RDM', 'subtipo' => 'Outros', 'valor' => $valor, 'data' => $data,
            'mes' => (int) substr($data, 5, 2), 'ano' => (int) substr($data, 0, 4), 'razao_social' => 'POSTO NORMAL', 'deleted' => false,
        ], $campos));
        $n->save();

        return $n;
    }

    /** Nota que chegou com o mês fechado, como o NotaController a grava. */
    private function fora(?Colaborador $c, float $valor, array $campos = []): Nota
    {
        $n = $this->nota($c, $valor, ['razao_social' => 'POSTO ATRASADO'] + $campos);
        $n->forceFill(['fora_fechamento_em' => now()])->save();

        return $n;
    }

    private function fechar(int $ano = self::ANO, int $mes = 10): void
    {
        MesFechado::create(['ano' => $ano, 'mes' => $mes, 'fechado_em' => now()]);
    }

    private function conferir(Nota $n): void
    {
        app(FechamentoMes::class)->conferir($n, $this->pessoa('rdm_rda', 'gestor'));
    }

    private function repasse(Colaborador $c, float $valor, array $campos = []): void
    {
        $r = new Repasse(array_replace([
            'id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => 'RDM', 'valor' => $valor, 'data' => '2026-10-05', 'mes' => 10, 'ano' => self::ANO,
            'kind' => 'received', 'deleted' => false,
        ], $campos));
        $r->forceFill(['confirmado_em' => now()])->save();
    }

    private function bd(Spreadsheet $ss, string $celula): mixed
    {
        return $ss->getSheetByName('BANCO DE DADOS')->getCell($celula)->getCalculatedValue();
    }

    /** @return array<string, string> nome => conteúdo */
    private function arquivosDoZip(string $url): array
    {
        $resp = $this->get($url)->assertOk();
        $zip = new \ZipArchive;
        $this->assertTrue($zip->open($resp->baseResponse->getFile()->getPathname()) === true);
        $saida = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $saida[$zip->getNameIndex($i)] = (string) $zip->getFromIndex($i);
        }
        $zip->close();

        return $saida;
    }

    private function comAnexo(Nota $n): void
    {
        $caminho = "{$n->user_id}/{$n->id}.jpg";
        Storage::disk('fotos')->put($caminho, 'imagem');
        $n->forceFill(['foto_path' => $caminho])->save();
    }

    public function test_escopo_segura_so_a_nota_nao_conferida_de_mes_fechado(): void
    {
        $c = $this->pessoa();
        $this->fechar();
        $normal = $this->nota($c, 10);
        $presa = $this->fora($c, 20);
        $conferida = $this->fora($c, 30);
        $this->conferir($conferida);
        $this->fora($c, 40, ['deleted' => true]);   // apagada não é pendência: os relatórios já a tiram e ela não conta no aviso
        $outroMes = $this->fora($c, 50, ['data' => '2026-09-20']);   // chegou com setembro fechado, depois movida ou reaberta

        $this->assertEqualsCanonicalizing([$normal->id, $conferida->id, $outroMes->id], Nota::query()->noRelatorio()->pluck('id')->all());
        $this->assertSame([$presa->id], Nota::query()->aguardandoConferencia()->pluck('id')->all());
    }

    public function test_frase_no_singular_e_no_plural(): void
    {
        $this->assertSame(self::AVISO_DUAS, NotasAguardando::frase(2, 287.49, 'nesta planilha'));
        $this->assertSame('1 nota (R$ 1.200,50) aguarda conferência e não entra neste relatório', NotasAguardando::frase(1, 1200.5, 'neste relatório'));
        $this->assertNull(NotasAguardando::frase(0, 0, 'nesta planilha'));
    }

    public function test_planilha_cv_sem_a_nota_com_aviso_e_depois_de_conferida_com_ela(): void
    {
        $c = $this->pessoa('cv');
        $this->fechar();
        $this->nota($c, 100, ['pagamento' => 'cv']);
        $this->repasse($c, 1000, ['destino' => 'recarga']);
        $a = $this->fora($c, 200.49, ['pagamento' => 'cv']);
        $b = $this->fora($c, 87, ['pagamento' => 'cv']);
        $svc = app(RelatorioCv::class);

        $ss = $svc->gerar($c, self::ANO);
        $this->assertSame(self::AVISO_DUAS, $ss->getSheetByName('CABEÇALHO')->getCell('A1')->getValue());
        $this->assertSame(self::AVISO_DUAS, $ss->getSheetByName('BANCO DE DADOS')->getCell('I1')->getValue());
        $this->assertEqualsWithDelta(100, $this->bd($ss, 'B9'), 0.001, 'o gasto do arquivo não tem a nota');
        $this->assertEqualsWithDelta(900, $this->bd($ss, 'B11'), 0.001, 'a conta fecha dentro do arquivo');
        $this->assertSame('=B7+I7-B9', $ss->getSheetByName('BANCO DE DADOS')->getCell('B11')->getValue(), 'fórmula no lugar');
        $ss->disconnectWorksheets();

        $this->conferir($a);
        $this->conferir($b);
        $ss = $svc->gerar($c, self::ANO);
        $this->assertNull($ss->getSheetByName('CABEÇALHO')->getCell('A1')->getValue(), 'sem pendência o arquivo não muda');
        $this->assertNull($ss->getSheetByName('BANCO DE DADOS')->getCell('I1')->getValue());
        $this->assertArrayNotHasKey('A1:E4', $ss->getSheetByName('CABEÇALHO')->getMergeCells());
        $this->assertEqualsWithDelta(387.49, $this->bd($ss, 'B9'), 0.001);
        $this->assertEqualsWithDelta(612.51, $this->bd($ss, 'B11'), 0.001);
        $ss->disconnectWorksheets();
    }

    public function test_planilha_rdm_rda_sem_a_nota_com_aviso_e_depois_de_conferida_com_ela(): void
    {
        $c = $this->pessoa();
        $this->fechar();
        $this->nota($c, 100);
        $this->repasse($c, 1000);
        $a = $this->fora($c, 287.49);
        $svc = app(RelatorioRdmRda::class);

        $ss = $svc->gerar($c, self::ANO);
        $aviso = '1 nota (R$ 287,49) aguarda conferência e não entra nesta planilha';
        $this->assertSame($aviso, $ss->getSheetByName('CABEÇALHO')->getCell('A1')->getValue());
        $this->assertSame($aviso, $ss->getSheetByName('BANCO DE DADOS')->getCell('L1')->getValue());
        $this->assertEqualsWithDelta(100, $this->bd($ss, 'B9'), 0.001);
        $this->assertEqualsWithDelta(900, $this->bd($ss, 'B11'), 0.001);
        $ss->disconnectWorksheets();

        $this->conferir($a);
        $ss = $svc->gerar($c, self::ANO);
        $this->assertNull($ss->getSheetByName('CABEÇALHO')->getCell('A1')->getValue());
        $this->assertEqualsWithDelta(387.49, $this->bd($ss, 'B9'), 0.001);
        $this->assertEqualsWithDelta(612.51, $this->bd($ss, 'B11'), 0.001);
        $ss->disconnectWorksheets();
    }

    public function test_saldo_final_de_um_ano_e_o_anterior_do_seguinte_nos_relatorios(): void
    {
        $c = $this->pessoa();
        $this->fechar(2025, 12);
        $this->nota($c, 100, ['data' => '2025-12-01']);
        $this->repasse($c, 500, ['data' => '2025-12-02', 'mes' => 12, 'ano' => 2025]);
        $presa = $this->fora($c, 80, ['data' => '2025-12-20']);

        $real = app(SaldoAnterior::class);
        $rel = app(SaldoAnterior::class)->doRelatorio();
        $this->assertEqualsWithDelta(320, $real->de($c, 2026)['saldo']['RDM'], 0.001, 'a tela é o dinheiro real');
        $this->assertEqualsWithDelta(400, $rel->de($c, 2026)['saldo']['RDM'], 0.001, 'o relatório fica sem a nota');
        $fim2025 = $rel->ateMes(2025, 12)[$c->id]['saldo']['RDM'];
        $this->assertEqualsWithDelta($fim2025, $rel->de($c, 2026)['saldo']['RDM'], 0.001, 'saldo final de 2025 = anterior de 2026');

        /* o ano seguinte não fica calado: a planilha dele também diz que a nota está fora do saldo trazido */
        $html = app(RelatorioRdmRdaPdf::class)->html($c, 2026);
        $this->assertStringContainsString('1 nota (R$ 80,00) de anos anteriores aguarda conferência e não entra no saldo do ano anterior', $html);
        $this->assertStringContainsString('R$ 400,00', $html);

        $this->conferir($presa);
        $this->assertEqualsWithDelta(320, $rel->ateMes(2025, 12)[$c->id]['saldo']['RDM'], 0.001);
        $this->assertEqualsWithDelta(320, $rel->de($c, 2026)['saldo']['RDM'], 0.001, 'conferida entra nos dois lados ao mesmo tempo');
    }

    public function test_pdfs_individuais_sem_a_nota_com_aviso(): void
    {
        $cv = $this->pessoa('cv');
        $rdm = $this->pessoa();
        $this->fechar();
        foreach ([$cv, $rdm] as $c) {
            $this->nota($c, 100);
            $this->fora($c, 287.49);
        }
        $aviso = '1 nota (R$ 287,49) aguarda conferência e não entra neste relatório';
        foreach ([app(RelatorioCvPdf::class)->html($cv, self::ANO), app(RelatorioRdmRdaPdf::class)->html($rdm, self::ANO)] as $html) {
            $this->assertStringContainsString($aviso, $html);
            $this->assertStringContainsString('R$ 100,00', $html);
            $this->assertStringNotContainsString('387,49', $html);
        }
    }

    public function test_pdf_da_equipe_tira_a_nota_do_mes_e_do_saldo_seguinte(): void
    {
        $c = $this->pessoa();
        $this->fechar();
        $this->nota($c, 100);
        $this->fora($c, 50);
        $svc = app(RelatorioEquipePdf::class);

        $html = $svc->html(self::ANO, 10);
        $this->assertStringContainsString('1 nota (R$ 50,00) aguarda conferência e não entra neste relatório', $html);
        $this->assertStringNotContainsString('150,00', $html);

        $this->assertEqualsWithDelta(-100, $svc->saldoAnterior(self::ANO, 11)[$c->id]['RDM'], 0.001);
        $html = $svc->html(self::ANO, 11);
        $this->assertStringContainsString('1 nota (R$ 50,00) de meses anteriores aguarda conferência e não entra no saldo trazido dos meses anteriores', $html);
    }

    public function test_pdf_da_equipe_no_cv_tira_a_nota_do_saldo_do_cartao(): void
    {
        $c = $this->pessoa('cv');
        $this->fechar();
        $this->repasse($c, 1000, ['destino' => 'recarga']);
        $this->nota($c, 100, ['pagamento' => 'cv']);
        $this->fora($c, 50, ['pagamento' => 'cv']);

        $this->assertEqualsWithDelta(900, (new RelatorioEquipePdf)->contasCv(self::ANO, 10)[$c->id]['saldo']['cartao'], 0.001);
    }

    public function test_resumo_da_equipe_soma_sem_a_nota_e_avisa_na_linha_livre(): void
    {
        $c = $this->pessoa();
        $this->fechar();
        $this->nota($c, 100);
        $this->fora($c, 287.49);

        $ss = new Spreadsheet;
        $ss->removeSheetByIndex(0);
        app(RelatorioCv::class)->abaResumo($ss, collect([$c]), self::ANO);
        $ws = $ss->getSheetByName('RESUMO');

        $this->assertSame('1 nota (R$ 287,49) aguarda conferência e não entra neste resumo', $ws->getCell('A3')->getValue());
        $this->assertSame('1 · POR COLABORADOR', $ws->getCell('A4')->getValue(), 'o quadro não desceu');
        $this->assertEqualsWithDelta(100, $ws->getCell('F6')->getValue(), 0.001, 'Total gasto do colaborador');
        $this->assertEqualsWithDelta(-100, $ws->getCell('I6')->getValue(), 0.001, 'Saldo no número do relatório');
        $ss->disconnectWorksheets();
    }

    public function test_faturamento_xlsx_e_pdf(): void
    {
        $this->fechar();
        $this->nota(null, 100, ['pagamento' => 'empresa']);
        $this->fora(null, 287.49, ['pagamento' => 'empresa']);
        $aviso = '1 nota (R$ 287,49) aguarda conferência e não entra nesta planilha';
        $svc = app(RelatorioFaturamentoXlsx::class);

        $ano = $svc->gerar(self::ANO);
        $this->assertSame($aviso, $ano->getSheetByName('RESUMO')->getCell('A3')->getValue());
        $this->assertSame($aviso, $ano->getSheetByName('Out')->getCell('A3')->getValue());
        $this->assertNull($ano->getSheetByName('Set')->getCell('A3')->getValue(), 'só o mês da nota avisa');
        $this->assertEqualsWithDelta(100, $ano->getSheetByName('Out')->getCell('I6')->getCalculatedValue(), 0.001);
        $this->assertSame('TOTAL', $ano->getSheetByName('Out')->getCell('A6')->getValue());
        $ano->disconnectWorksheets();

        $mes = $svc->gerar(self::ANO, null, 10);
        $this->assertSame($aviso, $mes->getSheetByName('CATEGORIAS')->getCell('A3')->getValue());
        $mes->disconnectWorksheets();

        $html = app(RelatorioFaturamentoPdf::class)->html(self::ANO, 10);
        $this->assertStringContainsString('1 nota (R$ 287,49) aguarda conferência e não entra neste relatório', $html);
        $this->assertStringNotContainsString('POSTO ATRASADO', $html);
    }

    public function test_zip_fica_sem_o_anexo_diz_quais_faltam_e_recebe_depois_de_conferida(): void
    {
        $c = $this->pessoa();
        $this->fechar();
        $normal = $this->nota($c, 100);
        $presa = $this->fora($c, 287.49);
        $this->comAnexo($normal);
        $this->comAnexo($presa);
        Sanctum::actingAs($c);
        $url = '/api/arquivos/zip?planilha=0&ano='.self::ANO.'&mes=10';

        $arquivos = $this->arquivosDoZip($url);
        $fotos = array_filter(array_keys($arquivos), fn ($n) => str_ends_with($n, '.jpg'));
        $this->assertCount(1, $fotos);
        $this->assertStringContainsString('POSTO NORMAL', mb_strtoupper(reset($fotos)));
        $txt = array_values(array_filter($arquivos, fn ($conteudo, $n) => str_ends_with($n, 'AGUARDANDO CONFERENCIA.txt'), ARRAY_FILTER_USE_BOTH));
        $this->assertCount(1, $txt);
        $this->assertStringContainsString('1 nota (R$ 287,49) aguarda conferência e não entra neste ZIP', $txt[0]);
        $this->assertStringContainsString('POSTO ATRASADO', $txt[0]);

        $this->conferir($presa);
        Sanctum::actingAs($c);
        $arquivos = $this->arquivosDoZip($url);
        $this->assertCount(2, array_filter(array_keys($arquivos), fn ($n) => str_ends_with($n, '.jpg')));
        $this->assertSame([], array_filter(array_keys($arquivos), fn ($n) => str_contains($n, 'AGUARDANDO')));
    }

    public function test_zip_so_com_nota_aguardando_sai_com_o_aviso_e_nao_404(): void
    {
        $c = $this->pessoa();
        $this->fechar();
        $this->comAnexo($this->fora($c, 50));
        Sanctum::actingAs($c);

        $nomes = array_keys($this->arquivosDoZip('/api/arquivos/zip?planilha=0&ano='.self::ANO.'&mes=10'));
        $this->assertCount(1, $nomes);
        $this->assertStringEndsWith('AGUARDANDO CONFERENCIA.txt', $nomes[0]);
    }

    public function test_zip_da_equipe_fica_sem_o_anexo_e_o_leiame_avisa(): void
    {
        $c = $this->pessoa();
        $this->fechar();
        $this->comAnexo($this->nota($c, 100));
        $this->comAnexo($this->fora($c, 287.49));
        Sanctum::actingAs($this->pessoa('rdm_rda', 'gestor'));

        $arquivos = $this->arquivosDoZip('/api/arquivos/zip-equipe?ano='.self::ANO.'&mes=10');
        $this->assertCount(1, array_filter(array_keys($arquivos), fn ($n) => str_ends_with($n, '.jpg')));
        $this->assertStringContainsString('1 nota (R$ 287,49) aguarda conferência e não entra neste ZIP', $arquivos['LEIAME.txt']);
    }

    public function test_mes_aberto_nao_tem_efeito_e_reabrir_nao_esconde_a_nota(): void
    {
        $c = $this->pessoa('cv');
        $this->nota($c, 100);
        $this->assertSame([], NotasAguardando::doPeriodo(self::ANO), 'mês aberto sem marca: nada muda');

        /* a nota entrou com o mês fechado; reabriu, ela volta a sair e continua a conferir */
        $presa = $this->fora($c, 50);
        $this->fechar();
        $this->assertCount(1, NotasAguardando::doPeriodo(self::ANO));
        $gestor = $this->pessoa('rdm_rda', 'gestor');
        $fechamento = app(FechamentoMes::class);
        $this->assertTrue($fechamento->painel($gestor)['fora'][0]['fora_da_planilha']);

        $fechamento->reabrir(self::ANO, 10, 'corrigir', $gestor);
        $this->assertSame([], NotasAguardando::doPeriodo(self::ANO));
        $this->assertStringContainsString('R$ 150,00', app(RelatorioCvPdf::class)->html($c, self::ANO), 'mês reaberto: a soma do relatório tem a nota');
        $painel = $fechamento->painel($gestor);
        $this->assertSame($presa->id, $painel['fora'][0]['id'], 'reabrir não confere por ninguém');
        $this->assertFalse($painel['fora'][0]['fora_da_planilha']);

        /* fechou de novo sem conferir: sai outra vez, com o aviso no arquivo */
        $fechamento->fechar(self::ANO, 10, $gestor);
        $this->assertSame(['1 nota (R$ 50,00) aguarda conferência e não entra nesta planilha'], NotasAguardando::doPeriodo(self::ANO));
    }

    public function test_telas_seguem_com_o_dinheiro_real(): void
    {
        $c = $this->pessoa();
        $this->fechar();
        $this->nota($c, 100);
        $presa = $this->fora($c, 50);
        Sanctum::actingAs($c);

        $this->assertCount(2, $this->getJson('/api/notas?ano='.self::ANO)->assertOk()->json());
        $this->assertCount(2, $this->getJson('/api/arquivos/notas?ano='.self::ANO.'&mes=10')->assertOk()->json('notas'));
        $linha = collect($this->getJson('/api/arquivos/resumo?ano='.self::ANO)->assertOk()->json('colaboradores'))->firstWhere('user_id', $c->id);
        $this->assertEqualsWithDelta(150, $linha['total'], 0.001);

        /* a ficha pergunta aqui; colaborador só vê a própria nota */
        $this->assertSame([$presa->id], array_column($this->getJson('/api/fechamento/aguardando')->assertOk()->json('notas'), 'id'));
        Sanctum::actingAs($this->pessoa());
        $this->assertSame([], $this->getJson('/api/fechamento/aguardando')->assertOk()->json('notas'));
    }

    public function test_banco_sem_as_colunas_funciona_como_antes(): void
    {
        $c = $this->pessoa();
        $this->nota($c, 100);
        Schema::table('notas', function ($t) {
            $t->dropIndex(['fora_fechamento_em']);
            $t->dropIndex(['fora_avisada_em']);
            $t->dropColumn(['fora_fechamento_em', 'fora_conferida_em', 'fora_conferida_por', 'fora_avisada_em']);
        });
        Nota::esquecerForaFechamento();

        $this->assertSame(1, Nota::query()->noRelatorio()->count());
        $this->assertSame(0, Nota::query()->aguardandoConferencia()->count());
        $this->assertSame([], NotasAguardando::doPeriodo(self::ANO));
        $this->assertStringContainsString('R$ 100,00', app(RelatorioRdmRdaPdf::class)->html($c, self::ANO));
        Sanctum::actingAs($c);
        $this->assertSame([], $this->getJson('/api/fechamento/aguardando')->assertOk()->json('notas'));
    }

    public function test_banco_sem_a_tabela_de_meses_funciona_como_antes(): void
    {
        $c = $this->pessoa();
        $this->fora($c, 100);
        Schema::drop('meses_fechados');
        MesFechado::esquecerTabela();

        $this->assertSame(1, Nota::query()->noRelatorio()->count());
        $this->assertSame([], NotasAguardando::doPeriodo(self::ANO));
    }
}
