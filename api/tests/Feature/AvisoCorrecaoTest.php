<?php

namespace Tests\Feature;

use App\Models\AvisoCorrecao;
use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\PushService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Resend\Laravel\Facades\Resend;
use Tests\TestCase;

/**
 * 24/10/2026 — pedido do Cleiton: no quadro "O que falta corrigir", o gestor/admin avisa o dono da nota
 * (celular + sino + e-mail) para ele corrigi-la. Sem resposta em texto: o aviso sai do sino com "OK, vi"
 * ou quando a nota deixa de ter pendência.
 */
class AvisoCorrecaoTest extends TestCase
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

    private function nota(?Colaborador $dono, array $campos = []): Nota
    {
        $agora = now('America/Sao_Paulo');
        $n = new Nota(array_replace([
            'id' => (string) Str::uuid(), 'user_id' => $dono?->id, 'tipo' => 'RDM', 'valor' => 23.2,
            'data' => $agora->format('Y-m-d'), 'mes' => (int) $agora->format('n'), 'ano' => (int) $agora->format('Y'),
            'razao_social' => 'PAPELARIA CENTRAL', 'deleted' => false,
        ], $campos));
        $n->save();

        return $n->fresh();
    }

    private function avisar(Colaborador $quem, Nota $nota, array $extra = [])
    {
        Sanctum::actingAs($quem);

        return $this->postJson('/api/avisos-correcao', array_replace([
            'nota_id' => $nota->id, 'motivos' => ['sem CNPJ'], 'mensagem' => 'Confere no cupom?',
        ], $extra));
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        AvisoCorrecao::esquecerTabela();

        parent::tearDown();
    }

    private object $resendFalso;

    /** Resend falso (os e-mails ficam em $this->resendFalso->enviados) + PushService espião (anota em $pushes). */
    private function canais(array &$pushes, bool $pushQuebra = false): void
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
        $this->resendFalso = $falso;
        $this->mock(PushService::class, function ($m) use (&$pushes, $pushQuebra) {
            $m->shouldReceive('enviar')->andReturnUsing(function ($destino, $titulo, $corpo, $url, $tag) use (&$pushes, $pushQuebra) {
                if ($pushQuebra) {
                    throw new \RuntimeException('push fora do ar');
                }
                $pushes[] = ['para' => $destino->id, 'titulo' => $titulo, 'corpo' => $corpo, 'url' => $url, 'tag' => $tag];

                return 1;
            });
        });
    }

    public function test_gestor_avisa_o_dono_da_nota_com_push_e_email(): void
    {
        $pushes = [];
        $this->canais($pushes);
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $nota = $this->nota($ana);

        $this->avisar($paulo, $nota, ['motivos' => ['sem CNPJ', 'sem nº da nota']])
            ->assertCreated()
            ->assertJsonPath('nota_id', $nota->id)
            ->assertJsonPath('colaborador_id', $ana->id)
            ->assertJsonPath('pedido_por_nome', 'Paulo')
            ->assertJsonPath('motivos', ['sem CNPJ', 'sem nº da nota'])
            ->assertJsonPath('nota_titulo', 'PAPELARIA CENTRAL')
            ->assertJsonPath('email_enviado', true);

        $a = AvisoCorrecao::firstOrFail();
        $this->assertNull($a->visto_em);
        $this->assertEquals(23.2, $a->nota_valor);

        $this->assertCount(1, $pushes);
        $this->assertSame($ana->id, $pushes[0]['para']);
        $this->assertSame('Corrija uma nota', $pushes[0]['titulo']);
        $this->assertStringContainsString('Paulo pede para corrigir a nota PAPELARIA CENTRAL (sem CNPJ, sem nº da nota)', $pushes[0]['corpo']);
        $this->assertStringContainsString('Confere no cupom?', $pushes[0]['corpo']);
        $this->assertSame('./?abrir=sino', $pushes[0]['url']);
        $this->assertSame('correcao-'.$ana->id, $pushes[0]['tag'], 'a tag é por colaborador: avisos seguidos viram uma notificação só no celular');

        $emails = $this->resendFalso->enviados;
        $this->assertCount(1, $emails);
        $this->assertSame(['ana@teste.local'], $emails[0]['to']);
        $this->assertSame('paulo@teste.local', $emails[0]['reply_to']);
        $this->assertStringContainsString('PAPELARIA CENTRAL', $emails[0]['text']);
        $this->assertStringContainsString('O que falta: sem CNPJ, sem nº da nota', $emails[0]['text']);
        $this->assertStringContainsString('Mensagem: Confere no cupom?', $emails[0]['text']);
        $this->assertStringContainsString('R$ 23,20', $emails[0]['text']);
    }

    public function test_admin_tambem_avisa(): void
    {
        $pushes = [];
        $this->canais($pushes);
        $this->avisar($this->pessoa('Cleiton', 'admin'), $this->nota($this->pessoa('Ana')))->assertCreated();
        $this->assertCount(1, $pushes);
    }

    public function test_falha_de_push_ou_de_email_nao_impede_o_aviso(): void
    {
        $pushes = [];
        $this->canais($pushes, pushQuebra: true);
        config(['resend.api_key' => null]);   // e-mail também não sai
        $ana = $this->pessoa('Ana');

        $this->avisar($this->pessoa('Paulo', 'gestor'), $this->nota($ana))
            ->assertCreated()
            ->assertJsonPath('email_enviado', false);

        $this->assertSame(1, AvisoCorrecao::count(), 'o aviso ficou gravado e aparece no sino');
        $this->assertStringContainsString('RESEND_API_KEY', (string) AvisoCorrecao::first()->email_erro);
    }

    public function test_so_gestor_e_admin_avisam(): void
    {
        $ana = $this->pessoa('Ana');
        $nota = $this->nota($ana);

        $this->avisar($this->pessoa('Bia'), $nota)->assertForbidden();
        $this->avisar($ana, $nota)->assertForbidden();
        $this->avisar($this->pessoa('Patricia', 'contabilidade'), $nota)->assertForbidden()->assertJsonPath('somente_leitura', true);
        $this->assertSame(0, AvisoCorrecao::count());
    }

    public function test_regras_de_quem_pode_ser_avisado(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');

        $this->avisar($paulo, $this->nota($ana, ['id' => (string) Str::uuid()]), ['nota_id' => (string) Str::uuid()])->assertNotFound();
        $this->avisar($paulo, $this->nota($ana, ['deleted' => true]))->assertStatus(422)->assertJsonPath('message', 'Esta nota está na lixeira — não há o que corrigir.');
        $this->avisar($paulo, $this->nota(null, ['pagamento' => 'empresa']))->assertStatus(422)->assertJsonPath('message', 'Nota de Faturamento sem colaborador não tem a quem avisar.');
        $this->avisar($paulo, $this->nota($paulo))->assertStatus(422)->assertJsonPath('message', 'A nota é sua: corrija direto.');
        $this->avisar($paulo, $this->nota($this->pessoa('Outro Gestor', 'gestor')))->assertStatus(422);
        $this->avisar($paulo, $this->nota($this->pessoa('Cleiton', 'admin')))->assertStatus(422);
        $this->avisar($paulo, $this->nota($this->pessoa('Desativado', 'colaborador', ativo: false)))->assertStatus(422);
        $this->avisar($paulo, $this->nota($this->pessoa('Pendente', 'colaborador', confirmado: false)))->assertStatus(422);
        $this->assertSame(0, AvisoCorrecao::count());
    }

    public function test_validacao_dos_motivos_e_da_mensagem(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor');
        $nota = $this->nota($this->pessoa('Ana'));

        $this->avisar($paulo, $nota, ['motivos' => []])->assertStatus(422);
        $this->avisar($paulo, $nota, ['motivos' => null])->assertStatus(422);
        $this->avisar($paulo, $nota, ['motivos' => array_fill(0, 9, 'x')])->assertStatus(422);
        $this->avisar($paulo, $nota, ['motivos' => [str_repeat('a', 61)]])->assertStatus(422);
        $this->avisar($paulo, $nota, ['mensagem' => str_repeat('a', 501)])->assertStatus(422);
        $this->avisar($paulo, $nota, ['mensagem' => '   '])->assertCreated();
        $this->assertNull(AvisoCorrecao::first()->mensagem, 'mensagem só com espaços não vira texto');
    }

    public function test_a_mesma_nota_so_e_avisada_de_novo_depois_do_intervalo(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $nota = $this->nota($ana);
        $outra = $this->nota($ana, ['razao_social' => 'POSTO']);

        $this->avisar($paulo, $nota)->assertCreated();
        $this->avisar($paulo, $nota)->assertStatus(422)->assertJsonPath('message', fn ($m) => str_contains($m, 'já recebeu o aviso desta nota'));
        $this->avisar($this->pessoa('Cleiton', 'admin'), $nota)->assertStatus(422);
        $this->avisar($paulo, $outra)->assertCreated();   // outra nota da mesma pessoa não é barrada

        /* dispensar não libera: o intervalo conta desde o aviso */
        Sanctum::actingAs($ana);
        $this->patchJson('/api/avisos-correcao/'.AvisoCorrecao::where('nota_id', $nota->id)->value('id').'/visto')->assertOk();
        $this->avisar($paulo, $nota)->assertStatus(422);

        Carbon::setTestNow(now()->addHours(11));
        $this->avisar($paulo, $nota)->assertStatus(422);
        Carbon::setTestNow(now()->addHours(2));   // 13 h depois do primeiro
        $this->avisar($paulo, $nota)->assertCreated();
        $this->assertSame(3, AvisoCorrecao::count());
    }

    public function test_intervalo_zero_desliga_o_freio(): void
    {
        config(['petermann.aviso_correcao.intervalo_horas' => 0]);
        $paulo = $this->pessoa('Paulo', 'gestor');
        $nota = $this->nota($this->pessoa('Ana'));

        $this->avisar($paulo, $nota)->assertCreated();
        $this->avisar($paulo, $nota)->assertCreated();
    }

    public function test_sino_do_colaborador_traz_so_os_avisos_abertos_dele(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $bia = $this->pessoa('Bia');
        $daAna = $this->nota($ana);
        $daBia = $this->nota($bia);
        $this->avisar($paulo, $daAna)->assertCreated();
        $this->avisar($paulo, $daBia)->assertCreated();

        Sanctum::actingAs($ana);
        $lista = $this->getJson('/api/avisos-correcao/sino')->assertOk()->json();
        $this->assertCount(1, $lista);
        $this->assertSame($daAna->id, $lista[0]['nota_id']);
        $this->assertSame('Paulo', $lista[0]['pedido_por_nome']);
        $this->assertSame(['sem CNPJ'], $lista[0]['motivos']);
        $this->assertSame('Confere no cupom?', $lista[0]['mensagem']);

        /* gestor e admin não têm aviso no sino */
        Sanctum::actingAs($paulo);
        $this->getJson('/api/avisos-correcao/sino')->assertOk()->assertExactJson([]);
        /* contador: módulo fechado */
        Sanctum::actingAs($this->pessoa('Patricia', 'contabilidade'));
        $this->getJson('/api/avisos-correcao/sino')->assertForbidden();
    }

    public function test_sino_esconde_aviso_visto_nota_na_lixeira_nota_trocada_de_dono_e_aviso_velho(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $bia = $this->pessoa('Bia');
        $notas = [];
        foreach (['vista', 'lixeira', 'trocada', 'velha', 'aberta'] as $i => $rotulo) {
            $notas[$rotulo] = $this->nota($ana, ['razao_social' => strtoupper($rotulo)]);
            $this->avisar($paulo, $notas[$rotulo])->assertCreated();
        }

        Sanctum::actingAs($ana);
        $this->patchJson('/api/avisos-correcao/'.AvisoCorrecao::where('nota_id', $notas['vista']->id)->value('id').'/visto')->assertOk();
        Nota::where('id', $notas['lixeira']->id)->update(['deleted' => true]);
        Nota::where('id', $notas['trocada']->id)->update(['user_id' => $bia->id]);
        AvisoCorrecao::where('nota_id', $notas['velha']->id)->update(['created_at' => now()->subDays(31)]);

        $titulos = collect($this->getJson('/api/avisos-correcao/sino')->assertOk()->json())->pluck('nota_titulo')->all();
        $this->assertSame(['ABERTA'], $titulos);
    }

    public function test_dispensar_so_vale_para_o_dono_do_aviso_e_e_idempotente(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $this->avisar($paulo, $this->nota($ana))->assertCreated();
        $id = AvisoCorrecao::value('id');

        Sanctum::actingAs($this->pessoa('Bia'));
        $this->patchJson("/api/avisos-correcao/$id/visto")->assertNotFound();
        Sanctum::actingAs($paulo);
        $this->patchJson("/api/avisos-correcao/$id/visto")->assertNotFound();
        $this->assertNull(AvisoCorrecao::first()->visto_em);

        Sanctum::actingAs($ana);
        $this->patchJson("/api/avisos-correcao/$id/visto")->assertOk()->assertJsonPath('id', $id);
        $primeiro = AvisoCorrecao::first()->visto_em;
        $this->assertNotNull($primeiro);
        Carbon::setTestNow(now()->addMinutes(5));
        $this->patchJson("/api/avisos-correcao/$id/visto")->assertOk();
        $this->assertEquals($primeiro->timestamp, AvisoCorrecao::first()->visto_em->timestamp, 'dispensar de novo não muda o carimbo');
        $this->getJson('/api/avisos-correcao/sino')->assertOk()->assertExactJson([]);
    }

    public function test_gestor_ve_o_ultimo_aviso_de_cada_nota_e_colaborador_nao_ve(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $a = $this->nota($ana);
        $b = $this->nota($ana, ['razao_social' => 'POSTO']);
        $semAviso = $this->nota($ana, ['razao_social' => 'FARMACIA']);
        config(['petermann.aviso_correcao.intervalo_horas' => 0]);
        $this->avisar($paulo, $a, ['mensagem' => 'primeiro'])->assertCreated();
        Carbon::setTestNow(now()->addMinute());
        $this->avisar($paulo, $a, ['mensagem' => 'segundo'])->assertCreated();
        $this->avisar($paulo, $b)->assertCreated();

        Sanctum::actingAs($paulo);
        $r = $this->getJson('/api/avisos-correcao?nota_ids='.implode(',', [$a->id, $b->id, $semAviso->id]))->assertOk()->json();
        $porNota = collect($r)->keyBy('nota_id');
        $this->assertCount(2, $r, 'um por nota, só das que foram avisadas');
        $this->assertSame('segundo', $porNota[$a->id]['mensagem'], 'vale o aviso mais recente');
        $this->assertFalse($porNota->has($semAviso->id));
        $this->assertSame('Paulo', $porNota[$b->id]['pedido_por_nome']);
        $this->getJson('/api/avisos-correcao')->assertOk()->assertExactJson([]);

        Sanctum::actingAs($ana);
        $this->getJson('/api/avisos-correcao?nota_ids='.$a->id)->assertForbidden();
    }

    public function test_sem_a_tabela_a_api_nao_quebra(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $nota = $this->nota($ana);
        Schema::drop('avisos_correcao');
        AvisoCorrecao::esquecerTabela();

        $this->avisar($paulo, $nota)->assertStatus(503);
        $this->getJson('/api/avisos-correcao?nota_ids='.$nota->id)->assertOk()->assertExactJson([]);
        Sanctum::actingAs($ana);
        $this->getJson('/api/avisos-correcao/sino')->assertOk()->assertExactJson([]);
        $this->patchJson('/api/avisos-correcao/x/visto')->assertStatus(503);
    }

    public function test_excluir_colaborador_leva_os_avisos_dele(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $bia = $this->pessoa('Bia');
        $this->avisar($paulo, $this->nota($ana))->assertCreated();
        $this->avisar($paulo, $this->nota($bia))->assertCreated();

        Sanctum::actingAs($paulo);
        $this->postJson("/api/colaboradores/{$ana->id}/excluir", ['confirmacao' => 'EXCLUIR'])->assertOk()->assertJsonPath('avisos_correcao', 1);
        $this->assertSame([$bia->id], AvisoCorrecao::pluck('colaborador_id')->all());
    }

    /* ── revisão independente de 24/10/2026 ─────────────────────────────────────────────── */

    public function test_avisos_seguidos_ao_mesmo_colaborador_viram_um_celular_e_um_email(): void
    {
        $pushes = [];
        $this->canais($pushes);
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $bia = $this->pessoa('Bia');
        $notas = [$this->nota($ana, ['razao_social' => 'A']), $this->nota($ana, ['razao_social' => 'B']), $this->nota($ana, ['razao_social' => 'C'])];

        $primeiro = $this->avisar($paulo, $notas[0])->assertCreated()->assertJsonPath('agrupado', false);
        $this->avisar($paulo, $notas[1])->assertCreated()->assertJsonPath('agrupado', true)->assertJsonPath('email_enviado', false);
        $this->avisar($paulo, $notas[2])->assertCreated()->assertJsonPath('agrupado', true);
        $this->avisar($paulo, $this->nota($bia))->assertCreated()->assertJsonPath('agrupado', false);   // outra pessoa não é agrupada

        $this->assertCount(2, $pushes, 'um celular para a Ana e um para a Bia');
        $this->assertCount(2, $this->resendFalso->enviados, 'um e-mail para cada');
        $this->assertSame(4, AvisoCorrecao::count(), 'mas os 4 avisos existem');

        Sanctum::actingAs($ana);
        $this->assertCount(3, $this->getJson('/api/avisos-correcao/sino')->assertOk()->json(), 'e o sino da Ana mostra os 3');
        $this->assertSame($primeiro->json('id'), AvisoCorrecao::where('agrupado', false)->where('colaborador_id', $ana->id)->value('id'));
    }

    public function test_a_janela_de_agrupamento_conta_do_ultimo_aviso_que_notificou(): void
    {
        $pushes = [];
        $this->canais($pushes);
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $a = $this->nota($ana, ['razao_social' => 'A']);
        $b = $this->nota($ana, ['razao_social' => 'B']);
        $c = $this->nota($ana, ['razao_social' => 'C']);

        $this->avisar($paulo, $a)->assertCreated();                                       // t0: notifica
        Carbon::setTestNow(now()->addMinutes(6));
        $this->avisar($paulo, $b)->assertCreated()->assertJsonPath('agrupado', true);       // t0+6: dentro da janela de 10 min
        Carbon::setTestNow(now()->addMinutes(5));
        $this->avisar($paulo, $c)->assertCreated()->assertJsonPath('agrupado', false);      // t0+11: passou da janela do ÚLTIMO QUE NOTIFICOU

        $this->assertCount(2, $pushes);
    }

    public function test_agrupar_minutos_zero_notifica_cada_aviso(): void
    {
        config(['petermann.aviso_correcao.agrupar_minutos' => 0]);
        $pushes = [];
        $this->canais($pushes);
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');

        $this->avisar($paulo, $this->nota($ana))->assertCreated()->assertJsonPath('agrupado', false);
        $this->avisar($paulo, $this->nota($ana))->assertCreated()->assertJsonPath('agrupado', false);
        $this->assertCount(2, $pushes);
    }

    public function test_ok_vi_tira_todos_os_avisos_abertos_da_mesma_nota(): void
    {
        config(['petermann.aviso_correcao.intervalo_horas' => 0, 'petermann.aviso_correcao.agrupar_minutos' => 0]);
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $nota = $this->nota($ana);
        $outra = $this->nota($ana, ['razao_social' => 'OUTRA']);
        $this->avisar($paulo, $nota)->assertCreated();
        $this->avisar($paulo, $nota)->assertCreated();
        $this->avisar($paulo, $outra)->assertCreated();

        Sanctum::actingAs($ana);
        $this->patchJson('/api/avisos-correcao/'.AvisoCorrecao::where('nota_id', $nota->id)->value('id').'/visto')->assertOk();

        $this->assertSame(0, AvisoCorrecao::where('nota_id', $nota->id)->whereNull('visto_em')->count(), 'os dois avisos da nota foram dispensados');
        $this->assertSame(1, AvisoCorrecao::where('nota_id', $outra->id)->whereNull('visto_em')->count(), 'o da outra nota continua aberto');
        $titulos = collect($this->getJson('/api/avisos-correcao/sino')->assertOk()->json())->pluck('nota_titulo')->all();
        $this->assertSame(['OUTRA'], $titulos);
    }

    public function test_sino_traz_os_cinquenta_avisos_mais_novos_em_ordem_cronologica(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        for ($i = 1; $i <= 52; $i++) {   // direto no banco: pelo POST, 52 chamadas esbarrariam no throttle de 30/min
            $nota = $this->nota($ana, ['razao_social' => sprintf('NOTA %02d', $i)]);
            $a = AvisoCorrecao::create(['nota_id' => $nota->id, 'colaborador_id' => $ana->id, 'pedido_por' => $paulo->id, 'motivos' => ['sem CNPJ'], 'nota_titulo' => sprintf('NOTA %02d', $i)]);
            $a->forceFill(['created_at' => now()->subMinutes(100 - $i)])->saveQuietly();   // 01 = mais velha, 52 = mais nova
        }

        Sanctum::actingAs($ana);
        $titulos = collect($this->getJson('/api/avisos-correcao/sino')->assertOk()->json())->pluck('nota_titulo');
        $this->assertCount(50, $titulos);
        $this->assertSame('NOTA 03', $titulos->first(), 'as 2 mais velhas ficaram de fora');
        $this->assertSame('NOTA 52', $titulos->last());
    }

    public function test_apagar_a_nota_em_definitivo_leva_os_avisos_dela(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor');
        $ana = $this->pessoa('Ana');
        $nota = $this->nota($ana);
        $this->avisar($paulo, $nota)->assertCreated();
        $outra = $this->nota($ana, ['razao_social' => 'OUTRA']);
        $this->avisar($paulo, $outra)->assertCreated();
        Nota::where('id', $nota->id)->update(['deleted' => true]);   // só nota na lixeira é apagada em definitivo por não-dono

        Sanctum::actingAs($paulo);
        $this->deleteJson("/api/notas/{$nota->id}")->assertOk();

        $this->assertSame(0, AvisoCorrecao::where('nota_id', $nota->id)->count());
        $this->assertSame(1, AvisoCorrecao::where('nota_id', $outra->id)->count());
    }
}
