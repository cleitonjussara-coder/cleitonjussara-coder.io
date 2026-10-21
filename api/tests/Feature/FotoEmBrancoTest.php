<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\FotoEmBranco;
use App\Services\PushService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 21/10/2026 — o colaborador João Vitor lançou "Pedágio · RDM · R$ 14,00" com a foto de um papel liso, e o app
 * deixou: a nota só aparecia como "sem nº da nota". Agora o servidor mede o anexo no envio (FotoEmBranco),
 * guarda em notas.foto_em_branco e avisa gestor e admin no celular; o mutirão `fotos:em-branco` marca as antigas.
 * Nada é recusado nem apagado: é marcação e aviso.
 */
class FotoEmBrancoTest extends TestCase
{
    use RefreshDatabase;

    /** @var list<array{0: string, 1: string}> [título, corpo] de cada push enviado à gestão */
    private array $pushes = [];

    /** @var list<list<string>> ids de quem recebeu cada push */
    private array $destinos = [];

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('fotos');
        $this->mock(PushService::class, function ($m) {
            $m->shouldReceive('enviar')->andReturnUsing(function ($destino, $titulo, $corpo) {
                $this->pushes[] = [$titulo, $corpo];
                $this->destinos[] = collect($destino)->map(fn ($c) => $c->id)->all();

                return 1;
            });
        });
    }

    /* ── imagens sintéticas ──────────────────────────────────────── */

    /** Papel liso com degradê de sombra (como a foto do caso), com ruído opcional. */
    private function branca(int $w = 800, int $h = 1000, int $ruido = 0): string
    {
        $im = imagecreatetruecolor($w, $h);
        for ($y = 0; $y < $h; $y++) {
            $v = 236 - (int) (22 * $y / $h);
            imagefilledrectangle($im, 0, $y, $w, $y, imagecolorallocate($im, $v, $v - 4, $v - 8));
        }
        if ($ruido) {
            mt_srand(7);
            for ($i = 0; $i < $w * $h / 4; $i++) {
                $d = mt_rand(-$ruido, $ruido);
                imagesetpixel($im, mt_rand(0, $w - 1), mt_rand(0, $h - 1), imagecolorallocate($im, 225 + $d, 221 + $d, 217 + $d));
            }
        }

        return $this->jpeg($im);
    }

    /** Cupom com texto de verdade. */
    private function cupom(): string
    {
        $im = imagecreatetruecolor(800, 1000);
        imagefill($im, 0, 0, imagecolorallocate($im, 240, 238, 234));
        $preto = imagecolorallocate($im, 30, 30, 30);
        foreach (['MERCADO TESTE LTDA', 'CNPJ 11.222.333/0001-81', 'ARROZ 5KG        24,90', 'FEIJAO 1KG        8,50', 'TOTAL R$          33,40'] as $i => $linha) {
            imagestring($im, 5, 120, 200 + $i * 40, $linha, $preto);
        }

        return $this->jpeg($im);
    }

    /** Recibo manuscrito curto num papel grande: o caso que NÃO pode ser barrado. */
    private function manuscrito(): string
    {
        $im = imagecreatetruecolor(800, 1000);
        imagefill($im, 0, 0, imagecolorallocate($im, 238, 236, 230));
        imagestring($im, 5, 330, 480, 'R$ 14,00', imagecolorallocate($im, 20, 20, 90));

        return $this->jpeg($im);
    }

    private function jpeg(\GdImage $im): string
    {
        ob_start();
        imagejpeg($im, null, 90);
        $bin = ob_get_clean();
        imagedestroy($im);

        return $bin;
    }

    /* ── pessoas e notas ─────────────────────────────────────────── */

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

    private function corpoNota(Colaborador $dono, array $troca = []): array
    {
        $ontem = now('America/Sao_Paulo')->subDay();

        return array_replace([
            'user_id' => $dono->id, 'tipo' => 'RDM', 'subtipo' => 'Outros', 'valor' => 14, 'razao_social' => 'Pedágio',
            'data' => $ontem->format('Y-m-d'), 'mes' => (int) $ontem->format('n'), 'ano' => (int) $ontem->format('Y'),
        ], $troca);
    }

    /** Fluxo do app: sobe o anexo ANTES, grava a nota depois. */
    private function lancar(Colaborador $quem, Colaborador $dono, string $bin, ?string $id = null): string
    {
        $id ??= (string) Str::uuid();
        Sanctum::actingAs($quem);
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->createWithContent('nota.jpg', $bin), 'user_id' => $dono->id], ['Accept' => 'application/json'])->assertOk();
        $this->putJson("/api/notas/{$id}", $this->corpoNota($dono))->assertOk();

        return $id;
    }

    private function trocarAnexo(Colaborador $quem, string $id, string $bin): void
    {
        Sanctum::actingAs($quem);
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->createWithContent('nota.jpg', $bin)], ['Accept' => 'application/json'])->assertOk();
    }

    /* ── o detector ──────────────────────────────────────────────── */

    public function test_papel_liso_com_sombra_esta_em_branco(): void
    {
        $this->assertTrue(FotoEmBranco::emBranco($this->branca()));
        $this->assertSame(0.0, FotoEmBranco::tinta($this->branca()));
    }

    public function test_papel_liso_com_ruido_de_foto_escura_continua_em_branco(): void
    {
        $this->assertTrue(FotoEmBranco::emBranco($this->branca(800, 1000, 4)));
    }

    public function test_cupom_com_texto_nao_esta_em_branco(): void
    {
        $this->assertFalse(FotoEmBranco::emBranco($this->cupom()));
        $this->assertGreaterThan(50 * FotoEmBranco::TINTA_MIN, FotoEmBranco::tinta($this->cupom()), 'com folga: o texto passa de 50× o corte');
    }

    public function test_recibo_manuscrito_curto_num_papel_grande_nao_e_barrado(): void
    {
        $this->assertFalse(FotoEmBranco::emBranco($this->manuscrito()), 'R$ 14,00 escrito à mão é dado de nota');
    }

    public function test_o_que_nao_da_para_medir_nunca_e_em_branco(): void
    {
        $this->assertNull(FotoEmBranco::emBranco(''));
        $this->assertNull(FotoEmBranco::emBranco("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n"));   // PDF
        $this->assertNull(FotoEmBranco::emBranco(random_bytes(500)));                    // lixo
    }

    public function test_a_mesma_regra_roda_igual_no_aparelho(): void
    {
        /* Padrão determinístico (inteiros): o JS (rda-rdm-app/js/foto-branca.js) calcula o MESMO número em
           scripts/testar-foto-branca.js. Se um dos dois mudar de regra, os dois testes avisam. */
        $w = 120;
        $h = 90;
        $g = [];
        for ($y = 0; $y < $h; $y++) {
            for ($x = 0; $x < $w; $x++) {
                $g[] = 200 + (($x * 7 + $y * 13) % 9) - ((($x >> 4) + ($y >> 4)) % 2 === 0 ? 0 : 36);
            }
        }
        $this->assertEqualsWithDelta(15.3333, FotoEmBranco::tintaDoCinza($g, $w, $h), 0.0001);
    }

    /* ── no envio da nota ────────────────────────────────────────── */

    public function test_nota_com_foto_em_branco_e_marcada_e_a_gestao_recebe_push(): void
    {
        $paulo = $this->pessoa('gestor', 'Paulo');
        $cleiton = $this->pessoa('admin', 'Cleiton');
        $colab = $this->pessoa('colaborador', 'João Vitor');
        $outro = $this->pessoa('colaborador', 'Outra Pessoa');

        $id = $this->lancar($colab, $colab, $this->branca());

        $nota = Nota::find($id);
        $this->assertTrue($nota->foto_em_branco);
        $this->assertFalse((bool) $nota->deleted, 'só marca: a nota continua viva');
        $this->assertTrue(Storage::disk('fotos')->exists($nota->foto_path), 'e o arquivo continua no disco');
        $this->assertCount(1, $this->pushes);
        $this->assertSame('Foto em branco numa nota', $this->pushes[0][0]);
        $this->assertStringContainsString('João Vitor enviou uma nota com a foto em branco', $this->pushes[0][1]);
        $this->assertStringContainsString('Pedágio', $this->pushes[0][1]);
        $this->assertStringContainsString('R$ 14,00', $this->pushes[0][1]);
        $this->assertEqualsCanonicalizing([$paulo->id, $cleiton->id], $this->destinos[0]);
        $this->assertNotContains($colab->id, $this->destinos[0]);
        $this->assertNotContains($outro->id, $this->destinos[0]);
    }

    public function test_nota_com_conteudo_nao_e_marcada_e_ninguem_e_avisado(): void
    {
        $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');

        $id = $this->lancar($colab, $colab, $this->cupom());

        $this->assertFalse(Nota::find($id)->foto_em_branco);
        $this->assertSame([], $this->pushes);
    }

    public function test_recibo_manuscrito_curto_nao_e_marcado(): void
    {
        $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');

        $id = $this->lancar($colab, $colab, $this->manuscrito());

        $this->assertFalse(Nota::find($id)->foto_em_branco);
        $this->assertSame([], $this->pushes);
    }

    public function test_pdf_nao_e_foto_e_nunca_e_marcado(): void
    {
        $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $id = (string) Str::uuid();
        Sanctum::actingAs($colab);
        $this->post("/api/notas/{$id}/foto", ['file' => UploadedFile::fake()->createWithContent('nota.pdf', "%PDF-1.4\n%%EOF"), 'ext' => 'pdf'], ['Accept' => 'application/json'])->assertOk();
        $this->putJson("/api/notas/{$id}", $this->corpoNota($colab))->assertOk();

        $this->assertFalse(Nota::find($id)->foto_em_branco);
        $this->assertSame([], $this->pushes);
    }

    public function test_reenviar_a_mesma_foto_em_branco_nao_repete_o_push(): void
    {
        $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $id = $this->lancar($colab, $colab, $this->branca());

        $this->trocarAnexo($colab, $id, $this->branca());           // reenvio da fila do aparelho
        $this->putJson("/api/notas/{$id}", $this->corpoNota($colab))->assertOk();   // e uma edição qualquer

        $this->assertTrue(Nota::find($id)->foto_em_branco);
        $this->assertCount(1, $this->pushes);
    }

    public function test_foto_corrigida_limpa_a_marca_sem_novo_aviso(): void
    {
        $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $id = $this->lancar($colab, $colab, $this->branca());

        $this->trocarAnexo($colab, $id, $this->cupom());

        $this->assertFalse(Nota::find($id)->foto_em_branco);
        $this->assertCount(1, $this->pushes, 'só o aviso da foto em branco; corrigir não avisa de novo');
    }

    public function test_trocar_uma_foto_boa_por_uma_em_branco_marca_e_avisa(): void
    {
        $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $id = $this->lancar($colab, $colab, $this->cupom());

        $this->trocarAnexo($colab, $id, $this->branca());

        $this->assertTrue(Nota::find($id)->foto_em_branco);
        $this->assertCount(1, $this->pushes);
    }

    public function test_gestor_que_lanca_para_o_colaborador_nao_recebe_o_proprio_aviso(): void
    {
        $paulo = $this->pessoa('gestor', 'Paulo');
        $cleiton = $this->pessoa('admin', 'Cleiton');
        $colab = $this->pessoa('colaborador', 'João Vitor');

        $this->lancar($paulo, $colab, $this->branca());

        $this->assertCount(1, $this->pushes);
        $this->assertSame([$cleiton->id], $this->destinos[0]);
    }

    public function test_na_homologacao_o_push_so_vai_para_conta_de_teste(): void
    {
        $this->app['env'] = 'staging';              // homologação = cópia da produção, com push de gente real
        $real = $this->pessoa('gestor', 'Gestor Real');
        $teste = new Colaborador(['id' => (string) Str::uuid(), 'nome' => 'Gestor Teste', 'email' => 'gestor.teste@homolog.local', 'password' => 'segredo123', 'role' => 'gestor']);
        $teste->forceFill(['ativo' => true] + (Colaborador::temConfirmacao() ? ['confirmado_em' => now()] : []))->save();
        $colab = $this->pessoa('colaborador');

        $this->lancar($colab, $colab, $this->branca());

        $this->assertCount(1, $this->pushes);
        $this->assertSame([$teste->id], $this->destinos[0]);
        $this->assertNotContains($real->id, $this->destinos[0]);
    }

    public function test_o_aparelho_nao_consegue_forjar_a_marca(): void
    {
        $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $id = $this->lancar($colab, $colab, $this->cupom());

        Sanctum::actingAs($colab);
        $this->putJson("/api/notas/{$id}", $this->corpoNota($colab) + ['foto_em_branco' => true])->assertOk();

        $this->assertFalse(Nota::find($id)->foto_em_branco);
    }

    public function test_a_marca_chega_ao_app_do_gestor_e_do_dono(): void
    {
        $paulo = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $outro = $this->pessoa('colaborador');
        $id = $this->lancar($colab, $colab, $this->branca());

        Sanctum::actingAs($paulo);
        $this->getJson('/api/notas')->assertOk()->assertJsonPath('0.foto_em_branco', true);
        Sanctum::actingAs($colab);
        $this->getJson('/api/notas')->assertOk()->assertJsonPath('0.foto_em_branco', true);
        Sanctum::actingAs($outro);
        $this->getJson('/api/notas')->assertOk()->assertJsonCount(0);
        $this->assertTrue(Nota::find($id)->foto_em_branco);
    }

    public function test_falha_no_push_nao_derruba_o_envio_da_nota(): void
    {
        $this->mock(PushService::class, fn ($m) => $m->shouldReceive('enviar')->andThrow(new \RuntimeException('push fora do ar')));
        $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');

        $id = $this->lancar($colab, $colab, $this->branca());

        $this->assertTrue(Nota::find($id)->foto_em_branco, 'a nota foi gravada e marcada mesmo com o push fora do ar');
    }

    public function test_nota_antiga_sem_medida_e_medida_ao_ser_editada(): void
    {
        $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador');
        $id = (string) Str::uuid();
        $path = "{$colab->id}/{$id}.jpg";
        Storage::disk('fotos')->put($path, $this->branca());
        $n = new Nota(['id' => $id] + $this->corpoNota($colab) + ['foto_path' => $path, 'deleted' => false]);
        $n->save();
        $this->assertNull($n->fresh()->foto_em_branco, 'antes: ainda não analisada');

        Sanctum::actingAs($colab);
        $this->putJson("/api/notas/{$id}", $this->corpoNota($colab, ['valor' => 15]) + ['foto_path' => $path])->assertOk();

        $this->assertTrue(Nota::find($id)->foto_em_branco);
    }

    /* ── o mutirão das notas que já existem ──────────────────────── */

    private function notaAntiga(Colaborador $dono, ?string $bin, string $ext = 'jpg', array $troca = []): Nota
    {
        $id = (string) Str::uuid();
        $path = "{$dono->id}/{$id}.{$ext}";
        if ($bin !== null) {
            Storage::disk('fotos')->put($path, $bin);
        }
        $n = new Nota(['id' => $id] + $this->corpoNota($dono, $troca) + ['foto_path' => $path, 'deleted' => false]);
        $n->save();

        return $n->fresh();
    }

    public function test_mutirao_marca_as_antigas_sem_apagar_nem_avisar(): void
    {
        $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador', 'João Vitor');
        $branca = $this->notaAntiga($colab, $this->branca());
        $boa = $this->notaAntiga($colab, $this->cupom());
        $pdf = $this->notaAntiga($colab, "%PDF-1.4\n%%EOF", 'pdf');
        $semArquivo = $this->notaAntiga($colab, null);
        $apagada = $this->notaAntiga($colab, $this->branca(), 'jpg', ['deleted' => true]);
        Nota::whereKey($apagada->id)->update(['deleted' => true]);

        $this->artisan('fotos:em-branco')->assertSuccessful();

        $this->assertTrue($branca->fresh()->foto_em_branco);
        $this->assertFalse($boa->fresh()->foto_em_branco);
        $this->assertFalse($pdf->fresh()->foto_em_branco);
        $this->assertNull($semArquivo->fresh()->foto_em_branco, 'arquivo ausente: continua não analisada');
        $this->assertNull($apagada->fresh()->foto_em_branco, 'nota na lixeira não entra');
        $this->assertTrue(Storage::disk('fotos')->exists($branca->foto_path), 'nada é apagado');
        $this->assertFalse((bool) $branca->fresh()->deleted);
        $this->assertSame([], $this->pushes, 'o mutirão não manda push de nota velha');
    }

    public function test_mutirao_so_mexe_no_updated_at_de_quem_vira_em_branco(): void
    {
        $colab = $this->pessoa('colaborador');
        $branca = $this->notaAntiga($colab, $this->branca());
        $boa = $this->notaAntiga($colab, $this->cupom());
        $antes = '2026-10-01 12:00:00';
        Nota::whereKey([$branca->id, $boa->id])->toBase()->update(['updated_at' => $antes]);   // toBase: sem o updated_at automático do Eloquent

        $this->artisan('fotos:em-branco')->assertSuccessful();

        $this->assertFalse($boa->fresh()->foto_em_branco);
        $this->assertSame($antes, $boa->fresh()->updated_at->format('Y-m-d H:i:s'), 'com conteúdo: o "enviada ao servidor em" do gestor não muda');
        $this->assertTrue($branca->fresh()->foto_em_branco);
        $this->assertNotSame($antes, $branca->fresh()->updated_at->format('Y-m-d H:i:s'), 'em branco: sobe o updated_at para os aparelhos puxarem a marca');
    }

    public function test_mutirao_seco_so_lista(): void
    {
        $colab = $this->pessoa('colaborador');
        $branca = $this->notaAntiga($colab, $this->branca());

        $this->artisan('fotos:em-branco --seco')->expectsOutputToContain($branca->id)->assertSuccessful();

        $this->assertNull($branca->fresh()->foto_em_branco, '--seco não grava');
    }

    public function test_mutirao_so_mede_quem_ainda_nao_foi_medido_a_menos_que_refaca(): void
    {
        $colab = $this->pessoa('colaborador');
        $n = $this->notaAntiga($colab, $this->cupom());
        Nota::whereKey($n->id)->update(['foto_em_branco' => true]);     // marca velha, foto já é boa

        $this->artisan('fotos:em-branco')->assertSuccessful();
        $this->assertTrue($n->fresh()->foto_em_branco, 'já medida: o padrão não mexe');

        $this->artisan('fotos:em-branco --refazer')->assertSuccessful();
        $this->assertFalse($n->fresh()->foto_em_branco, '--refazer mede de novo');
    }
}
