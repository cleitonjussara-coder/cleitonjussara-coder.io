<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\FotoStorage;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 05/11/2026 — link de emissão da NFS-e impresso no recibo de pedágio: muda por concessionária.
 * Link ruim vira null em vez de recusar a nota (recusa travaria a fila do aparelho).
 */
class NotaPortalNfseTest extends TestCase
{
    use RefreshDatabase;

    private const CNPJ = '63929367000104';

    private function colaborador(): Colaborador
    {
        $c = new Colaborador(['id' => (string) Str::uuid(), 'nome' => 'Ana', 'email' => 'ana@portal.local', 'password' => 'segredo123', 'role' => 'colaborador']);
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
            'user_id' => $dono->id, 'tipo' => 'RDM', 'subtipo' => 'Pedágio', 'valor' => 15.60, 'data' => $hoje->format('Y-m-d'),
            'mes' => (int) $hoje->format('n'), 'ano' => (int) $hoje->format('Y'), 'razao_social' => 'WAY 153', 'documento' => 'outro',
            'cnpj' => self::CNPJ, 'numero' => 'JLEE546J82JK', 'deleted' => true,
        ], $troca);
    }

    public function test_link_e_normalizado_e_link_ruim_nao_recusa_a_nota(): void
    {
        $ana = $this->colaborador();
        Sanctum::actingAs($ana);
        $a = (string) Str::uuid();
        $b = (string) Str::uuid();

        $this->putJson("/api/notas/$a", $this->corpo($ana, ['portal_nfse' => 'WWW.WAY153.COM.BR']))->assertOk();
        $this->assertSame('https://www.way153.com.br', Nota::find($a)->portal_nfse);

        $this->putJson("/api/notas/$b", $this->corpo($ana, ['cnpj' => null, 'portal_nfse' => 'javascript:alert(1)']))->assertOk();
        $this->assertNull(Nota::find($b)->portal_nfse);
    }

    public function test_so_aceita_site_br_que_nao_seja_do_governo(): void
    {
        $this->assertSame('https://nfsevia.ecorodovias.com.br', Nota::portalNormalizado('https://nfsevia.ecorodovias.com.br/'));
        $this->assertSame('https://x.com.br/Emitir/Cupom', Nota::portalNormalizado('http://X.com.br/Emitir/Cupom'));
        $this->assertNull(Nota::portalNormalizado('https://portal.fazenda.go.gov.br'));
        $this->assertNull(Nota::portalNormalizado('https://golpe.com'));
        $this->assertNull(Nota::portalNormalizado('https://x.com.br/a?b=1'));
        $this->assertNull(Nota::portalNormalizado('gov.br/nfse'));
        $this->assertNull(Nota::portalNormalizado(null));
    }

    public function test_apagar_o_cnpj_na_edicao_nao_herda_o_link_do_cnpj_antigo(): void
    {
        $ana = $this->colaborador();
        Sanctum::actingAs($ana);
        $a = (string) Str::uuid();
        $b = (string) Str::uuid();
        $this->putJson("/api/notas/$b", $this->corpo($ana, ['portal_nfse' => null]))->assertOk();
        $this->putJson("/api/notas/$a", $this->corpo($ana, ['portal_nfse' => 'www.way153.com.br']))->assertOk();
        Nota::whereKey($a)->update(['deleted' => false]);

        $this->putJson("/api/notas/$b", $this->corpo($ana, ['cnpj' => null, 'portal_nfse' => null]))->assertOk();

        $this->assertNull(Nota::find($b)->portal_nfse);
    }

    public function test_recibo_sem_link_usa_o_ultimo_lido_do_mesmo_cnpj(): void
    {
        $ana = $this->colaborador();
        Sanctum::actingAs($ana);
        $a = (string) Str::uuid();
        $b = (string) Str::uuid();
        $c = (string) Str::uuid();
        $d = (string) Str::uuid();
        /* a nota de origem precisa estar ativa; 'deleted' => true nos testes só dispensa o anexo */
        $this->putJson("/api/notas/$a", $this->corpo($ana, ['portal_nfse' => 'www.way153.com.br']))->assertOk();
        Nota::whereKey($a)->update(['deleted' => false]);

        $this->putJson("/api/notas/$b", $this->corpo($ana, ['portal_nfse' => null]))->assertOk();
        $this->assertSame('https://www.way153.com.br', Nota::find($b)->portal_nfse);

        $this->putJson("/api/notas/$c", $this->corpo($ana, ['portal_nfse' => null, 'cnpj' => '11222333000181']))->assertOk();
        $this->assertNull(Nota::find($c)->portal_nfse, 'outro CNPJ');

        $this->putJson("/api/notas/$d", $this->corpo($ana, ['portal_nfse' => null, 'documento' => 'nfce']))->assertOk();
        $this->assertNull(Nota::find($d)->portal_nfse, 'nota fiscal não é recibo');
    }

    public function test_leitor_devolve_o_link_lido_pela_ia(): void
    {
        $leitor = app(\App\Services\LeitorNota::class);
        $this->assertSame('https://www.way153.com.br', $leitor->validar(json_encode(['portal' => 'WWW.WAY153.COM.BR']))['portal_nfse']);
        $this->assertNull($leitor->validar(json_encode(['portal' => 'ver no site']))['portal_nfse']);
    }
}
