<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\PushSubscription;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Resend\Laravel\Facades\Resend;
use Tests\TestCase;

/**
 * 12/11/2026 — pedido do Cleiton: o gestor vê no sino quem da equipe está com aviso no celular ligado e pode pedir
 * (por e-mail) para quem está desligado ligar.
 */
class PushEquipeTest extends TestCase
{
    use RefreshDatabase;

    private object $resendFalso;

    protected function setUp(): void
    {
        parent::setUp();
        Cache::flush();
        config(['resend.api_key' => 're_teste']);
        $this->resendFalso = new class
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
        Resend::swap($this->resendFalso);
    }

    private function pessoa(string $nome, string $role = 'colaborador', bool $ativo = true): Colaborador
    {
        $c = new Colaborador(['id' => (string) Str::uuid(), 'nome' => $nome, 'email' => strtolower($nome).'@teste.local',
            'password' => 'segredo123', 'role' => $role]);
        $c->forceFill(['ativo' => $ativo]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c->fresh();
    }

    private function aparelho(Colaborador $c, string $nome = 'Android'): void
    {
        $ep = 'https://push.exemplo/'.Str::random(20);
        PushSubscription::create(['user_id' => $c->id, 'endpoint' => $ep, 'endpoint_hash' => hash('sha256', $ep),
            'p256dh' => 'x', 'auth' => 'y', 'aparelho' => $nome]);
    }

    public function test_gestor_ve_quem_tem_aviso_ligado(): void
    {
        $gestor = $this->pessoa('Paulo', 'gestor');
        $pedro = $this->pessoa('Pedro');
        $romario = $this->pessoa('Romario');
        $this->pessoa('Contador', 'contabilidade');
        $this->pessoa('Antigo', 'colaborador', false);
        $this->aparelho($pedro);
        $this->aparelho($pedro, 'iPhone');
        $this->aparelho($gestor);

        Sanctum::actingAs($gestor);
        $r = $this->getJson('/api/push/equipe')->assertOk();

        $this->assertSame(2, $r->json('ligados'));
        $this->assertSame(3, $r->json('total'), 'contabilidade e inativo ficam fora');
        $porNome = collect($r->json('equipe'))->keyBy('nome');
        $this->assertSame(2, $porNome['Pedro']['aparelhos']);
        $this->assertSame(0, $porNome['Romario']['aparelhos']);
        $this->assertArrayNotHasKey('email', $porNome['Romario']);
        $this->assertSame($romario->id, $porNome['Romario']['id']);
    }

    public function test_colaborador_nao_ve_a_lista_nem_lembra(): void
    {
        Sanctum::actingAs($this->pessoa('Joao'));
        $this->getJson('/api/push/equipe')->assertForbidden();
        $this->postJson('/api/push/lembrar')->assertForbidden();
    }

    public function test_lembrar_manda_email_so_para_desligados_e_uma_vez_por_dia(): void
    {
        $gestor = $this->pessoa('Paulo', 'gestor');
        $pedro = $this->pessoa('Pedro');
        $this->pessoa('Romario');
        $this->pessoa('Bia');
        $this->aparelho($pedro);

        Sanctum::actingAs($gestor);
        $r = $this->postJson('/api/push/lembrar')->assertOk();
        $this->assertSame(2, $r->json('enviados'), 'Romario e Bia; Pedro já tem aviso e o gestor não lembra a si mesmo');
        $para = collect($this->resendFalso->enviados)->pluck('to.0')->sort()->values()->all();
        $this->assertSame(['bia@teste.local', 'romario@teste.local'], $para);
        $this->assertStringContainsString('Ligar avisos neste celular', $this->resendFalso->enviados[0]['text']);
        $this->assertSame('paulo@teste.local', $this->resendFalso->enviados[0]['reply_to']);

        $r2 = $this->postJson('/api/push/lembrar')->assertOk();
        $this->assertSame(0, $r2->json('enviados'));
        $this->assertSame(2, $r2->json('pulados'));
        $this->assertCount(2, $this->resendFalso->enviados);

        $lista = collect($this->getJson('/api/push/equipe')->json('equipe'))->keyBy('nome');
        $this->assertNotNull($lista['Romario']['lembrado_em']);
        $this->assertNull($lista['Pedro']['lembrado_em']);
    }

    public function test_lembrar_so_os_escolhidos(): void
    {
        $gestor = $this->pessoa('Paulo', 'admin');
        $romario = $this->pessoa('Romario');
        $this->pessoa('Bia');

        Sanctum::actingAs($gestor);
        $r = $this->postJson('/api/push/lembrar', ['ids' => [$romario->id]])->assertOk();
        $this->assertSame(1, $r->json('enviados'));
        $this->assertSame(['romario@teste.local'], $this->resendFalso->enviados[0]['to']);
    }
}
