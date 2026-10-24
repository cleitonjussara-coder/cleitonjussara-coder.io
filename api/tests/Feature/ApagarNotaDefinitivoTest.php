<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 23/10/2026 — o Paulo (gestor) tentou "Apagar definitivo" numa nota da Lixeira e ouviu que só o dono ou o admin podiam.
 * A Lixeira mostra, além das notas da pessoa, as que não têm dono (Faturamento sem colaborador, que só gestor/admin
 * lança) — para essas o `user_id === eu` nunca fecha, então nem o gestor limpava. Agora: dono, gestor ou admin.
 * Colaborador que não é o dono e o Contador (somente leitura) continuam barrados.
 */
class ApagarNotaDefinitivoTest extends TestCase
{
    use RefreshDatabase;

    private function pessoa(string $role, string $sufixo = ''): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(),
            'nome' => ucfirst($role).$sufixo, 'email' => $role.$sufixo.'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    /** Nota já na Lixeira (é de onde o app oferece "Apagar definitivo"). $dono null = Faturamento sem colaborador. */
    private function notaNaLixeira(?Colaborador $dono, array $campos = []): Nota
    {
        $agora = now('America/Sao_Paulo');
        $n = new Nota(array_replace([
            'id' => (string) Str::uuid(), 'user_id' => $dono?->id, 'tipo' => 'RDA', 'valor' => 50,
            'data' => $agora->format('Y-m-d'), 'mes' => (int) $agora->format('n'), 'ano' => (int) $agora->format('Y'),
            'razao_social' => 'FORNECEDOR TESTE', 'deleted' => true,
        ], $campos));
        $n->save();

        return $n->fresh();
    }

    private function lapide(Nota $n): ?object
    {
        return DB::table('notas_apagadas')->where('id', $n->id)->first();
    }

    public function test_dono_apaga_a_propria_nota_em_definitivo(): void
    {
        $colab = $this->pessoa('colaborador');
        $nota = $this->notaNaLixeira($colab);
        Sanctum::actingAs($colab);

        $this->deleteJson("/api/notas/{$nota->id}")->assertOk()->assertJsonPath('ok', true);

        $this->assertNull(Nota::find($nota->id));
        $this->assertSame($colab->id, $this->lapide($nota)->apagada_por);
    }

    public function test_gestor_apaga_nota_de_colaborador_e_a_lapide_diz_quem_foi(): void
    {
        $colab = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        $nota = $this->notaNaLixeira($colab);
        Sanctum::actingAs($gestor);

        $this->deleteJson("/api/notas/{$nota->id}")->assertOk();

        $this->assertNull(Nota::find($nota->id));
        $l = $this->lapide($nota);
        $this->assertSame($gestor->id, $l->apagada_por, 'o Histórico lê apagada_por: precisa ser o gestor');
        $this->assertSame($colab->id, $l->user_id, 'a lápide guarda de quem era a nota');
    }

    /** O caso do Paulo: nota sem dono, na Lixeira dele. */
    public function test_gestor_apaga_nota_de_faturamento_sem_colaborador_e_leva_o_anexo(): void
    {
        Storage::fake('fotos');
        $gestor = $this->pessoa('gestor');
        $nota = $this->notaNaLixeira(null, ['pagamento' => 'empresa']);
        $anexo = Nota::PASTA_GERAL."/{$nota->id}.jpg";
        Storage::disk('fotos')->put($anexo, 'jpg');
        Sanctum::actingAs($gestor);

        $this->deleteJson("/api/notas/{$nota->id}")->assertOk();

        $this->assertNull(Nota::find($nota->id));
        $this->assertFalse(Storage::disk('fotos')->exists($anexo), 'o anexo da pasta geral sai junto');
        $l = $this->lapide($nota);
        $this->assertNull($l->user_id);
        $this->assertSame($gestor->id, $l->apagada_por);
    }

    public function test_admin_continua_apagando(): void
    {
        $colab = $this->pessoa('colaborador');
        $nota = $this->notaNaLixeira($colab);
        Sanctum::actingAs($this->pessoa('admin'));

        $this->deleteJson("/api/notas/{$nota->id}")->assertOk();

        $this->assertNull(Nota::find($nota->id));
    }

    public function test_colaborador_nao_apaga_nota_de_outro_colaborador(): void
    {
        $dono = $this->pessoa('colaborador', '1');
        $intruso = $this->pessoa('colaborador', '2');
        $nota = $this->notaNaLixeira($dono);
        Sanctum::actingAs($intruso);

        $this->deleteJson("/api/notas/{$nota->id}")->assertForbidden();

        $this->assertNotNull(Nota::find($nota->id), 'a nota continua lá');
        $this->assertNull($this->lapide($nota), 'e nenhuma lápide foi criada');
    }

    public function test_colaborador_nao_apaga_nota_sem_dono(): void
    {
        $nota = $this->notaNaLixeira(null, ['pagamento' => 'empresa']);
        Sanctum::actingAs($this->pessoa('colaborador'));

        $this->deleteJson("/api/notas/{$nota->id}")->assertForbidden();

        $this->assertNotNull(Nota::find($nota->id));
    }

    public function test_contador_nao_apaga_nada(): void
    {
        $nota = $this->notaNaLixeira($this->pessoa('colaborador'));
        Sanctum::actingAs($this->pessoa('contabilidade'));

        $this->deleteJson("/api/notas/{$nota->id}")->assertForbidden()->assertJsonPath('somente_leitura', true);

        $this->assertNotNull(Nota::find($nota->id));
        $this->assertNull($this->lapide($nota));
    }

    /** A corrida: um gestor restaurou a nota sem dono; o outro, com a Lixeira velha na tela, manda apagar. */
    public function test_gestor_e_admin_nao_apagam_nota_viva_de_outra_pessoa(): void
    {
        $colab = $this->pessoa('colaborador');
        foreach (['gestor', 'admin'] as $papel) {
            $viva = $this->notaNaLixeira($colab, ['deleted' => false]);
            $semDono = $this->notaNaLixeira(null, ['deleted' => false, 'pagamento' => 'empresa']);
            Sanctum::actingAs($this->pessoa($papel));

            foreach ([$viva, $semDono] as $nota) {
                $this->deleteJson("/api/notas/{$nota->id}")->assertStatus(409);
                $this->assertNotNull(Nota::find($nota->id), "$papel: a nota viva continua lá");
                $this->assertNull($this->lapide($nota), "$papel: e nenhuma lápide foi criada");
            }
        }
    }

    /** O dono segue como sempre: a exigência de lixeira vale só para quem não é o dono. */
    public function test_dono_continua_apagando_nota_mesmo_fora_da_lixeira(): void
    {
        $colab = $this->pessoa('colaborador');
        $nota = $this->notaNaLixeira($colab, ['deleted' => false]);
        Sanctum::actingAs($colab);

        $this->deleteJson("/api/notas/{$nota->id}")->assertOk();

        $this->assertNull(Nota::find($nota->id));
    }
}
