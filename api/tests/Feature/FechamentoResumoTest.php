<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Conferencia;
use App\Models\MesFechado;
use App\Models\Nota;
use App\Models\Repasse;
use App\Services\PushService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 27/11/2026 — resumo antes de fechar o mês (verificação de 26/11, fase 3 item 3): conferidas, sem anexo, sem valor,
 * duplicatas (uma por par) e pedidos de repasse abertos, da empresa inteira. Só informa.
 */
class FechamentoResumoTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Carbon::setTestNow(Carbon::parse('2026-11-06 15:00:00', 'UTC'));
        MesFechado::esquecerTabela();
        Nota::esquecerForaFechamento();
        $this->mock(PushService::class, fn ($m) => $m->shouldIgnoreMissing());
    }

    protected function tearDown(): void
    {
        MesFechado::esquecerTabela();
        Nota::esquecerForaFechamento();
        Conferencia::esquecerTabela();
        Carbon::setTestNow();
        parent::tearDown();
    }

    private function pessoa(string $role, string $nome): Colaborador
    {
        $c = new Colaborador(['id' => (string) Str::uuid(), 'nome' => $nome, 'email' => strtolower($nome).'@teste.local', 'password' => 'segredo123', 'role' => $role]);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(Colaborador $dono, array $extra = [], string $criada = '2026-10-21 10:00:00'): Nota
    {
        $n = new Nota(array_merge(['id' => (string) Str::uuid(), 'user_id' => $dono->id, 'tipo' => 'RDM', 'valor' => 100,
            'data' => '2026-10-20', 'mes' => 10, 'ano' => 2026, 'razao_social' => 'POSTO BOM', 'deleted' => false], $extra));
        $n->forceFill(['foto_path' => array_key_exists('foto_path', $extra) ? $extra['foto_path'] : 'u/n.jpg', 'created_at' => $criada])->save();

        return $n;
    }

    public function test_resumo_conta_o_que_falta_olhar_no_mes(): void
    {
        $ana = $this->pessoa('colaborador', 'Ana');
        $ze = $this->pessoa('colaborador', 'Ze');
        $gestor = $this->pessoa('gestor', 'Gil');
        $a = $this->nota($ana, ['valor' => 55.5, 'razao_social' => 'MERCADO A', 'data' => '2026-10-02']);
        $this->nota($ana, ['foto_path' => null, 'razao_social' => 'MERCADO B', 'valor' => 31, 'data' => '2026-10-03']);
        $this->nota($ze, ['valor' => 0, 'razao_social' => 'MERCADO C', 'data' => '2026-10-04']);
        $this->nota($ana, ['valor' => 77.7, 'razao_social' => 'POSTO X', 'data' => '2026-10-09'], '2026-10-09 10:00:00');
        $this->nota($ana, ['valor' => 77.7, 'razao_social' => 'POSTO X', 'data' => '2026-10-09'], '2026-10-10 10:00:00');   // repete a de cima
        $this->nota($ana, ['valor' => 12, 'razao_social' => 'APAGADA', 'deleted' => true]);
        $this->nota($ana, ['mes' => 11, 'data' => '2026-11-02', 'razao_social' => 'OUTRO MES']);
        (new Repasse(['id' => (string) Str::uuid(), 'user_id' => $ana->id, 'tipo' => 'RDM', 'kind' => 'requested', 'valor' => 800.25,
            'data' => '2026-10-22', 'mes' => 10, 'ano' => 2026, 'deleted' => false]))->save();
        $pago = new Repasse(['id' => (string) Str::uuid(), 'user_id' => $ze->id, 'tipo' => 'RDM', 'kind' => 'requested', 'valor' => 500,
            'data' => '2026-10-22', 'mes' => 10, 'ano' => 2026, 'deleted' => false]);
        $pago->forceFill(['atendido_em' => now()])->save();

        Sanctum::actingAs($gestor);
        $this->putJson('/api/conferencias', ['tipo' => 'nota', 'registro_id' => $a->id, 'conferido' => true])->assertOk();

        $this->getJson('/api/fechamento/resumo?ano=2026&mes=10')->assertOk()->assertJson([
            'notas' => 5, 'conferidas' => 1, 'sem_anexo' => 1, 'sem_valor' => 1, 'duplicatas' => 1,
            'pedidos_abertos' => 1, 'pedidos_valor' => 800.25,
        ]);
    }

    public function test_colaborador_nao_ve_o_resumo(): void
    {
        Sanctum::actingAs($this->pessoa('colaborador', 'Ana'));
        $this->getJson('/api/fechamento/resumo?ano=2026&mes=10')->assertForbidden();
    }
}
