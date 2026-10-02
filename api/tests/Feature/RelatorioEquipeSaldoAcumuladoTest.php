<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use App\Services\RelatorioEquipePdf;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * 01/10/2026 — "sempre somar os saldos acumulados dos meses anteriores".
 * O PDF da equipe mostrava só recebido − gasto do mês isolado; agora o saldo
 * de cada colaborador é anterior + recebido − gasto, com a MESMA conta do app
 * (_saldoAcumuladoAte) e da ficha do gestor: Faturamento (pagamento=empresa)
 * não é gasto, pedido pendente e recarga do cartão não são recebido.
 */
class RelatorioEquipeSaldoAcumuladoTest extends TestCase
{
    use RefreshDatabase;

    private function pessoa(string $nome): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome, 'email' => Str::slug($nome).'@teste.local',
            'password' => 'segredo123', 'role' => 'colaborador',
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(Colaborador $c, int $ano, int $mes, float $valor, string $tipo = 'RDM', ?string $pagamento = null, bool $deleted = false): void
    {
        $n = new Nota(['id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => $tipo, 'valor' => $valor,
            'data' => sprintf('%d-%02d-10', $ano, $mes), 'mes' => $mes, 'ano' => $ano, 'pagamento' => $pagamento, 'deleted' => $deleted]);
        $n->save();
    }

    private function repasse(Colaborador $c, int $ano, int $mes, float $valor, string $tipo = 'RDM', ?string $kind = 'received', ?string $destino = null, bool $deleted = false): void
    {
        $r = new Repasse(['id' => (string) Str::uuid(), 'user_id' => $c->id, 'tipo' => $tipo, 'valor' => $valor,
            'data' => sprintf('%d-%02d-05', $ano, $mes), 'mes' => $mes, 'ano' => $ano, 'kind' => $kind, 'destino' => $destino, 'deleted' => $deleted]);
        $r->forceFill(['confirmado_em' => now()])->save();
    }

    public function test_soma_os_meses_anteriores_do_mesmo_ano(): void
    {
        $c = $this->pessoa('Maria Souza');
        // setembro: gasto 500, repasse 300 → ficou devendo 200
        $this->nota($c, 2026, 9, 500);
        $this->repasse($c, 2026, 9, 300);
        // agosto: sobrou 50
        $this->nota($c, 2026, 8, 100);
        $this->repasse($c, 2026, 8, 150);
        // outubro NÃO entra no anterior de outubro
        $this->nota($c, 2026, 10, 999);

        $ant = (new RelatorioEquipePdf)->saldoAnterior(2026, 10);

        $this->assertEqualsWithDelta(-150.0, $ant[$c->id]['RDM'], 0.001);   // (300-500) + (150-100)
        $this->assertEqualsWithDelta(0.0, $ant[$c->id]['RDA'], 0.001);
    }

    public function test_atravessa_a_virada_de_ano(): void
    {
        $c = $this->pessoa('Joao Lima');
        $this->nota($c, 2025, 12, 400);
        $this->repasse($c, 2025, 12, 1000);   // dezembro/2025 sobrou 600
        $this->nota($c, 2026, 1, 100);

        $ant = (new RelatorioEquipePdf)->saldoAnterior(2026, 1);
        $this->assertEqualsWithDelta(600.0, $ant[$c->id]['RDM'], 0.001);

        $ant2 = (new RelatorioEquipePdf)->saldoAnterior(2026, 2);   // janeiro entra: 600 + (0 - 100)
        $this->assertEqualsWithDelta(500.0, $ant2[$c->id]['RDM'], 0.001);
    }

    public function test_faturamento_pedido_pendente_recarga_e_apagados_ficam_fora(): void
    {
        $c = $this->pessoa('Ana Costa');
        $this->nota($c, 2026, 7, 200);                                   // gasto que conta
        $this->nota($c, 2026, 7, 5000, 'RDM', 'empresa');                // Faturamento: a empresa pagou
        $this->nota($c, 2026, 7, 80, 'RDM', null, true);                 // apagada
        $this->repasse($c, 2026, 7, 1000, 'RDM', 'received', 'recarga'); // recarga do cartão: não é recebido
        $this->repasse($c, 2026, 7, 700, 'RDM', 'requested');            // pedido pendente: não é dinheiro
        $this->repasse($c, 2026, 7, 60, 'RDM', 'received', 'carteira');  // reembolso de carteira conta
        $this->repasse($c, 2026, 7, 40, 'RDM', 'received', null, true);  // apagado

        $ant = (new RelatorioEquipePdf)->saldoAnterior(2026, 8);

        $this->assertEqualsWithDelta(-140.0, $ant[$c->id]['RDM'], 0.001);   // 60 - 200
    }

    public function test_saldo_e_por_tipo_e_quem_tem_saldos_opostos_nao_some(): void
    {
        $d = $this->pessoa('Daniel Opostos');
        $this->repasse($d, 2026, 8, 300, 'RDM');   // sobrou 300 de RDM
        $this->nota($d, 2026, 8, 300, 'RDA');       // e deve 300 de RDA

        $ant = (new RelatorioEquipePdf)->saldoAnterior(2026, 10);

        $this->assertEqualsWithDelta(300.0, $ant[$d->id]['RDM'], 0.001);
        $this->assertEqualsWithDelta(-300.0, $ant[$d->id]['RDA'], 0.001);   // somando daria 0 — mas não está zerado
    }

    public function test_so_os_colaboradores_pedidos_e_quem_nao_tem_historico_fica_de_fora(): void
    {
        $a = $this->pessoa('Aline');
        $b = $this->pessoa('Bruno');
        $this->nota($a, 2026, 5, 100);
        $this->nota($b, 2026, 5, 300);

        $so = (new RelatorioEquipePdf)->saldoAnterior(2026, 6, [$a->id]);

        $this->assertArrayHasKey($a->id, $so);
        $this->assertArrayNotHasKey($b->id, $so);
        $this->assertSame([], (new RelatorioEquipePdf)->saldoAnterior(2026, 5));   // nada antes de maio
    }

    public function test_pdf_inclui_quem_so_carrega_saldo_anterior(): void
    {
        $c = $this->pessoa('Carlos Devedor');
        $this->nota($c, 2026, 8, 250);   // deve 250 e não lançou nada em outubro

        $arq = tempnam(sys_get_temp_dir(), 'eq').'.pdf';
        (new RelatorioEquipePdf)->gerar(2026, 10, $arq);

        $this->assertFileExists($arq);
        $this->assertStringStartsWith('%PDF', (string) file_get_contents($arq, false, null, 0, 4));
        $this->assertGreaterThan(1500, filesize($arq));
        @unlink($arq);
    }
}
