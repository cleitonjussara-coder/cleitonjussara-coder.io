<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 22/10/2026 — pasta "Faturamento" na tela Arquivos: as notas que a empresa pagou direto (pagamento='empresa'),
 * de qualquer colaborador ou sem colaborador, reunidas numa pasta só. Só gestor/admin/contabilidade enxergam.
 */
class ArquivosFaturamentoTest extends TestCase
{
    use RefreshDatabase;

    private const ANO = 2026;

    private function pessoa(string $role, string $nome): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome, 'email' => Str::slug($nome).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['regime' => 'rdm_rda', 'ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(?Colaborador $c, string $razao, float $valor, ?string $pagamento, int $mes = 3, ?string $foto = null): Nota
    {
        $n = new Nota([
            'id' => (string) Str::uuid(), 'user_id' => $c?->id, 'tipo' => 'RDM', 'subtipo' => 'Hospedagem', 'valor' => $valor,
            'data' => sprintf('%d-%02d-10', self::ANO, $mes), 'mes' => $mes, 'ano' => self::ANO, 'razao_social' => $razao,
            'pagamento' => $pagamento, 'deleted' => false,
        ]);
        $n->forceFill(['foto_path' => $foto])->save();

        return $n;
    }

    public function test_resumo_e_notas_do_faturamento_juntam_todo_mundo_e_quem_nao_tem_dono(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora');
        $paulo = $this->pessoa('colaborador', 'Paulo');
        $this->nota($paulo, 'HOTEL PAGO PELA EMPRESA', 300, 'empresa');
        $this->nota(null, 'HOTEL SEM DONO', 200, 'empresa', 4);
        $this->nota($paulo, 'POSTO DO BOLSO', 50, null);
        Sanctum::actingAs($gestor);

        $r = $this->getJson('/api/arquivos/resumo?ano='.self::ANO)->assertOk();
        $this->assertSame(2, $r->json('faturamento.qtd'));
        $this->assertEquals(500, $r->json('faturamento.total'));
        $this->assertSame([3, 4], array_column($r->json('faturamento.meses'), 'mes'));

        $notas = $this->getJson('/api/arquivos/notas?faturamento=1&ano='.self::ANO.'&mes=3')->assertOk()->json('notas');
        $this->assertSame(['HOTEL PAGO PELA EMPRESA'], array_column($notas, 'razao_social'));
        $this->assertStringStartsWith('Faturamento/2026/', $notas[0]['pasta']);
    }

    public function test_zip_do_faturamento_fica_na_pasta_faturamento_com_a_planilha_de_faturamento(): void
    {
        Storage::fake('fotos');
        $gestor = $this->pessoa('gestor', 'Gestora');
        $paulo = $this->pessoa('colaborador', 'Paulo');
        Storage::disk('fotos')->put('x/a.jpg', 'jpg');
        Storage::disk('fotos')->put('x/b.jpg', 'jpg');
        $this->nota($paulo, 'HOTEL A', 300, 'empresa', 3, 'x/a.jpg');
        $this->nota(null, 'HOTEL B', 200, 'empresa', 3, 'x/b.jpg');
        $this->nota($paulo, 'POSTO DO BOLSO', 50, null, 3, 'x/a.jpg');
        Sanctum::actingAs($gestor);

        $resp = $this->get('/api/arquivos/zip?faturamento=1&ano='.self::ANO.'&mes=3');
        $resp->assertOk();
        $this->assertStringContainsString('Notas_Faturamento_2026-03.zip', (string) $resp->headers->get('content-disposition'));
        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($resp->baseResponse->getFile()->getPathname()) === true);
        $nomes = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $nomes[] = $zip->getNameIndex($i);
        }
        $zip->close();

        $this->assertCount(3, $nomes, implode(', ', $nomes));   // 2 anexos + a planilha
        foreach ($nomes as $n) {
            $this->assertStringStartsWith('Faturamento/2026/', $n);
            $this->assertStringNotContainsString('POSTO DO BOLSO', $n);
        }
        $this->assertContains('Faturamento/2026/Planilha_Faturamento_2026.xlsx', $nomes);
        $this->assertEmpty(array_filter($nomes, fn ($n) => str_contains($n, 'Planilha_CV') || str_contains($n, 'Planilha_RDM')));
    }

    /** Achado da revisão de 22/10/2026: "HOTEL IPE" e "Hotel Ipe" são o mesmo arquivo no Windows — um sobrescrevia o outro ao extrair. */
    public function test_zip_nao_repete_nome_que_so_muda_maiuscula(): void
    {
        Storage::fake('fotos');
        $gestor = $this->pessoa('gestor', 'Gestora');
        $ana = $this->pessoa('colaborador', 'Ana');
        $bruno = $this->pessoa('colaborador', 'Bruno');
        Storage::disk('fotos')->put('x/a.jpg', 'jpg');
        Storage::disk('fotos')->put('x/b.jpg', 'jpg');
        $this->nota($ana, 'HOTEL IPE', 250, 'empresa', 3, 'x/a.jpg');
        $this->nota($bruno, 'Hotel Ipe', 250, 'empresa', 3, 'x/b.jpg');
        Sanctum::actingAs($gestor);

        $resp = $this->get('/api/arquivos/zip?faturamento=1&planilha=0&ano='.self::ANO.'&mes=3');
        $resp->assertOk();
        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($resp->baseResponse->getFile()->getPathname()) === true);
        $nomes = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $nomes[] = mb_strtolower($zip->getNameIndex($i));
        }
        $zip->close();

        $this->assertCount(2, $nomes);
        $this->assertCount(2, array_unique($nomes), 'sem diferenciar maiúsculas, os dois nomes têm de ser diferentes: '.implode(', ', $nomes));
    }

    public function test_colaborador_nao_ve_o_faturamento(): void
    {
        $paulo = $this->pessoa('colaborador', 'Paulo');
        $this->nota($paulo, 'HOTEL PAGO PELA EMPRESA', 300, 'empresa');
        Sanctum::actingAs($paulo);

        $this->assertNull($this->getJson('/api/arquivos/resumo?ano='.self::ANO)->assertOk()->json('faturamento'));
        $this->getJson('/api/arquivos/notas?faturamento=1&ano='.self::ANO)->assertForbidden();
        $this->get('/api/arquivos/zip?faturamento=1&ano='.self::ANO)->assertForbidden();
    }

    public function test_locacao_de_veiculos_vira_categoria_propria_na_pasta(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora');
        $n = $this->nota(null, 'LOCADORA X', 900, 'empresa');
        Sanctum::actingAs($gestor);

        $this->patchJson("/api/notas/{$n->id}/tipo", ['tipo' => 'RDM', 'subtipo' => 'Locação de Veículos'])->assertOk();

        $r = $this->getJson('/api/arquivos/notas?faturamento=1&ano='.self::ANO.'&mes=3')->assertOk();
        $this->assertSame('RDM · LOCAÇÃO DE VEÍCULOS', $r->json('notas.0.grupo'));
        $this->assertStringContainsString('LOCAÇÃO DE VEÍCULOS', $r->json('notas.0.pasta'));
    }

    public function test_gestor_manda_nota_faturada_para_a_lixeira_e_contador_nao(): void
    {
        $gestor = $this->pessoa('gestor', 'Gestora');
        $contador = $this->pessoa('contabilidade', 'Contador');
        $n = $this->nota(null, 'HOTEL', 1215.78, 'empresa');

        Sanctum::actingAs($contador);
        $this->patchJson("/api/notas/{$n->id}/lixeira", ['deleted' => true])->assertStatus(403);

        Sanctum::actingAs($gestor);
        $this->patchJson("/api/notas/{$n->id}/lixeira", ['deleted' => true])->assertOk();
        $this->assertTrue((bool) $n->fresh()->deleted);
        $r = $this->getJson('/api/arquivos/resumo?ano='.self::ANO)->assertOk();
        $this->assertSame(0, $r->json('faturamento.qtd'));

        $this->patchJson("/api/notas/{$n->id}/lixeira", ['deleted' => false])->assertOk();
        $this->assertFalse((bool) $n->fresh()->deleted);
    }
}
