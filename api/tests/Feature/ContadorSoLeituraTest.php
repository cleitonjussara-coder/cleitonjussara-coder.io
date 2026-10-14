<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
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
        /* corrigir nota que já existe (14/10/2026): o controller segura o resto */
        'PUT notas/{id}', 'PATCH notas/{id}/tipo', 'POST notas/{id}/foto',
        'POST notas/chave-existe', 'POST notas/ler-foto',
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

    private function nota(Colaborador $dono, array $campos = []): Nota
    {
        $agora = now('America/Sao_Paulo');
        $n = new Nota(array_replace([
            'id' => (string) Str::uuid(), 'user_id' => $dono->id, 'tipo' => 'RDA', 'valor' => 50,
            'data' => $agora->format('Y-m-d'), 'mes' => (int) $agora->format('n'), 'ano' => (int) $agora->format('Y'),
            'razao_social' => 'FORNECEDOR TESTE', 'deleted' => false,
        ], $campos));
        $n->save();

        return $n->fresh();
    }

    private function corpo(Nota $n, array $troca = []): array
    {
        return array_replace([
            'user_id' => $n->user_id, 'tipo' => $n->tipo, 'valor' => (float) $n->valor,
            'data' => $n->data->format('Y-m-d'), 'mes' => (int) $n->mes, 'ano' => (int) $n->ano,
            'razao_social' => $n->razao_social, 'deleted' => false,
        ], $troca);
    }

    public function test_contador_corrige_nota_existente_e_fica_registrado_como_autor(): void
    {
        $colab = $this->pessoa('colaborador');
        $contador = $this->pessoa('contabilidade');
        $nota = $this->nota($colab);
        Sanctum::actingAs($contador);

        $this->putJson("/api/notas/{$nota->id}", $this->corpo($nota, ['valor' => 77.5, 'razao_social' => 'RAZAO CORRIGIDA']))
            ->assertOk();
        $this->assertEquals(77.5, $nota->fresh()->valor);

        $depois = $nota->fresh();
        $this->assertSame('RAZAO CORRIGIDA', $depois->razao_social);
        $this->assertSame($colab->id, $depois->user_id, 'a nota continua do colaborador');
        $this->assertSame($contador->id, $depois->updated_by, 'o Histórico lê updated_by: precisa ser o Contador');
    }

    public function test_contador_corrige_o_grupo_da_nota(): void
    {
        $colab = $this->pessoa('colaborador');
        $nota = $this->nota($colab, ['tipo' => 'RDA']);
        Sanctum::actingAs($this->pessoa('contabilidade'));

        $this->patchJson("/api/notas/{$nota->id}/tipo", ['tipo' => 'RDM', 'subtipo' => 'Hospedagem'])->assertOk()->assertJsonPath('mudou', true);
        $this->assertSame('RDM', $nota->fresh()->tipo);
    }

    public function test_contador_nao_lanca_nota_nova_nem_exclui_nem_troca_o_dono(): void
    {
        $colab = $this->pessoa('colaborador');
        $outro = $this->pessoa('gestor');
        $contador = $this->pessoa('contabilidade');
        $nota = $this->nota($colab);
        Sanctum::actingAs($contador);

        $nova = $this->nota($colab);
        $nova->delete();   // um id que não existe mais: seria nota NOVA
        $this->putJson("/api/notas/{$nova->id}", $this->corpo($nova))->assertStatus(403);
        $this->assertNull(Nota::find($nova->id));

        $this->putJson("/api/notas/{$nota->id}", $this->corpo($nota, ['deleted' => true]))->assertStatus(403);
        $this->assertFalse((bool) $nota->fresh()->deleted);

        $this->putJson("/api/notas/{$nota->id}", $this->corpo($nota, ['user_id' => $outro->id]))->assertStatus(403);
        $this->assertSame($colab->id, $nota->fresh()->user_id);

        $this->deleteJson("/api/notas/{$nota->id}")->assertStatus(403);
        $this->assertNotNull(Nota::find($nota->id));
    }

    public function test_contador_nao_mexe_em_nota_de_faturamento_nem_em_repasse(): void
    {
        $colab = $this->pessoa('colaborador');
        $fat = $this->nota($colab, ['pagamento' => 'empresa']);
        $comum = $this->nota($colab);
        Sanctum::actingAs($this->pessoa('contabilidade'));

        $this->putJson("/api/notas/{$fat->id}", $this->corpo($fat, ['valor' => 1]))->assertStatus(403);
        $this->putJson("/api/notas/{$comum->id}", $this->corpo($comum, ['pagamento' => 'empresa']))->assertStatus(403);
        $this->putJson('/api/repasses/'.Str::uuid(), ['user_id' => $colab->id, 'tipo' => 'RDM', 'valor' => 10, 'data' => now('America/Sao_Paulo')->format('Y-m-d'), 'mes' => 1, 'ano' => 2026, 'kind' => 'received'])->assertStatus(403);
    }

    public function test_anexo_so_pode_ser_trocado_em_nota_que_existe(): void
    {
        $colab = $this->pessoa('colaborador');
        $nota = $this->nota($colab);
        Sanctum::actingAs($this->pessoa('contabilidade'));

        $arquivo = \Illuminate\Http\UploadedFile::fake()->image('nota.jpg', 100, 100);
        $this->post("/api/notas/{$nota->id}/foto", ['file' => $arquivo], ['Accept' => 'application/json'])->assertOk();
        $this->assertNotEmpty($nota->fresh()->foto_path);

        $novoId = (string) Str::uuid();
        $outro = \Illuminate\Http\UploadedFile::fake()->image('nota2.jpg', 100, 100);
        $this->post("/api/notas/{$novoId}/foto", ['file' => $outro, 'user_id' => $colab->id], ['Accept' => 'application/json'])->assertStatus(403);
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
