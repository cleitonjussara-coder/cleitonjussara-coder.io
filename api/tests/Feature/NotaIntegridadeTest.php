<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\FotoStorage;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 03/11/2026 — pente fino das notas no servidor:
 *   409 correção da gestão não é desfeita por aparelho que editou em cima da versão velha;
 *   410 nota apagada em definitivo não renasce pela fila de um aparelho;
 *   403 só quem gerencia põe ou tira 'empresa' (Faturamento);
 *   foto_path nunca vem do cliente, e caminho malicioso já gravado não derruba Arquivos e ZIP.
 */
class NotaIntegridadeTest extends TestCase
{
    use RefreshDatabase;

    private const DATA = '2026-10-10';

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('fotos');
        $this->travelTo('2026-10-20 12:00:00');
    }

    private function pessoa(string $role): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(),
            'nome' => ucfirst($role), 'email' => $role.Str::random(6).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function corpo(?string $dono, array $troca = []): array
    {
        return array_replace([
            'user_id' => $dono, 'tipo' => 'RDM', 'subtipo' => 'Outros', 'pagamento' => 'carteira',
            'razao_social' => 'POSTO ORIGINAL', 'valor' => 100, 'data' => self::DATA, 'mes' => 10, 'ano' => 2026,
            'deleted' => false,
        ], $troca);
    }

    private function subirAnexo(string $id, array $campos = [])
    {
        return $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->image('nota.jpg', 60, 60)] + $campos, ['Accept' => 'application/json']);
    }

    /** Lança como o app: anexo primeiro, nota depois. Devolve o id e o updated_at que o aparelho passa a conhecer. */
    private function lancar(Colaborador $quem, array $troca = []): array
    {
        $id = (string) Str::uuid();
        Sanctum::actingAs($quem);
        $this->subirAnexo($id, ['user_id' => $troca['user_id'] ?? $quem->id])->assertOk();
        $r = $this->putJson("/api/notas/{$id}", $this->corpo($quem->id, $troca))->assertOk();

        return [$id, $r->json('updated_at')];
    }

    private function correcaoDoContador(string $id, string $dono): void
    {
        $this->travel(5)->minutes();
        Sanctum::actingAs($this->pessoa('contabilidade'));
        $this->putJson("/api/notas/{$id}", $this->corpo($dono, ['valor' => 80, 'razao_social' => 'POSTO CORRIGIDO']))->assertOk();
        $this->travel(5)->minutes();
    }

    /* ── Item 2: 409 ─────────────────────────────────────────────── */

    public function test_nota_nova_com_anexo_continua_funcionando(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id, $base] = $this->lancar($colab);

        $nota = Nota::findOrFail($id);
        $this->assertSame("{$colab->id}/{$id}.jpg", $nota->foto_path);
        $this->assertSame($colab->id, $nota->updated_by);
        $this->assertNotEmpty($base, 'devolve o updated_at do servidor');
    }

    public function test_contador_corrige_e_colaborador_com_base_velha_recebe_409_sem_gravar(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id, $base] = $this->lancar($colab);
        $this->correcaoDoContador($id, $colab->id);
        $antes = Nota::findOrFail($id)->updated_at->getTimestamp();

        Log::spy();
        Sanctum::actingAs($colab);
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 999, 'base_updated_at' => $base]))
            ->assertStatus(409)
            ->assertJsonPath('conflito', true)
            ->assertJsonPath('nota.id', $id)
            ->assertJsonPath('nota.razao_social', 'POSTO CORRIGIDO');

        $nota = Nota::findOrFail($id);
        $this->assertSame(80.0, $nota->valor);
        $this->assertSame('POSTO CORRIGIDO', $nota->razao_social);
        $this->assertSame($antes, $nota->updated_at->getTimestamp());
        Log::shouldHaveReceived('warning')->withArgs(fn ($msg, $ctx = []) => ($ctx['id'] ?? null) === $id
            && ($ctx['descartado']['valor'] ?? null) == 999 && array_key_exists('razao_social', $ctx['descartado'])
            && ! empty($ctx['enviado_por']))->once();
    }

    public function test_grupo_corrigido_pelo_gestor_tambem_da_409(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id, $base] = $this->lancar($colab);
        $this->travel(5)->minutes();
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->patchJson("/api/notas/{$id}/tipo", ['tipo' => 'RDA'])->assertOk();

        $this->travel(5)->minutes();
        Sanctum::actingAs($colab);
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['base_updated_at' => $base]))->assertStatus(409);
        $this->assertSame('RDA', Nota::findOrFail($id)->tipo);
    }

    public function test_nota_na_lixeira_pelo_gestor_e_colaborador_com_base_velha_recebe_409(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id, $base] = $this->lancar($colab);
        $this->travel(5)->minutes();
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->patchJson("/api/notas/{$id}/lixeira", ['deleted' => true])->assertOk();

        $this->travel(5)->minutes();
        Sanctum::actingAs($colab);
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 999, 'deleted' => false, 'base_updated_at' => $base]))
            ->assertStatus(409)->assertJsonPath('nota.deleted', true);
        $this->assertTrue(Nota::findOrFail($id)->deleted, 'a nota não volta da lixeira');
    }

    public function test_aparelho_antigo_sem_base_grava_como_antes(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id] = $this->lancar($colab);
        $this->correcaoDoContador($id, $colab->id);

        Sanctum::actingAs($colab);
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 999]))->assertOk();
        $this->assertSame(999.0, Nota::findOrFail($id)->valor);
    }

    public function test_base_invalida_segue_como_aparelho_antigo(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id] = $this->lancar($colab);
        $this->correcaoDoContador($id, $colab->id);
        Sanctum::actingAs($colab);

        foreach (['', 'ontem', 'yesterday', '0', '2026-13-45T00:00:00Z', 12345, ['x']] as $i => $base) {
            $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 500 + $i, 'base_updated_at' => $base]))->assertOk();
            $this->assertSame((float) (500 + $i), Nota::findOrFail($id)->valor);
            /* cada volta o colaborador vira o último a mexer: devolve a correção à gestão para a próxima valer */
            Nota::whereKey($id)->update(['updated_by' => Colaborador::where('role', 'contabilidade')->value('id')]);
        }
    }

    public function test_base_em_dia_passa_mesmo_depois_da_correcao_da_gestao(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id] = $this->lancar($colab);
        $this->correcaoDoContador($id, $colab->id);
        $atual = Nota::findOrFail($id)->updated_at;

        Sanctum::actingAs($colab);
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 70, 'base_updated_at' => $atual->copy()->utc()->format('Y-m-d\TH:i:s.v\Z')]))->assertOk();
        $this->assertSame(70.0, Nota::findOrFail($id)->valor);
    }

    public function test_base_compara_o_instante_e_nao_o_texto(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id] = $this->lancar($colab);
        $this->correcaoDoContador($id, $colab->id);
        $atual = Nota::findOrFail($id)->updated_at;
        Sanctum::actingAs($colab);

        /* mesmo instante em Brasília: como texto seria "mais velho", e é o mesmo momento */
        $igual = $atual->copy()->setTimezone('America/Sao_Paulo')->format('Y-m-d\TH:i:sP');
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['base_updated_at' => $igual]))->assertOk();

        /* um segundo antes da correção, em Brasília: conflito */
        Nota::whereKey($id)->update(['updated_by' => Colaborador::where('role', 'contabilidade')->value('id')]);
        $antes = Nota::findOrFail($id)->updated_at->copy()->subSecond()->setTimezone('America/Sao_Paulo')->format('Y-m-d\TH:i:sP');
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['base_updated_at' => $antes]))->assertStatus(409);
    }

    public function test_proprio_colaborador_editando_duas_vezes_nao_da_conflito(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id, $base] = $this->lancar($colab);

        $this->travel(5)->minutes();
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 110, 'base_updated_at' => $base]))->assertOk();
        $this->travel(5)->minutes();
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 120, 'base_updated_at' => $base]))->assertOk();
        $this->assertSame(120.0, Nota::findOrFail($id)->valor);
    }

    public function test_gestor_enviando_por_cima_do_colaborador_nao_da_conflito(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id, $base] = $this->lancar($colab);
        $this->travel(5)->minutes();
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 110, 'base_updated_at' => $base]))->assertOk();

        $this->travel(5)->minutes();
        foreach (['gestor', 'admin', 'contabilidade'] as $i => $papel) {
            Sanctum::actingAs($this->pessoa($papel));
            $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 200 + $i, 'base_updated_at' => $base]))->assertOk();
            $this->travel(1)->minutes();
        }
        $this->assertSame(202.0, Nota::findOrFail($id)->valor);
    }

    public function test_sem_autor_conhecido_ou_autor_colega_nao_da_conflito(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id, $base] = $this->lancar($colab);
        $this->travel(5)->minutes();
        Sanctum::actingAs($colab);

        Nota::whereKey($id)->update(['updated_by' => null, 'updated_at' => now()]);
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 110, 'base_updated_at' => $base]))->assertOk();

        Nota::whereKey($id)->update(['updated_by' => $this->pessoa('colaborador')->id, 'updated_at' => now()->addMinute()]);
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 120, 'base_updated_at' => $base]))->assertOk();
        $this->assertSame(120.0, Nota::findOrFail($id)->valor);
    }

    public function test_quem_nao_pode_gravar_recebe_403_e_nao_ve_a_nota_pelo_409(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id, $base] = $this->lancar($colab);
        $this->correcaoDoContador($id, $colab->id);

        Sanctum::actingAs($this->pessoa('colaborador'));
        $r = $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['base_updated_at' => $base]))->assertStatus(403);
        $this->assertNull($r->json('nota'));
    }

    /* O app sobe o anexo ANTES da nota: se esse envio assinasse a nota como do colaborador, o PUT seguinte com base velha
       passaria direto por cima da correção da gestão. */
    public function test_anexo_subido_antes_da_nota_nao_esconde_a_correcao_da_gestao(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id, $base] = $this->lancar($colab);
        $this->correcaoDoContador($id, $colab->id);

        Sanctum::actingAs($colab);
        $this->subirAnexo($id)->assertOk();
        $this->travel(1)->minutes();
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 999, 'base_updated_at' => $base]))->assertStatus(409);
        $this->assertSame(80.0, Nota::findOrFail($id)->valor);
    }

    /* E o contrário: quem já conhecia a correção e só trocou o anexo não pode perder a edição por um falso conflito. */
    public function test_anexo_subido_por_quem_ja_conhecia_a_correcao_nao_gera_falso_conflito(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id] = $this->lancar($colab);
        $this->correcaoDoContador($id, $colab->id);
        $base = Nota::findOrFail($id)->updated_at->toISOString();

        Sanctum::actingAs($colab);
        $this->subirAnexo($id)->assertOk();
        $this->travel(1)->minutes();
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 75, 'base_updated_at' => $base]))->assertOk();
        $this->assertSame(75.0, Nota::findOrFail($id)->valor);
        $this->assertSame($colab->id, Nota::findOrFail($id)->updated_by);
    }

    public function test_reparar_fotos_nao_gera_falso_conflito(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id] = $this->lancar($colab);
        $this->correcaoDoContador($id, $colab->id);
        $base = Nota::findOrFail($id)->updated_at->toISOString();
        DB::table('notas')->where('id', $id)->update(['foto_path' => null]);   // sem tocar no updated_at

        Sanctum::actingAs($colab);
        $this->postJson('/api/notas/reparar-fotos')->assertOk()->assertJsonPath('recuperadas', 1);
        $this->travel(1)->minutes();
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 75, 'base_updated_at' => $base]))->assertOk();
    }

    /* A gestão transformou em Faturamento e o aparelho ainda tem a edição antiga: o 409 entrega a versão atual e a fila
       resolve; um 403 deixaria o item recusado para sempre. Sem base, a trava de Faturamento segue valendo. */
    public function test_nota_virou_faturamento_e_colaborador_com_base_velha_recebe_409(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id, $base] = $this->lancar($colab);
        $this->travel(5)->minutes();
        Sanctum::actingAs($this->pessoa('gestor'));
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['pagamento' => 'empresa']))->assertOk();

        $this->travel(5)->minutes();
        Sanctum::actingAs($colab);
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['base_updated_at' => $base]))->assertStatus(409);
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id))->assertStatus(403);
        $this->assertSame('empresa', Nota::findOrFail($id)->pagamento);
    }

    /* ── Anexo que sobe antes do PUT (revisão de 03/11/2026) ──────── */

    private function subirArquivo(string $id, string $nome, string $conteudo, array $campos = [])
    {
        return $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->createWithContent($nome, $conteudo)] + $campos, ['Accept' => 'application/json']);
    }

    /** Colaborador lança com a.pdf e a gestão corrige o valor. Devolve o id e a base velha do aparelho. */
    private function notaCorrigidaPelaGestao(Colaborador $colab, Colaborador $gestor, ?string $anexoDaGestao = null): array
    {
        $id = (string) Str::uuid();
        Sanctum::actingAs($colab);
        $this->subirArquivo($id, 'a.pdf', 'ANEXO DO COLABORADOR', ['user_id' => $colab->id, 'ext' => 'pdf'])->assertOk();
        $base = $this->putJson("/api/notas/{$id}", $this->corpo($colab->id))->assertOk()->json('updated_at');

        $this->travel(5)->minutes();
        Sanctum::actingAs($gestor);
        if ($anexoDaGestao !== null) {
            $this->subirArquivo($id, 'b.pdf', $anexoDaGestao, ['ext' => 'pdf'])->assertOk();
        }
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 80]))->assertOk();
        $this->travel(5)->minutes();

        return [$id, $base];
    }

    public function test_anexo_da_gestao_nao_some_na_edicao_descartada(): void
    {
        $colab = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        [$id, $base] = $this->notaCorrigidaPelaGestao($colab, $gestor, 'ANEXO CERTO DA GESTAO');
        $antes = Nota::findOrFail($id);

        Sanctum::actingAs($colab);
        $this->subirArquivo($id, 'c.pdf', 'ANEXO VELHO DA FILA', ['ext' => 'pdf'])->assertOk();
        /* até o PUT dizer de qual versão veio, nada muda */
        $this->assertSame('ANEXO CERTO DA GESTAO', Storage::disk('fotos')->get(Nota::findOrFail($id)->foto_path));

        Log::spy();
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 999, 'base_updated_at' => $base]))->assertStatus(409);

        $nota = Nota::findOrFail($id);
        $this->assertSame('ANEXO CERTO DA GESTAO', Storage::disk('fotos')->get($nota->foto_path));
        $this->assertSame($gestor->id, $nota->updated_by);
        $this->assertSame($antes->updated_at->getTimestamp(), $nota->updated_at->getTimestamp());
        /* 13/11/2026: a troca da gestão guardou o primeiro anexo em original/ (Voltar à original); a edição descartada não fica */
        $this->assertSame(["{$colab->id}/{$id}.pdf", "{$colab->id}/original/{$id}.pdf"], Storage::disk('fotos')->allFiles(), 'o anexo da edição descartada não fica no disco');
        $this->assertSame('ANEXO DO COLABORADOR', Storage::disk('fotos')->get("{$colab->id}/original/{$id}.pdf"));
        Log::shouldHaveReceived('warning')->withArgs(fn ($msg, $ctx = []) => ($ctx['id'] ?? null) === $id && ($ctx['anexo_descartado'] ?? null) === true)->once();
    }

    public function test_troca_de_formato_descartada_nao_mata_o_caminho_do_anexo(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id, $base] = $this->notaCorrigidaPelaGestao($colab, $this->pessoa('gestor'));

        Sanctum::actingAs($colab);
        $this->subirArquivo($id, 'c.xml', '<x/>', ['ext' => 'xml'])->assertOk();
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 999, 'base_updated_at' => $base]))->assertStatus(409);

        $caminho = Nota::findOrFail($id)->foto_path;
        $this->assertSame("{$colab->id}/{$id}.pdf", $caminho);
        $this->assertSame('ANEXO DO COLABORADOR', Storage::disk('fotos')->get($caminho));
    }

    /* Quem já conhecia a correção troca o anexo de verdade, e a troca precisa chegar aos outros aparelhos pelo pull. */
    public function test_anexo_de_edicao_aceita_entra_e_chega_no_pull(): void
    {
        $colab = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        [$id] = $this->notaCorrigidaPelaGestao($colab, $gestor);
        $base = Nota::findOrFail($id)->updated_at->toISOString();
        $corte = now()->toISOString();

        $this->travel(5)->minutes();
        Sanctum::actingAs($colab);
        $this->subirArquivo($id, 'c.xml', '<x/>', ['ext' => 'xml'])->assertOk()->assertJsonPath('foto_path', "{$colab->id}/{$id}.xml");
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 75, 'base_updated_at' => $base]))->assertOk()
            ->assertJsonPath('foto_path', "{$colab->id}/{$id}.xml");

        /* 13/11/2026: o anexo que existia antes da troca fica guardado como original */
        $this->assertSame(["{$colab->id}/{$id}.xml", "{$colab->id}/original/{$id}.pdf"], Storage::disk('fotos')->allFiles());
        $this->assertSame($colab->id, Nota::findOrFail($id)->updated_by);

        Sanctum::actingAs($gestor);
        $this->getJson('/api/notas?since='.urlencode($corte))->assertOk()->assertJsonCount(1)->assertJsonPath('0.foto_path', "{$colab->id}/{$id}.xml");
    }

    public function test_aparelho_antigo_sem_base_troca_o_anexo_como_antes(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id] = $this->notaCorrigidaPelaGestao($colab, $this->pessoa('gestor'), 'ANEXO DA GESTAO');

        Sanctum::actingAs($colab);
        $this->subirArquivo($id, 'c.pdf', 'ANEXO NOVO', ['ext' => 'pdf'])->assertOk();
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 999]))->assertOk();

        $this->assertSame('ANEXO NOVO', Storage::disk('fotos')->get(Nota::findOrFail($id)->foto_path));
    }

    /* A marca de foto em branco depende de updated_at subir: é ela que os aparelhos puxam. */
    public function test_anexo_em_branco_de_edicao_aceita_marca_a_nota_e_chega_no_pull(): void
    {
        $colab = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        [$id] = $this->notaCorrigidaPelaGestao($colab, $gestor);
        $base = Nota::findOrFail($id)->updated_at->toISOString();
        $corte = now()->toISOString();

        $im = imagecreatetruecolor(800, 1000);
        imagefill($im, 0, 0, imagecolorallocate($im, 236, 232, 228));
        ob_start();
        imagejpeg($im, null, 90);
        $branca = ob_get_clean();
        imagedestroy($im);

        $this->travel(5)->minutes();
        Sanctum::actingAs($colab);
        $this->subirArquivo($id, 'c.jpg', $branca, ['ext' => 'jpg'])->assertOk();
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['base_updated_at' => $base]))->assertOk();

        Sanctum::actingAs($gestor);
        $this->getJson('/api/notas?since='.urlencode($corte))->assertOk()->assertJsonCount(1)->assertJsonPath('0.foto_em_branco', true);
    }

    public function test_put_da_gestao_nao_faz_entrar_o_anexo_do_colaborador(): void
    {
        $colab = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        [$id, $base] = $this->notaCorrigidaPelaGestao($colab, $gestor, 'ANEXO DA GESTAO');

        Sanctum::actingAs($colab);
        $this->subirArquivo($id, 'c.pdf', 'ANEXO VELHO DA FILA', ['ext' => 'pdf'])->assertOk();
        Sanctum::actingAs($gestor);
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 85]))->assertOk();
        $this->assertSame('ANEXO DA GESTAO', Storage::disk('fotos')->get(Nota::findOrFail($id)->foto_path));

        $this->travel(5)->minutes();
        Sanctum::actingAs($colab);
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['base_updated_at' => $base]))->assertStatus(409);
        $this->assertSame('ANEXO DA GESTAO', Storage::disk('fotos')->get(Nota::findOrFail($id)->foto_path));
    }

    /* Sem correção da gestão no meio nada muda: o anexo entra na hora, assina e sobe o updated_at. */
    public function test_anexo_do_colaborador_sem_correcao_da_gestao_entra_na_hora(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id, $base] = $this->lancar($colab);

        $this->travel(5)->minutes();
        $this->subirArquivo($id, 'c.xml', '<x/>', ['ext' => 'xml'])->assertOk();

        $nota = Nota::findOrFail($id);
        $this->assertSame("{$colab->id}/{$id}.xml", $nota->foto_path);
        $this->assertSame('<x/>', Storage::disk('fotos')->get($nota->foto_path));
        $this->assertGreaterThan(strtotime($base), $nota->updated_at->getTimestamp());
    }

    public function test_apagar_em_definitivo_leva_o_anexo_em_espera(): void
    {
        $colab = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        [$id] = $this->notaCorrigidaPelaGestao($colab, $gestor);

        Sanctum::actingAs($colab);
        $this->subirArquivo($id, 'c.pdf', 'EM ESPERA', ['ext' => 'pdf'])->assertOk();
        $this->deleteJson("/api/notas/{$id}")->assertOk();

        $this->assertSame([], Storage::disk('fotos')->allFiles());
    }

    /* ── Item 3: 410 ─────────────────────────────────────────────── */

    public function test_nota_apagada_em_definitivo_nao_renasce_pelo_put(): void
    {
        $colab = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        [$id, $base] = $this->lancar($colab);
        $this->deleteJson("/api/notas/{$id}")->assertOk();
        Storage::disk('fotos')->put("{$colab->id}/{$id}.jpg", 'arquivo que ficou para trás');

        foreach ([$colab, $gestor] as $quem) {
            Sanctum::actingAs($quem);
            foreach ([false, true] as $lixeira) {
                $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['deleted' => $lixeira, 'base_updated_at' => $base]))
                    ->assertStatus(410)->assertJsonPath('apagada', true);
                $this->assertNull(Nota::find($id));
            }
        }
    }

    public function test_item_preso_na_fila_com_corpo_recusavel_tambem_recebe_410(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id] = $this->lancar($colab);
        $this->deleteJson("/api/notas/{$id}")->assertOk();

        $this->putJson("/api/notas/{$id}", ['valor' => 'lixo'])->assertStatus(410);
    }

    public function test_anexo_de_nota_apagada_em_definitivo_recebe_410_e_nada_vai_para_o_disco(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id] = $this->lancar($colab);
        $this->deleteJson("/api/notas/{$id}")->assertOk();
        $this->assertSame([], Storage::disk('fotos')->allFiles());

        $this->subirAnexo($id)->assertStatus(410)->assertJsonPath('apagada', true);
        $this->assertSame([], Storage::disk('fotos')->allFiles(), 'nenhum arquivo é salvo');
        $this->assertNull(Nota::find($id));
    }

    /* Nota que já renasceu antes desta correção está viva na tabela: a lápide velha não pode travar a edição dela. */
    public function test_lapide_velha_nao_trava_nota_que_existe_na_tabela(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id] = $this->lancar($colab);
        DB::table('notas_apagadas')->insert(['id' => $id, 'user_id' => $colab->id, 'apagada_por' => $colab->id, 'apagada_em' => now()]);

        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 130]))->assertOk();
        $this->subirAnexo($id)->assertOk();
        $this->assertSame(130.0, Nota::findOrFail($id)->valor);
    }

    /* ── Item 4: Faturamento ─────────────────────────────────────── */

    public function test_quem_nao_gerencia_nao_tira_empresa_da_nota(): void
    {
        $colab = $this->pessoa('colaborador');
        $contador = $this->pessoa('contabilidade');
        [$id] = $this->lancar($this->pessoa('gestor'), ['user_id' => $colab->id, 'pagamento' => 'empresa']);

        foreach ([$colab, $contador] as $quem) {
            Sanctum::actingAs($quem);
            foreach (['carteira', 'cv', 'reembolso', null] as $pagamento) {
                $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['pagamento' => $pagamento]))->assertStatus(403);
                $this->assertSame('empresa', Nota::findOrFail($id)->pagamento);
            }
        }
    }

    public function test_quem_nao_gerencia_nao_poe_empresa_na_nota(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id] = $this->lancar($colab);

        foreach ([$colab, $this->pessoa('contabilidade')] as $quem) {
            Sanctum::actingAs($quem);
            $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['pagamento' => 'empresa']))->assertStatus(403);
            $this->assertSame('carteira', Nota::findOrFail($id)->pagamento);
        }
    }

    public function test_gestor_e_admin_seguem_trocando_o_faturamento(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id] = $this->lancar($colab);

        foreach (['gestor', 'admin'] as $papel) {
            Sanctum::actingAs($this->pessoa($papel));
            $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['pagamento' => 'empresa']))->assertOk();
            $this->assertSame('empresa', Nota::findOrFail($id)->pagamento);
            $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['pagamento' => 'carteira']))->assertOk();
            $this->assertSame('carteira', Nota::findOrFail($id)->pagamento);
        }
    }

    public function test_contador_segue_corrigindo_nota_comum(): void
    {
        $colab = $this->pessoa('colaborador');
        [$id] = $this->lancar($colab);

        Sanctum::actingAs($this->pessoa('contabilidade'));
        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['valor' => 55, 'pagamento' => 'cv']))->assertOk();
        $this->assertSame(55.0, Nota::findOrFail($id)->valor);
    }

    /* ── Item 6: foto_path ───────────────────────────────────────── */

    public function test_put_nunca_aceita_foto_path_do_cliente(): void
    {
        $colab = $this->pessoa('colaborador');
        $outro = $this->pessoa('colaborador');
        [$id] = $this->lancar($colab);
        [$idOutro] = $this->lancar($outro);
        $certo = "{$colab->id}/{$id}.jpg";

        foreach ([$colab, $this->pessoa('gestor')] as $quem) {
            Sanctum::actingAs($quem);
            foreach (["{$outro->id}/{$idOutro}.jpg", '../../../../.env', "{$colab->id}/outra.jpg", '', null] as $caminho) {
                $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['foto_path' => $caminho]))->assertOk()->assertJsonPath('foto_path', $certo);
                $this->assertSame($certo, Nota::findOrFail($id)->foto_path);
            }
        }

        Sanctum::actingAs($colab);
        $lista = $this->getJson('/api/arquivos/notas?ano=2026&mes=10')->assertOk()->json('notas');
        $this->assertSame([$certo], array_column($lista, 'foto_path'));
    }

    public function test_nota_nova_ignora_o_caminho_mandado_pelo_cliente(): void
    {
        $colab = $this->pessoa('colaborador');
        $id = (string) Str::uuid();
        Sanctum::actingAs($colab);
        $this->subirAnexo($id)->assertOk();

        $this->putJson("/api/notas/{$id}", $this->corpo($colab->id, ['foto_path' => '../../../../.env']))->assertOk()
            ->assertJsonPath('foto_path', "{$colab->id}/{$id}.jpg");
    }

    public function test_existe_devolve_falso_para_caminho_malicioso(): void
    {
        $fotos = app(FotoStorage::class);

        $this->assertFalse($fotos->existe('../../../../.env'));
        $this->assertFalse($fotos->existe("x/a\0b.jpg"));
        $fotos->apagar('../../../../.env');   // não lança
    }

    public function test_caminho_malicioso_ja_gravado_nao_derruba_arquivos_nem_zip(): void
    {
        $colab = $this->pessoa('colaborador');
        $gestor = $this->pessoa('gestor');
        [$id] = $this->lancar($colab);
        Nota::whereKey($id)->update(['foto_path' => '../../../../.env']);

        Sanctum::actingAs($gestor);
        $this->getJson("/api/arquivos/notas?user_id={$colab->id}&ano=2026&mes=10")->assertOk()
            ->assertJsonPath('notas.0.foto_path', null)->assertJsonPath('notas.0.arquivo', null);

        foreach (["/api/arquivos/zip?user_id={$colab->id}&ano=2026&mes=10&planilha=0", '/api/arquivos/zip-equipe?ano=2026&mes=10'] as $url) {
            $resp = $this->get($url);
            $resp->assertOk();
            $zip = new \ZipArchive();
            $this->assertTrue($zip->open($resp->baseResponse->getFile()->getPathname()) === true);
            $nomes = [];
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $nomes[] = $zip->getNameIndex($i);
            }
            $zip->close();
            $this->assertNotEmpty(array_filter($nomes, fn ($n) => str_ends_with($n, 'SEM ANEXO.txt')), implode(', ', $nomes));
        }
    }
}
