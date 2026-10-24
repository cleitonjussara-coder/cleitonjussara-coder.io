<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 24/10/2026 — achado na revisão do aviso de correção: o servidor aceitava QUALQUER texto como id de nota nova, e o app
 * coloca o id dentro de atributos de HTML (onclick, data-*) em várias telas. Um colaborador podia criar uma nota
 * (já na lixeira, que não exige anexo), restaurá-la e fazer o quadro "O que falta corrigir" do gestor rodar código dele.
 * O app sempre gera o id com crypto.randomUUID(), então nota NOVA só entra com UUID; nota que já existe segue como está.
 */
class NotaIdUuidTest extends TestCase
{
    use RefreshDatabase;

    private function colaborador(): Colaborador
    {
        $c = new Colaborador(['id' => (string) Str::uuid(), 'nome' => 'Ana', 'email' => 'ana@teste.local', 'password' => 'segredo123', 'role' => 'colaborador']);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function corpo(Colaborador $dono, array $troca = []): array
    {
        $hoje = now('America/Sao_Paulo');

        return array_replace([
            'user_id' => $dono->id, 'tipo' => 'RDM', 'valor' => 10, 'data' => $hoje->format('Y-m-d'),
            'mes' => (int) $hoje->format('n'), 'ano' => (int) $hoje->format('Y'), 'razao_social' => 'TESTE', 'deleted' => true,
        ], $troca);
    }

    public function test_nota_nova_com_id_que_nao_e_uuid_e_recusada(): void
    {
        $ana = $this->colaborador();
        Sanctum::actingAs($ana);

        foreach (['x"onmouseover="alert(1)', "a'b", 'nota-1', 'x y', '<script>', str_repeat('a', 36)] as $ruim) {
            $this->putJson('/api/notas/'.rawurlencode($ruim), $this->corpo($ana))->assertStatus(422)->assertJsonPath('message', 'Identificador de nota inválido.');
        }
        $this->assertSame(0, Nota::count());
    }

    public function test_nota_nova_com_uuid_continua_entrando(): void
    {
        $ana = $this->colaborador();
        Sanctum::actingAs($ana);
        $id = (string) Str::uuid();

        $this->putJson("/api/notas/$id", $this->corpo($ana))->assertOk();
        $this->assertNotNull(Nota::find($id));
    }

    public function test_nota_que_ja_existe_com_id_antigo_continua_editavel(): void
    {
        $ana = $this->colaborador();
        $legada = new Nota(['id' => 'legado-123', 'user_id' => $ana->id, 'tipo' => 'RDM', 'valor' => 5, 'data' => now('America/Sao_Paulo')->format('Y-m-d'),
            'mes' => (int) now('America/Sao_Paulo')->format('n'), 'ano' => (int) now('America/Sao_Paulo')->format('Y'), 'razao_social' => 'ANTIGA', 'deleted' => false]);
        $legada->save();
        Sanctum::actingAs($ana);

        $this->putJson('/api/notas/legado-123', $this->corpo($ana, ['deleted' => false, 'valor' => 6]))->assertOk();
        $this->assertEquals(6, Nota::find('legado-123')->valor);
    }

    /** O envio do anexo já exigia UUID (NotaController::foto); este teste garante que continua assim. */
    public function test_anexo_com_id_que_nao_e_uuid_continua_recusado(): void
    {
        Storage::fake('fotos');
        $ana = $this->colaborador();
        Sanctum::actingAs($ana);

        $this->post('/api/notas/'.rawurlencode('x"y').'/foto', ['file' => UploadedFile::fake()->image('a.jpg')], ['Accept' => 'application/json'])
            ->assertStatus(422);
        $this->assertSame([], Storage::disk('fotos')->allFiles());
    }

    /** O caminho que estava aberto: nota nascida na lixeira (sem anexo) e depois restaurada. */
    public function test_nao_da_para_criar_na_lixeira_e_restaurar_com_id_malicioso(): void
    {
        $ana = $this->colaborador();
        Sanctum::actingAs($ana);
        $mal = 'x"onmouseover="alert(1)';

        $this->putJson('/api/notas/'.rawurlencode($mal), $this->corpo($ana, ['deleted' => true]))->assertStatus(422);
        $this->putJson('/api/notas/'.rawurlencode($mal), $this->corpo($ana, ['deleted' => false]))->assertStatus(422);
        $this->assertNull(Nota::find($mal));
    }
}
