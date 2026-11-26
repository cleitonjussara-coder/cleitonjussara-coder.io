<?php

namespace Tests\Feature;

use App\Models\AtividadeCampo;
use App\Models\Colaborador;
use App\Services\PushService;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * 11/11/2026 — acompanhamento de trabalho solitário: quem está em campo há muitas horas sem finalizar gera aviso no celular de
 * quem acompanha (gestor, admin e focal), uma vez por atividade. Desde 12/11/2026: todos juntos; desde 24/11/2026: com 3 h.
 */
class CampoVerificarTest extends TestCase
{
    use RefreshDatabase;

    private array $pushes = [];
    private array $lembretes = [];

    protected function setUp(): void
    {
        parent::setUp();
        $this->mock(PushService::class, function ($m) {
            $m->shouldReceive('enviar')->andReturnUsing(function ($destino, $titulo, $corpo, $url, $tag) {
                if (str_starts_with((string) $tag, 'campo-eu-')) {
                    $this->lembretes[] = ['para' => $destino->nome, 'titulo' => $titulo, 'corpo' => $corpo, 'url' => $url, 'tag' => $tag];

                    return 1;
                }
                $this->pushes[] = ['para' => collect($destino)->pluck('nome')->sort()->values()->all(), 'titulo' => $titulo, 'corpo' => $corpo, 'url' => $url, 'tag' => $tag];

                return 1;
            });
        });
        Carbon::setTestNow(Carbon::parse('2026-11-11T15:00:00-03:00'));
    }

    private function pessoa(string $nome, string $role = 'colaborador', array $extra = []): Colaborador
    {
        $c = new Colaborador(['id' => (string) Str::uuid(), 'nome' => $nome, 'email' => strtolower($nome).'@teste.local',
            'password' => 'segredo123', 'role' => $role]);
        $c->forceFill($extra + ['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c->fresh();
    }

    /** hora de parede de Brasília, como o controller grava */
    private function campo(Colaborador $c, string $inicio, ?string $fim = null, string $campo = 'BRCB147'): AtividadeCampo
    {
        return AtividadeCampo::create(['id' => (string) Str::uuid(), 'user_id' => $c->id, 'fazenda' => 'Faz. São José',
            'campo' => $campo, 'inicio' => Carbon::parse($inicio), 'fim' => $fim ? Carbon::parse($fim) : null]);
    }

    /* 24/11/2026 — caso Romário: quem está em campo também é lembrado, com 3 h e de novo a cada 2 h */
    public function test_lembra_a_propria_pessoa_com_3h_e_a_cada_2h(): void
    {
        $this->pessoa('Paulo', 'gestor');
        $romario = $this->pessoa('Romario', 'colaborador', ['atividade_campo' => true]);
        $a = $this->campo($romario, '2026-11-11 12:10:00');           // 2h50
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertSame([], $this->lembretes);

        Carbon::setTestNow(Carbon::parse('2026-11-11T15:10:00-03:00'));
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(1, $this->lembretes);
        $this->assertSame('Romario', $this->lembretes[0]['para']);
        $this->assertSame('⏰ Você está em campo há 3h', $this->lembretes[0]['titulo']);
        $this->assertSame('./?abrir=campo', $this->lembretes[0]['url']);
        $this->assertSame('campo-eu-'.$a->id, $this->lembretes[0]['tag']);

        Carbon::setTestNow(Carbon::parse('2026-11-11T16:40:00-03:00'));
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(1, $this->lembretes, 'ainda não passaram 2 h');
        Carbon::setTestNow(Carbon::parse('2026-11-11T17:10:00-03:00'));
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(2, $this->lembretes);
        $this->assertCount(2, $this->pushes, 'a gestão: primeiro aviso e, sem confirmação, o segundo (26/11/2026)');

        $a->update(['fim' => Carbon::parse('2026-11-11 17:20:00')]);
        Carbon::setTestNow(Carbon::parse('2026-11-11T20:10:00-03:00'));
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(2, $this->lembretes, 'registrou a saída: para de lembrar');
    }

    /* 24/11/2026 — pedido do Paulo: com 3 h (era 2h30), um aviso só, ao mesmo tempo para o focal e o gestor */
    public function test_com_3h_avisa_focal_e_gestor_juntos_uma_vez(): void
    {
        $this->pessoa('Paulo', 'gestor');
        $this->pessoa('Focal', 'colaborador', ['focal_campo' => true]);
        $this->pessoa('Joao');                                      // colaborador comum: não recebe
        $romario = $this->pessoa('Romario', 'colaborador', ['atividade_campo' => true]);
        $this->campo($romario, '2026-11-11 12:40:00');               // 2h20: ainda não
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertSame([], $this->pushes);
        Carbon::setTestNow(Carbon::parse('2026-11-11T15:30:00-03:00'));   // 2h50: antes já avisava
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertSame([], $this->pushes);

        Carbon::setTestNow(Carbon::parse('2026-11-11T15:40:00-03:00'));   // 3h
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(1, $this->pushes, 'um aviso só, para todos');
        $this->assertSame(['Focal', 'Paulo'], $this->pushes[0]['para']);
        $this->assertSame('⚠️ Romario em campo há 3h', $this->pushes[0]['titulo']);
        $this->assertStringContainsString('Faz. São José · campo BRCB147, desde 12:40', $this->pushes[0]['corpo']);
        $this->assertSame('./?abrir=campo', $this->pushes[0]['url']);

        Carbon::setTestNow(Carbon::parse('2026-11-11T19:00:00-03:00'));   // sem confirmação: o segundo aviso (26/11/2026)
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(2, $this->pushes);
        Carbon::setTestNow(Carbon::parse('2026-11-11T21:00:00-03:00'));   // e não repete mais
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(2, $this->pushes);
    }

    public function test_sem_focal_o_gestor_recebe_sozinho(): void
    {
        $this->pessoa('Paulo', 'gestor');
        $romario = $this->pessoa('Romario', 'colaborador', ['atividade_campo' => true]);
        $this->campo($romario, '2026-11-11 12:00:00');

        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertSame(['Paulo'], $this->pushes[0]['para']);
        $this->assertSame('⚠️ Romario em campo há 3h', $this->pushes[0]['titulo']);
    }

    public function test_quem_so_avisou_o_focal_no_sistema_antigo_ainda_avisa_o_gestor(): void
    {
        $this->pessoa('Paulo', 'gestor');
        $this->pessoa('Focal', 'colaborador', ['focal_campo' => true]);
        $romario = $this->pessoa('Romario', 'colaborador', ['atividade_campo' => true]);
        $a = $this->campo($romario, '2026-11-11 10:00:00');
        \Illuminate\Support\Facades\Cache::put('campo-alerta-'.$a->id, 'antigo', now()->addDays(3));

        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertSame(['Focal', 'Paulo'], $this->pushes[0]['para']);
    }

    public function test_nao_avisa_curto_finalizado_antigo_ou_apagado(): void
    {
        $this->pessoa('Paulo', 'gestor');
        $r = $this->pessoa('Romario', 'colaborador', ['atividade_campo' => true]);
        $this->campo($r, '2026-11-11 13:30:00', null, 'CURTO');                          // só 1h30
        $this->campo($r, '2026-11-11 07:00:00', '2026-11-11 12:00:00', 'FECHADO');       // finalizado
        $this->campo($r, '2026-11-09 07:00:00', null, 'ESQUECIDO');                      // aberto há dias
        $apagado = $this->campo($r, '2026-11-11 08:00:00', null, 'APAGADO');
        if (AtividadeCampo::temLixeira()) {
            $apagado->forceFill(['apagado_em' => now()])->save();
        } else {
            $apagado->delete();
        }

        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertSame([], $this->pushes);
    }

    public function test_focal_em_campo_nao_recebe_aviso_de_si_mesmo(): void
    {
        $this->pessoa('Paulo', 'gestor');
        $focal = $this->pessoa('Focal', 'colaborador', ['focal_campo' => true, 'atividade_campo' => true]);
        $this->pessoa('Bia', 'colaborador', ['focal_campo' => true]);
        $this->campo($focal, '2026-11-11 10:00:00');

        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertSame(['Bia', 'Paulo'], $this->pushes[0]['para']);
    }

    /* 13/11/2026 — pedido do Cleiton: depois do aviso das 3 h, a saída registrada manda outro aviso, com a mesma tag
       (troca o "sem fim registrado" no celular). Sem o aviso das 3 h, a saída não avisa ninguém. */
    public function test_saida_depois_do_aviso_manda_outro_com_a_mesma_tag(): void
    {
        $this->pessoa('Paulo', 'gestor');
        $this->pessoa('Focal', 'colaborador', ['focal_campo' => true]);
        $romario = $this->pessoa('Romario', 'colaborador', ['atividade_campo' => true]);
        $a = $this->campo($romario, '2026-11-11 12:00:00');
        $curto = $this->campo($this->pessoa('Joao', 'colaborador', ['atividade_campo' => true]), '2026-11-11 14:00:00', null, 'CURTO');

        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(1, $this->pushes);

        Carbon::setTestNow(Carbon::parse('2026-11-11T15:20:00-03:00'));
        \Laravel\Sanctum\Sanctum::actingAs($romario);
        $this->postJson("/api/atividades-campo/{$a->id}/finalizar")->assertOk();
        $this->assertCount(2, $this->pushes);
        $this->assertSame(['Focal', 'Paulo'], $this->pushes[1]['para']);
        $this->assertSame('✅ Romario registrou a saída', $this->pushes[1]['titulo']);
        $this->assertStringContainsString('Faz. São José · campo BRCB147: das 12:00 às 15:20 (3h20)', $this->pushes[1]['corpo']);
        $this->assertSame('campo-longo-'.$a->id, $this->pushes[1]['tag']);
        $this->assertSame($this->pushes[0]['tag'], $this->pushes[1]['tag'], 'mesma tag: substitui o aviso no celular');

        $this->postJson("/api/atividades-campo/{$a->id}/finalizar")->assertOk();   // reenvio da fila: não repete
        $this->assertCount(2, $this->pushes);

        \Laravel\Sanctum\Sanctum::actingAs($curto->colaborador);
        $this->postJson("/api/atividades-campo/{$curto->id}/finalizar")->assertOk();   // não teve aviso das 3 h
        $this->assertCount(2, $this->pushes);
    }

    public function test_fechamento_automatico_ao_iniciar_outro_campo_tambem_avisa(): void
    {
        $this->pessoa('Paulo', 'gestor');
        $romario = $this->pessoa('Romario', 'colaborador', ['atividade_campo' => true]);
        $this->campo($romario, '2026-11-11 12:00:00');
        $this->artisan('campo:verificar')->assertSuccessful();

        \Laravel\Sanctum\Sanctum::actingAs($romario);
        $this->postJson('/api/atividades-campo/iniciar', ['id' => (string) Str::uuid(), 'fazenda' => 'Faz. Nova', 'campo' => 'X1'])->assertCreated();
        $this->assertCount(2, $this->pushes);
        $this->assertSame('✅ Romario registrou a saída', $this->pushes[1]['titulo']);
        $this->assertStringContainsString('fechado sozinho ao iniciar outro campo', $this->pushes[1]['corpo']);
    }

    public function test_focal_em_campo_avisa_o_admin(): void
    {
        $this->pessoa('Ana', 'admin');
        $focal = $this->pessoa('Focal', 'colaborador', ['focal_campo' => true, 'atividade_campo' => true]);
        $this->campo($focal, '2026-11-11 09:00:00');

        $this->artisan('campo:verificar', ['--horas' => 5])->assertSuccessful();
        $this->assertSame(['Ana'], $this->pushes[0]['para']);
        $this->assertSame('⚠️ Focal em campo há 6h', $this->pushes[0]['titulo']);
    }

    /* 26/11/2026 — pedido do Cleiton: sem "Liguei, está tudo bem" e ainda sem saída 1 h depois, sai UM segundo aviso */
    public function test_segundo_aviso_uma_hora_depois_sem_confirmacao(): void
    {
        $this->pessoa('Paulo', 'gestor');
        $this->pessoa('Focal', 'colaborador', ['focal_campo' => true]);
        $romario = $this->pessoa('Romario', 'colaborador', ['atividade_campo' => true]);
        $this->campo($romario, '2026-11-11 12:00:00');
        $this->artisan('campo:verificar')->assertSuccessful();                    // 15:00, 3h: primeiro aviso
        $this->assertCount(1, $this->pushes);

        Carbon::setTestNow(Carbon::parse('2026-11-11T15:50:00-03:00'));
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(1, $this->pushes, 'ainda não passou 1 h do primeiro');

        Carbon::setTestNow(Carbon::parse('2026-11-11T16:00:00-03:00'));
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(2, $this->pushes);
        $this->assertSame(['Focal', 'Paulo'], $this->pushes[1]['para']);
        $this->assertSame('⚠️ Ainda sem resposta: Romario em campo há 4h', $this->pushes[1]['titulo']);
        $this->assertStringContainsString('Liguei, está tudo bem', $this->pushes[1]['corpo']);
        $this->assertSame($this->pushes[0]['tag'], $this->pushes[1]['tag']);

        Carbon::setTestNow(Carbon::parse('2026-11-11T18:00:00-03:00'));
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(2, $this->pushes, 'não passa de dois avisos');
    }

    public function test_liguei_esta_tudo_bem_avisa_os_outros_e_cancela_o_segundo_aviso(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor');
        $this->pessoa('Focal', 'colaborador', ['focal_campo' => true]);
        $romario = $this->pessoa('Romario', 'colaborador', ['atividade_campo' => true]);
        $a = $this->campo($romario, '2026-11-11 12:00:00');
        $this->artisan('campo:verificar')->assertSuccessful();

        Carbon::setTestNow(Carbon::parse('2026-11-11T15:20:00-03:00'));
        \Laravel\Sanctum\Sanctum::actingAs($romario);
        $this->postJson("/api/atividades-campo/{$a->id}/verificar")->assertForbidden();   // colaborador comum não confirma

        \Laravel\Sanctum\Sanctum::actingAs($paulo);
        $r = $this->postJson("/api/atividades-campo/{$a->id}/verificar")->assertOk();
        $this->assertNotNull($r->json('verificado_em'));
        $this->assertSame('Paulo', $r->json('verificado_por_nome'));
        $this->assertCount(2, $this->pushes);
        $this->assertSame(['Focal'], $this->pushes[1]['para'], 'quem ligou não recebe o próprio aviso');
        $this->assertSame('✅ Romario está bem', $this->pushes[1]['titulo']);
        $this->assertStringContainsString('Paulo ligou às 15:20', $this->pushes[1]['corpo']);
        $this->assertSame('campo-longo-'.$a->id, $this->pushes[1]['tag']);

        $this->postJson("/api/atividades-campo/{$a->id}/verificar")->assertOk();          // de novo: não repete
        $this->assertCount(2, $this->pushes);

        Carbon::setTestNow(Carbon::parse('2026-11-11T16:30:00-03:00'));
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(2, $this->pushes, 'confirmado: sem segundo aviso');

        $eq = $this->getJson('/api/atividades-campo/equipe')->assertOk()->json();
        $rom = collect($eq)->firstWhere('nome', 'Romario');
        $this->assertSame('Paulo', $rom['ultima']['verificado_por_nome']);
        $this->assertArrayHasKey('visto_em', $rom);
    }

    public function test_nao_confirma_quem_ja_saiu(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor');
        $romario = $this->pessoa('Romario', 'colaborador', ['atividade_campo' => true]);
        $a = $this->campo($romario, '2026-11-11 10:00:00', '2026-11-11 14:00:00');
        \Laravel\Sanctum\Sanctum::actingAs($paulo);
        $this->postJson("/api/atividades-campo/{$a->id}/verificar")->assertStatus(409);
        $this->assertNull($a->fresh()->verificado_em);
    }

    public function test_aviso_diz_quando_o_celular_falou_com_o_servidor(): void
    {
        $this->pessoa('Paulo', 'gestor');
        $romario = $this->pessoa('Romario', 'colaborador', ['atividade_campo' => true]);
        $tok = $romario->createToken('app');
        $tok->accessToken->forceFill(['last_used_at' => Carbon::parse('2026-11-11T12:35:00-03:00')->utc()])->save();
        $this->campo($romario, '2026-11-11 12:00:00');

        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertStringContainsString('Celular falou com o servidor às 12:35.', $this->pushes[0]['corpo']);
    }
}
