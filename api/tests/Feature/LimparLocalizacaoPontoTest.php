<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\TestCase;

/** 04/11/2026: a migração apaga só a localização do ponto; horários e dias ficam. */
class LimparLocalizacaoPontoTest extends TestCase
{
    use RefreshDatabase;

    private function colaborador(string $email): string
    {
        $id = (string) Str::uuid();
        DB::table('colaboradores')->insert(['id' => $id, 'nome' => 'Fulano', 'email' => $email, 'password' => 'x', 'created_at' => now(), 'updated_at' => now()]);

        return $id;
    }

    public function test_apaga_a_localizacao_e_mantem_o_resto_do_ponto(): void
    {
        $a = $this->colaborador('a@teste.local');
        $b = $this->colaborador('b@teste.local');
        $comLocal = (string) Str::uuid();
        $semLocal = (string) Str::uuid();
        $carimbo = '2026-10-01 12:00:00';
        DB::table('pontos')->insert([
            ['id' => $comLocal, 'user_id' => $a, 'data' => '2026-10-01', 'entrada' => '2026-10-01 08:00:00', 'lat' => -16.7, 'lng' => -47.6, 'observacao' => 'obs', 'updated_at' => $carimbo],
            ['id' => $semLocal, 'user_id' => $b, 'data' => '2026-10-01', 'entrada' => '2026-10-01 09:00:00', 'lat' => null, 'lng' => null, 'observacao' => null, 'updated_at' => $carimbo],
        ]);

        (require database_path('migrations/2026_11_04_000001_limpar_localizacao_do_ponto.php'))->up();

        $l = DB::table('pontos')->where('id', $comLocal)->first();
        $this->assertNull($l->lat);
        $this->assertNull($l->lng);
        $this->assertSame('2026-10-01 08:00:00', $l->entrada);
        $this->assertSame('obs', $l->observacao);
        $this->assertSame($carimbo, $l->updated_at);
        $this->assertSame(2, DB::table('pontos')->count());
    }
}
