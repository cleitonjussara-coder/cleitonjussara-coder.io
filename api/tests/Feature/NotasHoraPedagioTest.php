<?php

namespace Tests\Feature;

use App\Models\Nota;
use App\Services\LeitorNota;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Mockery;
use Tests\TestCase;

/** 09/11/2026: mutirão que relê a foto dos recibos de pedágio antigos e grava só a hora (notas:hora-pedagio). */
class NotasHoraPedagioTest extends TestCase
{
    use RefreshDatabase;

    private function recibo(array $campos = []): Nota
    {
        $id = (string) Str::uuid();
        $path = "geral/{$id}.jpg";
        $im = imagecreatetruecolor(40, 30);
        ob_start();
        imagejpeg($im);
        Storage::disk('fotos')->put($path, ob_get_clean());
        $n = new Nota(array_replace([
            'id' => $id, 'user_id' => null, 'tipo' => 'RDM', 'subtipo' => 'Pedágio', 'valor' => 14.5, 'pagamento' => 'empresa',
            'data' => '2026-11-04', 'mes' => 11, 'ano' => 2026, 'cnpj' => '48127012000108', 'razao_social' => 'EPR TRIANGULO MINEIRO',
            'foto_path' => $path, 'deleted' => false,
        ], $campos));
        $n->save();

        return $n;
    }

    /** IA simulada: devolve a leitura por nota, na ordem em que o comando pergunta (por data). */
    private function ia(array $leituras): void
    {
        $m = Mockery::mock(LeitorNota::class);
        $m->shouldReceive('disponivel')->andReturn(true);
        $m->shouldReceive('ultimoMotivo')->andReturn(null);
        $m->shouldReceive('ler')->andReturn(...$leituras);
        $this->app->instance(LeitorNota::class, $m);
    }

    public function test_grava_so_a_hora_quando_a_data_da_foto_bate(): void
    {
        Storage::fake('fotos');
        $boa = $this->recibo(['data' => '2026-11-03']);
        $outraData = $this->recibo(['data' => '2026-11-04']);
        $semHora = $this->recibo(['data' => '2026-11-05']);
        $comHora = $this->recibo(['data' => '2026-11-06', 'hora' => '08:00:00']);
        $outroGasto = $this->recibo(['data' => '2026-11-02', 'subtipo' => 'Abastecimento']);
        $this->ia([
            ['data' => '2026-11-03', 'hora' => '09:44:18', 'valor' => 99.0],
            ['data' => '2026-10-30', 'hora' => '10:00:00'],
            ['data' => '2026-11-05', 'hora' => null],
        ]);

        $this->artisan('notas:hora-pedagio')->assertSuccessful();

        $this->assertSame('09:44:18', $boa->fresh()->hora);
        $this->assertSame(14.5, $boa->fresh()->valor, 'só a hora muda');
        $this->assertNull($outraData->fresh()->hora, 'hora de outro dia não entra');
        $this->assertNull($semHora->fresh()->hora);
        $this->assertSame('08:00:00', $comHora->fresh()->hora, 'a que já tem hora não é relida');
        $this->assertNull($outroGasto->fresh()->hora, 'só pedágio');
    }

    public function test_seco_nao_grava(): void
    {
        Storage::fake('fotos');
        $n = $this->recibo();
        $this->ia([['data' => '2026-11-04', 'hora' => '09:44:18']]);

        $this->artisan('notas:hora-pedagio', ['--seco' => true])->assertSuccessful();

        $this->assertNull($n->fresh()->hora);
    }
}
