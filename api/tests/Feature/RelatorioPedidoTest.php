<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\RelatorioPedido;
use App\Services\PlanilhasEquipe;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/** Fila das planilhas da equipe (06/11/2026). */
class RelatorioPedidoTest extends TestCase
{
    use RefreshDatabase;

    private const ANO = 2026;

    protected function tearDown(): void
    {
        foreach (glob(storage_path('app/relatorios/*')) ?: [] as $f) {
            @unlink($f);
        }
        parent::tearDown();
    }

    private function pessoa(string $role, string $sufixo = '', array $extra = []): Colaborador
    {
        $c = new Colaborador(array_replace([
            'id' => (string) Str::uuid(), 'nome' => ucfirst($role).$sufixo, 'email' => strtolower($role.$sufixo).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ], $extra));
        $c->forceFill(['confirmado_em' => now()]);
        $c->save();

        return $c;
    }

    private function nota(Colaborador $dono): void
    {
        (new Nota([
            'id' => (string) Str::uuid(), 'user_id' => $dono->id, 'tipo' => 'RDM', 'subtipo' => 'Outros', 'pagamento' => 'cv',
            'valor' => 100, 'data' => self::ANO.'-03-10', 'mes' => 3, 'ano' => self::ANO, 'razao_social' => 'Posto X',
        ]))->save();
    }

    private function pedir(Colaborador $quem, array $corpo = []): \Illuminate\Testing\TestResponse
    {
        Sanctum::actingAs($quem);

        return $this->postJson('/api/relatorio/cv-equipe/pedido', $corpo + ['ano' => self::ANO, 'modo' => 'unico']);
    }

    public function test_pedido_entra_na_fila_sem_gerar_nada(): void
    {
        $gestor = $this->pessoa('gestor');
        $this->nota($this->pessoa('colaborador', '', ['regime' => 'cv']));

        $r = $this->pedir($gestor)->assertStatus(202)->assertJsonPath('estado', 'fila')->assertJsonPath('pessoas', 1);

        $this->assertNull(RelatorioPedido::find($r->json('id'))->arquivo);
    }

    public function test_colaborador_nao_pede_e_contador_pede(): void
    {
        $this->nota($colab = $this->pessoa('colaborador', '', ['regime' => 'cv']));

        $this->pedir($colab)->assertForbidden();
        $this->pedir($this->pessoa('contabilidade'))->assertStatus(202);
    }

    public function test_dois_toques_no_botao_nao_criam_dois_pedidos(): void
    {
        $gestor = $this->pessoa('gestor');
        $this->nota($this->pessoa('colaborador', '', ['regime' => 'cv']));

        $a = $this->pedir($gestor)->json('id');
        $b = $this->pedir($gestor)->json('id');

        $this->assertSame($a, $b);
        $this->assertSame(1, RelatorioPedido::count());
    }

    public function test_sem_ninguem_no_ano_nao_entra_na_fila(): void
    {
        $this->pedir($this->pessoa('gestor'))->assertNotFound();
        $this->assertSame(0, RelatorioPedido::count());
    }

    public function test_comando_gera_e_so_o_dono_baixa(): void
    {
        $gestor = $this->pessoa('gestor');
        $outro = $this->pessoa('gestor', 'B');
        $this->nota($this->pessoa('colaborador', '', ['regime' => 'cv']));
        $id = $this->pedir($gestor)->json('id');

        $this->artisan('relatorios:processar')->assertSuccessful();

        $p = RelatorioPedido::find($id);
        $this->assertSame('pronto', $p->estado);
        $this->assertFileExists($p->arquivo);

        Sanctum::actingAs($gestor);
        $this->getJson("/api/relatorio/pedidos/{$id}")->assertOk()->assertJsonPath('estado', 'pronto')->assertJsonMissingPath('arquivo');
        $this->assertSame(200, $this->get("/api/relatorio/pedidos/{$id}/arquivo")->getStatusCode());

        Sanctum::actingAs($outro);
        $this->getJson("/api/relatorio/pedidos/{$id}")->assertNotFound();
        $this->getJson("/api/relatorio/pedidos/{$id}/arquivo")->assertNotFound();
    }

    public function test_zip_tambem_sai_pela_fila(): void
    {
        $gestor = $this->pessoa('gestor');
        $this->nota($this->pessoa('colaborador', '', ['regime' => 'cv']));
        $id = $this->pedir($gestor, ['modo' => 'zip'])->json('id');

        $this->artisan('relatorios:processar')->assertSuccessful();

        $p = RelatorioPedido::find($id);
        $this->assertStringEndsWith('.zip', $p->arquivo);
        $zip = new \ZipArchive;
        $this->assertTrue($zip->open($p->arquivo) === true);
        $this->assertNotFalse($zip->locateName('Resumo_Geral_'.self::ANO.'.xlsx'));
        $zip->close();
    }

    public function test_falha_vira_erro_sem_derrubar_o_proximo_da_fila(): void
    {
        $gestor = $this->pessoa('gestor');
        $this->nota($this->pessoa('colaborador', '', ['regime' => 'cv']));
        $ruim = $this->pedir($gestor)->json('id');
        $bom = $this->pedir($gestor, ['modo' => 'zip'])->json('id');

        $real = app(PlanilhasEquipe::class);
        $this->app->instance(PlanilhasEquipe::class, new class($real) extends PlanilhasEquipe
        {
            public function __construct(private PlanilhasEquipe $real) {}

            public function colaboradores(int $ano, array $ids): \Illuminate\Support\Collection
            {
                return $this->real->colaboradores($ano, $ids);
            }

            public function gerar(\Illuminate\Support\Collection $colabs, int $ano, string $modo, string $destino): void
            {
                if ($modo === 'unico') {
                    throw new \RuntimeException('caminho/secreto/do/servidor');
                }
                $this->real->gerar($colabs, $ano, $modo, $destino);
            }
        });

        $this->artisan('relatorios:processar')->assertSuccessful();

        $p = RelatorioPedido::find($ruim);
        $this->assertSame('erro', $p->estado);
        $this->assertStringNotContainsString('secreto', (string) $p->erro);
        $this->assertSame('pronto', RelatorioPedido::find($bom)->estado);
    }

    public function test_pedido_preso_em_gerando_vira_erro(): void
    {
        $gestor = $this->pessoa('gestor');
        $p = RelatorioPedido::create(['id' => (string) Str::uuid(), 'user_id' => $gestor->id, 'tipo' => 'cv-equipe', 'parametros' => ['ano' => self::ANO, 'ids' => [], 'modo' => 'unico'], 'estado' => 'gerando', 'iniciado_em' => now()->subMinutes(41)]);

        $this->artisan('relatorios:processar')->assertSuccessful();

        $this->assertSame('erro', $p->fresh()->estado);
    }

    public function test_arquivo_sai_depois_de_24_horas(): void
    {
        $gestor = $this->pessoa('gestor');
        @mkdir(storage_path('app/relatorios'), 0755, true);
        $velho = storage_path('app/relatorios/velho.xlsx');
        file_put_contents($velho, 'x');
        $novo = storage_path('app/relatorios/novo.xlsx');
        file_put_contents($novo, 'x');
        $base = ['user_id' => $gestor->id, 'tipo' => 'cv-equipe', 'parametros' => [], 'estado' => 'pronto'];
        $a = RelatorioPedido::create($base + ['id' => (string) Str::uuid(), 'arquivo' => $velho, 'concluido_em' => now()->subHours(25)]);
        $b = RelatorioPedido::create($base + ['id' => (string) Str::uuid(), 'arquivo' => $novo, 'concluido_em' => now()->subHours(23)]);

        $this->artisan('relatorios:processar')->assertSuccessful();

        $this->assertNull($a->fresh());
        $this->assertFileDoesNotExist($velho);
        $this->assertNotNull($b->fresh());
        $this->assertFileExists($novo);
    }

    public function test_rodada_em_andamento_nao_gera_duas_vezes(): void
    {
        $gestor = $this->pessoa('gestor');
        $this->nota($this->pessoa('colaborador', '', ['regime' => 'cv']));
        $id = $this->pedir($gestor)->json('id');
        $trava = Cache::lock('relatorios-processar', 60);
        $this->assertTrue((bool) $trava->get());

        $this->artisan('relatorios:processar')->assertSuccessful();

        $this->assertSame('fila', RelatorioPedido::find($id)->estado);
        $trava->release();
    }

    public function test_painel_de_saude_acusa_fila_parada(): void
    {
        $gestor = $this->pessoa('gestor');
        $p = RelatorioPedido::create(['id' => (string) Str::uuid(), 'user_id' => $gestor->id, 'tipo' => 'cv-equipe', 'parametros' => [], 'estado' => 'fila']);
        $texto = 'Planilhas da equipe paradas na fila. Confira o Agendador de tarefas da Locaweb.';

        $this->assertNotContains($texto, app(\App\Services\SaudeSistema::class)->medir()['resumo']['olhar']);

        RelatorioPedido::whereKey($p->id)->update(['created_at' => now()->subMinutes(6)]);
        $this->assertContains($texto, app(\App\Services\SaudeSistema::class)->medir()['resumo']['olhar']);
    }

    public function test_rota_direta_segue_funcionando(): void
    {
        $gestor = $this->pessoa('gestor');
        $this->nota($this->pessoa('colaborador', '', ['regime' => 'cv']));
        Sanctum::actingAs($gestor);

        $this->assertSame(200, $this->get('/api/relatorio/cv-equipe?ano='.self::ANO.'&modo=zip')->getStatusCode());
    }
}
