<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\GoogleOAuth;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Auditoria de 09/11/2026, segunda leva (build 607):
 *   • item 8: login só avisa "conta desativada" depois da senha certa;
 *   • item 9: login Google exige e-mail verificado;
 *   • item 11: observacao e qr_url são cortados em 2000 caracteres (sem 422, para não travar a fila);
 *   • item 15: cada limite de requisições tem contador próprio.
 */
class AuditoriaCorrecoes2Test extends TestCase
{
    use RefreshDatabase;

    private function pessoa(array $extra = []): Colaborador
    {
        $c = new Colaborador(['id' => (string) Str::uuid(), 'nome' => 'Ana', 'email' => 'ana-'.strtolower(Str::random(4)).'@teste.local', 'password' => 'segredo123', 'role' => 'colaborador']);
        $c->forceFill($extra + ['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    public function test_conta_desativada_so_aparece_depois_da_senha_certa(): void
    {
        $ana = $this->pessoa(['ativo' => false]);

        $this->postJson('/api/auth/login', ['email' => $ana->email, 'password' => 'errada'])
            ->assertStatus(422)->assertJsonPath('errors.email.0', 'E-mail ou senha incorretos');
        $this->postJson('/api/auth/login', ['email' => $ana->email, 'password' => 'segredo123'])
            ->assertStatus(422)->assertJsonPath('errors.email.0', 'Conta desativada. Fale com o gestor ou o administrador.');
    }

    private function voltaDoGoogle(mixed $verificado): \Illuminate\Testing\TestResponse
    {
        Http::fake([
            'oauth2.googleapis.com/token' => Http::response(['access_token' => 'a', 'scope' => 'openid email']),
            'www.googleapis.com/oauth2/v3/userinfo' => Http::response(['sub' => 'g-1', 'email' => 'novo@teste.local', 'email_verified' => $verificado]),
        ]);
        $state = app(GoogleOAuth::class)->assinarState(['n' => Str::random(8), 'exp' => time() + 600]);

        return $this->get(route('auth.google.callback', ['code' => 'codigo', 'state' => $state]));
    }

    public function test_google_com_email_nao_verificado_nao_entra(): void
    {
        $this->voltaDoGoogle(false)->assertRedirectContains('#auth_error=google');
        $this->assertNull(Colaborador::where('email', 'novo@teste.local')->first());
    }

    public function test_google_com_email_verificado_segue(): void
    {
        $resp = $this->voltaDoGoogle(true);
        $this->assertStringNotContainsString('auth_error=google', (string) $resp->headers->get('Location'));
        $this->assertNotNull(Colaborador::where('email', 'novo@teste.local')->first());
    }

    public function test_observacao_e_qr_url_grandes_sao_cortados_sem_recusar(): void
    {
        $ana = $this->pessoa();
        Sanctum::actingAs($ana);
        $hoje = now('America/Sao_Paulo');
        $id = (string) Str::uuid();

        $this->putJson('/api/notas/'.$id, [
            'user_id' => $ana->id, 'tipo' => 'RDM', 'valor' => 10, 'data' => $hoje->format('Y-m-d'),
            'mes' => (int) $hoje->format('n'), 'ano' => (int) $hoje->format('Y'), 'razao_social' => 'TESTE', 'deleted' => true,
            'observacao' => str_repeat('á', 5000), 'qr_url' => 'https://x.test/?p='.str_repeat('9', 5000),
        ])->assertOk();

        $n = Nota::findOrFail($id);
        $this->assertSame(2000, mb_strlen($n->observacao));
        $this->assertSame(2000, mb_strlen($n->qr_url));
    }

    public function test_limite_de_uma_rota_nao_trava_as_outras(): void
    {
        Sanctum::actingAs($this->pessoa(['atividade_campo' => true]));
        for ($i = 0; $i < 30; $i++) {
            $this->postJson('/api/atividades-campo/iniciar', [])->assertStatus(422);
        }
        $this->postJson('/api/atividades-campo/iniciar', [])->assertStatus(429);
        $this->assertNotSame(429, $this->postJson('/api/justificativas', [])->status(), 'justificativa tem contador próprio');
        $this->assertNotSame(429, $this->postJson('/api/avisos-correcao', [])->status(), 'aviso de correção tem contador próprio');
    }

    public function test_limite_sem_login_e_separado_por_rota(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->postJson('/api/auth/forgot', ['email' => 'x@teste.local']);
        }
        $this->postJson('/api/auth/forgot', ['email' => 'x@teste.local'])->assertStatus(429);
        $this->assertNotSame(429, $this->postJson('/api/auth/register', [])->status(), 'cadastro não divide o contador do esqueci a senha');
    }
}
