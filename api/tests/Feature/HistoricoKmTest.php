<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\KmRegistro;
use App\Models\Veiculo;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 21/10/2026 — histórico de KM e painel de acompanhamento (dia/semana/mês + ranking).
 * "Hoje" é fixo: quarta-feira 21/10/2026, 12:00 em Brasília.
 *
 * Massa de dados (km rodado = odômetro − leitura anterior do MESMO veículo):
 *   V1 ABC1D23: 12/10 Ana 1000 (0) · 14/10 Ana 1100 (+100) · 19/10 Bia 1180 (+80) · 20/10 Bia 1300 (+120) · 21/10 Ana 1500 (+200)
 *   V2 QRS4T56: 13/10 Bia 5000 (0) · 14/10 Bia 5050 (+50) · 20/10 Ana 5300 (+250) · 21/10 Ana 5350 (+50)
 * Semana 19–25/10: 700 km (Ana 500, Bia 200). Semana anterior 12–18/10: 150 km (Ana 100, Bia 50).
 */
class HistoricoKmTest extends TestCase
{
    use RefreshDatabase;

    private Colaborador $gestor;
    private Colaborador $admin;
    private Colaborador $ana;
    private Colaborador $bia;
    private Colaborador $contador;
    private Veiculo $v1;
    private Veiculo $v2;

    protected function setUp(): void
    {
        parent::setUp();
        Carbon::setTestNow(Carbon::parse('2026-10-21 15:00:00', 'UTC'));
        KmRegistro::esquecerAuditoria();

        $this->gestor = $this->pessoa('Gestor', 'gestor');
        $this->admin = $this->pessoa('Admin', 'admin');
        $this->ana = $this->pessoa('Ana');
        $this->bia = $this->pessoa('Bia');
        $this->contador = $this->pessoa('Contador', 'contabilidade');
        $this->v1 = $this->veiculo('ABC1D23', 'Strada');
        $this->v2 = $this->veiculo('QRS4T56', 'Hilux');

        foreach ([
            [$this->v1, $this->ana, '2026-10-12', 1000], [$this->v1, $this->ana, '2026-10-14', 1100],
            [$this->v1, $this->bia, '2026-10-19', 1180], [$this->v1, $this->bia, '2026-10-20', 1300], [$this->v1, $this->ana, '2026-10-21', 1500],
            [$this->v2, $this->bia, '2026-10-13', 5000], [$this->v2, $this->bia, '2026-10-14', 5050],
            [$this->v2, $this->ana, '2026-10-20', 5300], [$this->v2, $this->ana, '2026-10-21', 5350],
        ] as [$v, $quem, $data, $odo]) {
            $this->leitura($v, $quem, $data, $odo);
        }
    }

    protected function tearDown(): void
    {
        Carbon::setTestNow();
        KmRegistro::esquecerAuditoria();
        parent::tearDown();
    }

    private function pessoa(string $nome, string $role = 'colaborador'): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome, 'email' => strtolower($nome).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function veiculo(string $placa, string $modelo): Veiculo
    {
        $v = new Veiculo(['id' => (string) Str::uuid(), 'placa' => $placa, 'modelo' => $modelo, 'ativo' => true]);
        $v->save();

        return $v;
    }

    private function leitura(Veiculo $v, Colaborador $quem, string $data, int $odo): KmRegistro
    {
        $k = new KmRegistro(['id' => (string) Str::uuid(), 'veiculo_id' => $v->id, 'user_id' => $quem->id, 'data' => $data, 'odometro' => $odo]);
        $k->save();

        return $k;
    }

    private function itens(array $json, string $campo = 'odometro'): array
    {
        return array_column($json['itens'], $campo);
    }

    /* ── Histórico ─────────────────────────────────────────── */

    public function test_gestor_ve_tudo_em_ordem_cronologica_inversa_com_o_km_de_cada_leitura(): void
    {
        Sanctum::actingAs($this->gestor);
        $j = $this->getJson('/api/frota/historico?de=2026-10-01&ate=2026-10-21')->assertOk()->json();

        $this->assertSame(9, $j['total']);
        $this->assertSame(850, $j['total_km']);
        $this->assertSame([5350, 1500, 5300, 1300, 1180, 5050, 1100, 5000, 1000], $this->itens($j));
        $this->assertSame([50, 200, 250, 120, 80, 50, 100, 0, 0], $this->itens($j, 'km_rodado'));

        $primeiro = $j['itens'][1];            // Ana 1500 em V1, partindo da leitura da Bia
        $this->assertSame('Ana', $primeiro['user_nome']);
        $this->assertSame(1300, $primeiro['anterior_odometro']);
        $this->assertSame('Bia', $primeiro['anterior_por']);
        $this->assertSame('ABC1D23', $primeiro['placa']);
        $this->assertTrue($primeiro['pode_editar'], 'gestor corrige o de qualquer um');
    }

    public function test_km_por_dia_cobre_o_filtro_inteiro_mesmo_com_pagina_curta(): void
    {
        Sanctum::actingAs($this->gestor);
        $j = $this->getJson('/api/frota/historico?de=2026-10-19&ate=2026-10-21&limite=1')->assertOk()->json();
        $this->assertCount(1, $j['itens']);
        $this->assertEquals(['2026-10-19' => 80, '2026-10-20' => 370, '2026-10-21' => 250], $j['por_dia']);
    }

    public function test_lista_de_veiculos_traz_a_ultima_leitura_de_cada_um(): void
    {
        Sanctum::actingAs($this->ana);
        $v = collect($this->getJson('/api/veiculos')->assertOk()->json())->keyBy('placa');
        $this->assertSame(1500, $v['ABC1D23']['ultimo_odometro']);
        $this->assertSame('2026-10-21', $v['ABC1D23']['ultima_data']);
        $this->assertSame(5350, $v['QRS4T56']['ultimo_odometro']);
    }

    public function test_janela_nao_zera_o_km_da_primeira_leitura(): void
    {
        Sanctum::actingAs($this->gestor);
        /* a janela começa em 19/10: a leitura de 19/10 parte da de 14/10, fora da janela */
        $j = $this->getJson('/api/frota/historico?de=2026-10-19&ate=2026-10-21&veiculo_id='.$this->v1->id)->assertOk()->json();

        $this->assertSame([1500, 1300, 1180], $this->itens($j));
        $this->assertSame([200, 120, 80], $this->itens($j, 'km_rodado'));
        $this->assertSame(400, $j['total_km']);
    }

    public function test_filtros_por_colaborador_e_veiculo_e_as_opcoes_dos_filtros(): void
    {
        Sanctum::actingAs($this->gestor);
        $bia = $this->getJson('/api/frota/historico?de=2026-10-01&ate=2026-10-21&user_id='.$this->bia->id)->assertOk()->json();
        $this->assertSame(4, $bia['total']);
        $this->assertSame(250, $bia['total_km'], '80 + 120 + 50 + 0');
        /* as opções não se encolhem com o filtro: dá para trocar de pessoa sem limpar antes */
        $this->assertEqualsCanonicalizing(['Ana', 'Bia'], array_column($bia['colaboradores'], 'nome'));
        $this->assertEqualsCanonicalizing(['ABC1D23', 'QRS4T56'], array_column($bia['veiculos'], 'placa'));

        $v2 = $this->getJson('/api/frota/historico?de=2026-10-01&ate=2026-10-21&veiculo_id='.$this->v2->id.'&user_id='.$this->ana->id)->assertOk()->json();
        $this->assertSame([5350, 5300], $this->itens($v2));
    }

    public function test_paginacao(): void
    {
        Sanctum::actingAs($this->gestor);
        $a = $this->getJson('/api/frota/historico?de=2026-10-01&ate=2026-10-21&limite=4')->assertOk()->json();
        $this->assertCount(4, $a['itens']);
        $this->assertTrue($a['tem_mais']);
        $this->assertSame(9, $a['total'], 'o total é do filtro inteiro, não da página');
        $this->assertSame(850, $a['total_km']);

        $c = $this->getJson('/api/frota/historico?de=2026-10-01&ate=2026-10-21&limite=4&offset=8')->assertOk()->json();
        $this->assertSame([1000], $this->itens($c));
        $this->assertFalse($c['tem_mais']);
    }

    public function test_colaborador_ve_so_as_proprias_leituras_mas_com_o_km_do_veiculo(): void
    {
        Sanctum::actingAs($this->ana);
        $j = $this->getJson('/api/frota/historico?de=2026-10-01&ate=2026-10-21')->assertOk()->json();

        $this->assertSame([5350, 1500, 5300, 1100, 1000], $this->itens($j));
        $this->assertSame([50, 200, 250, 100, 0], $this->itens($j, 'km_rodado'), 'o km de 21/10 parte da leitura da Bia (1300)');
        $this->assertSame(600, $j['total_km']);
        foreach ($j['itens'] as $item) {
            $this->assertSame('Ana', $item['user_nome']);
            $this->assertNull($item['anterior_por'], 'quem leu antes é do gestor');
            $this->assertTrue($item['pode_editar']);
        }
        $this->assertSame([], $j['colaboradores'], 'a lista de pessoas é do gestor');
    }

    public function test_colaborador_nao_consegue_espiar_o_outro_pelo_filtro(): void
    {
        Sanctum::actingAs($this->ana);
        $j = $this->getJson('/api/frota/historico?de=2026-10-01&ate=2026-10-21&user_id='.$this->bia->id)->assertOk()->json();
        $this->assertSame(5, $j['total']);
        $this->assertSame(['Ana'], array_values(array_unique(array_column($j['itens'], 'user_nome'))));
    }

    public function test_colaborador_de_qualquer_regime_usa_a_frota_e_so_o_contador_nao(): void
    {
        /* 21/10/2026: a Frota deixou de ser só do regime C.V. — RDM/RDA também registra e acompanha o próprio km */
        foreach (['rdm_rda', 'cv'] as $regime) {
            $c = $this->pessoa('Colab '.$regime);
            $c->forceFill(['regime' => $regime])->save();
            Sanctum::actingAs($c);
            $this->getJson('/api/veiculos')->assertOk();
            $this->getJson('/api/frota/painel')->assertOk()->assertJsonPath('colaboradores', null);
            $this->getJson('/api/frota/historico')->assertOk();
            $this->putJson('/api/km/'.Str::uuid(), ['veiculo_id' => $this->v1->id, 'data' => '2026-10-21', 'odometro' => 1600])->assertOk();
            $this->getJson('/api/frota/anual?ano=2026')->assertOk();
        }
        Sanctum::actingAs($this->contador);
        $this->getJson('/api/veiculos')->assertForbidden();
        $this->putJson('/api/km/'.Str::uuid(), ['veiculo_id' => $this->v1->id, 'data' => '2026-10-21', 'odometro' => 1700])->assertForbidden();
    }

    public function test_contador_nao_usa_a_frota(): void
    {
        Sanctum::actingAs($this->contador);
        $this->getJson('/api/frota/historico')->assertForbidden()->assertJsonPath('somente_leitura', true);
        $this->getJson('/api/frota/painel')->assertForbidden()->assertJsonPath('somente_leitura', true);
    }

    public function test_leitura_com_odometro_absurdo_vem_marcada_para_conferir(): void
    {
        $this->leitura($this->v1, $this->bia, '2026-10-21', 150000);   // digitou 150000 em vez de 1500x
        Sanctum::actingAs($this->gestor);
        $j = $this->getJson('/api/frota/historico?de=2026-10-21&ate=2026-10-21&veiculo_id='.$this->v1->id)->assertOk()->json();
        $this->assertSame('salto', $j['itens'][0]['alerta']);
        $this->assertNull($j['itens'][1]['alerta']);
    }

    public function test_periodo_invertido_e_recusado(): void
    {
        Sanctum::actingAs($this->gestor);
        $this->getJson('/api/frota/historico?de=2026-10-21&ate=2026-10-01')->assertStatus(422);
    }

    /* ── Painel ────────────────────────────────────────────── */

    public function test_painel_da_semana_do_gestor_traz_total_comparacao_serie_e_ranking(): void
    {
        Sanctum::actingAs($this->gestor);
        $j = $this->getJson('/api/frota/painel?modo=semana&ref=2026-10-21')->assertOk()->json();

        $this->assertSame(['ini' => '2026-10-19', 'fim' => '2026-10-25', 'atual' => true], $j['periodo']);
        $this->assertSame(700, $j['total']);
        $this->assertSame(150, $j['total_anterior']);
        $this->assertSame(367, $j['variacao_pct']);
        $this->assertSame(5, $j['leituras']);
        $this->assertSame(2, $j['veiculos_rodaram']);
        $this->assertSame(2, $j['veiculos_ativos']);
        $this->assertSame(3, $j['dias_decorridos'], 'seg, ter e qua — a semana está andando');

        $this->assertCount(8, $j['serie']);
        $this->assertSame(700, $j['serie'][7]['km']);
        $this->assertSame(150, $j['serie'][6]['km']);
        $this->assertSame('2026-10-19', $j['serie'][7]['ini']);

        $this->assertSame(['Ana', 'Bia'], array_column($j['colaboradores'], 'nome'));
        $this->assertSame([500, 200], array_column($j['colaboradores'], 'km'));
        $this->assertSame([100, 50], array_column($j['colaboradores'], 'km_anterior'));

        $this->assertSame(['ABC1D23', 'QRS4T56'], array_column($j['veiculos'], 'placa'));
        $this->assertSame([400, 300], array_column($j['veiculos'], 'km'));
        $this->assertSame(1500, $j['veiculos'][0]['ultimo_odometro']);

        $this->assertSame(250, $j['contexto']['dia']['km']);
        $this->assertSame(700, $j['contexto']['semana']['km']);
        $this->assertSame(850, $j['contexto']['mes']['km']);
    }

    public function test_semana_em_andamento_compara_com_os_mesmos_dias_da_anterior(): void
    {
        /* um terceiro veículo anda 500 km na sexta da semana passada: fora do "seg a qua" que se compara */
        $v3 = $this->veiculo('MNO5P67', 'Fiorino');
        foreach ([['2026-10-12', 100], ['2026-10-16', 600], ['2026-10-19', 700], ['2026-10-21', 800]] as [$data, $odo]) {
            $this->leitura($v3, $this->ana, $data, $odo);
        }
        Sanctum::actingAs($this->gestor);

        $j = $this->getJson('/api/frota/painel?modo=semana&ref=2026-10-21')->assertOk()->json();
        $this->assertTrue($j['comparacao_parcial']);
        $this->assertSame(['ini' => '2026-10-12', 'fim' => '2026-10-14'], $j['comparado_com']);
        $this->assertSame(['ini' => '2026-10-12', 'fim' => '2026-10-18'], $j['anterior']);
        $this->assertSame(900, $j['total'], '700 + os 200 do Fiorino');
        $this->assertSame(150, $j['total_anterior'], 'só seg a qua; os 500 da sexta ficam de fora');

        /* a semana passada, já fechada, é comparada inteira com a retrasada */
        $fechada = $this->getJson('/api/frota/painel?modo=semana&ref=2026-10-14')->assertOk()->json();
        $this->assertFalse($fechada['comparacao_parcial']);
        $this->assertSame(650, $fechada['total']);
    }

    public function test_painel_do_dia_compara_com_ontem(): void
    {
        Sanctum::actingAs($this->admin);
        $j = $this->getJson('/api/frota/painel?modo=dia&ref=2026-10-21')->assertOk()->json();
        $this->assertSame(250, $j['total']);
        $this->assertSame(370, $j['total_anterior']);
        $this->assertSame(-32, $j['variacao_pct']);
        $this->assertCount(14, $j['serie']);
        $this->assertSame('2026-10-21', $j['serie'][13]['ini']);
    }

    public function test_painel_do_mes_e_navegacao_para_o_periodo_anterior(): void
    {
        Sanctum::actingAs($this->gestor);
        $mes = $this->getJson('/api/frota/painel?modo=mes&ref=2026-10-21')->assertOk()->json();
        $this->assertSame(850, $mes['total']);
        $this->assertSame(0, $mes['total_anterior']);
        $this->assertNull($mes['variacao_pct'], 'sem base de comparação não há porcentagem');
        $this->assertCount(12, $mes['serie']);

        /* a semana de 12–18/10, vista de trás: não é a atual */
        $ant = $this->getJson('/api/frota/painel?modo=semana&ref=2026-10-14&ate=2026-10-21')->assertOk()->json();
        $this->assertSame(150, $ant['total']);
        $this->assertFalse($ant['periodo']['atual']);
        $this->assertSame(7, $ant['dias_decorridos']);
        $this->assertSame('2026-10-19', $ant['serie'][7]['ini'], 'o gráfico não anda quando se escolhe uma barra dele');
    }

    public function test_selecionar_periodo_fora_do_grafico_faz_o_grafico_terminar_nele(): void
    {
        Sanctum::actingAs($this->gestor);
        $j = $this->getJson('/api/frota/painel?modo=semana&ref=2026-06-10&ate=2026-10-21')->assertOk()->json();
        $this->assertSame('2026-06-08', $j['serie'][7]['ini']);
    }

    public function test_painel_do_colaborador_so_tem_os_numeros_dele_e_nao_tem_ranking(): void
    {
        Sanctum::actingAs($this->ana);
        $j = $this->getJson('/api/frota/painel?modo=semana&ref=2026-10-21')->assertOk()->json();

        $this->assertSame(500, $j['total'], '200 + 250 + 50 — o km de 21/10 em V1 parte da leitura da Bia');
        $this->assertSame(100, $j['total_anterior']);
        $this->assertSame(400, $j['variacao_pct']);
        $this->assertNull($j['colaboradores'], 'ranking de gente é do gestor');
        $this->assertNull($j['veiculos_ativos']);
        $this->assertSame(500, $j['serie'][7]['km']);
        $this->assertSame(500, $j['contexto']['semana']['km']);
        $this->assertSame(250, $j['contexto']['dia']['km']);
        $this->assertSame(['QRS4T56', 'ABC1D23'], array_column($j['veiculos'], 'placa'));
        $this->assertSame([300, 200], array_column($j['veiculos'], 'km'), 'só o que ele rodou em cada veículo');
    }

    public function test_planilha_anual_do_colaborador_parte_da_leitura_do_veiculo_como_o_painel(): void
    {
        Sanctum::actingAs($this->ana);
        $anual = $this->getJson('/api/frota/anual?ano=2026')->assertOk()->json();
        $painel = $this->getJson('/api/frota/painel?modo=mes&ref=2026-10-21')->assertOk()->json();
        $this->assertSame(600, $anual['meses_total'][9], 'o km de 21/10 em V1 parte da leitura da Bia (1300), não da da própria Ana');
        $this->assertSame($painel['total'], $anual['meses_total'][9]);
        $this->assertSame(['Ana'], array_column($anual['motoristas'], 'nome'));
        $this->assertSame([5350, 1500, 5300, 1100, 1000], array_column($anual['leituras'], 'odometro'));

        Sanctum::actingAs($this->bia);
        $this->assertSame(250, $this->getJson('/api/frota/anual?ano=2026')->assertOk()->json('meses_total.9'), '80 + 120 + 0 + 50');

        Sanctum::actingAs($this->gestor);
        $g = $this->getJson('/api/frota/anual?ano=2026')->assertOk()->json();
        $this->assertSame(850, $g['meses_total'][9]);
        $this->assertEqualsCanonicalizing(['Ana', 'Bia'], array_column($g['motoristas'], 'nome'));
    }

    public function test_so_uuid_vira_id_de_registro_e_de_veiculo(): void
    {
        /* o id aparece em atributos HTML no app: id com aspas guardado aqui viraria script na tela do gestor */
        Sanctum::actingAs($this->ana);
        $this->putJson("/api/km/x');alert(1);('", ['veiculo_id' => $this->v1->id, 'data' => '2026-10-21', 'odometro' => 1600])->assertStatus(422);
        $this->putJson('/api/km/abc', ['veiculo_id' => $this->v1->id, 'data' => '2026-10-21', 'odometro' => 1600])->assertStatus(422);
        $this->assertSame(0, KmRegistro::where('odometro', 1600)->count());

        Sanctum::actingAs($this->gestor);
        $this->putJson('/api/veiculos/não-é-uuid', ['placa' => 'ZZZ9Z99', 'modelo' => 'Teste'])->assertStatus(422);
        $this->putJson('/api/veiculos/'.Str::uuid(), ['placa' => 'ZZZ9Z99', 'modelo' => 'Teste'])->assertOk();
    }

    public function test_data_no_futuro_e_recusada_ou_trazida_para_hoje(): void
    {
        Sanctum::actingAs($this->ana);
        $this->putJson('/api/km/'.Str::uuid(), ['veiculo_id' => $this->v1->id, 'data' => '2026-10-25', 'odometro' => 1600])->assertStatus(422);
        $this->putJson('/api/km/'.Str::uuid(), ['veiculo_id' => $this->v1->id, 'data' => '2999-01-01', 'odometro' => 9999999])->assertStatus(422);

        $perto = $this->putJson('/api/km/'.Str::uuid(), ['veiculo_id' => $this->v1->id, 'data' => '2026-10-22', 'odometro' => 1600])->assertOk()->json();
        $this->assertSame('2026-10-21', $perto['data'], 'até 2 dias à frente é relógio adiantado: vira hoje');

        /* a edição também não leva a leitura para o futuro */
        $k = $this->registroDaAna();
        $this->putJson('/api/km/'.$k->id, ['veiculo_id' => $this->v1->id, 'data' => '2999-01-01', 'odometro' => 1500])->assertStatus(422);
    }

    public function test_leitura_futura_ja_gravada_nao_vira_a_ultima_leitura_do_veiculo(): void
    {
        $this->leitura($this->v1, $this->ana, '2999-01-01', 9999999);       // registro antigo, de antes da regra
        Sanctum::actingAs($this->bia);
        $v = collect($this->getJson('/api/veiculos')->assertOk()->json())->keyBy('placa');
        $this->assertSame(1500, $v['ABC1D23']['ultimo_odometro']);
        $this->assertSame('2026-10-21', $v['ABC1D23']['ultima_data']);
    }

    public function test_contexto_do_mes_acompanha_o_inicio_do_periodo_mostrado(): void
    {
        $v3 = $this->veiculo('MNO5P67', 'Fiorino');
        foreach ([['2026-10-28', 1000], ['2026-10-29', 1100], ['2026-11-03', 1300]] as [$data, $odo]) {
            $this->leitura($v3, $this->ana, $data, $odo);
        }
        Sanctum::actingAs($this->ana);
        /* semana de 26/10 a 01/11: o domingo (ref) é novembro, mas a semana começa em outubro e a tela rotula "outubro" */
        $j = $this->getJson('/api/frota/painel?modo=semana&ref=2026-11-01')->assertOk()->json();
        $this->assertSame('2026-10-01', $j['contexto']['mes']['ini']);
        $this->assertSame(700, $j['contexto']['mes']['km'], 'só outubro: 600 + os 100 do Fiorino em 29/10');
    }

    public function test_veiculos_que_rodaram_so_conta_ativo(): void
    {
        $this->v2->update(['ativo' => false]);          // a Hilux rodou na semana (300 km), mas está inativa
        Sanctum::actingAs($this->gestor);
        $j = $this->getJson('/api/frota/painel?modo=semana&ref=2026-10-21')->assertOk()->json();
        $this->assertSame(1, $j['veiculos_ativos']);
        $this->assertSame(1, $j['veiculos_rodaram'], 'só a Strada, que está ativa — nunca "2 de 1"');
        $this->assertSame(700, $j['total'], 'o km do veículo inativo continua no total');
    }

    public function test_ultima_leitura_do_painel_e_a_ate_o_fim_do_periodo_mostrado(): void
    {
        Sanctum::actingAs($this->gestor);
        $j = $this->getJson('/api/frota/painel?modo=semana&ref=2026-10-14')->assertOk()->json();      // semana de 12 a 18/10
        $v = collect($j['veiculos'])->keyBy('placa');
        $this->assertSame(1100, $v['ABC1D23']['ultimo_odometro'], 'não 1500, que é de 21/10, depois da semana');
        $this->assertSame('2026-10-14', $v['ABC1D23']['ultima_data']);
        $this->assertSame(5050, $v['QRS4T56']['ultimo_odometro']);
        $pessoas = collect($j['colaboradores'])->keyBy('nome');
        $this->assertSame('2026-10-14', $pessoas['Ana']['ultima_data']);
    }

    public function test_modo_invalido_e_recusado(): void
    {
        Sanctum::actingAs($this->gestor);
        $this->getJson('/api/frota/painel?modo=ano')->assertStatus(422);
    }

    /* ── Correção e exclusão (gestor e admin corrigem o de qualquer um) ── */

    private function registroDaAna(): KmRegistro
    {
        return KmRegistro::where('user_id', $this->ana->id)->where('odometro', 1500)->firstOrFail();
    }

    public function test_gestor_corrige_a_leitura_de_outra_pessoa_e_fica_registrado_quem_foi(): void
    {
        $k = $this->registroDaAna();
        Sanctum::actingAs($this->gestor);
        $this->putJson('/api/km/'.$k->id, ['veiculo_id' => $this->v1->id, 'data' => '2026-10-21', 'odometro' => 1450, 'observacao' => 'corrigido'])->assertOk();

        $k->refresh();
        $this->assertSame(1450, $k->odometro);
        $this->assertSame($this->ana->id, $k->user_id, 'quem corrige não vira dono da leitura');
        $this->assertSame($this->gestor->id, $k->atualizado_por);

        $j = $this->getJson('/api/frota/historico?de=2026-10-21&ate=2026-10-21&veiculo_id='.$this->v1->id)->assertOk()->json();
        $this->assertSame('Gestor', $j['itens'][0]['editado_por']);
        $this->assertNotNull($j['itens'][0]['editado_em']);
        $this->assertSame(150, $j['itens'][0]['km_rodado'], 'o km se refaz com o número corrigido');
    }

    public function test_corrigir_nao_troca_o_dono_nem_a_hora_do_registro(): void
    {
        $k = $this->registroDaAna();
        $antes = $k->registrado_em;
        Sanctum::actingAs($this->admin);
        $this->putJson('/api/km/'.$k->id, [
            'veiculo_id' => $this->v1->id, 'user_id' => $this->bia->id, 'data' => '2026-10-21', 'odometro' => 1501,
            'registrado_em' => '2026-01-01T00:00:00Z',
        ])->assertOk();
        $k->refresh();
        $this->assertSame($this->ana->id, $k->user_id);
        $this->assertEquals($antes, $k->registrado_em);
    }

    public function test_colaborador_nao_mexe_na_leitura_do_outro(): void
    {
        $k = $this->registroDaAna();
        Sanctum::actingAs($this->bia);
        $this->putJson('/api/km/'.$k->id, ['veiculo_id' => $this->v1->id, 'data' => '2026-10-21', 'odometro' => 1499])->assertForbidden();
        $this->deleteJson('/api/km/'.$k->id)->assertForbidden();
        $this->assertSame(1500, $k->fresh()->odometro);
        $this->assertNotNull(KmRegistro::find($k->id));
    }

    public function test_o_dono_edita_a_propria_leitura_e_limpa_a_marca_de_correcao(): void
    {
        $k = $this->registroDaAna();
        Sanctum::actingAs($this->gestor);
        $this->putJson('/api/km/'.$k->id, ['veiculo_id' => $this->v1->id, 'data' => '2026-10-21', 'odometro' => 1450])->assertOk();
        $this->assertSame($this->gestor->id, $k->fresh()->atualizado_por);

        Sanctum::actingAs($this->ana);
        $this->putJson('/api/km/'.$k->id, ['veiculo_id' => $this->v1->id, 'data' => '2026-10-21', 'odometro' => 1460])->assertOk();
        $this->assertNull($k->fresh()->atualizado_por);
    }

    public function test_gestor_exclui_a_leitura_de_outra_pessoa_e_o_historico_se_refaz(): void
    {
        $k = $this->registroDaAna();
        Sanctum::actingAs($this->gestor);
        $this->deleteJson('/api/km/'.$k->id)->assertOk();
        $this->assertNull(KmRegistro::find($k->id));

        $j = $this->getJson('/api/frota/historico?de=2026-10-21&ate=2026-10-21&veiculo_id='.$this->v1->id)->assertOk()->json();
        $this->assertSame(0, $j['total']);
    }

    /* ── Hora do registro ──────────────────────────────────── */

    private function novoRegistro(array $extra = []): array
    {
        return $this->putJson('/api/km/'.Str::uuid(), array_replace([
            'veiculo_id' => $this->v1->id, 'data' => '2026-10-21', 'odometro' => 1600,
        ], $extra))->assertOk()->json();
    }

    public function test_hora_informada_pelo_aparelho_vale_e_aparece_no_historico_em_utc(): void
    {
        Sanctum::actingAs($this->ana);
        $r = $this->novoRegistro(['registrado_em' => '2026-10-21T07:55:00-03:00']);   // feito às 07:55 de Brasília, subiu agora
        $this->assertStringStartsWith('2026-10-21T10:55:00', $r['registrado_em']);

        $j = $this->getJson('/api/frota/historico?de=2026-10-21&ate=2026-10-21&veiculo_id='.$this->v1->id)->assertOk()->json();
        $this->assertStringStartsWith('2026-10-21T10:55:00', $j['itens'][0]['registrado_em']);
    }

    public function test_leitura_anterior_mostra_a_hora_da_leitura_e_nao_a_do_envio(): void
    {
        Sanctum::actingAs($this->ana);
        $this->novoRegistro(['registrado_em' => '2026-10-21T07:55:00-03:00', 'odometro' => 1600]);
        $this->novoRegistro(['registrado_em' => '2026-10-21T11:42:00-03:00', 'odometro' => 1750]);   // as duas subiram agora, às 12:00 de Brasília

        $j = $this->getJson('/api/frota/historico?de=2026-10-21&ate=2026-10-21&veiculo_id='.$this->v1->id)->assertOk()->json();
        $this->assertSame([1750, 1600, 1500], $this->itens($j));
        $this->assertSame(150, $j['itens'][0]['km_rodado']);
        $this->assertStringStartsWith('2026-10-21T10:55:00', $j['itens'][0]['anterior_em'], 'a hora da leitura anterior é a que ela foi feita');
        $this->assertStringStartsWith('2026-10-21T14:42:00', $j['itens'][0]['registrado_em']);
    }

    public function test_hora_no_futuro_ou_ausente_vira_agora(): void
    {
        Sanctum::actingAs($this->ana);
        $futuro = $this->novoRegistro(['registrado_em' => '2026-10-25T00:00:00Z', 'odometro' => 1600]);
        $this->assertStringStartsWith('2026-10-21T15:00:00', $futuro['registrado_em']);

        $sem = $this->novoRegistro(['odometro' => 1601]);
        $this->assertStringStartsWith('2026-10-21T15:00:00', $sem['registrado_em']);
    }

    /* ── Antes da migração rodar ───────────────────────────── */

    public function test_funciona_antes_da_migracao_das_colunas_novas(): void
    {
        Schema::table('km_registros', fn ($t) => $t->dropColumn(['registrado_em', 'atualizado_por']));
        KmRegistro::esquecerAuditoria();

        Sanctum::actingAs($this->gestor);
        $this->putJson('/api/km/'.Str::uuid(), ['veiculo_id' => $this->v1->id, 'data' => '2026-10-21', 'odometro' => 1700, 'registrado_em' => '2026-10-21T10:00:00Z'])->assertOk();
        $k = $this->registroDaAna();
        $this->putJson('/api/km/'.$k->id, ['veiculo_id' => $this->v1->id, 'data' => '2026-10-21', 'odometro' => 1450])->assertOk();

        $j = $this->getJson('/api/frota/historico?de=2026-10-21&ate=2026-10-21')->assertOk()->json();
        $this->assertGreaterThanOrEqual(3, $j['total']);
        $this->assertNotNull($j['itens'][0]['registrado_em'], 'cai no created_at');
        $this->getJson('/api/frota/painel')->assertOk();
    }
}
