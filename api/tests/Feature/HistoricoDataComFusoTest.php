<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 16/10/2026 — "histórico com data incorreta no lançamento do Paulo": as linhas "apagou em definitivo" (lápides) e de troca de
 * papel/regime vêm de DB::table(), que devolve a data CRUA ("2026-10-17 00:57:00", em UTC e sem fuso). O app a lia como
 * horário local — um apagamento das 21:57 de Brasília aparecia como 17/10 00:57 — e a ordenava como texto. Agora a API manda
 * a data em ISO UTC com "Z", como os models, e o app converte para Brasília na hora de mostrar.
 */
class HistoricoDataComFusoTest extends TestCase
{
    use RefreshDatabase;

    private function gestor(): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => 'Gestor Teste', 'email' => 'gestor@teste.local',
            'password' => 'segredo123', 'role' => 'gestor',
        ]);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    public function test_apagadas_em_definitivo_saem_com_data_iso_utc(): void
    {
        $g = $this->gestor();
        DB::table('notas_apagadas')->insert(['id' => 'nota-1', 'user_id' => $g->id, 'apagada_por' => $g->id, 'apagada_em' => '2026-10-17 00:57:00']);
        Sanctum::actingAs($g);

        $linha = $this->getJson('/api/notas/apagadas?detalhe=1')->assertOk()->json(0);

        $this->assertStringEndsWith('Z', $linha['apagada_em'], 'ISO em UTC, com o Z');
        $this->assertStringContainsString('T', $linha['apagada_em']);
        $this->assertSame('2026-10-17 00:57:00', Carbon::parse($linha['apagada_em'])->utc()->format('Y-m-d H:i:s'), 'o mesmo instante');
        // 00:57 UTC = 21:57 em Brasília, ainda no dia 16
        $this->assertSame('16/10/2026 21:57', Carbon::parse($linha['apagada_em'])->setTimezone('America/Sao_Paulo')->format('d/m/Y H:i'));
    }

    public function test_sem_detalhe_continua_devolvendo_so_os_ids(): void
    {
        $g = $this->gestor();
        DB::table('notas_apagadas')->insert(['id' => 'nota-2', 'user_id' => $g->id, 'apagada_por' => $g->id, 'apagada_em' => '2026-10-17 00:57:00']);
        Sanctum::actingAs($g);

        $this->assertSame(['nota-2'], $this->getJson('/api/notas/apagadas')->assertOk()->json());
    }

    public function test_troca_de_papel_e_regime_saem_com_data_iso_utc(): void
    {
        $g = $this->gestor();
        DB::table('colaboradores_historico')->insert([
            'id' => (string) Str::uuid(), 'colaborador_id' => $g->id, 'campo' => 'regime', 'de' => 'rdm_rda', 'para' => 'cv',
            'alterado_por' => $g->id, 'alterado_em' => '2026-10-17 00:57:00',
        ]);
        Sanctum::actingAs($g);

        $linha = $this->getJson('/api/colaboradores/historico')->assertOk()->json(0);

        $this->assertStringEndsWith('Z', $linha['alterado_em']);
        $this->assertSame('2026-10-17 00:57:00', Carbon::parse($linha['alterado_em'])->utc()->format('Y-m-d H:i:s'));
        $this->assertSame('regime', $linha['campo']);
    }
}
