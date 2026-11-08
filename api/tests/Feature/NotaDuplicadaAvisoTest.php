<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\PushService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 08/11/2026 — "aviso automático das notas duplicadas para o gestor/admin". O app só pergunta ao colaborador
 * "Lançar assim mesmo?" e a nota entra; a gestão não ficava sabendo. Agora, quando a nota gravada repete outra
 * nota viva da equipe (mesmas regras de POST /notas/duplicada), gestor e admin recebem push. Nada é recusado.
 */
class NotaDuplicadaAvisoTest extends TestCase
{
    use RefreshDatabase;

    /** @var list<array{0: string, 1: string}> */
    private array $pushes = [];

    /** @var list<list<string>> */
    private array $destinos = [];

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('fotos');
        $this->mock(PushService::class, function ($m) {
            $m->shouldReceive('enviar')->andReturnUsing(function ($destino, $titulo, $corpo, $url = '/') {
                $this->pushes[] = [$titulo, $corpo, $url];
                $this->destinos[] = collect($destino)->map(fn ($c) => $c->id)->all();

                return 1;
            });
        });
    }

    private function pessoa(string $role, ?string $nome = null): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome ?? ucfirst($role),
            'email' => Str::slug($nome ?? $role).'-'.Str::random(4).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function corpo(Colaborador $dono, array $troca = []): array
    {
        $ontem = now('America/Sao_Paulo')->subDay();

        return array_replace([
            'user_id' => $dono->id, 'tipo' => 'RDA', 'subtipo' => 'Abastecimento', 'valor' => 87.5,
            'razao_social' => 'POSTO SANTA FE LTDA', 'cnpj' => '11222333000181', 'numero' => '4521', 'serie' => '1',
            'data' => $ontem->format('Y-m-d'), 'mes' => (int) $ontem->format('n'), 'ano' => (int) $ontem->format('Y'),
        ], $troca);
    }

    /** Fluxo do app: sobe o anexo ANTES, grava a nota depois. Foto com conteúdo, para não cair no aviso de foto em branco. */
    private function lancar(Colaborador $quem, Colaborador $dono, array $troca = [], ?string $id = null): string
    {
        $id ??= (string) Str::uuid();
        Sanctum::actingAs($quem);
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->create('nota.pdf', 10, 'application/pdf'), 'ext' => 'pdf', 'user_id' => $dono->id], ['Accept' => 'application/json'])->assertOk();
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, $troca))->assertOk();

        return $id;
    }

    public function test_nota_duplicada_lancada_avisa_gestor_e_admin(): void
    {
        $paulo = $this->pessoa('gestor', 'Paulo');
        $cleiton = $this->pessoa('admin', 'Cleiton');
        $ana = $this->pessoa('colaborador', 'Ana');
        $joao = $this->pessoa('colaborador', 'João Vitor');

        $this->lancar($ana, $ana);
        $this->assertSame([], $this->pushes, 'a primeira nota não é duplicada');

        $id = $this->lancar($joao, $joao);

        $this->assertFalse((bool) Nota::find($id)->deleted, 'só avisa: a nota entra');
        $this->assertCount(1, $this->pushes);
        $this->assertSame('Nota duplicada lançada', $this->pushes[0][0]);
        $this->assertStringContainsString('João Vitor lançou uma nota que já existe', $this->pushes[0][1]);
        $this->assertStringContainsString('mesmo número de nota e fornecedor', $this->pushes[0][1]);
        $this->assertStringContainsString('já lançada por Ana', $this->pushes[0][1]);
        $this->assertStringContainsString('R$ 87,50', $this->pushes[0][1]);
        $this->assertEqualsCanonicalizing([$paulo->id, $cleiton->id], $this->destinos[0]);
        $this->assertSame('./?abrir=nota&id='.$id, $this->pushes[0][2], 'tocar no aviso abre a nota nova');
    }

    public function test_quem_lancou_nao_recebe_o_proprio_aviso(): void
    {
        $paulo = $this->pessoa('gestor', 'Paulo');
        $cleiton = $this->pessoa('admin', 'Cleiton');
        $ana = $this->pessoa('colaborador', 'Ana');

        $this->lancar($ana, $ana);
        $this->lancar($paulo, $ana);

        $this->assertCount(1, $this->pushes);
        $this->assertSame([$cleiton->id], $this->destinos[0]);
    }

    public function test_nota_diferente_nao_avisa(): void
    {
        $this->pessoa('gestor', 'Paulo');
        $ana = $this->pessoa('colaborador', 'Ana');

        $this->lancar($ana, $ana);
        $this->lancar($ana, $ana, ['numero' => '9999', 'valor' => 40]);

        $this->assertSame([], $this->pushes);
    }

    public function test_reenvio_e_edicao_da_mesma_nota_nao_avisam_de_novo(): void
    {
        $this->pessoa('gestor', 'Paulo');
        $ana = $this->pessoa('colaborador', 'Ana');
        $this->lancar($ana, $ana);
        $id = $this->lancar($ana, $ana);
        $this->assertCount(1, $this->pushes);

        Sanctum::actingAs($ana);
        $this->putJson("/api/notas/{$id}", $this->corpo($ana))->assertOk();                       // fila reenviando
        $this->putJson("/api/notas/{$id}", $this->corpo($ana, ['subtipo' => 'Outros']))->assertOk(); // edição

        $this->assertCount(1, $this->pushes);
    }

    public function test_nota_na_lixeira_nao_conta_e_restaurar_duplicada_avisa(): void
    {
        $this->pessoa('gestor', 'Paulo');
        $ana = $this->pessoa('colaborador', 'Ana');
        $primeira = $this->lancar($ana, $ana);
        $segunda = $this->lancar($ana, $ana);
        $this->assertCount(1, $this->pushes);

        Sanctum::actingAs($ana);
        $this->putJson("/api/notas/{$segunda}", $this->corpo($ana, ['deleted' => true]))->assertOk();
        $this->assertCount(1, $this->pushes, 'mandar para a lixeira não avisa');

        $this->putJson("/api/notas/{$segunda}", $this->corpo($ana, ['deleted' => false]))->assertOk();
        $this->assertCount(2, $this->pushes, 'tirar da lixeira uma nota que repete outra viva avisa');
        $this->assertNotNull(Nota::find($primeira));
    }
}
