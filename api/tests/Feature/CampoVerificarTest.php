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
 * quem acompanha (gestor, admin e focal), uma vez por atividade. Desde 12/11/2026: com 2h30, todos juntos.
 */
class CampoVerificarTest extends TestCase
{
    use RefreshDatabase;

    private array $pushes = [];

    protected function setUp(): void
    {
        parent::setUp();
        $this->mock(PushService::class, function ($m) {
            $m->shouldReceive('enviar')->andReturnUsing(function ($destino, $titulo, $corpo, $url, $tag) {
                $this->pushes[] = ['para' => collect($destino)->pluck('nome')->sort()->values()->all(), 'titulo' => $titulo, 'corpo' => $corpo, 'url' => $url];

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

    /* 12/11/2026 — decisão do Cleiton: com 2h30, um aviso só, ao mesmo tempo para o focal e o gestor */
    public function test_com_2h30_avisa_focal_e_gestor_juntos_uma_vez(): void
    {
        $this->pessoa('Paulo', 'gestor');
        $this->pessoa('Focal', 'colaborador', ['focal_campo' => true]);
        $this->pessoa('Joao');                                      // colaborador comum: não recebe
        $romario = $this->pessoa('Romario', 'colaborador', ['atividade_campo' => true]);
        $this->campo($romario, '2026-11-11 12:40:00');               // 2h20: ainda não
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertSame([], $this->pushes);

        Carbon::setTestNow(Carbon::parse('2026-11-11T15:10:00-03:00'));   // 2h30
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(1, $this->pushes, 'um aviso só, para todos');
        $this->assertSame(['Focal', 'Paulo'], $this->pushes[0]['para']);
        $this->assertSame('⚠️ Romario em campo há 2h30', $this->pushes[0]['titulo']);
        $this->assertStringContainsString('Faz. São José · campo BRCB147, desde 12:40', $this->pushes[0]['corpo']);
        $this->assertSame('./?abrir=campo', $this->pushes[0]['url']);

        Carbon::setTestNow(Carbon::parse('2026-11-11T19:00:00-03:00'));   // não repete mais tarde
        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(1, $this->pushes);
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

    public function test_focal_em_campo_avisa_o_admin(): void
    {
        $this->pessoa('Ana', 'admin');
        $focal = $this->pessoa('Focal', 'colaborador', ['focal_campo' => true, 'atividade_campo' => true]);
        $this->campo($focal, '2026-11-11 09:00:00');

        $this->artisan('campo:verificar', ['--horas' => 5])->assertSuccessful();
        $this->assertSame(['Ana'], $this->pushes[0]['para']);
        $this->assertSame('⚠️ Focal em campo há 6h', $this->pushes[0]['titulo']);
    }
}
