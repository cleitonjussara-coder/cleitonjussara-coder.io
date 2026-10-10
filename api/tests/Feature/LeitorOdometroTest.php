<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 09/10/2026 — leitura do odômetro por IA de visão (2ª tentativa do app).
 * A API da Anthropic é sempre simulada: nenhum teste gasta dinheiro.
 */
class LeitorOdometroTest extends TestCase
{
    use RefreshDatabase;

    private function colaborador(): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) \Illuminate\Support\Str::uuid(),
            'nome' => 'Colab', 'email' => 'colab@teste.local',
            'password' => 'segredo123', 'role' => 'colaborador',
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function foto(): UploadedFile
    {
        return UploadedFile::fake()->image('odometro.jpg', 300, 100);
    }

    private function respostaIa(string $texto): array
    {
        return ['stop_reason' => 'end_turn', 'content' => [['type' => 'text', 'text' => $texto]]];
    }

    public function test_le_o_odometro_e_envia_imagem_com_a_chave_do_servidor(): void
    {
        config(['petermann.anthropic.key' => 'chave-de-teste']);
        Http::fake(['api.anthropic.com/*' => Http::response($this->respostaIa('{"odometro": 85420}'))]);
        Sanctum::actingAs($this->colaborador());

        $this->post('/api/km/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])
            ->assertOk()->assertJson(['valor' => 85420, 'motivo' => null]);

        Http::assertSent(function ($req) {
            $b = $req->data();

            return $req->hasHeader('x-api-key', 'chave-de-teste')
                && $b['model'] === 'claude-haiku-5-5'
                && $b['messages'][0]['content'][0]['type'] === 'image'
                && $b['messages'][0]['content'][0]['source']['media_type'] === 'image/jpeg';
        });
    }

    public function test_sem_chave_no_servidor_responde_indisponivel_sem_chamar_a_api(): void
    {
        config(['petermann.anthropic.key' => null]);
        Http::fake();
        Sanctum::actingAs($this->colaborador());

        $this->post('/api/km/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])
            ->assertOk()->assertJson(['valor' => null, 'motivo' => 'indisponivel']);
        Http::assertNothingSent();
    }

    public function test_resposta_fora_do_formato_ou_nula_vira_nao_leu(): void
    {
        config(['petermann.anthropic.key' => 'k']);
        Sanctum::actingAs($this->colaborador());

        foreach (['{"odometro": null}', 'não consegui ler', '{"odometro": "abc"}', '{"odometro": -5}', '{"odometro": 99999999}'] as $txt) {
            Http::fake(['api.anthropic.com/*' => Http::response($this->respostaIa($txt))]);
            $this->post('/api/km/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])
                ->assertOk()->assertJson(['valor' => null, 'motivo' => 'nao_leu']);
        }
    }

    public function test_erro_da_api_e_recusa_nao_derrubam_o_endpoint(): void
    {
        config(['petermann.anthropic.key' => 'k']);
        Sanctum::actingAs($this->colaborador());

        Http::fake(['api.anthropic.com/*' => Http::response(['error' => 'x'], 529)]);
        $this->post('/api/km/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])
            ->assertOk()->assertJson(['valor' => null]);

        Http::fake(['api.anthropic.com/*' => Http::response(['stop_reason' => 'refusal', 'content' => []])]);
        $this->post('/api/km/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])
            ->assertOk()->assertJson(['valor' => null]);
    }

    public function test_limite_diario_por_colaborador(): void
    {
        config(['petermann.anthropic.key' => 'k', 'petermann.anthropic.limite_dia' => 2]);
        Http::fake(['api.anthropic.com/*' => Http::response($this->respostaIa('{"odometro": 1000}'))]);
        Sanctum::actingAs($this->colaborador());

        $this->post('/api/km/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])->assertJson(['valor' => 1000]);
        $this->post('/api/km/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])->assertJson(['valor' => 1000]);
        $this->post('/api/km/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])
            ->assertOk()->assertJson(['valor' => null, 'motivo' => 'limite']);
        Http::assertSentCount(2);
    }

    public function test_exige_login_e_arquivo_de_imagem(): void
    {
        $this->post('/api/km/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])->assertUnauthorized();

        Sanctum::actingAs($this->colaborador());
        $this->post('/api/km/ler-foto', ['file' => UploadedFile::fake()->create('x.pdf', 10, 'application/pdf')], ['Accept' => 'application/json'])
            ->assertStatus(422);
    }
}
