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
