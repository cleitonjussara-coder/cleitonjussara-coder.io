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
 * 11/11/2026 — acompanhamento solidário: quem está em campo há muitas horas sem finalizar gera aviso no celular de
 * quem acompanha (gestor, admin e focal), uma vez por atividade.
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

    public function test_avisa_quem_acompanha_uma_vez_so(): void
    {
        $this->pessoa('Paulo', 'gestor');
        $this->pessoa('Focal', 'colaborador', ['focal_campo' => true]);
        $this->pessoa('Joao');                                      // colaborador comum: não recebe
        $romario = $this->pessoa('Romario', 'colaborador', ['atividade_campo' => true]);
        $this->campo($romario, '2026-11-11 10:20:00');               // 4h40 em campo

        $this->artisan('campo:verificar')->assertSuccessful();
        $this->assertCount(1, $this->pushes);
        $this->assertSame(['Focal', 'Paulo'], $this->pushes[0]['para']);
        $this->assertSame('⚠️ Romario em campo há 4 h', $this->pushes[0]['titulo']);
        $this->assertStringContainsString('Faz. São José · campo BRCB147, desde 10:20', $this->pushes[0]['corpo']);
        $this->assertSame('./?abrir=campo', $this->pushes[0]['url']);

        $this->artisan('campo:verificar')->assertSuccessful();      // a mesma atividade não avisa de novo
        $this->assertCount(1, $this->pushes);
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

    public function test_quem_esta_em_campo_nao_recebe_aviso_de_si_mesmo(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor', ['atividade_campo' => true]);
        $this->pessoa('Ana', 'admin');
        $this->campo($paulo, '2026-11-11 09:00:00');

        $this->artisan('campo:verificar', ['--horas' => 5])->assertSuccessful();
        $this->assertSame(['Ana'], $this->pushes[0]['para']);
        $this->assertSame('⚠️ Paulo em campo há 6 h', $this->pushes[0]['titulo']);
    }
}
