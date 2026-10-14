<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 14/10/2026 — "o Contador não lança notas, ele visualiza e baixa os arquivos".
 * A trava vivia só em alguns controllers (notas e repasses); Frota, Ponto, IA,
 * CNPJ e QR esqueceram. Agora é o middleware SomenteLeitura, e este teste
 * percorre TODAS as rotas com token de contabilidade: escrita fora da lista
 * curta responde 403, inclusive a rota que alguém criar amanhã.
 */
class ContadorSoLeituraTest extends TestCase
{
    use RefreshDatabase;

    /** Escritas que o Contador faz de verdade (perfil e abertura de anexos). */
    private const LIBERADAS = [
        'POST auth/logout', 'PATCH me', 'POST me/foto', 'DELETE me/foto',
        'POST fotos/urls', 'POST notas/existem', 'PATCH colaboradores/{id}',
    ];

    private function pessoa(string $role): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(),
            'nome' => ucfirst($role), 'email' => $role.'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    public function test_toda_rota_de_escrita_fora_da_lista_responde_403_para_o_contador(): void
    {
        $contador = $this->pessoa('contabilidade');
        Sanctum::actingAs($contador);

        $testadas = 0;
        foreach (Route::getRoutes() as $rota) {
            $uri = $rota->uri();
            if (! str_starts_with($uri, 'api/') || ! in_array('auth:sanctum', $rota->gatherMiddleware(), true)) {
                continue;
            }
            $caminho = substr($uri, 4);
            foreach ($rota->methods() as $metodo) {
                if (in_array($metodo, ['GET', 'HEAD', 'OPTIONS'], true) || in_array($metodo.' '.$caminho, self::LIBERADAS, true)) {
                    continue;
                }
                $url = '/'.preg_replace('/\{[^}]+\}/', 'x', $uri);
                $resp = $this->json($metodo, $url);
                $this->assertSame(403, $resp->getStatusCode(), "$metodo $url deveria ser 403 para o Contador (veio {$resp->getStatusCode()})");
                $this->assertTrue((bool) $resp->json('somente_leitura'), "$metodo $url: 403 deve vir do SomenteLeitura");
                $testadas++;
            }
        }
        $this->assertGreaterThan(20, $testadas, 'o teste precisa ter percorrido as rotas de escrita');
    }

    public function test_contador_nao_le_ponto_frota_nem_historico_detalhado(): void
    {
        Sanctum::actingAs($this->pessoa('contabilidade'));

        foreach (['/api/ponto', '/api/ponto/resumo', '/api/feriados', '/api/km', '/api/veiculos', '/api/frota/resumo', '/api/frota/anual', '/api/notas/apagadas?detalhe=1'] as $url) {
            $this->getJson($url)->assertStatus(403)->assertJsonPath('somente_leitura', true);
        }
    }

    public function test_contador_continua_vendo_a_equipe_e_baixando(): void
    {
        $this->pessoa('colaborador');
        Sanctum::actingAs($this->pessoa('contabilidade'));

        $this->getJson('/api/colaboradores')->assertOk();
        $this->getJson('/api/notas')->assertOk();
        $this->getJson('/api/repasses')->assertOk();
        $this->getJson('/api/notas/apagadas')->assertOk();
        $this->getJson('/api/arquivos/resumo')->assertOk();
        $this->getJson('/api/me')->assertOk();
    }

    public function test_contador_edita_so_o_proprio_perfil(): void
    {
        $outro = $this->pessoa('colaborador');
        $contador = $this->pessoa('contabilidade');
        Sanctum::actingAs($contador);

        $this->patchJson('/api/me', ['nome' => 'Patrícia M.'])->assertOk();
        $this->patchJson("/api/colaboradores/{$contador->id}", ['nome' => 'Patrícia Moraes'])->assertOk();
        $this->patchJson("/api/colaboradores/{$outro->id}", ['nome' => 'Invasor'])->assertStatus(403);
        $this->assertSame('Colaborador', $outro->fresh()->nome);
    }

    public function test_colaborador_e_gestor_nao_sao_afetados(): void
    {
        foreach (['colaborador', 'gestor'] as $papel) {
            Sanctum::actingAs($this->pessoa($papel));
            $this->getJson('/api/ponto')->assertOk();
            $this->getJson('/api/km')->assertOk();
            $this->getJson('/api/notas/apagadas')->assertOk();
        }
        $this->assertTrue(true);
    }

    public function test_gestor_que_vira_contador_perde_o_regime_cv(): void
    {
        $gestor = $this->pessoa('gestor');
        $alvo = $this->pessoa('colaborador');
        $alvo->forceFill(['regime' => 'cv'])->save();
        Sanctum::actingAs($gestor);

        $this->patchJson("/api/colaboradores/{$alvo->id}", ['role' => 'contabilidade', 'regime' => 'cv'])->assertOk();
        $this->assertSame('contabilidade', $alvo->fresh()->role);
        $this->assertSame('rdm_rda', $alvo->fresh()->regime);
    }
}
