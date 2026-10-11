<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 11/10/2026 — rastreio da equipe (gestor/admin): visto no app, última nota,
 * contagens e últimas notas mexidas, por colaborador.
 */
class RastreioEquipeTest extends TestCase
{
    use RefreshDatabase;

    private function pessoa(string $nome, string $role = 'colaborador', bool $ativo = true): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome, 'email' => strtolower($nome).'@teste.local',
            'password' => 'segredo123', 'role' => $role, 'ativo' => $ativo,
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(Colaborador $dono, array $campos = []): Nota
    {
        $agora = now();
        $n = new Nota(array_replace([
            'id' => (string) Str::uuid(), 'user_id' => $dono->id, 'tipo' => 'RDA', 'valor' => 50,
            'data' => $agora->format('Y-m-d'), 'mes' => (int) $agora->format('n'), 'ano' => (int) $agora->format('Y'),
            'razao_social' => 'FORNECEDOR TESTE', 'deleted' => false,
        ], $campos));
        $n->save();

        return $n->fresh();
    }

    private function marcar(Nota $n, string $criada, string $atualizada): void
    {
        DB::table('notas')->where('id', $n->id)->update(['created_at' => $criada, 'updated_at' => $atualizada]);
    }

    public function test_so_gestor_e_admin_veem(): void
    {
        $colab = $this->pessoa('Ana');
        Sanctum::actingAs($colab);
        $this->getJson('/api/colaboradores/atividade')->assertForbidden();

        Sanctum::actingAs($this->pessoa('Contador', 'contabilidade'));
        $this->getJson('/api/colaboradores/atividade')->assertForbidden();

        foreach (['gestor', 'admin'] as $papel) {
            Sanctum::actingAs($this->pessoa('Chefe '.$papel, $papel));
            $this->getJson('/api/colaboradores/atividade')->assertOk()->assertJsonStructure(['gerado_em', 'janela_dias', 'equipe']);
        }
    }

    public function test_lista_so_ativos_sem_contador_e_traz_o_visto_no_app(): void
    {
        $gestor = $this->pessoa('Gestor', 'gestor');
        $ana = $this->pessoa('Ana');
        $this->pessoa('Bruno');
        $this->pessoa('Desativado', 'colaborador', false);
        $this->pessoa('Contador', 'contabilidade');

        $ana->createToken('app');
        $ana->createToken('google');
        DB::table('personal_access_tokens')->where('tokenable_id', $ana->id)->orderBy('id')->limit(1)->update(['last_used_at' => '2026-10-10 12:00:00']);
        DB::table('personal_access_tokens')->where('tokenable_id', $ana->id)->orderByDesc('id')->limit(1)->update(['last_used_at' => '2026-10-11 15:30:00']);

        Sanctum::actingAs($gestor);
        $res = $this->getJson('/api/colaboradores/atividade')->assertOk();
        $nomes = collect($res->json('equipe'))->pluck('nome')->all();

        $this->assertSame(['Ana', 'Bruno', 'Gestor'], $nomes);                         // sem Desativado nem Contador
        $linhaAna = collect($res->json('equipe'))->firstWhere('nome', 'Ana');
        $this->assertStringStartsWith('2026-10-11T15:30:00', $linhaAna['visto_em']);   // o uso mais recente de qualquer token
        $this->assertNull(collect($res->json('equipe'))->firstWhere('nome', 'Bruno')['visto_em']);
    }

    public function test_contagens_ultima_nota_e_recentes(): void
    {
        /* 15:00 UTC = 12:00 em Brasília: "hoje" começa às 03:00 UTC de 11/10 */
        \Illuminate\Support\Carbon::setTestNow('2026-10-11 15:00:00');
        $gestor = $this->pessoa('Gestor', 'gestor');
        $ana = $this->pessoa('Ana');

        $this->nota($ana, ['razao_social' => 'POSTO HOJE', 'valor' => 113]);                                   // lançada agora
        $editada = $this->nota($ana, ['razao_social' => 'EDITADA', 'valor' => 20]);
        $this->marcar($editada, '2026-10-11 12:00:00', '2026-10-11 14:00:00');                                  // criada hoje, editada depois
        $ontem = $this->nota($ana, ['razao_social' => 'PADARIA ONTEM', 'valor' => 56]);
        $this->marcar($ontem, '2026-10-10 15:00:00', '2026-10-10 15:00:00');                                    // semana, não hoje
        $velha = $this->nota($ana, ['razao_social' => 'ANTIGA', 'valor' => 10]);
        $this->marcar($velha, '2026-09-01 15:00:00', '2026-09-01 15:00:00');                                    // dentro dos 60 dias, fora da semana e do mês
        $this->nota($ana, ['razao_social' => 'APAGADA', 'valor' => 999, 'deleted' => true]);                    // não conta nas somas

        Sanctum::actingAs($gestor);
        $l = collect($this->getJson('/api/colaboradores/atividade')->assertOk()->json('equipe'))->firstWhere('nome', 'Ana');

        $this->assertSame(2, $l['hoje']);          // POSTO HOJE e EDITADA
        $this->assertSame(3, $l['semana']);        // + PADARIA ONTEM
        $this->assertSame(3, $l['mes']);
        $this->assertEquals(189.0, $l['mes_valor']);   // 113 + 20 + 56 — a apagada (999) e a de setembro ficam de fora
        $this->assertStringStartsWith('2026-10-11T15:00:00', $l['ultimo_lancamento_em']);

        $recentes = collect($l['recentes']);
        $this->assertCount(5, $recentes);
        $this->assertSame('ANTIGA', $recentes->last()['fornecedor'], 'ordenadas da mais recente para a mais antiga');
        $porNome = $recentes->keyBy('fornecedor');
        $this->assertSame('apagou', $porNome['APAGADA']['acao']);
        $this->assertSame('editou', $porNome['EDITADA']['acao']);
        $this->assertSame('lançou', $porNome['POSTO HOJE']['acao']);
        $this->assertSame(113.0, (float) $porNome['POSTO HOJE']['valor']);

        \Illuminate\Support\Carbon::setTestNow();
    }

    public function test_quem_nao_tem_nota_na_janela_aparece_sem_atividade(): void
    {
        $gestor = $this->pessoa('Gestor', 'gestor');
        $carla = $this->pessoa('Carla');
        $velha = $this->nota($carla, ['razao_social' => 'MUITO ANTIGA']);
        $this->marcar($velha, now()->subDays(90)->format('Y-m-d H:i:s'), now()->subDays(90)->format('Y-m-d H:i:s'));

        Sanctum::actingAs($gestor);
        $c = collect($this->getJson('/api/colaboradores/atividade')->assertOk()->json('equipe'))->firstWhere('nome', 'Carla');

        $this->assertNull($c['ultimo_lancamento_em']);
        $this->assertNull($c['ultima_atividade_em']);
        $this->assertEquals([0, 0, 0, 0], [$c['hoje'], $c['semana'], $c['mes'], $c['mes_valor']]);
        $this->assertSame([], $c['recentes']);
    }

    public function test_exige_login(): void
    {
        $this->getJson('/api/colaboradores/atividade')->assertUnauthorized();
    }
}
