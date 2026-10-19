<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Justificativa;
use App\Services\PushService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Resend\Laravel\Facades\Resend;
use Tests\TestCase;

/**
 * 19/10/2026 — pedido do Paulo (gestor): no Rastreio, um botão por colaborador que manda uma
 * notificação pedindo justificativa; o colaborador responde pelo app e a resposta volta ao gestor.
 */
class JustificativaTest extends TestCase
{
    use RefreshDatabase;

    private function pessoa(string $nome, string $role = 'colaborador', bool $ativo = true, bool $confirmado = true): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome, 'email' => strtolower(str_replace(' ', '', $nome)).'@teste.local',
            'password' => 'segredo123', 'role' => $role, 'ativo' => $ativo,
        ]);
        if (Colaborador::temConfirmacao() && $confirmado) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function pedir(Colaborador $gestor, Colaborador $alvo, array $extra = [])
    {
        Sanctum::actingAs($gestor);

        return $this->postJson('/api/justificativas', array_replace([
            'colaborador_id' => $alvo->id, 'motivo' => 'Sem lançar há 4 dias', 'mensagem' => 'Aconteceu algo?',
        ], $extra));
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    public function test_gestor_pede_e_o_colaborador_ve_no_sino_so_o_dele(): void
    {
        $gestor = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $bia = $this->pessoa('Bia');

        $this->pedir($gestor, $ana)->assertCreated()
            ->assertJsonPath('status', 'pendente')
            ->assertJsonPath('colaborador_nome', 'Ana')
            ->assertJsonPath('pedido_por_nome', 'Paulo')
            ->assertJsonPath('motivo', 'Sem lançar há 4 dias');

        Sanctum::actingAs($ana);
        $this->getJson('/api/justificativas/sino')->assertOk()->assertJsonCount(1)->assertJsonPath('0.mensagem', 'Aconteceu algo?');

        Sanctum::actingAs($bia);
        $this->getJson('/api/justificativas/sino')->assertOk()->assertJsonCount(0);

        /* o gestor, no sino dele, só vê RESPOSTAS — pedido aberto não é pendência dele */
        Sanctum::actingAs($gestor);
        $this->getJson('/api/justificativas/sino')->assertOk()->assertJsonCount(0);
    }

    public function test_so_gestor_e_admin_pedem(): void
    {
        $ana = $this->pessoa('Ana');
        $bia = $this->pessoa('Bia');

        $this->pedir($ana, $bia)->assertForbidden();
        $this->pedir($this->pessoa('Contador', 'contabilidade'), $bia)->assertForbidden();
        $this->pedir($this->pessoa('Chefe', 'admin'), $bia)->assertCreated();
        $this->assertSame(1, Justificativa::count());
    }

    public function test_contador_nao_enxerga_nem_escreve(): void
    {
        $gestor = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $this->pedir($gestor, $ana)->assertCreated();
        $id = Justificativa::first()->id;

        Sanctum::actingAs($this->pessoa('Contador', 'contabilidade'));
        $this->getJson('/api/justificativas')->assertForbidden();
        $this->getJson('/api/justificativas/sino')->assertForbidden();
        $this->postJson("/api/justificativas/$id/responder", ['resposta' => 'tentando'])->assertForbidden();
        $this->patchJson("/api/justificativas/$id/visto")->assertForbidden();
        $this->deleteJson("/api/justificativas/$id")->assertForbidden();
        $this->assertNull(Justificativa::first()->resposta);
    }

    public function test_so_se_pede_a_colaborador_ativo_liberado_e_nunca_a_si_mesmo(): void
    {
        $gestor = $this->pessoa('Paulo', 'gestor');

        $this->pedir($gestor, $this->pessoa('Outro Gestor', 'gestor'))->assertStatus(422);
        $this->pedir($gestor, $this->pessoa('Contadora', 'contabilidade'))->assertStatus(422);
        $this->pedir($gestor, $this->pessoa('Inativo', 'colaborador', false))->assertStatus(422);
        $this->pedir($gestor, $gestor)->assertStatus(422);
        if (Colaborador::temConfirmacao()) {
            $this->pedir($gestor, $this->pessoa('Novato', 'colaborador', true, false))->assertStatus(422);
        }
        Sanctum::actingAs($gestor);
        $this->postJson('/api/justificativas', ['colaborador_id' => (string) Str::uuid(), 'motivo' => 'qualquer'])->assertNotFound();
        $this->assertSame(0, Justificativa::count());
    }

    public function test_motivo_e_limites_de_tamanho(): void
    {
        $gestor = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');

        $this->pedir($gestor, $ana, ['motivo' => ''])->assertStatus(422)->assertJsonValidationErrors('motivo');
        $this->pedir($gestor, $ana, ['motivo' => 'ab'])->assertStatus(422);
        $this->pedir($gestor, $ana, ['motivo' => str_repeat('x', 201)])->assertStatus(422);
        $this->pedir($gestor, $ana, ['mensagem' => str_repeat('x', 1001)])->assertStatus(422);
        $this->pedir($gestor, $ana, ['mensagem' => '   '])->assertCreated()->assertJsonPath('mensagem', null);   // texto livre é opcional
    }

    public function test_freio_um_aberto_por_vez_e_intervalo_minimo(): void
    {
        Carbon::setTestNow('2026-10-19 15:00:00');   // 12:00 em Brasília
        $gestor = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $bia = $this->pessoa('Bia');

        $this->pedir($gestor, $ana)->assertCreated();
        $r = $this->pedir($gestor, $ana)->assertStatus(422);                     // já há um aguardando
        $this->assertStringContainsString('aguardando resposta', $r->json('message'));
        $this->pedir($gestor, $bia)->assertCreated();                             // outra pessoa não é afetada

        /* Ana responde: pedido fechado, mas o intervalo de 24 h ainda vale */
        Sanctum::actingAs($ana);
        $id = Justificativa::where('colaborador_id', $ana->id)->value('id');
        $this->postJson("/api/justificativas/$id/responder", ['resposta' => 'Estava de atestado.'])->assertOk();
        $r = $this->pedir($gestor, $ana)->assertStatus(422);
        $this->assertStringContainsString('24 h', $r->json('message'));
        $this->assertStringContainsString('12:00', $r->json('message'));        // pedido feito às 12:00 (Brasília)
        $this->assertStringContainsString('20/10 às 12:00', $r->json('message'));   // libera no dia seguinte

        Carbon::setTestNow('2026-10-20 15:01:00');
        $this->pedir($gestor, $ana)->assertCreated();
        $this->assertSame(2, Justificativa::where('colaborador_id', $ana->id)->count());
    }

    public function test_pedido_cancelado_nao_conta_para_o_freio(): void
    {
        Carbon::setTestNow('2026-10-19 15:00:00');
        $gestor = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');

        $this->pedir($gestor, $ana)->assertCreated();
        $id = Justificativa::first()->id;
        Sanctum::actingAs($gestor);
        $this->deleteJson("/api/justificativas/$id")->assertOk()->assertJsonPath('status', 'cancelada');

        $this->pedir($gestor, $ana, ['motivo' => 'Pedido corrigido'])->assertCreated();   // pode pedir de novo na hora

        /* e a Ana, que tinha o pedido cancelado no sino, só vê o novo */
        Sanctum::actingAs($ana);
        $this->getJson('/api/justificativas/sino')->assertOk()->assertJsonCount(1)->assertJsonPath('0.motivo', 'Pedido corrigido');
        $this->postJson("/api/justificativas/$id/responder", ['resposta' => 'tarde demais'])->assertStatus(422);   // cancelado não se responde
    }

    public function test_colaborador_responde_e_a_resposta_volta_ao_gestor(): void
    {
        $gestor = $this->pessoa('Paulo', 'gestor');
        $outroGestor = $this->pessoa('Cleiton', 'admin');
        $ana = $this->pessoa('Ana');
        $this->pedir($gestor, $ana)->assertCreated();
        $id = Justificativa::first()->id;

        Sanctum::actingAs($ana);
        $this->postJson("/api/justificativas/$id/responder", ['resposta' => ''])->assertStatus(422)->assertJsonValidationErrors('resposta');
        $this->postJson("/api/justificativas/$id/responder", ['resposta' => 'Estava sem sinal na fazenda.'])
            ->assertOk()->assertJsonPath('status', 'respondida')->assertJsonPath('resposta', 'Estava sem sinal na fazenda.');
        $this->postJson("/api/justificativas/$id/responder", ['resposta' => 'outra'])->assertStatus(422);   // uma resposta por pedido
        $this->getJson('/api/justificativas/sino')->assertOk()->assertJsonCount(0);                          // saiu do sino dela

        /* quem pediu vê a resposta no sino; o outro gestor não (é do Paulo) */
        Sanctum::actingAs($gestor);
        $this->getJson('/api/justificativas/sino')->assertOk()->assertJsonCount(1)->assertJsonPath('0.resposta', 'Estava sem sinal na fazenda.');
        Sanctum::actingAs($outroGestor);
        $this->getJson('/api/justificativas/sino')->assertOk()->assertJsonCount(0);

        /* "OK, vi" tira do sino — mas continua no histórico/Rastreio */
        Sanctum::actingAs($gestor);
        $this->patchJson("/api/justificativas/$id/visto")->assertOk();
        $this->getJson('/api/justificativas/sino')->assertOk()->assertJsonCount(0);
        $this->getJson('/api/justificativas')->assertOk()->assertJsonCount(1)->assertJsonPath('0.status', 'respondida');
    }

    public function test_colaborador_nao_mexe_no_pedido_dos_outros(): void
    {
        $gestor = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $bia = $this->pessoa('Bia');
        $this->pedir($gestor, $ana)->assertCreated();
        $id = Justificativa::first()->id;

        Sanctum::actingAs($bia);
        $this->postJson("/api/justificativas/$id/responder", ['resposta' => 'Eu respondo pela Ana'])->assertNotFound();
        $this->getJson('/api/justificativas')->assertForbidden();                    // a lista geral é do gestor
        $this->patchJson("/api/justificativas/$id/visto")->assertForbidden();
        $this->deleteJson("/api/justificativas/$id")->assertForbidden();
        $this->postJson('/api/justificativas', ['colaborador_id' => $ana->id, 'motivo' => 'xxx'])->assertForbidden();

        Sanctum::actingAs($gestor);                                                   // nem o gestor responde pelo colaborador
        $this->postJson("/api/justificativas/$id/responder", ['resposta' => 'resposta do gestor'])->assertNotFound();
        $this->assertNull(Justificativa::first()->resposta);
    }

    public function test_nao_cancela_pedido_ja_respondido(): void
    {
        $gestor = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $this->pedir($gestor, $ana)->assertCreated();
        $id = Justificativa::first()->id;
        Sanctum::actingAs($ana);
        $this->postJson("/api/justificativas/$id/responder", ['resposta' => 'Estava doente'])->assertOk();

        Sanctum::actingAs($gestor);
        $this->deleteJson("/api/justificativas/$id")->assertStatus(422);
        $this->assertNull(Justificativa::first()->cancelada_em);
    }

    public function test_rastreio_traz_o_ultimo_pedido_e_quando_libera_um_novo(): void
    {
        Carbon::setTestNow('2026-10-19 15:00:00');
        $gestor = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $bia = $this->pessoa('Bia');
        $this->pedir($gestor, $ana)->assertCreated();

        Sanctum::actingAs($gestor);
        $eq = collect($this->getJson('/api/colaboradores/atividade')->assertOk()->json('equipe'));
        $a = $eq->firstWhere('nome', 'Ana');
        $this->assertSame('pendente', $a['justificativa']['status']);
        $this->assertSame('Paulo', $a['justificativa']['pedido_por_nome']);
        $this->assertStringStartsWith('2026-10-20T15:00:00', $a['justificativa_libera_em']);
        $this->assertNull($eq->firstWhere('nome', 'Bia')['justificativa']);
        $this->assertNull($eq->firstWhere('nome', 'Bia')['justificativa_libera_em']);

        /* cancelado some do cartão e libera na hora */
        $id = Justificativa::first()->id;
        $this->deleteJson("/api/justificativas/$id")->assertOk();
        $a = collect($this->getJson('/api/colaboradores/atividade')->json('equipe'))->firstWhere('nome', 'Ana');
        $this->assertNull($a['justificativa']);
        $this->assertNull($a['justificativa_libera_em']);

        /* passadas as 24 h, o botão volta mesmo com o pedido respondido no cartão */
        $this->pedir($gestor, $ana)->assertCreated();
        Sanctum::actingAs($ana);
        $this->postJson('/api/justificativas/'.Justificativa::latest('created_at')->value('id').'/responder', ['resposta' => 'Feito.'])->assertOk();
        Carbon::setTestNow('2026-10-21 15:00:00');
        Sanctum::actingAs($gestor);
        $a = collect($this->getJson('/api/colaboradores/atividade')->json('equipe'))->firstWhere('nome', 'Ana');
        $this->assertSame('respondida', $a['justificativa']['status']);
        $this->assertNull($a['justificativa_libera_em']);
    }

    public function test_historico_lista_pedidos_respostas_e_cancelamentos(): void
    {
        $gestor = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $bia = $this->pessoa('Bia');
        $this->pedir($gestor, $ana)->assertCreated();
        $this->pedir($gestor, $bia)->assertCreated();
        Sanctum::actingAs($gestor);
        $this->deleteJson('/api/justificativas/'.Justificativa::where('colaborador_id', $bia->id)->value('id'))->assertOk();

        $lista = collect($this->getJson('/api/justificativas')->assertOk()->json());
        $this->assertCount(2, $lista);
        $this->assertSame(['pendente'], $lista->where('colaborador_nome', 'Ana')->pluck('status')->all());
        $cancelada = $lista->firstWhere('colaborador_nome', 'Bia');
        $this->assertSame('cancelada', $cancelada['status']);
        $this->assertSame($gestor->id, $cancelada['cancelada_por']);

        $this->getJson('/api/justificativas?colaborador_id='.$ana->id)->assertOk()->assertJsonCount(1);
        $this->getJson('/api/justificativas?since=2999-01-01T00:00:00Z')->assertOk()->assertJsonCount(0);
    }

    public function test_aviso_por_push_e_email_sem_travar_o_pedido(): void
    {
        $gestor = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');

        /* sem RESEND_API_KEY (como nos testes e em ambiente novo): o pedido sai do mesmo jeito, o motivo fica registrado */
        config(['resend.api_key' => null]);
        $this->pedir($gestor, $ana)->assertCreated()->assertJsonPath('email_enviado', false);
        $j = Justificativa::first();
        $this->assertFalse($j->email_enviado);
        $this->assertStringContainsString('RESEND_API_KEY', (string) $j->email_erro);
    }

    public function test_email_vai_para_o_colaborador_com_reply_para_o_gestor(): void
    {
        config(['resend.api_key' => 're_teste']);
        $falso = new class
        {
            public array $enviados = [];

            public function emails(): object
            {
                return new class($this)
                {
                    public function __construct(private object $dono) {}

                    public function send(array $p): array
                    {
                        $this->dono->enviados[] = $p;

                        return ['id' => 'abc'];
                    }
                };
            }
        };
        Resend::swap($falso);

        $gestor = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $this->pedir($gestor, $ana)->assertCreated()->assertJsonPath('email_enviado', true);
        $this->assertTrue(Justificativa::first()->email_enviado);
        $this->assertCount(1, $falso->enviados);
        $this->assertSame(['ana@teste.local'], $falso->enviados[0]['to']);
        $this->assertSame('paulo@teste.local', $falso->enviados[0]['reply_to']);
        $this->assertStringContainsString('Sem lançar há 4 dias', $falso->enviados[0]['text']);
        $this->assertStringContainsString('Aconteceu algo?', $falso->enviados[0]['text']);

        /* a resposta também avisa quem pediu */
        Sanctum::actingAs($ana);
        $this->postJson('/api/justificativas/'.Justificativa::first()->id.'/responder', ['resposta' => 'Estava de folga.'])->assertOk();
        $this->assertCount(2, $falso->enviados);
        $this->assertSame(['paulo@teste.local'], $falso->enviados[1]['to']);
        $this->assertStringContainsString('Estava de folga.', $falso->enviados[1]['text']);
    }

    public function test_push_vai_para_o_colaborador_e_a_resposta_para_quem_pediu(): void
    {
        $gestor = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $chamadas = [];
        $this->mock(PushService::class, function ($m) use (&$chamadas) {
            $m->shouldReceive('enviar')->andReturnUsing(function ($destino, $titulo, $corpo, $url = '/', $tag = null) use (&$chamadas) {
                $chamadas[] = [$destino->id, $titulo, $corpo, $tag];

                return 1;
            });
        });

        $this->pedir($gestor, $ana)->assertCreated();
        $this->assertCount(1, $chamadas);
        $this->assertSame($ana->id, $chamadas[0][0]);
        $this->assertStringContainsString('Paulo pede uma justificativa', $chamadas[0][2]);

        Sanctum::actingAs($ana);
        $this->postJson('/api/justificativas/'.Justificativa::first()->id.'/responder', ['resposta' => 'Estava de folga.'])->assertOk();
        $this->assertCount(2, $chamadas);
        $this->assertSame($gestor->id, $chamadas[1][0]);
        $this->assertStringContainsString('Ana respondeu: Estava de folga.', $chamadas[1][2]);
    }

    public function test_excluir_colaborador_leva_as_justificativas_dele(): void
    {
        $gestor = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $bia = $this->pessoa('Bia');
        $this->pedir($gestor, $ana)->assertCreated();
        $this->pedir($gestor, $bia)->assertCreated();

        Sanctum::actingAs($gestor);
        $this->postJson("/api/colaboradores/{$ana->id}/excluir", ['confirmacao' => 'EXCLUIR'])->assertOk()->assertJsonPath('justificativas', 1);
        $this->assertSame([$bia->id], Justificativa::pluck('colaborador_id')->all());
    }
}
