<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Services\AjudaRag;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 01/11/2026 — assistente do "Como usar" (RAG por palavras sobre a ajuda do app). Só texto da ajuda vai à IA;
 * o que a tela de ajuda esconde de um papel o assistente também não pode citar.
 */
class AssistenteAjudaTest extends TestCase
{
    use RefreshDatabase;

    private function pessoa(string $role = 'colaborador'): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => 'Pessoa '.$role, 'email' => $role.'@teste.local',
            'password' => 'segredo123', 'role' => $role, 'ativo' => true,
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    public function test_copia_da_ajuda_no_servidor_e_igual_a_do_app(): void
    {
        $fonte = base_path('../svelte-ajuda/src/ajuda-conteudo.html');
        if (! is_file($fonte)) {
            $this->markTestSkipped('fonte do app fora do pacote da API');
        }
        /* 10/11/2026: no Windows o git pode gravar a fonte com CRLF; o conteúdo é o mesmo, então compara sem o CR */
        $semCr = fn (string $f) => md5(str_replace("\r\n", "\n", file_get_contents($f)));
        $this->assertSame($semCr($fonte), $semCr(base_path('resources/ajuda/ajuda-conteudo.html')), 'copie svelte-ajuda/src/ajuda-conteudo.html para api/resources/ajuda/');
    }

    public function test_busca_acha_o_trecho_certo_e_respeita_o_papel(): void
    {
        $rag = new AjudaRag;
        $this->assertNotEmpty($rag->paragrafos());

        $colab = $this->pessoa();
        $gestor = $this->pessoa('gestor');
        $contador = $this->pessoa('contabilidade');

        $r = $rag->buscar('como avisar o dono da nota para corrigir', $gestor);
        $this->assertStringContainsString('Avisar', implode(' ', array_column($r, 'texto')));

        $textoColab = implode(' ', array_column($rag->buscar('como avisar o dono da nota para corrigir', $colab, 10), 'texto'));
        $this->assertStringNotContainsString('Avisar o dono da nota:', $textoColab, 'bloco do gestor vazou para o colaborador');

        $textoContador = implode(' ', array_column($rag->buscar('lançar nota', $contador, 10), 'texto'));
        $this->assertStringNotContainsString('Lançamento diário', $textoContador);
        $this->assertNotEmpty($rag->buscar('corrigir nota incorreta', $contador));
    }

    public function test_perguntar_manda_so_trechos_da_ajuda_e_devolve_a_resposta(): void
    {
        config(['petermann.anthropic.key' => 'chave-teste', 'petermann.anthropic.limite_dia_assistente' => 2]);
        Cache::flush();
        Http::fake(['api.anthropic.com/*' => Http::response(['stop_reason' => 'end_turn', 'content' => [['type' => 'text', 'text' => "## Passos
**Toque** em `Avisar`.
* item um"]]])]);
        Sanctum::actingAs($this->pessoa('gestor'));

        $r = $this->postJson('/api/assistente/perguntar', ['pergunta' => 'como avisar o dono da nota para corrigir?'])->assertOk();
        $r->assertJsonPath('resposta', "Passos
Toque em Avisar.
• item um")->assertJsonPath('motivo', null);
        $this->assertNotEmpty($r->json('fontes'));
        Http::assertSent(fn ($req) => str_contains($req['messages'][0]['content'][0]['text'], '<trechos>') && isset($req['system']));

        $this->postJson('/api/assistente/perguntar', ['pergunta' => 'como avisar o dono da nota para corrigir?'])->assertOk();
        $this->postJson('/api/assistente/perguntar', ['pergunta' => 'como avisar o dono da nota para corrigir?'])
            ->assertOk()->assertJsonPath('motivo', 'limite');
    }

    public function test_pergunta_sem_trecho_nao_chama_a_ia(): void
    {
        config(['petermann.anthropic.key' => 'chave-teste']);
        Http::fake();
        Sanctum::actingAs($this->pessoa());

        $this->postJson('/api/assistente/perguntar', ['pergunta' => 'zzxx qqww'])->assertOk()->assertJsonPath('motivo', 'sem_trecho');
        Http::assertNothingSent();
    }

    public function test_contador_pode_perguntar_e_precisa_de_login(): void
    {
        $this->postJson('/api/assistente/perguntar', ['pergunta' => 'como baixar planilha'])->assertUnauthorized();

        config(['petermann.anthropic.key' => '']);
        Sanctum::actingAs($this->pessoa('contabilidade'));
        $this->postJson('/api/assistente/perguntar', ['pergunta' => 'como baixar planilha'])->assertOk();
    }
}
