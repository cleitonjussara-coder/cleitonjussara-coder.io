<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Http\Controllers\RepasseController;
use App\Models\Repasse;
use App\Models\RepasseEmail;
use App\Services\PushService;
use App\Services\RepasseEmailService;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Mockery;
use Tests\TestCase;

/**
 * 03/11/2026 — pente fino nos repasses.
 *  - O colaborador mudava tipo e data do repasse lançado pelo gestor (HTTP 200):
 *    a proteção só olhava valor, kind, recarga e deleted.
 *  - "Ler se já foi atendido, depois criar o recebido" não era atômico: duas
 *    chamadas juntas criavam dois recebidos, dinheiro em dobro no saldo.
 *
 * Sobre a corrida: o PHPUnit roda num processo só, então há dois tipos de prova.
 *  - armarCorrida() ENCENA a outra chamada logo depois de o pedido ser lido fora de
 *    transação. Só pega o código antigo: no novo não há leitura fora da transação,
 *    e ela nem entra.
 *  - comSegundaConexao() usa banco em ARQUIVO com WAL e uma segunda conexão de
 *    verdade, tentando escrever no meio da transação. É o que prova que a escrita
 *    fica reservada. Duas requisições em paralelo mesmo, nenhum teste daqui faz.
 */
class RepasseIntegridadeTest extends TestCase
{
    use RefreshDatabase;

    /** Corrida armada: a "outra chamada", pronta para entrar na janela. */
    private ?\Closure $outraChamada = null;

    private function pessoa(string $role): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(),
            'nome' => ucfirst($role), 'email' => $role.Str::random(6).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function hoje(): string
    {
        return now('America/Sao_Paulo')->format('Y-m-d');
    }

    /** Data de outro mês, para mes/ano mudarem junto. */
    private function outraData(): string
    {
        return now('America/Sao_Paulo')->subDays(40)->format('Y-m-d');
    }

    private function corpo(Colaborador $dono, array $troca = []): array
    {
        $h = now('America/Sao_Paulo');

        return array_replace([
            'user_id' => $dono->id, 'tipo' => 'RDM', 'valor' => 500, 'data' => $h->format('Y-m-d'),
            'mes' => (int) $h->format('n'), 'ano' => (int) $h->format('Y'),
            'kind' => 'received', 'destino' => null, 'deleted' => false,
        ], $troca);
    }

    /** O que o aparelho manda de volta: o registro inteiro. */
    private function payload(Repasse $r, array $troca = []): array
    {
        return array_replace([
            'user_id' => $r->user_id, 'tipo' => $r->tipo, 'valor' => (float) $r->valor,
            'data' => $r->data->format('Y-m-d'), 'mes' => (int) $r->mes, 'ano' => (int) $r->ano,
            'descricao' => $r->descricao, 'kind' => $r->kind, 'destino' => $r->destino, 'deleted' => false,
        ], $troca);
    }

    private function lancar(Colaborador $quem, Colaborador $dono, array $troca = []): Repasse
    {
        $id = (string) Str::uuid();
        Sanctum::actingAs($quem);
        $this->putJson("/api/repasses/$id", $this->corpo($dono, $troca))->assertOk();

        return Repasse::findOrFail($id);
    }

    private function pedido(Colaborador $dono, array $troca = []): Repasse
    {
        return $this->lancar($dono, $dono, ['kind' => 'requested'] + $troca);
    }

    private function recebidosDe(Repasse $pedido)
    {
        return Repasse::where('user_id', $pedido->user_id)->where('kind', 'received')->where('deleted', false)->get();
    }

    /** Troca o PushService por um espião. Antes da 1ª chamada: a rota guarda o controller. */
    private function espiaoDePush()
    {
        $push = Mockery::spy(PushService::class);
        $this->app->instance(PushService::class, $push);

        return $push;
    }

    /**
     * Arma a corrida: na 1ª leitura do pedido FORA de transação, a outra chamada
     * termina por inteiro (marca o pedido e cria o recebido dela) antes de esta
     * seguir. Escreve por DB::table para não disparar os eventos do modelo.
     */
    private function armarCorrida(Repasse $pedido, Colaborador $outro): void
    {
        $fora = DB::transactionLevel();     // o RefreshDatabase já abre uma
        $this->outraChamada = function () use ($pedido, $outro) {
            /* como a chamada de verdade: pedido já encerrado, ela não cria nada */
            if (DB::table('repasses')->where('id', $pedido->id)->value('atendido_em')) {
                return;
            }
            $h = now('America/Sao_Paulo');
            DB::table('repasses')->insert([
                'id' => (string) Str::uuid(), 'user_id' => $pedido->user_id, 'tipo' => $pedido->tipo,
                'valor' => $pedido->valor, 'data' => $h->format('Y-m-d'), 'mes' => (int) $h->format('n'),
                'ano' => (int) $h->format('Y'), 'kind' => 'received', 'destino' => $pedido->destino,
                'pedido_id' => $pedido->id, 'confirmado_em' => now(), 'confirmado_por' => $outro->id,
                'created_by' => $outro->id, 'updated_by' => $outro->id, 'deleted' => false,
                'created_at' => now(), 'updated_at' => now(),
            ]);
            DB::table('repasses')->where('id', $pedido->id)
                ->update(['atendido_em' => now(), 'atendido_por' => $outro->id]);
        };
        Repasse::retrieved(function (Repasse $m) use ($pedido, $fora) {
            if ($this->outraChamada && $m->id === $pedido->id && DB::transactionLevel() === $fora) {
                $entra = $this->outraChamada;
                $this->outraChamada = null;
                $entra();
            }
        });
    }

    private function desarmarCorrida(): void
    {
        $this->outraChamada = null;
    }

    /**
     * Roda $teste num banco em arquivo com WAL, como o de produção. Depois de $teste chamar $armar(), na
     * 1ª leitura de repasses DENTRO de transação uma segunda conexão tenta gravar, e o resultado fica em
     * $entrou. Sem a escrita reservada ela entra, e a transação em andamento cai em "database is locked"
     * (HTTP 500) ao gravar. O :memory: dos outros testes tem uma conexão só e nunca mostra isso.
     */
    private function comSegundaConexao(\Closure $teste, ?bool &$entrou): void
    {
        $arquivo = tempnam(sys_get_temp_dir(), 'repasse');
        $padrao = config('database.default');
        config([
            'database.connections.arquivo' => ['database' => $arquivo, 'journal_mode' => 'WAL'] + config('database.connections.sqlite'),
            'database.default' => 'arquivo',
        ]);
        $outra = null;
        try {
            Artisan::call('migrate', ['--database' => 'arquivo', '--force' => true]);
            $this->assertSame('wal', DB::selectOne('pragma journal_mode')->journal_mode);

            $outra = new \PDO('sqlite:'.$arquivo);
            $outra->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            $outra->setAttribute(\PDO::ATTR_TIMEOUT, 0);

            $armada = false;
            DB::listen(function (QueryExecuted $q) use (&$entrou, &$armada, $outra) {
                if ($armada && $entrou === null && $q->connectionName === 'arquivo' && DB::transactionLevel() > 0
                    && str_starts_with($q->sql, 'select') && str_contains($q->sql, 'from "repasses"')) {
                    try {
                        $outra->exec("update repasses set descricao = 'outra chamada'");
                        $entrou = true;
                    } catch (\PDOException) {
                        $entrou = false;
                    }
                }
            });

            $teste(function () use (&$armada) {
                $armada = true;
            });
        } finally {
            config(['database.default' => $padrao]);
            DB::purge('arquivo');
            $outra = null;
            foreach (['', '-wal', '-shm'] as $fim) {
                @unlink($arquivo.$fim);
            }
        }
    }

    /* ---------- Ambiente: de nada vale passar rodando o código de outra pasta ---------- */

    public function test_roda_o_controller_desta_pasta(): void
    {
        /* vendor de worktree é link para a pasta principal: sem o bootstrap da worktree, o App\ vem de lá.
           Compara com a pasta deste arquivo; o base_path() também aponta para lá e não acusaria. */
        $arquivo = (new \ReflectionClass(RepasseController::class))->getFileName();

        $this->assertStringStartsWith(
            realpath(dirname(__DIR__, 2).'/app'),
            realpath($arquivo),
            'O autoload pegou o controller de outra pasta. Em worktree, rode com --bootstrap apontando App\\ para ela.'
        );
    }

    /* ---------- Item 5: o que o gestor lançou, só o gestor altera ---------- */

    public function test_colaborador_nao_muda_o_tipo_do_repasse_do_gestor(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $rep = $this->lancar($gestor, $colab);

        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['tipo' => 'RDA']))->assertStatus(403);
        $this->assertSame('RDM', $rep->fresh()->tipo);
    }

    public function test_colaborador_nao_muda_a_data_do_repasse_do_gestor(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $rep = $this->lancar($gestor, $colab);
        $outra = \Illuminate\Support\Carbon::parse($this->outraData());

        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, [
            'data' => $outra->format('Y-m-d'), 'mes' => (int) $outra->format('n'), 'ano' => (int) $outra->format('Y'),
        ]))->assertStatus(403);

        $novo = $rep->fresh();
        $this->assertSame($this->hoje(), $novo->data->format('Y-m-d'));
        $this->assertSame((int) $rep->mes, (int) $novo->mes);
        $this->assertSame((int) $rep->ano, (int) $novo->ano);
    }

    public function test_mes_e_ano_trocados_com_a_mesma_data_nao_movem_o_repasse(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $rep = $this->lancar($gestor, $colab);

        /* mês/ano saem da data: o que veio do aparelho é corrigido, sem recusa */
        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['mes' => $rep->mes % 12 + 1, 'ano' => 2021]))->assertOk();

        $this->assertSame((int) $rep->mes, (int) $rep->fresh()->mes);
        $this->assertSame((int) $rep->ano, (int) $rep->fresh()->ano);
    }

    public function test_colaborador_nao_muda_o_destino_do_repasse_do_gestor(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $recarga = $this->lancar($gestor, $colab, ['destino' => 'recarga']);
        $carteira = $this->lancar($gestor, $colab, ['destino' => 'carteira', 'valor' => 501]);
        $semDestino = $this->lancar($gestor, $colab, ['destino' => null, 'valor' => 502]);

        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/{$recarga->id}", $this->payload($recarga, ['destino' => 'carteira']))->assertStatus(403);
        $this->putJson("/api/repasses/{$recarga->id}", $this->payload($recarga, ['destino' => null]))->assertStatus(403);
        $this->putJson("/api/repasses/{$carteira->id}", $this->payload($carteira, ['destino' => 'recarga']))->assertStatus(403);
        $this->putJson("/api/repasses/{$semDestino->id}", $this->payload($semDestino, ['destino' => 'recarga']))->assertStatus(403);

        $this->assertSame('recarga', $recarga->fresh()->destino);
        $this->assertSame('carteira', $carteira->fresh()->destino);
        $this->assertNull($semDestino->fresh()->destino);
    }

    public function test_sem_destino_e_carteira_valem_o_mesmo(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $carteira = $this->lancar($gestor, $colab, ['destino' => 'carteira']);
        $semDestino = $this->lancar($gestor, $colab, ['destino' => null, 'valor' => 501]);

        /* quem não tem cartão anda com destino null: não é mudança de dinheiro */
        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/{$carteira->id}", $this->payload($carteira, ['destino' => null]))->assertOk();
        $this->putJson("/api/repasses/{$semDestino->id}", $this->payload($semDestino, ['destino' => 'carteira']))->assertOk();
    }

    public function test_colaborador_muda_a_descricao_do_repasse_do_gestor(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $rep = $this->lancar($gestor, $colab);

        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['descricao' => 'conferido']))->assertOk();
        $this->assertSame('conferido', $rep->fresh()->descricao);
    }

    public function test_reenvio_sem_mudanca_continua_passando(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $antigo = $this->lancar($gestor, $colab, ['data' => $this->outraData(), 'valor' => 503]);
        $recarga = $this->lancar($gestor, $colab, ['destino' => 'recarga']);
        $carteira = $this->lancar($gestor, $colab, ['destino' => 'carteira', 'valor' => 501]);
        $semDestino = $this->lancar($gestor, $colab, ['destino' => null, 'valor' => 502]);

        Sanctum::actingAs($colab);
        foreach ([$antigo, $recarga, $carteira, $semDestino] as $rep) {
            $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep))->assertOk();
            $this->assertSame($rep->data->format('Y-m-d'), $rep->fresh()->data->format('Y-m-d'));
        }
        /* a data no formato que o próprio servidor devolve ao aparelho */
        $json = $this->getJson('/api/repasses')->json();
        foreach ($json as $linha) {
            $this->putJson('/api/repasses/'.$linha['id'], $linha)->assertOk();
        }
    }

    public function test_colaborador_nao_desfaz_o_cancelamento_do_gestor(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $rep = $this->lancar($gestor, $colab);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['deleted' => true]))->assertOk();

        /* deleted=false com o resto igual: o dinheiro voltava ao saldo e à planilha */
        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['deleted' => false]))->assertStatus(403);
        $this->assertTrue((bool) $rep->fresh()->deleted);

        /* quem cancelou pode desfazer */
        Sanctum::actingAs($gestor);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['deleted' => false]))->assertOk();
        $this->assertFalse((bool) $rep->fresh()->deleted);
    }

    public function test_reenvio_de_repasse_ja_cancelado_passa_e_ele_segue_cancelado(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $rep = $this->lancar($gestor, $colab);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['deleted' => true]))->assertOk();

        /* o aparelho já sabe do cancelamento: nada muda, não há o que recusar */
        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['deleted' => true]))->assertOk();
        $this->assertTrue((bool) $rep->fresh()->deleted);
    }

    public function test_colaborador_nao_cancela_o_repasse_do_gestor(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $rep = $this->lancar($gestor, $colab);

        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['deleted' => true]))->assertStatus(403);
        $this->assertFalse((bool) $rep->fresh()->deleted);
    }

    public function test_pedido_pago_e_seu_recebido_ficam_protegidos_e_o_reenvio_passa(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $pedido = $this->pedido($colab);
        Sanctum::actingAs($gestor);
        $this->patchJson("/api/repasses/{$pedido->id}/atendido")->assertOk();
        $pedido = $pedido->fresh();
        $recebido = Repasse::where('pedido_id', $pedido->id)->firstOrFail();

        Sanctum::actingAs($colab);
        foreach ([$pedido, $recebido] as $rep) {
            $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['tipo' => 'RDA']))->assertStatus(403);
            $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['data' => $this->outraData()]))->assertStatus(403);
            $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep))->assertOk();
        }
    }

    public function test_gestor_e_admin_mudam_tudo(): void
    {
        $colab = $this->pessoa('colaborador');
        foreach (['gestor', 'admin'] as $papel) {
            $chefe = $this->pessoa($papel);
            $rep = $this->lancar($chefe, $colab, ['valor' => $papel === 'admin' ? 510 : 520, 'destino' => 'recarga']);
            $outra = \Illuminate\Support\Carbon::parse($this->outraData());

            $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, [
                'tipo' => 'RDA', 'data' => $outra->format('Y-m-d'), 'destino' => 'carteira', 'valor' => 77, 'descricao' => 'acerto',
            ]))->assertOk();

            $novo = $rep->fresh();
            $this->assertSame('RDA', $novo->tipo);
            $this->assertSame($outra->format('Y-m-d'), $novo->data->format('Y-m-d'));
            $this->assertSame((int) $outra->format('n'), (int) $novo->mes);
            $this->assertSame((int) $outra->format('Y'), (int) $novo->ano);
            $this->assertSame('carteira', $novo->destino);
            $this->assertEquals(77, $novo->valor);
        }
    }

    public function test_o_que_o_colaborador_registrou_segue_editavel_por_ele(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        /* registro de antes de 05/11/2026, quando o colaborador ainda registrava o recebimento */
        $rep = $this->lancar($gestor, $colab, ['destino' => 'recarga']);
        $rep->forceFill(['created_by' => $colab->id])->save();
        Sanctum::actingAs($colab);
        $outra = \Illuminate\Support\Carbon::parse($this->outraData());

        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, [
            'tipo' => 'RDA', 'data' => $outra->format('Y-m-d'), 'destino' => 'carteira', 'valor' => 123,
        ]))->assertOk();

        $novo = $rep->fresh();
        $this->assertSame('RDA', $novo->tipo);
        $this->assertSame($outra->format('Y-m-d'), $novo->data->format('Y-m-d'));
        $this->assertSame((int) $outra->format('n'), (int) $novo->mes);
        $this->assertSame('carteira', $novo->destino);
        $this->assertEquals(123, $novo->valor);
    }

    public function test_pedido_aberto_do_colaborador_segue_editavel_por_ele(): void
    {
        $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $pedido = $this->pedido($colab);

        $this->putJson("/api/repasses/{$pedido->id}", $this->payload($pedido, ['tipo' => 'RDA', 'data' => $this->outraData()]))->assertOk();
        $this->assertSame('RDA', $pedido->fresh()->tipo);
    }

    public function test_contador_nao_altera_repasse_nem_paga_pedido(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $rep = $this->lancar($gestor, $colab);
        $pedido = $this->pedido($colab);

        Sanctum::actingAs($this->pessoa('contabilidade'));
        $this->putJson("/api/repasses/{$rep->id}", $this->payload($rep, ['tipo' => 'RDA']))->assertStatus(403);
        $this->patchJson("/api/repasses/{$pedido->id}/atendido")->assertStatus(403);
        $this->patchJson("/api/repasses/{$pedido->id}/recebi")->assertStatus(403);
        $this->assertSame('RDM', $rep->fresh()->tipo);
        $this->assertNull($pedido->fresh()->atendido_em);
    }

    /* ---------- Item 7: um pedido, um recebido ---------- */

    public function test_atendido_seguido_de_recebi_cria_um_so_recebido(): void
    {
        $push = $this->espiaoDePush();
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $pedido = $this->pedido($colab);

        Sanctum::actingAs($gestor);
        $this->patchJson("/api/repasses/{$pedido->id}/atendido")->assertOk()->assertJsonPath('ja_estava', false);
        Sanctum::actingAs($colab);
        $this->patchJson("/api/repasses/{$pedido->id}/recebi")->assertOk()->assertJsonPath('ja_estava', true);

        $this->assertCount(1, $this->recebidosDe($pedido));
        $push->shouldHaveReceived('enviar')->once();
        $push->shouldNotHaveReceived('avisarGestores', ['Recebimento confirmado', Mockery::any(), Mockery::any(), Mockery::any()]);
    }

    public function test_chamada_repetida_nao_duplica_nem_avisa_de_novo(): void
    {
        $push = $this->espiaoDePush();
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $pedido = $this->pedido($colab);

        Sanctum::actingAs($gestor);
        $this->patchJson("/api/repasses/{$pedido->id}/atendido")->assertOk();
        $carimbo = DB::table('repasses')->where('id', $pedido->id)->value('updated_at');
        $this->travel(5)->minutes();
        $this->patchJson("/api/repasses/{$pedido->id}/atendido")->assertOk()->assertJsonPath('ja_estava', true);

        $this->assertCount(1, $this->recebidosDe($pedido));
        $push->shouldHaveReceived('enviar')->once();
        /* a chamada repetida não mexe no registro: sem isso o pull incremental baixaria o pedido de novo */
        $this->assertSame($carimbo, DB::table('repasses')->where('id', $pedido->id)->value('updated_at'));
    }

    public function test_corrida_recebi_perde_para_o_atendido_e_nao_duplica(): void
    {
        $push = $this->espiaoDePush();
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $pedido = $this->pedido($colab);

        /* o app antigo leu "em aberto" e o gestor pagou nesse meio tempo: é recusado e não cria nada */
        $this->armarCorrida($pedido, $gestor);
        Sanctum::actingAs($colab);
        $this->patchJson("/api/repasses/{$pedido->id}/recebi")->assertForbidden();
        $this->desarmarCorrida();

        $this->assertCount(1, $this->recebidosDe($pedido));
        $push->shouldNotHaveReceived('avisarGestores', ['Recebimento confirmado', Mockery::any(), Mockery::any(), Mockery::any()]);
    }

    public function test_corrida_atendido_le_o_pedido_dentro_da_transacao(): void
    {
        $this->espiaoDePush();
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $pedido = $this->pedido($colab);

        $this->armarCorrida($pedido, $colab);
        Sanctum::actingAs($gestor);
        $this->patchJson("/api/repasses/{$pedido->id}/atendido")->assertOk();
        $this->desarmarCorrida();

        $this->assertCount(1, $this->recebidosDe($pedido));
    }

    public function test_lancamento_direto_do_gestor_com_pedido_aberto_nao_duplica(): void
    {
        $this->espiaoDePush();
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $pedido = $this->pedido($colab);

        $rep = $this->lancar($gestor, $colab);
        $this->assertSame($pedido->id, $rep->pedido_id);
        $this->assertNotNull($pedido->fresh()->atendido_em);

        /* o colaborador confirma em seguida: encontra o pedido encerrado */
        Sanctum::actingAs($colab);
        $this->patchJson("/api/repasses/{$pedido->id}/recebi")->assertOk()
            ->assertJsonPath('ja_estava', true)->assertJsonPath('recebido.id', $rep->id);

        $this->assertCount(1, $this->recebidosDe($pedido));
    }

    public function test_corrida_lancamento_direto_le_o_pedido_dentro_da_transacao(): void
    {
        $this->espiaoDePush();
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $pedido = $this->pedido($colab);

        $this->armarCorrida($pedido, $colab);
        $this->lancar($gestor, $colab);
        $this->desarmarCorrida();

        $this->assertCount(1, $this->recebidosDe($pedido));
    }

    public function test_outra_conexao_nao_escreve_no_meio_do_atendido(): void
    {
        $this->espiaoDePush();
        $this->comSegundaConexao(function (\Closure $armar) {
            $gestor = $this->pessoa('gestor');
            $colab = $this->pessoa('colaborador');
            $pedido = $this->pedido($colab);

            $armar();
            Sanctum::actingAs($gestor);
            $this->patchJson("/api/repasses/{$pedido->id}/atendido")->assertOk()->assertJsonPath('ja_estava', false);

            $this->assertCount(1, $this->recebidosDe($pedido));
        }, $entrou);

        $this->assertFalse($entrou, 'A outra conexão gravou no meio da transação: a escrita não estava reservada.');
    }

    public function test_outra_conexao_nao_escreve_no_meio_do_lancamento_direto(): void
    {
        $this->espiaoDePush();
        $this->comSegundaConexao(function (\Closure $armar) {
            $gestor = $this->pessoa('gestor');
            $colab = $this->pessoa('colaborador');
            $pedido = $this->pedido($colab);

            $armar();
            $rep = $this->lancar($gestor, $colab);

            $this->assertSame($pedido->id, $rep->pedido_id);
            $this->assertCount(1, $this->recebidosDe($pedido));
        }, $entrou);

        $this->assertFalse($entrou, 'A outra conexão gravou no meio da transação: a escrita não estava reservada.');
    }

    /* ---------- E-mail do pedido: um por pedido, mesmo com reenvio em paralelo ---------- */

    public function test_reenvio_com_o_email_saindo_nao_manda_outro(): void
    {
        $this->espiaoDePush();
        $email = Mockery::spy(RepasseEmailService::class);
        $this->app->instance(RepasseEmailService::class, $email);
        $colab = $this->pessoa('colaborador');
        $id = (string) Str::uuid();
        $corpo = $this->corpo($colab, ['kind' => 'requested']);

        /* a 1ª chamada ainda espera a Resend: a trava está com ela */
        $trava = Cache::lock("repasse-email-$id", 60);
        $this->assertTrue($trava->get());
        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/$id", $corpo)->assertOk();
        $email->shouldNotHaveReceived('enviarSePreciso');

        /* terminou sem conseguir enviar: o próximo reenvio tenta */
        $trava->release();
        $this->putJson("/api/repasses/$id", $corpo)->assertOk();
        $email->shouldHaveReceived('enviarSePreciso')->once();
    }

    public function test_email_que_saiu_enquanto_o_reenvio_gravava_nao_sai_de_novo(): void
    {
        $this->espiaoDePush();
        config(['resend.api_key' => null]);     // sem chave: se tentar enviar, fica a linha do erro
        $colab = $this->pessoa('colaborador');
        $pedido = $this->pedido($colab);
        $tentativas = RepasseEmail::where('repasse_id', $pedido->id)->count();

        /* o registro em mãos diz "não enviado"; a outra chamada marcou enviado logo depois */
        Repasse::saved(fn (Repasse $m) => DB::table('repasses')->where('id', $m->id)->update(['email_sent' => true]));
        $this->putJson("/api/repasses/{$pedido->id}", $this->payload($pedido, ['descricao' => 'reenvio']))->assertOk();

        $this->assertSame($tentativas, RepasseEmail::where('repasse_id', $pedido->id)->count());
    }

    public function test_falha_na_trava_do_email_nao_impede_o_registro(): void
    {
        $this->espiaoDePush();
        $email = Mockery::spy(RepasseEmailService::class);
        $this->app->instance(RepasseEmailService::class, $email);
        Cache::shouldReceive('lock')->andThrow(new \RuntimeException('cache fora do ar'));
        $colab = $this->pessoa('colaborador');
        $id = (string) Str::uuid();

        Sanctum::actingAs($colab);
        $this->putJson("/api/repasses/$id", $this->corpo($colab, ['kind' => 'requested']))->assertOk();

        $this->assertNotNull(Repasse::find($id));
        $email->shouldHaveReceived('enviarSePreciso')->once();
    }

    public function test_atendido_antes_do_lancamento_igual_do_gestor_nao_duplica(): void
    {
        $this->espiaoDePush();
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $pedido = $this->pedido($colab);

        Sanctum::actingAs($gestor);
        $this->patchJson("/api/repasses/{$pedido->id}/atendido")->assertOk();

        $this->putJson('/api/repasses/'.Str::uuid(), $this->corpo($colab))->assertStatus(422);

        $this->assertCount(1, $this->recebidosDe($pedido));
    }

    public function test_falha_no_meio_nao_deixa_recebido_sem_pedido_encerrado(): void
    {
        $this->espiaoDePush();
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $pedido = $this->pedido($colab);

        /* cai depois de criar o recebido: sem transação ele ficava, e o reenvio criava outro */
        Repasse::saving(function (Repasse $m) use ($pedido) {
            if ($m->id === $pedido->id) {
                throw new \RuntimeException('queda simulada');
            }
        });
        Sanctum::actingAs($gestor);
        $this->patchJson("/api/repasses/{$pedido->id}/atendido")->assertStatus(500);

        $this->assertCount(0, $this->recebidosDe($pedido));
        $this->assertNull(Repasse::findOrFail($pedido->id)->atendido_em);
    }
}
