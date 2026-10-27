<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 27/10/2026 — placa do veículo no recibo de pedágio (o portal de NFS-e da EcoRodovias pede a placa).
 * Vai em coluna própria (notas.placa); o servidor guarda em maiúscula e recusa o que não é placa.
 */
class NotaPlacaReciboTest extends TestCase
{
    use RefreshDatabase;

    private function colaborador(): Colaborador
    {
        $c = new Colaborador(['id' => (string) Str::uuid(), 'nome' => 'Ana', 'email' => 'ana@placa.local', 'password' => 'segredo123', 'role' => 'colaborador']);
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
            'user_id' => $dono->id, 'tipo' => 'RDM', 'subtipo' => 'Outros', 'valor' => 6.30, 'data' => $hoje->format('Y-m-d'),
            'mes' => (int) $hoje->format('n'), 'ano' => (int) $hoje->format('Y'), 'razao_social' => 'ECORODOVIAS', 'documento' => 'outro',
            'numero' => '13E47631-C253-4255-A77E-50FBEBA7105F', 'deleted' => true,
        ], $troca);
    }

    public function test_placa_e_guardada_em_maiuscula_junto_com_o_seq_como_numero(): void
    {
        $ana = $this->colaborador();
        Sanctum::actingAs($ana);
        $id = (string) Str::uuid();

        $this->putJson("/api/notas/$id", $this->corpo($ana, ['placa' => 'rem8h68']))->assertOk();

        $n = Nota::find($id);
        $this->assertSame('REM8H68', $n->placa);
        $this->assertSame('13E47631-C253-4255-A77E-50FBEBA7105F', $n->numero);
    }

    public function test_placa_vazia_ou_ausente_fica_nula_e_placa_invalida_e_recusada(): void
    {
        $ana = $this->colaborador();
        Sanctum::actingAs($ana);

        $a = (string) Str::uuid();
        $this->putJson("/api/notas/$a", $this->corpo($ana, ['placa' => null]))->assertOk();
        $this->assertNull(Nota::find($a)->placa);

        $b = (string) Str::uuid();
        $this->putJson("/api/notas/$b", $this->corpo($ana))->assertOk();
        $this->assertNull(Nota::find($b)->placa);

        foreach (['REM-8H68', 'x"><script>', 'ABCDEFGHIJK'] as $ruim) {
            $this->putJson('/api/notas/'.Str::uuid(), $this->corpo($ana, ['placa' => $ruim]))->assertStatus(422);
        }
    }

    public function test_editar_a_nota_atualiza_e_limpa_a_placa(): void
    {
        $ana = $this->colaborador();
        Sanctum::actingAs($ana);
        $id = (string) Str::uuid();

        $this->putJson("/api/notas/$id", $this->corpo($ana, ['placa' => 'ABC1234']))->assertOk();
        $this->putJson("/api/notas/$id", $this->corpo($ana, ['placa' => 'XYZ9A87']))->assertOk();
        $this->assertSame('XYZ9A87', Nota::find($id)->placa);

        $this->putJson("/api/notas/$id", $this->corpo($ana, ['placa' => null]))->assertOk();
        $this->assertNull(Nota::find($id)->placa);
    }
}
