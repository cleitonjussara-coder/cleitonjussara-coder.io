<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 21/10/2026 — "mesma nota lançada como faturamento e depois lançada como
 * colaborador não está sendo barrada por duplicidade".
 *
 * Causa: o app só comparava a nota nova com as notas GUARDADAS NO APARELHO
 * (`notas` = as do próprio usuário), e o servidor só conferia a chave de 44
 * dígitos. Nota de Faturamento sem colaborador (user_id nulo) nunca está no
 * aparelho de ninguém como "minha", e nota de outra pessoa só está no do
 * gestor — então número+fornecedor, dia+valor+fornecedor e NFS-e passavam
 * batido. Agora o servidor confere as mesmas regras do app em TODAS as notas
 * vivas, e devolve ao colaborador comum só "existe / por quê / de onde vem",
 * nunca a nota.
 */
class DuplicidadeNotasTest extends TestCase
{
    use RefreshDatabase;

    private const CHAVE = '35260117117768000142650010000123451000123450';

    private function pessoa(string $role, string $nome = null): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(),
            'nome' => $nome ?? ucfirst($role), 'email' => Str::slug($nome ?? $role).'-'.Str::random(4).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    /** Nota de Faturamento: paga pela empresa, sem colaborador (user_id nulo). */
    private function faturamento(array $campos = []): Nota
    {
        return $this->nota(null, array_replace(['pagamento' => 'empresa', 'foto_path' => 'geral/x.jpg'], $campos));
    }

    private function nota(?Colaborador $dono, array $campos = []): Nota
    {
        $n = new Nota(array_replace([
            'id' => (string) Str::uuid(), 'user_id' => $dono?->id, 'tipo' => 'RDA', 'valor' => 87.5,
            'data' => '2026-10-10', 'mes' => 10, 'ano' => 2026,
            'cnpj' => '11222333000181', 'razao_social' => 'POSTO SANTA FE LTDA', 'numero' => '4521', 'serie' => '1',
            'deleted' => false,
        ], $campos));
        $n->save();

        return $n->fresh();
    }

    /** O que o formulário manda ao conferir antes de lançar. */
    private function candidata(array $troca = []): array
    {
        return array_replace([
            'tipo' => 'RDA', 'valor' => 87.5, 'data' => '2026-10-10',
            'cnpj' => '11.222.333/0001-81', 'razao_social' => 'Posto Santa Fe Ltda', 'numero' => '4521', 'serie' => '1',
        ], $troca);
    }

    /* ── o que a pessoa relatou ─────────────────────────────────────── */

    public function test_faturamento_depois_colaborador_com_a_mesma_chave_e_barrado(): void
    {
        $colab = $this->pessoa('colaborador');
        $this->faturamento(['chave_nfce' => self::CHAVE]);
        Sanctum::actingAs($colab);

        $this->postJson('/api/notas/chave-existe', ['chave' => self::CHAVE])->assertOk()->assertJsonPath('existe', true);
        $this->postJson('/api/notas/duplicada', ['chave' => self::CHAVE])
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'chave')->assertJsonPath('origem', 'faturamento');
    }

    public function test_faturamento_sem_chave_depois_colaborador_com_mesmo_numero_e_fornecedor(): void
    {
        $colab = $this->pessoa('colaborador');
        $this->faturamento();
        Sanctum::actingAs($colab);

        $this->postJson('/api/notas/duplicada', $this->candidata(['valor' => 99.9, 'data' => '2026-10-11']))
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'numero')->assertJsonPath('origem', 'faturamento');
    }

    public function test_faturamento_sem_numero_depois_colaborador_com_mesmo_dia_valor_e_fornecedor(): void
    {
        $colab = $this->pessoa('colaborador');
        $this->faturamento(['numero' => null, 'serie' => null]);
        Sanctum::actingAs($colab);

        $this->postJson('/api/notas/duplicada', $this->candidata(['numero' => '']))
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'igual')->assertJsonPath('origem', 'faturamento');
    }

    public function test_nfse_com_a_mesma_chave_de_50_digitos_e_barrada(): void
    {
        $colab = $this->pessoa('colaborador');
        $url = 'https://nfse.exemplo.gov.br/consulta?chave=12345678901234567890123456789012345678901234567890';
        $this->faturamento(['documento' => 'nfse', 'qr_url' => $url, 'numero' => null, 'valor' => 1200, 'razao_social' => 'SERVICOS LTDA', 'cnpj' => '22333444000155']);
        Sanctum::actingAs($colab);

        $this->postJson('/api/notas/duplicada', ['qr_url' => $url, 'valor' => 1200, 'data' => '2026-10-12', 'tipo' => 'RDM'])
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'nfse')->assertJsonPath('origem', 'faturamento');
    }

    /* ── 06/11/2026: NFS-e 214 e 215 da mesma clínica, mesmo valor e mesmo dia ── */

    private const NFSE_214 = 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=52080042240831425000167000000000021426113884758809';
    private const NFSE_215 = 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=52080042240831425000167000000000021526113661145304';

    private function nfseDaClinica(array $campos = []): array
    {
        return array_replace([
            'tipo' => 'RDM', 'subtipo' => 'Outros', 'documento' => 'nfse', 'qr_url' => self::NFSE_214, 'numero' => '214', 'serie' => '70000',
            'valor' => 80, 'data' => '2026-11-05', 'mes' => 11, 'ano' => 2026,
            'cnpj' => '40831425000167', 'razao_social' => 'CLINICA THAIS ZANETTI LTDA',
        ], $campos);
    }

    public function test_nfse_de_chaves_diferentes_com_mesmo_dia_e_valor_nao_e_duplicata(): void
    {
        $this->faturamento($this->nfseDaClinica());
        Sanctum::actingAs($this->pessoa('gestor'));

        $this->postJson('/api/notas/duplicada', [
            'tipo' => 'RDM', 'qr_url' => self::NFSE_215, 'numero' => '215', 'serie' => '70000',
            'valor' => 80, 'data' => '2026-11-05', 'cnpj' => '40831425000167', 'razao_social' => 'CLINICA THAIS ZANETTI LTDA',
        ])->assertOk()->assertJsonPath('existe', false);
    }

    public function test_chaves_de_44_diferentes_com_mesmo_dia_e_valor_nao_e_duplicata(): void
    {
        $this->faturamento(['chave_nfce' => self::CHAVE, 'numero' => null]);
        Sanctum::actingAs($this->pessoa('gestor'));

        $this->postJson('/api/notas/duplicada', $this->candidata(['chave' => '35260117117768000142650010000999991000999990', 'numero' => '']))
            ->assertOk()->assertJsonPath('existe', false);
    }

    public function test_nfse_sem_chave_de_um_lado_continua_avisando_por_dia_e_valor(): void
    {
        $this->faturamento($this->nfseDaClinica());
        Sanctum::actingAs($this->pessoa('gestor'));

        // o mesmo documento lançado por foto, sem o QR nem o número lidos: a coincidência é o único sinal
        $this->postJson('/api/notas/duplicada', [
            'tipo' => 'RDM', 'valor' => 80, 'data' => '2026-11-05', 'cnpj' => '40831425000167',
        ])->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'igual');
    }

    public function test_mesmo_numero_com_chave_diferente_continua_avisando(): void
    {
        $this->faturamento($this->nfseDaClinica());
        Sanctum::actingAs($this->pessoa('gestor'));

        // chave lida do texto pode vir com um dígito errado: o número igual segue perguntando
        $this->postJson('/api/notas/duplicada', [
            'tipo' => 'RDM', 'qr_url' => self::NFSE_215, 'numero' => '214', 'serie' => '70000',
            'valor' => 80, 'data' => '2026-11-05', 'cnpj' => '40831425000167',
        ])->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'numero');
    }

    /* ── sentido inverso: colaborador primeiro, faturamento depois ──── */

    public function test_colaborador_depois_faturamento_o_gestor_e_avisado_e_ve_qual_nota(): void
    {
        $gestor = $this->pessoa('gestor');
        $colab = $this->pessoa('colaborador', 'Maria Campo');
        $existente = $this->nota($colab, ['chave_nfce' => self::CHAVE]);
        Sanctum::actingAs($gestor);

        $r = $this->postJson('/api/notas/duplicada', $this->candidata(['chave' => self::CHAVE]))->assertOk();
        $r->assertJsonPath('existe', true)->assertJsonPath('motivo', 'chave')->assertJsonPath('origem', 'colaborador');
        $r->assertJsonPath('nota.id', $existente->id)->assertJsonPath('nota.dono_nome', 'Maria Campo');

        $sem = $this->postJson('/api/notas/duplicada', $this->candidata(['valor' => 10, 'data' => '2026-10-01']))->assertOk();
        $sem->assertJsonPath('motivo', 'numero')->assertJsonPath('nota.id', $existente->id);
    }

    public function test_faturamento_sobre_faturamento_tambem_e_visto(): void
    {
        $gestor = $this->pessoa('gestor');
        $this->faturamento();
        Sanctum::actingAs($gestor);

        $this->postJson('/api/notas/duplicada', $this->candidata())
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('origem', 'faturamento');
    }

    /* ── colaboradores diferentes e placa (09/11/2026, EPR Triângulo R$ 14,50) ── */

    public function test_mesmo_fornecedor_dia_e_valor_de_colaboradores_diferentes_nao_e_duplicata(): void
    {
        $pedro = $this->pessoa('colaborador', 'Pedro');
        $joao = $this->pessoa('colaborador', 'Joao');
        $epr = ['tipo' => 'RDM', 'subtipo' => 'Pedágio', 'valor' => 14.5, 'data' => '2026-11-05',
            'cnpj' => '48127012000108', 'razao_social' => 'EPR TRIANGULO MINEIRO', 'numero' => null, 'serie' => null];
        $this->nota($pedro, $epr);
        Sanctum::actingAs($joao);
        $cand = array_replace($epr, ['cnpj' => '48.127.012/0001-08']);

        // de outra pessoa: só fornecedor + dia + valor não junta
        $this->postJson('/api/notas/duplicada', $cand + ['user_id' => $joao->id])->assertOk()->assertJsonPath('existe', false);
        // da mesma pessoa continua perguntando
        $this->postJson('/api/notas/duplicada', $cand + ['user_id' => $pedro->id])->assertOk()->assertJsonPath('motivo', 'igual');
        // sem dono informado (app antigo) segue a regra de sempre
        $this->postJson('/api/notas/duplicada', $cand)->assertOk()->assertJsonPath('motivo', 'igual');
        // número igual entre pessoas continua valendo
        Nota::query()->update(['numero' => 'L3GIA8IJ82NA']);
        $this->postJson('/api/notas/duplicada', array_replace($cand, ['user_id' => $joao->id, 'numero' => 'L3GIA8IJ82NA']))
            ->assertOk()->assertJsonPath('motivo', 'numero');
    }

    public function test_faturamento_sem_colaborador_continua_conferido_contra_qualquer_pessoa(): void
    {
        $colab = $this->pessoa('colaborador');
        $this->faturamento(['numero' => null]);
        Sanctum::actingAs($colab);

        $this->postJson('/api/notas/duplicada', $this->candidata(['numero' => '', 'user_id' => $colab->id]))
            ->assertOk()->assertJsonPath('motivo', 'igual')->assertJsonPath('origem', 'faturamento');
    }

    public function test_placa_diferente_nos_dois_lados_separa(): void
    {
        $colab = $this->pessoa('colaborador');
        $this->nota($colab, ['valor' => 14.5, 'data' => '2026-11-05', 'numero' => null, 'placa' => 'TXI1F14']);
        Sanctum::actingAs($colab);
        $cand = $this->candidata(['valor' => 14.5, 'data' => '2026-11-05', 'numero' => '', 'user_id' => $colab->id]);

        $this->postJson('/api/notas/duplicada', $cand + ['placa' => 'ABC1D23'])->assertOk()->assertJsonPath('existe', false);
        $this->postJson('/api/notas/duplicada', $cand + ['placa' => 'txi-1f14'])->assertOk()->assertJsonPath('motivo', 'igual');
    }

    /* ── lixeira e exclusão ─────────────────────────────────────────── */

    public function test_nota_na_lixeira_nao_barra(): void
    {
        $colab = $this->pessoa('colaborador');
        $this->faturamento(['chave_nfce' => self::CHAVE, 'deleted' => true]);
        Sanctum::actingAs($colab);

        $this->postJson('/api/notas/chave-existe', ['chave' => self::CHAVE])->assertOk()->assertJsonPath('existe', false);
        $this->postJson('/api/notas/duplicada', $this->candidata(['chave' => self::CHAVE]))
            ->assertOk()->assertJsonPath('existe', false)->assertJsonPath('motivo', null);
    }

    public function test_nota_apagada_em_definitivo_nao_barra(): void
    {
        $colab = $this->pessoa('colaborador');
        $this->faturamento()->delete();
        Sanctum::actingAs($colab);

        $this->postJson('/api/notas/duplicada', $this->candidata())->assertOk()->assertJsonPath('existe', false);
    }

    public function test_restaurada_da_lixeira_volta_a_barrar(): void
    {
        $colab = $this->pessoa('colaborador');
        $fat = $this->faturamento(['deleted' => true]);
        Sanctum::actingAs($colab);
        $this->postJson('/api/notas/duplicada', $this->candidata())->assertJsonPath('existe', false);

        $fat->forceFill(['deleted' => false])->save();
        $this->postJson('/api/notas/duplicada', $this->candidata())->assertJsonPath('existe', true);
    }

    /* ── o que NÃO é duplicata ──────────────────────────────────────── */

    public function test_a_propria_nota_em_edicao_nao_se_acusa(): void
    {
        $colab = $this->pessoa('colaborador');
        $minha = $this->nota($colab, ['chave_nfce' => self::CHAVE]);
        Sanctum::actingAs($colab);

        $this->postJson('/api/notas/duplicada', $this->candidata(['chave' => self::CHAVE, 'ignore_id' => $minha->id]))
            ->assertOk()->assertJsonPath('existe', false);
        $this->postJson('/api/notas/duplicada', $this->candidata(['chave' => self::CHAVE]))
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('origem', 'sua');
    }

    public function test_notas_diferentes_nao_sao_duplicata(): void
    {
        $colab = $this->pessoa('colaborador');
        $this->faturamento();
        Sanctum::actingAs($colab);

        // outro fornecedor, mesmo número / mesmo dia e valor
        $this->postJson('/api/notas/duplicada', $this->candidata(['cnpj' => '99888777000166', 'razao_social' => 'OUTRO POSTO']))
            ->assertOk()->assertJsonPath('existe', false);
        // mesmo fornecedor e número, mas série diferente, valor e dia diferentes
        $this->postJson('/api/notas/duplicada', $this->candidata(['serie' => '2', 'valor' => 10, 'data' => '2026-10-02']))
            ->assertOk()->assertJsonPath('existe', false);
        // mesmo fornecedor, dia e valor, mas o outro grupo (RDM x RDA)
        $this->postJson('/api/notas/duplicada', $this->candidata(['tipo' => 'RDM', 'numero' => '']))
            ->assertOk()->assertJsonPath('existe', false);
        // chave de outra nota
        $this->postJson('/api/notas/duplicada', ['chave' => '35260117117768000142650010000999991000999990'])
            ->assertOk()->assertJsonPath('existe', false);
        // nada que identifique a nota
        $this->postJson('/api/notas/duplicada', [])->assertOk()->assertJsonPath('existe', false);
    }

    public function test_numero_com_zeros_a_esquerda_e_fornecedor_so_pela_razao_social(): void
    {
        $colab = $this->pessoa('colaborador');
        $this->faturamento(['numero' => '000123', 'cnpj' => null, 'razao_social' => 'Mercado  do   Joao']);
        Sanctum::actingAs($colab);

        $this->postJson('/api/notas/duplicada', ['tipo' => 'RDA', 'numero' => '123', 'razao_social' => 'MERCADO DO JOAO', 'valor' => 5, 'data' => '2026-10-03'])
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'numero');
        // CNPJ zerado não é CNPJ: não casa fornecedor sozinho
        $this->postJson('/api/notas/duplicada', ['tipo' => 'RDA', 'numero' => '123', 'cnpj' => '00000000000000', 'valor' => 5, 'data' => '2026-10-03'])
            ->assertOk()->assertJsonPath('existe', false);
    }

    /* ── pedágio (09/11/2026): número do recibo e data separam um do outro ── */

    public function test_pedagio_diferencia_pelo_numero_do_recibo_e_pela_data(): void
    {
        $colab = $this->pessoa('colaborador');
        $praca = ['tipo' => 'RDM', 'subtipo' => 'Pedágio', 'valor' => 12.4, 'data' => '2026-11-05',
            'cnpj' => '02509491000126', 'razao_social' => 'ECOVIAS DO CERRADO', 'serie' => null];
        $this->nota($colab, $praca + ['numero' => 'a1b2c3d4-0000-4000-8000-000000000001']);
        Sanctum::actingAs($colab);
        $cand = fn (array $t) => array_replace(array_diff_key($praca, ['serie' => 1]), $t);

        // mesma praça, mesmo dia e tarifa, outro recibo: não é duplicata
        $this->postJson('/api/notas/duplicada', $cand(['numero' => 'a1b2c3d4-0000-4000-8000-000000000002']))
            ->assertOk()->assertJsonPath('existe', false);
        // mesmo número de recibo em outro dia: não é a mesma passagem
        $this->postJson('/api/notas/duplicada', $cand(['numero' => 'a1b2c3d4-0000-4000-8000-000000000001', 'data' => '2026-11-06']))
            ->assertOk()->assertJsonPath('existe', false);
        // mesmo número e mesma data: é o mesmo recibo
        $this->postJson('/api/notas/duplicada', $cand(['numero' => 'a1b2c3d4-0000-4000-8000-000000000001']))
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'numero');
        // sem número lido: segue a regra de sempre e pergunta
        $this->postJson('/api/notas/duplicada', $cand(['numero' => null]))
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'igual');
        // a candidata sem subtipo também é separada quando a nota gravada é pedágio
        $this->postJson('/api/notas/duplicada', array_diff_key($cand(['numero' => 'a1b2c3d4-0000-4000-8000-000000000003']), ['subtipo' => 1]))
            ->assertOk()->assertJsonPath('existe', false);
    }

    public function test_pedagio_sem_numero_diferencia_pela_hora_do_recibo(): void
    {
        $colab = $this->pessoa('colaborador');
        $praca = ['tipo' => 'RDM', 'subtipo' => 'Pedágio', 'valor' => 14.5, 'data' => '2026-11-04',
            'cnpj' => '48127012000108', 'razao_social' => 'EPR TRIANGULO MINEIRO', 'numero' => null, 'serie' => null];
        $this->nota($colab, $praca + ['hora' => '09:44:18']);
        Sanctum::actingAs($colab);

        // mesma praça, dia e tarifa, outra hora: outra passagem
        $this->postJson('/api/notas/duplicada', array_replace($praca, ['hora' => '17:02:40']))
            ->assertOk()->assertJsonPath('existe', false);
        // mesma hora (segundos lidos diferente não separam): pergunta
        $this->postJson('/api/notas/duplicada', array_replace($praca, ['hora' => '09:44:13']))
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'igual');
        // sem hora de um lado: regra de sempre
        $this->postJson('/api/notas/duplicada', $praca)
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'igual');
    }

    /* Caso do Pedro (09/11/2026): dois recibos da EPR Triângulo de 04/11, lançados antes da categoria Pedágio (ficaram em
       Outros), com placa, DFE e hora diferentes. */
    public function test_recibo_em_outros_com_placa_separa_pelo_numero_e_pela_hora(): void
    {
        $colab = $this->pessoa('colaborador');
        $recibo = ['tipo' => 'RDM', 'subtipo' => 'Outros', 'valor' => 14.5, 'data' => '2026-11-04', 'serie' => null,
            'cnpj' => '48127012000108', 'razao_social' => 'EPR TRIANGULO MINEIRO', 'placa' => 'REM8H68'];
        $this->nota($colab, $recibo + ['numero' => 'JM5I10EJ8220', 'hora' => '08:16:22']);
        Sanctum::actingAs($colab);
        $semSerie = array_diff_key($recibo, ['serie' => 1]);

        // DFE diferente: outra passagem
        $this->postJson('/api/notas/duplicada', $semSerie + ['numero' => 'SJBEDCEJ82J4'])
            ->assertOk()->assertJsonPath('existe', false);
        // sem número, hora diferente: outra passagem (vale até sem placa)
        $this->postJson('/api/notas/duplicada', array_diff_key($semSerie, ['placa' => 1]) + ['hora' => '11:51:45'])
            ->assertOk()->assertJsonPath('existe', false);
        // mesmo DFE no mesmo dia: é o mesmo recibo
        $this->postJson('/api/notas/duplicada', $semSerie + ['numero' => 'JM5I10EJ8220'])
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'numero');
        // sem número nem hora: regra de sempre, pergunta
        $this->postJson('/api/notas/duplicada', $semSerie)
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'igual');
    }

    public function test_hora_do_recibo_e_gravada_e_recusada_quando_invalida(): void
    {
        $colab = $this->pessoa('colaborador');
        $n = $this->nota($colab, ['tipo' => 'RDM', 'subtipo' => 'Pedágio', 'hora' => '09:44:18']);
        $this->assertSame('09:44:18', $n->hora);
        $this->assertSame('09:44:18', \App\Services\LeitorNota::hora(' 09:44:18 '));
        $this->assertSame('09:44', \App\Services\LeitorNota::hora('09:44'));
        $this->assertNull(\App\Services\LeitorNota::hora('25:10'));
        $this->assertNull(\App\Services\LeitorNota::hora('9h44'));
    }

    /* 09/11/2026 (Cleiton): Casa das Balanças nº 31703 e 31704, R$ 70 no mesmo dia; a foto da 31704 cortou o fim da chave.
       Antes, fora do pedágio, número diferente ainda perguntava por dia e valor. */
    public function test_numero_diferente_separa_em_qualquer_categoria_mesmo_com_chave_cortada(): void
    {
        $colab = $this->pessoa('colaborador');
        $balanca = ['tipo' => 'RDM', 'subtipo' => 'Outros', 'valor' => 70, 'data' => '2026-11-07',
            'cnpj' => '25654468000120', 'razao_social' => 'CANUTO E CIA LTDA', 'serie' => '002'];
        $this->nota($colab, $balanca + ['numero' => '0000031703', 'chave_nfce' => '31261125654468000120550020000317031547533851']);
        Sanctum::actingAs($colab);
        $cortada = '312611256544680001205500200003170416'.'58';   // 38 dígitos: chave cortada na foto

        // número diferente, chave cortada: duas notas
        $this->postJson('/api/notas/duplicada', $balanca + ['numero' => '31704', 'chave' => $cortada])
            ->assertOk()->assertJsonPath('existe', false);
        // sem número gravado: o número sai de dentro da chave cortada
        $this->postJson('/api/notas/duplicada', $balanca + ['numero' => null, 'chave' => $cortada])
            ->assertOk()->assertJsonPath('existe', false);
        // número diferente, sem chave nenhuma: também separa
        $this->postJson('/api/notas/duplicada', $balanca + ['numero' => '31704'])
            ->assertOk()->assertJsonPath('existe', false);
        // mesmo número: continua sendo a mesma nota
        $this->postJson('/api/notas/duplicada', $balanca + ['numero' => '31703'])
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'numero');
        // sem número de nenhum jeito: regra de sempre, pergunta
        $this->postJson('/api/notas/duplicada', $balanca + ['numero' => null])
            ->assertOk()->assertJsonPath('existe', true)->assertJsonPath('motivo', 'igual');
    }

    public function test_numero_vem_da_chave_so_em_nfe_ou_nfce_que_chegou_ate_o_numero(): void
    {
        $this->assertSame('31704', \App\Services\DuplicataNota::numeroDe(null, '31261125654468000120550020000317041658'));
        $this->assertSame('12345', \App\Services\DuplicataNota::numeroDe(null, self::CHAVE));
        $this->assertSame('77', \App\Services\DuplicataNota::numeroDe('0077', self::CHAVE), 'o número gravado vale primeiro');
        $this->assertSame('', \App\Services\DuplicataNota::numeroDe(null, '3126112565446800012055002000'), 'cortada antes do número');
        $this->assertSame('', \App\Services\DuplicataNota::numeroDe(null, '31261125654468000120990020000317041658'), 'modelo que não é 55/65');
    }

    /* ── privacidade ────────────────────────────────────────────────── */

    public function test_colaborador_comum_nao_recebe_dado_de_outra_pessoa(): void
    {
        $maria = $this->pessoa('colaborador', 'Maria Campo');
        $joao = $this->pessoa('colaborador', 'Joao Roca');
        $this->nota($maria, ['chave_nfce' => self::CHAVE]);
        Sanctum::actingAs($joao);

        $r = $this->postJson('/api/notas/duplicada', $this->candidata(['chave' => self::CHAVE]))->assertOk();
        $r->assertJsonPath('existe', true)->assertJsonPath('origem', 'colaborador');
        $this->assertSame(['existe', 'motivo', 'origem'], array_keys($r->json()), 'só sim/não, motivo e de onde vem');
        $texto = json_encode($r->json());
        foreach (['Maria', $maria->id, 'POSTO SANTA FE', '87.5', '11222333000181', '4521'] as $segredo) {
            $this->assertStringNotContainsString($segredo, $texto, "a resposta não pode trazer $segredo");
        }

        $this->postJson('/api/notas/chave-existe', ['chave' => self::CHAVE])->assertOk()->assertExactJson(['existe' => true]);
    }

    public function test_contador_consegue_conferir_ao_corrigir_nota(): void
    {
        $contador = $this->pessoa('contabilidade');
        $this->faturamento(['chave_nfce' => self::CHAVE]);
        Sanctum::actingAs($contador);

        $this->postJson('/api/notas/duplicada', ['chave' => self::CHAVE])->assertOk()->assertJsonPath('existe', true);
    }

    public function test_exige_login(): void
    {
        $this->postJson('/api/notas/duplicada', ['chave' => self::CHAVE])->assertStatus(401);
    }
}
