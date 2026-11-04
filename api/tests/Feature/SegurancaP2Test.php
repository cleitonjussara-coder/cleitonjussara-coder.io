<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Prioridade 2 do pente fino (04/11/2026): papel do admin, localização do ponto, limite de login,
 * senha mínima, limpeza de sessões velhas e cabeçalhos de segurança.
 */
class SegurancaP2Test extends TestCase
{
    use RefreshDatabase;

    private function pessoa(string $role, string $sufixo = ''): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => ucfirst($role).$sufixo, 'email' => strtolower($role.$sufixo).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['confirmado_em' => now()]);
        $c->save();

        return $c;
    }

    /* ---------- papel ---------- */

    public function test_admin_nao_muda_o_proprio_papel(): void
    {
        $adm = $this->pessoa('admin');
        Sanctum::actingAs($adm);

        $this->patchJson("/api/colaboradores/{$adm->id}", ['role' => 'gestor'])->assertOk();

        $this->assertSame('admin', $adm->fresh()->role);
    }

    public function test_admin_segue_mudando_o_proprio_regime(): void
    {
        $adm = $this->pessoa('admin');
        Sanctum::actingAs($adm);

        $this->patchJson("/api/colaboradores/{$adm->id}", ['regime' => 'cv'])->assertOk();

        $this->assertSame('cv', $adm->fresh()->regime);
    }

    public function test_gestor_muda_o_papel_do_admin(): void
    {
        $adm = $this->pessoa('admin');
        Sanctum::actingAs($this->pessoa('gestor'));

        $this->patchJson("/api/colaboradores/{$adm->id}", ['role' => 'colaborador'])->assertOk();

        $this->assertSame('colaborador', $adm->fresh()->role);
    }

    /* ---------- localização ---------- */

    public function test_ponto_nao_grava_localizacao_nem_de_aparelho_antigo(): void
    {
        $colab = $this->pessoa('colaborador');
        Sanctum::actingAs($colab);

        $this->postJson('/api/ponto/bater', ['marcacao' => 'entrada', 'lat' => -16.7, 'lng' => -47.6])->assertOk();

        $linha = DB::table('pontos')->where('user_id', $colab->id)->first();
        $this->assertNotNull($linha->entrada);
        $this->assertNull($linha->lat);
        $this->assertNull($linha->lng);
    }

    /* ---------- login ---------- */

    public function test_login_trava_depois_de_tentativas_seguidas_na_mesma_conta(): void
    {
        $c = $this->pessoa('colaborador');

        foreach (range(1, 8) as $i) {
            $this->postJson('/api/auth/login', ['email' => $c->email, 'password' => 'errada'.$i])->assertStatus(422);
        }

        $this->postJson('/api/auth/login', ['email' => strtoupper($c->email), 'password' => 'segredo123'])->assertStatus(429);
    }

    public function test_login_com_email_em_lista_da_422_e_nao_500(): void
    {
        $this->postJson('/api/auth/login', ['email' => ['a@b.c'], 'password' => 'x'])->assertStatus(422);
    }

    public function test_aviso_de_muitas_tentativas_sai_em_portugues(): void
    {
        $c = $this->pessoa('colaborador');
        foreach (range(1, 8) as $i) {
            $this->postJson('/api/auth/login', ['email' => $c->email, 'password' => 'errada'.$i]);
        }

        $this->postJson('/api/auth/login', ['email' => $c->email, 'password' => 'errada'])
            ->assertStatus(429)->assertJsonPath('message', 'Muitas tentativas de entrar. Aguarde 1 minuto e tente de novo.');
    }

    public function test_erro_em_uma_conta_nao_trava_a_outra_no_mesmo_ip(): void
    {
        $a = $this->pessoa('colaborador', 'A');
        $b = $this->pessoa('colaborador', 'B');

        foreach (range(1, 8) as $i) {
            $this->postJson('/api/auth/login', ['email' => $a->email, 'password' => 'errada'.$i])->assertStatus(422);
        }

        $this->postJson('/api/auth/login', ['email' => $b->email, 'password' => 'segredo123'])->assertOk();
    }

    /* ---------- senha ---------- */

    public function test_cadastro_recusa_senha_com_menos_de_8(): void
    {
        $this->postJson('/api/auth/register', ['email' => 'nova@teste.local', 'password' => '1234567'])->assertStatus(422);
        $this->postJson('/api/auth/register', ['email' => 'nova@teste.local', 'password' => '12345678'])->assertCreated();
    }

    public function test_quem_ja_tem_senha_curta_continua_entrando(): void
    {
        $c = $this->pessoa('colaborador');
        $c->forceFill(['password' => 'abc123'])->save();

        $this->postJson('/api/auth/login', ['email' => $c->email, 'password' => 'abc123'])->assertOk();
    }

    /* ---------- sessões velhas ---------- */

    public function test_limpeza_apaga_so_a_sessao_parada_ha_mais_de_180_dias(): void
    {
        $c = $this->pessoa('colaborador');
        $parada = $c->createToken('parada')->accessToken;
        $parada->forceFill(['last_used_at' => now()->subDays(181)])->save();
        $emUso = $c->createToken('em uso')->accessToken;
        $emUso->forceFill(['last_used_at' => now()->subDays(10)])->save();
        $nunca = $c->createToken('nunca usada')->accessToken;
        $nunca->forceFill(['created_at' => now()->subDays(200), 'last_used_at' => null])->save();
        $nova = $c->createToken('nova sem uso')->accessToken;

        $this->artisan('tokens:limpar')->assertSuccessful();

        $this->assertSame(
            collect([$emUso->id, $nova->id])->sort()->values()->all(),
            DB::table('personal_access_tokens')->pluck('id')->sort()->values()->all(),
        );
    }

    /* ---------- cabeçalhos ---------- */

    public function test_api_responde_com_nosniff(): void
    {
        $this->getJson('/api/ping')->assertHeader('X-Content-Type-Options', 'nosniff');
    }

    public function test_anexo_xml_nao_roda_script_e_foto_segue_normal(): void
    {
        Storage::fake('fotos');
        $colab = $this->pessoa('colaborador');
        Sanctum::actingAs($colab);
        Storage::disk('fotos')->put("{$colab->id}/a.xml", '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>');
        Storage::disk('fotos')->put("{$colab->id}/b.pdf", '%PDF');

        $xml = $this->get("/api/fotos/{$colab->id}/a.xml");
        $this->assertSame(200, $xml->getStatusCode());
        $this->assertStringContainsString('sandbox', (string) $xml->headers->get('Content-Security-Policy'));
        $this->assertSame('nosniff', $xml->headers->get('X-Content-Type-Options'));

        $pdf = $this->get("/api/fotos/{$colab->id}/b.pdf");
        $this->assertSame(200, $pdf->getStatusCode());
        $this->assertNull($pdf->headers->get('Content-Security-Policy'), 'PDF abre no leitor do navegador; sandbox o quebraria');
    }

    public function test_foto_enviada_continua_subindo(): void
    {
        Storage::fake('fotos');
        Sanctum::actingAs($this->pessoa('colaborador'));
        $id = (string) Str::uuid();

        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->image('a.jpg')], ['Accept' => 'application/json'])->assertOk();
    }
}
