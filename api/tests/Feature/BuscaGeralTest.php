<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/** Busca geral (06/11/2026): acha nota, repasse e pessoa, e nunca mostra ao colaborador o que é de outro. */
class BuscaGeralTest extends TestCase
{
    use RefreshDatabase;

    private function pessoa(string $nome, string $role = 'colaborador'): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome, 'email' => Str::slug($nome).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function nota(?Colaborador $dono, array $campos = []): Nota
    {
        $n = new Nota(array_merge([
            'id' => (string) Str::uuid(), 'user_id' => $dono?->id, 'tipo' => 'RDM', 'subtipo' => 'Abastecimento', 'valor' => 100,
            'data' => '2026-10-10', 'mes' => 10, 'ano' => 2026, 'razao_social' => 'POSTO AMOSTRA LTDA', 'foto_path' => 'x/y.jpg',
        ], $campos));
        $n->save();

        return $n;
    }

    private function repasse(Colaborador $dono, array $campos = []): Repasse
    {
        $r = new Repasse(array_merge([
            'id' => (string) Str::uuid(), 'user_id' => $dono->id, 'tipo' => 'RDM', 'valor' => 1500, 'data' => '2026-10-01',
            'mes' => 10, 'ano' => 2026, 'descricao' => 'Viagem de campo', 'kind' => 'received',
        ], $campos));
        $r->save();

        return $r;
    }

    private function ids(array $lista): array
    {
        return collect($lista)->pluck('id')->sort()->values()->all();
    }

    public function test_acha_por_fornecedor_sem_diferenca_de_maiuscula_ou_acento(): void
    {
        $ana = $this->pessoa('Ana');
        $n = $this->nota($ana, ['razao_social' => 'HOTEL SAO JOAO']);
        $this->nota($ana);
        Sanctum::actingAs($this->pessoa('Gestor', 'gestor'));

        $this->assertSame([$n->id], $this->ids($this->getJson('/api/busca?q=hotel')->json('notas')));
        $this->assertSame([$n->id], $this->ids($this->getJson('/api/busca?q='.urlencode('são joão'))->json('notas')));
    }

    public function test_acha_por_valor_cnpj_numero_placa_e_categoria(): void
    {
        $ana = $this->pessoa('Ana');
        $a = $this->nota($ana, ['valor' => 1234.56]);
        $b = $this->nota($ana, ['cnpj' => '45123456000110']);
        $c = $this->nota($ana, ['numero' => '778899']);
        $d = $this->nota($ana, ['placa' => 'ABC1D23']);
        $e = $this->nota($ana, ['subtipo' => 'Pedágio']);
        $f = $this->nota($ana, ['tipo' => 'RDA', 'subtipo' => null]);
        Sanctum::actingAs($this->pessoa('Gestor', 'gestor'));

        foreach (['1.234,56' => $a, '1234,56' => $a, 'R$1.234,56' => $a, '1234.56' => $a, '45.123.456/0001-10' => $b, '778899' => $c, 'abc1d23' => $d, 'pedagio' => $e, 'alimentação' => $f] as $q => $nota) {
            $this->assertSame([$nota->id], $this->ids($this->getJson('/api/busca?q='.urlencode($q))->json('notas')), "busca por $q");
        }
    }

    public function test_termos_se_somam_e_nome_da_pessoa_conta(): void
    {
        $ana = $this->pessoa('Ana Exemplo');
        $bia = $this->pessoa('Bia Modelo');
        $n = $this->nota($ana);
        $this->nota($bia);
        Sanctum::actingAs($this->pessoa('Gestor', 'gestor'));

        $r = $this->getJson('/api/busca?q='.urlencode('ana posto'))->json();
        $this->assertSame([$n->id], $this->ids($r['notas']));
        $this->assertSame('Ana Exemplo', $r['notas'][0]['user_nome']);
        $this->assertSame([$ana->id], $this->ids($this->getJson('/api/busca?q=exemplo')->json('pessoas')));
    }

    public function test_colaborador_so_acha_o_que_e_dele(): void
    {
        $ana = $this->pessoa('Ana');
        $bia = $this->pessoa('Bia');
        $minha = $this->nota($ana);
        $this->nota($bia);
        $this->nota(null, ['pagamento' => 'empresa']);
        $meu = $this->repasse($ana);
        $this->repasse($bia);
        Sanctum::actingAs($ana);

        $r = $this->getJson('/api/busca?q=posto')->json();
        $this->assertSame([$minha->id], $this->ids($r['notas']));
        $this->assertSame([], $r['pessoas'], 'colaborador não procura pessoas');
        $this->assertSame([], $this->getJson('/api/busca?q=bia')->json('notas'), 'nome de outra pessoa não abre as notas dela');
        $this->assertSame([$meu->id], $this->ids($this->getJson('/api/busca?q=viagem')->json('repasses')));
    }

    public function test_contador_busca_a_equipe(): void
    {
        $n = $this->nota($this->pessoa('Ana'));
        Sanctum::actingAs($this->pessoa('Conta', 'contabilidade'));
        $this->assertSame([$n->id], $this->ids($this->getJson('/api/busca?q=posto')->json('notas')));
    }

    public function test_nota_na_lixeira_nao_aparece_e_curinga_e_texto_comum(): void
    {
        $ana = $this->pessoa('Ana');
        $this->nota($ana, ['deleted' => true]);
        $this->nota($ana, ['razao_social' => 'OUTRA COISA']);
        Sanctum::actingAs($this->pessoa('Gestor', 'gestor'));

        $this->assertSame([], $this->getJson('/api/busca?q=posto')->json('notas'));
        $this->assertSame([], $this->getJson('/api/busca?q='.urlencode('%%'))->json('notas'));
        $this->assertSame([], $this->getJson('/api/busca?q=x')->json('notas'), 'uma letra não busca');
    }

    public function test_atalhos(): void
    {
        $ana = $this->pessoa('Ana');
        $hoje = now('America/Sao_Paulo');
        $semFoto = $this->nota($ana, ['foto_path' => null]);
        $semValor = $this->nota($ana, ['valor' => 0]);
        $deHoje = $this->nota($ana, ['data' => $hoje->toDateString(), 'mes' => $hoje->month, 'ano' => $hoje->year]);
        $fat = $this->nota(null, ['pagamento' => 'empresa', 'data' => $hoje->toDateString(), 'mes' => $hoje->month, 'ano' => $hoje->year]);
        $pedido = $this->repasse($ana, ['kind' => 'requested']);
        $this->repasse($ana);
        Sanctum::actingAs($this->pessoa('Gestor', 'gestor'));

        $this->assertSame([$semFoto->id], $this->ids($this->getJson('/api/busca?atalho=sem_foto')->json('notas')));
        $this->assertSame([$semValor->id], $this->ids($this->getJson('/api/busca?atalho=sem_valor')->json('notas')));
        $this->assertSame($this->ids([['id' => $deHoje->id], ['id' => $fat->id]]), $this->ids($this->getJson('/api/busca?atalho=hoje')->json('notas')));
        $this->assertSame([$fat->id], $this->ids($this->getJson('/api/busca?atalho=faturamento')->json('notas')));
        $r = $this->getJson('/api/busca?atalho=pedidos')->json();
        $this->assertSame([$pedido->id], $this->ids($r['repasses']));
        $this->assertSame([], $r['notas']);
    }

    public function test_limite_informa_o_total(): void
    {
        $ana = $this->pessoa('Ana');
        for ($i = 0; $i < 32; $i++) {
            $this->nota($ana);
        }
        Sanctum::actingAs($this->pessoa('Gestor', 'gestor'));
        $r = $this->getJson('/api/busca?q=posto')->json();
        $this->assertCount(30, $r['notas']);
        $this->assertSame(32, $r['total_notas']);
    }
}
