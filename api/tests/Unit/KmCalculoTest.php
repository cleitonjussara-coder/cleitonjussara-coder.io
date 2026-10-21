<?php

namespace Tests\Unit;

use App\Services\KmCalculo;
use PHPUnit\Framework\TestCase;

/**
 * 21/10/2026 — contas do histórico e do painel de KM: km rodado por leitura,
 * períodos (dia, semana de segunda a domingo, mês), série do gráfico e variação.
 */
class KmCalculoTest extends TestCase
{
    private function leitura(string $id, string $data, int $odo, string $user = 'u1', string $veiculo = 'v1', string $criado = ''): array
    {
        return ['id' => $id, 'veiculo_id' => $veiculo, 'user_id' => $user, 'data' => $data, 'odometro' => $odo, 'criado' => $criado];
    }

    public function test_km_e_o_odometro_menos_a_leitura_anterior_do_mesmo_veiculo(): void
    {
        $r = KmCalculo::comKm([
            $this->leitura('c', '2026-10-21', 1300, 'ana'),
            $this->leitura('a', '2026-10-19', 1000, 'ana'),
            $this->leitura('b', '2026-10-20', 1120, 'bia'),   // entrada fora de ordem: a função ordena
        ]);

        $this->assertSame(['a', 'b', 'c'], array_column($r, 'id'));
        $this->assertSame([0, 120, 180], array_column($r, 'km'));
        $this->assertSame([null, 1000, 1120], array_map(fn ($l) => $l['anterior']['odometro'] ?? null, $r));
        /* o km vai para quem fez a leitura, mesmo que a anterior seja de outra pessoa */
        $this->assertSame('ana', $r[1]['anterior']['user_id']);
    }

    public function test_primeira_leitura_do_veiculo_vale_zero_mas_a_base_da_janela_conta(): void
    {
        $sem = KmCalculo::comKm([$this->leitura('a', '2026-10-05', 5000)]);
        $this->assertSame(0, $sem[0]['km']);
        $this->assertNull($sem[0]['anterior']);

        $com = KmCalculo::comKm([$this->leitura('a', '2026-10-05', 5000)], $this->leitura('x', '2026-09-30', 4800));
        $this->assertSame(200, $com[0]['km']);
        $this->assertSame('2026-09-30', $com[0]['anterior']['data']);
    }

    public function test_mesmo_dia_ordena_pelo_odometro_e_depois_pela_hora(): void
    {
        $r = KmCalculo::comKm([
            $this->leitura('tarde', '2026-10-21', 1300, 'u1', 'v1', '2026-10-21 20:00:00'),
            $this->leitura('manha', '2026-10-21', 1000, 'u1', 'v1', '2026-10-21 10:00:00'),
        ]);
        $this->assertSame(['manha', 'tarde'], array_column($r, 'id'));
        $this->assertSame(300, $r[1]['km']);
    }

    public function test_leitura_menor_que_a_anterior_vale_zero_e_avisa(): void
    {
        $r = KmCalculo::comKm([$this->leitura('a', '2026-10-19', 1000), $this->leitura('b', '2026-10-20', 900)]);
        $this->assertSame(0, $r[1]['km']);
        $this->assertSame('menor', $r[1]['alerta']);
        $this->assertNull($r[0]['alerta']);
    }

    public function test_salto_grande_avisa_para_conferir(): void
    {
        $r = KmCalculo::comKm([$this->leitura('a', '2026-10-19', 1000), $this->leitura('b', '2026-10-20', 1000 + KmCalculo::SALTO_SUSPEITO), $this->leitura('c', '2026-10-21', 1000 + KmCalculo::SALTO_SUSPEITO + 1 + KmCalculo::SALTO_SUSPEITO)]);
        $this->assertNull($r[1]['alerta'], 'exatamente o limite ainda é normal');
        $this->assertSame('salto', $r[2]['alerta']);
    }

    public function test_periodo_da_semana_vai_de_segunda_a_domingo(): void
    {
        /* 21/10/2026 é quarta-feira */
        $this->assertSame(['ini' => '2026-10-19', 'fim' => '2026-10-25'], KmCalculo::periodo('semana', '2026-10-21'));
        $this->assertSame(['ini' => '2026-10-19', 'fim' => '2026-10-25'], KmCalculo::periodo('semana', '2026-10-19'), 'segunda abre a semana');
        $this->assertSame(['ini' => '2026-10-19', 'fim' => '2026-10-25'], KmCalculo::periodo('semana', '2026-10-25'), 'domingo fecha a semana, não abre a próxima');
    }

    public function test_periodos_de_dia_e_mes(): void
    {
        $this->assertSame(['ini' => '2026-10-21', 'fim' => '2026-10-21'], KmCalculo::periodo('dia', '2026-10-21'));
        $this->assertSame(['ini' => '2026-02-01', 'fim' => '2026-02-28'], KmCalculo::periodo('mes', '2026-02-14'));
        $this->assertSame(['ini' => '2028-02-01', 'fim' => '2028-02-29'], KmCalculo::periodo('mes', '2028-02-01'), 'ano bissexto');
        $this->assertSame(['ini' => '2026-12-01', 'fim' => '2026-12-31'], KmCalculo::periodo('mes', '2026-12-31'));
    }

    public function test_periodo_anterior_atravessa_mes_e_ano(): void
    {
        $this->assertSame(['ini' => '2026-10-20', 'fim' => '2026-10-20'], KmCalculo::anterior('dia', '2026-10-21'));
        $this->assertSame(['ini' => '2026-09-30', 'fim' => '2026-09-30'], KmCalculo::anterior('dia', '2026-10-01'));
        $this->assertSame(['ini' => '2026-10-12', 'fim' => '2026-10-18'], KmCalculo::anterior('semana', '2026-10-21'));
        $this->assertSame(['ini' => '2025-12-01', 'fim' => '2025-12-31'], KmCalculo::anterior('mes', '2026-01-15'));
    }

    public function test_comparavel_pega_so_os_primeiros_dias_do_periodo_anterior(): void
    {
        $semanaPassada = KmCalculo::anterior('semana', '2026-10-21');                  // 12 a 18/10
        $this->assertSame(['ini' => '2026-10-12', 'fim' => '2026-10-14'], KmCalculo::comparavel($semanaPassada, 3), 'seg a qua contra seg a qua');
        $this->assertSame($semanaPassada, KmCalculo::comparavel($semanaPassada, 7));
        $this->assertSame($semanaPassada, KmCalculo::comparavel($semanaPassada, 9), 'nunca passa do fim do período anterior');

        $setembro = KmCalculo::anterior('mes', '2026-10-21');
        $this->assertSame(['ini' => '2026-09-01', 'fim' => '2026-09-21'], KmCalculo::comparavel($setembro, 21));
        $fevereiro = KmCalculo::anterior('mes', '2026-03-31');
        $this->assertSame(['ini' => '2026-02-01', 'fim' => '2026-02-28'], KmCalculo::comparavel($fevereiro, 31), 'mês anterior mais curto');
    }

    public function test_serie_termina_no_periodo_pedido_e_tem_o_tamanho_do_modo(): void
    {
        $dias = KmCalculo::serie('dia', '2026-10-21');
        $this->assertCount(14, $dias);
        $this->assertSame('2026-10-08', $dias[0]['ini']);
        $this->assertSame('2026-10-21', $dias[13]['ini']);

        $semanas = KmCalculo::serie('semana', '2026-10-21');
        $this->assertCount(8, $semanas);
        $this->assertSame('2026-10-19', $semanas[7]['ini']);
        $this->assertSame('2026-08-31', $semanas[0]['ini']);

        $meses = KmCalculo::serie('mes', '2026-10-21');
        $this->assertCount(12, $meses);
        $this->assertSame('2025-11-01', $meses[0]['ini']);
        $this->assertSame('2026-10-31', $meses[11]['fim']);
    }

    public function test_somar_conta_so_as_leituras_do_periodo(): void
    {
        $ls = KmCalculo::comKm([
            $this->leitura('a', '2026-10-18', 1000), $this->leitura('b', '2026-10-19', 1100),
            $this->leitura('c', '2026-10-21', 1250), $this->leitura('d', '2026-10-26', 1500),
        ]);
        $this->assertSame(['km' => 250, 'leituras' => 2], KmCalculo::somar($ls, KmCalculo::periodo('semana', '2026-10-21')));
        $this->assertSame(['km' => 250, 'leituras' => 1], KmCalculo::somar($ls, KmCalculo::periodo('semana', '2026-10-26')));
        $this->assertSame(['km' => 0, 'leituras' => 0], KmCalculo::somar($ls, KmCalculo::periodo('dia', '2026-10-20')));
    }

    public function test_variacao_sobre_o_periodo_anterior(): void
    {
        $this->assertSame(18, KmCalculo::variacao(1482, 1256));
        $this->assertSame(-50, KmCalculo::variacao(50, 100));
        $this->assertNull(KmCalculo::variacao(300, 0), 'sem base de comparação não inventa porcentagem');
    }
}
