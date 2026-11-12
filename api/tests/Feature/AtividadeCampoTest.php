<?php

namespace Tests\Feature;

use App\Models\AtividadeCampo;
use App\Models\Colaborador;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 08/11/2026 — atividade em campo: início/fim por fazenda e campo, com localização, liberada pelo gestor por pessoa.
 */
class AtividadeCampoTest extends TestCase
{
    use RefreshDatabase;

    private function pessoa(string $nome, string $role = 'colaborador', bool $campo = false): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => $nome, 'email' => strtolower($nome).'@teste.local',
            'password' => 'segredo123', 'role' => $role, 'atividade_campo' => $campo,
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c->fresh();
    }

    private function iniciar(array $extra = []): \Illuminate\Testing\TestResponse
    {
        return $this->postJson('/api/atividades-campo/iniciar', $extra + [
            'id' => (string) Str::uuid(), 'fazenda' => 'Faz. São José', 'campo' => 'brcb147a-b',
            'lat' => -16.7654321, 'lng' => -47.6123456, 'precisao' => 12.4,
        ]);
    }

    public function test_sem_a_funcao_ligada_nao_registra(): void
    {
        Sanctum::actingAs($this->pessoa('Ana'));
        $this->iniciar()->assertForbidden();
        $this->assertSame(0, AtividadeCampo::count());
    }

    public function test_inicia_com_localizacao_e_finaliza(): void
    {
        $romario = $this->pessoa('Romario', 'colaborador', true);
        Sanctum::actingAs($romario);
        $id = (string) Str::uuid();

        $this->iniciar(['id' => $id])->assertCreated()
            ->assertJsonPath('campo', 'BRCB147A-B')->assertJsonPath('em_campo', true)
            ->assertJsonPath('lat_inicio', -16.7654321)->assertJsonPath('precisao_inicio', 12);

        $this->postJson("/api/atividades-campo/{$id}/finalizar", ['lat' => -16.77, 'lng' => -47.61, 'precisao' => 8])
            ->assertOk()->assertJsonPath('em_campo', false)->assertJsonPath('fim_automatico', false)
            ->assertJsonPath('lat_fim', -16.77);
    }

    public function test_reenvio_do_mesmo_toque_nao_duplica(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id])->assertCreated();
        $this->iniciar(['id' => $id])->assertOk();
        $this->assertSame(1, AtividadeCampo::count());
    }

    public function test_iniciar_outro_campo_fecha_o_anterior_sozinho(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $primeiro = (string) Str::uuid();
        $this->iniciar(['id' => $primeiro, 'hora' => Carbon::now()->subHours(3)->toIso8601String()])->assertCreated();
        $this->iniciar(['campo' => 'BRCB148'])->assertCreated();

        $a = AtividadeCampo::find($primeiro);
        $this->assertNotNull($a->fim);
        $this->assertTrue($a->fim_automatico);
        $this->assertSame(1, AtividadeCampo::whereNull('fim')->count());
    }

    public function test_marcacao_offline_usa_a_hora_do_aparelho_e_recusa_futuro(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $hora = Carbon::now('America/Sao_Paulo')->subMinutes(40)->startOfMinute();
        $this->iniciar(['hora' => $hora->toIso8601String()])->assertCreated()
            ->assertJsonPath('inicio', $hora->toIso8601String());

        $this->iniciar(['hora' => Carbon::now()->addHour()->toIso8601String()])->assertStatus(422);
    }

    /* Auditoria 09/11, item 3: a hora do aparelho vale até 24 h para trás; o gestor/focal corrige qualquer hora */
    public function test_hora_do_aparelho_vale_ate_24_horas_para_tras(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $this->iniciar(['hora' => Carbon::now()->subHours(25)->toIso8601String()])->assertStatus(422)
            ->assertJsonPath('message', 'Registro de mais de 24 horas atrás. Peça ao gestor ou ao focal para lançar a hora certa.');
        $this->assertSame(0, AtividadeCampo::count());

        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id, 'hora' => Carbon::now()->subHours(23)->toIso8601String()])->assertCreated();
        $this->postJson("/api/atividades-campo/{$id}/finalizar", ['hora' => Carbon::now()->subHours(30)->toIso8601String()])->assertStatus(422);

        Sanctum::actingAs($this->pessoa('Paulo', 'gestor'));
        $this->patchJson("/api/atividades-campo/{$id}", ['inicio' => Carbon::now()->subDays(3)->toIso8601String()])->assertOk();
    }

    public function test_toque_sem_internet_que_chega_depois_ganha_o_selo(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $this->iniciar(['hora' => Carbon::now()->subHours(3)->toIso8601String()])->assertCreated()
            ->assertJsonPath('registrado_depois_min', 180);
        $this->iniciar(['campo' => 'BRCB148', 'hora' => Carbon::now()->subMinutes(5)->toIso8601String()])->assertCreated()
            ->assertJsonPath('registrado_depois_min', null);
        $this->iniciar(['campo' => 'BRCB149'])->assertCreated()->assertJsonPath('registrado_depois_min', null);
    }

    public function test_fim_antes_do_inicio_e_recusado(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id])->assertCreated();
        $this->postJson("/api/atividades-campo/{$id}/finalizar", ['hora' => Carbon::now()->subDay()->toIso8601String()])->assertStatus(422);
    }

    public function test_so_o_dono_finaliza_e_ve_so_as_proprias(): void
    {
        $dono = $this->pessoa('Romario', 'colaborador', true);
        $outro = $this->pessoa('Joao', 'colaborador', true);
        Sanctum::actingAs($dono);
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id])->assertCreated();

        Sanctum::actingAs($outro);
        $this->postJson("/api/atividades-campo/{$id}/finalizar")->assertForbidden();
        $this->getJson('/api/atividades-campo')->assertOk()->assertJsonCount(0);
        $this->getJson('/api/atividades-campo/equipe')->assertForbidden();

        Sanctum::actingAs($this->pessoa('Gestor', 'gestor'));
        $this->getJson('/api/atividades-campo')->assertOk()->assertJsonCount(1);
    }

    public function test_gestor_ve_ultimo_registro_de_cada_pessoa_ligada(): void
    {
        $romario = $this->pessoa('Romario', 'colaborador', true);
        $this->pessoa('Joao', 'colaborador', true);
        $this->pessoa('Sem Funcao');
        Sanctum::actingAs($romario);
        $this->iniciar(['campo' => 'BRCB147A-B', 'hora' => Carbon::now()->subHours(2)->toIso8601String()]);
        $this->iniciar(['campo' => 'BRCB148']);

        Sanctum::actingAs($this->pessoa('Gestor', 'gestor'));
        $r = $this->getJson('/api/atividades-campo/equipe')->assertOk()->assertJsonCount(2)->json();
        $porNome = collect($r)->keyBy('nome');
        $this->assertSame('BRCB148', $porNome['Romario']['ultima']['campo']);
        $this->assertTrue($porNome['Romario']['ultima']['em_campo']);
        $this->assertNull($porNome['Joao']['ultima']);
    }

    public function test_so_gestor_liga_a_funcao_e_fica_no_historico(): void
    {
        $gestor = $this->pessoa('Gestor', 'gestor');
        $ana = $this->pessoa('Ana');

        Sanctum::actingAs($ana);
        $this->patchJson("/api/colaboradores/{$ana->id}", ['atividade_campo' => true])->assertOk();
        $this->assertFalse($ana->fresh()->registraAtividadeCampo());

        Sanctum::actingAs($gestor);
        $this->patchJson("/api/colaboradores/{$ana->id}", ['atividade_campo' => true])->assertOk()->assertJsonPath('atividade_campo', true);
        $this->assertTrue($ana->fresh()->registraAtividadeCampo());
        $this->assertSame(1, DB::table('colaboradores_historico')->where('colaborador_id', $ana->id)->where('campo', 'atividade_campo')->where('para', 'sim')->count());

        /* o gestor também liga para si mesmo */
        $this->patchJson("/api/colaboradores/{$gestor->id}", ['atividade_campo' => true])->assertOk();
        $this->assertTrue($gestor->fresh()->registraAtividadeCampo());
    }

    public function test_buscador_lista_campos_da_equipe_sem_repetir(): void
    {
        $romario = $this->pessoa('Romario', 'colaborador', true);
        $joao = $this->pessoa('Joao', 'colaborador', true);
        Sanctum::actingAs($joao);
        $this->iniciar(['fazenda' => 'Arco Verde', 'campo' => 'BRAE4305', 'hora' => Carbon::now()->subHours(5)->toIso8601String()]);
        Sanctum::actingAs($romario);
        $this->iniciar(['fazenda' => 'Faz. São José', 'campo' => 'BRCB147A-B', 'hora' => Carbon::now()->subHours(3)->toIso8601String()]);
        $this->iniciar(['fazenda' => 'São José', 'campo' => 'brcb147a-b']);   // mesmo campo escrito de outro jeito

        $r = collect($this->getJson('/api/atividades-campo/campos')->assertOk()->assertJsonCount(2)->json())->keyBy('campo');
        $this->assertSame(2, $r['BRCB147A-B']['usos']);
        $this->assertSame(2, $r['BRCB147A-B']['meus']);
        $this->assertSame(0, $r['BRAE4305']['meus']);      // do colega: aparece, sem dizer quem foi
        $this->assertArrayNotHasKey('lat_inicio', $r['BRAE4305']);

        Sanctum::actingAs($this->pessoa('Sem Funcao'));
        $this->getJson('/api/atividades-campo/campos')->assertForbidden();
    }

    /* 09/11/2026 — focal: acompanha a equipe em campo como o gestor, só nessa função */
    public function test_focal_acompanha_a_equipe_em_campo_como_o_gestor(): void
    {
        $romario = $this->pessoa('Romario', 'colaborador', true);
        $focal = $this->pessoa('Focal', 'colaborador', true);
        Sanctum::actingAs($romario);
        $this->iniciar(['campo' => 'BRCB148'])->assertCreated();

        /* sem a chave: igual a qualquer colaborador */
        Sanctum::actingAs($focal);
        $this->getJson('/api/atividades-campo')->assertOk()->assertJsonCount(0);
        $this->getJson('/api/atividades-campo/equipe')->assertForbidden();

        Sanctum::actingAs($this->pessoa('Gestor', 'gestor'));
        $this->patchJson("/api/colaboradores/{$focal->id}", ['focal_campo' => true])->assertOk()->assertJsonPath('focal_campo', true);
        $this->assertSame(1, DB::table('colaboradores_historico')->where('colaborador_id', $focal->id)->where('campo', 'focal_campo')->where('para', 'sim')->count());

        Sanctum::actingAs($focal->fresh());
        $this->getJson('/api/atividades-campo')->assertOk()->assertJsonCount(1)->assertJsonPath('0.user_nome', 'Romario');
        $this->getJson('/api/atividades-campo/equipe')->assertOk()->assertJsonCount(2);
        /* continua registrando o próprio campo */
        $this->iniciar(['campo' => 'BRAE4305'])->assertCreated();
        /* e continua colaborador fora do campo */
        $this->getJson('/api/colaboradores/atividade')->assertForbidden();
    }

    public function test_focal_nao_liga_chaves_de_ninguem(): void
    {
        $focal = $this->pessoa('Focal', 'colaborador', true);
        $focal->forceFill(['focal_campo' => true])->save();
        $ana = $this->pessoa('Ana');

        Sanctum::actingAs($focal->fresh());
        $this->patchJson("/api/colaboradores/{$ana->id}", ['focal_campo' => true, 'atividade_campo' => true])->assertForbidden();
        $this->patchJson("/api/colaboradores/{$focal->id}", ['focal_campo' => false])->assertOk();
        $this->assertTrue($focal->fresh()->acompanhaCampo());   // nem desligar a própria
        $this->assertFalse($ana->fresh()->acompanhaCampo());
    }

    /* 09/11/2026 — cadastro de campos: gestor, admin e focal criam sem registrar atividade */
    public function test_gestor_e_focal_cadastram_campo_sem_registrar_atividade(): void
    {
        Sanctum::actingAs($this->pessoa('Ana', 'colaborador', true));
        $this->postJson('/api/atividades-campo/campos', ['fazenda' => 'Arco Verde', 'campo' => 'BRAE1'])->assertForbidden();

        $gestor = $this->pessoa('Gestor', 'gestor');   // sem a função de registrar
        Sanctum::actingAs($gestor);
        $this->postJson('/api/atividades-campo/campos', ['fazenda' => 'Faz. Arco Verde', 'campo' => 'brae4305'])
            ->assertCreated()->assertJsonPath('campo', 'BRAE4305');
        $this->postJson('/api/atividades-campo/campos', ['fazenda' => 'Arco Verde', 'campo' => 'BRAE4305'])->assertStatus(409);

        $focal = $this->pessoa('Focal');
        $focal->forceFill(['focal_campo' => true])->save();
        Sanctum::actingAs($focal->fresh());
        $this->postJson('/api/atividades-campo/campos', ['fazenda' => 'São José', 'campo' => 'BRCB200'])->assertCreated();
        $this->assertSame(0, AtividadeCampo::count());

        /* aparece no buscador de quem registra, sem uso ainda */
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $r = collect($this->getJson('/api/atividades-campo/campos')->assertOk()->assertJsonCount(2)->json())->keyBy('campo');
        $this->assertTrue($r['BRAE4305']['cadastrado']);
        $this->assertSame(0, $r['BRAE4305']['usos']);
    }

    public function test_corrigir_campo_e_opcionalmente_os_registros_antigos(): void
    {
        $romario = $this->pessoa('Romario', 'colaborador', true);
        Sanctum::actingAs($romario);
        $this->iniciar(['fazenda' => 'Sao Jose', 'campo' => 'BRCB14', 'hora' => Carbon::now()->subHours(3)->toIso8601String()]);
        $this->iniciar(['fazenda' => 'Faz. Sao Jose', 'campo' => 'BRCB14']);
        $this->iniciar(['fazenda' => 'Outra', 'campo' => 'BRCB14']);   // mesmo campo, outra fazenda: não muda

        $novo = ['fazenda_antiga' => 'Sao Jose', 'campo_antigo' => 'BRCB14', 'fazenda' => 'Faz. São José', 'campo' => 'BRCB147A-B'];
        $this->putJson('/api/atividades-campo/campos', $novo)->assertForbidden();   // colaborador não corrige

        Sanctum::actingAs($this->pessoa('Gestor', 'gestor'));
        /* só o cadastro: os registros ficam como estavam */
        $this->putJson('/api/atividades-campo/campos', $novo)->assertOk()->assertJsonPath('registros_corrigidos', 0);
        $this->assertSame(3, AtividadeCampo::where('campo', 'BRCB14')->count());

        /* agora corrigindo os registros também */
        $this->putJson('/api/atividades-campo/campos', $novo + ['corrigir_registros' => true])->assertOk()->assertJsonPath('registros_corrigidos', 2);
        $this->assertSame(2, AtividadeCampo::where('campo', 'BRCB147A-B')->where('fazenda', 'Faz. São José')->count());
        $this->assertSame('Outra', AtividadeCampo::where('campo', 'BRCB14')->value('fazenda'));
        $this->assertSame(1, \App\Models\CampoCadastro::count());

        /* nome que já existe no cadastro é recusado; campo inexistente dá 404 */
        $this->postJson('/api/atividades-campo/campos', ['fazenda' => 'X', 'campo' => 'Y'])->assertCreated();
        $this->putJson('/api/atividades-campo/campos', ['fazenda_antiga' => 'X', 'campo_antigo' => 'Y', 'fazenda' => 'São José', 'campo' => 'BRCB147A-B'])->assertStatus(409);
        $this->putJson('/api/atividades-campo/campos', ['fazenda_antiga' => 'Nada', 'campo_antigo' => 'Z', 'fazenda' => 'A', 'campo' => 'B'])->assertNotFound();
    }

    public function test_contador_nao_registra(): void
    {
        Sanctum::actingAs($this->pessoa('Contador', 'contabilidade', true));
        $this->iniciar()->assertForbidden();
    }

    /* 09/11/2026 — corrigir registro: dono corrige texto, gestor também a hora; localização nunca muda */
    public function test_dono_corrige_fazenda_e_campo_mas_nao_a_hora(): void
    {
        $romario = $this->pessoa('Romario', 'colaborador', true);
        Sanctum::actingAs($romario);
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id])->assertCreated();

        $this->patchJson("/api/atividades-campo/{$id}", ['fazenda' => 'Faz. Santa Rita', 'campo' => 'brcb150', 'lat_inicio' => 0])
            ->assertOk()->assertJsonPath('fazenda', 'Faz. Santa Rita')->assertJsonPath('campo', 'BRCB150')
            ->assertJsonPath('lat_inicio', -16.7654321)->assertJsonPath('editado_por_nome', 'Romario');
        $this->assertNotNull(AtividadeCampo::find($id)->editado_em);

        $this->patchJson("/api/atividades-campo/{$id}", ['inicio' => Carbon::now()->subHour()->toIso8601String()])->assertForbidden();
    }

    public function test_sem_mudanca_nao_marca_editado(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id])->assertCreated();
        $this->patchJson("/api/atividades-campo/{$id}", ['fazenda' => 'Faz. São José', 'campo' => 'BRCB147A-B'])
            ->assertOk()->assertJsonPath('editado_em', null);
    }

    public function test_colega_nao_edita_registro_dos_outros(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id])->assertCreated();

        Sanctum::actingAs($this->pessoa('Joao', 'colaborador', true));
        $this->patchJson("/api/atividades-campo/{$id}", ['campo' => 'XXX'])->assertNotFound();
        $this->assertSame('BRCB147A-B', AtividadeCampo::find($id)->campo);
    }

    public function test_gestor_corrige_a_hora_e_o_fim_automatico(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-11-08T18:00:00-03:00'));   // as horas abaixo são de 08/11; o limite de 24 h conta a partir de "agora"
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id, 'hora' => '2026-11-08T07:00:00-03:00'])->assertCreated();
        $this->iniciar(['campo' => 'BRCB148', 'hora' => '2026-11-08T15:00:00-03:00'])->assertCreated();   // fecha o 1º sozinho às 15:00
        $this->assertTrue(AtividadeCampo::find($id)->fim_automatico);

        Sanctum::actingAs($this->pessoa('Paulo', 'gestor'));
        $this->patchJson("/api/atividades-campo/{$id}", ['inicio' => '2026-11-08T07:30:00-03:00', 'fim' => '2026-11-08T11:45:00-03:00'])
            ->assertOk()->assertJsonPath('fim_automatico', false)->assertJsonPath('minutos', 255)
            ->assertJsonPath('inicio', '2026-11-08T07:30:00-03:00')->assertJsonPath('editado_por_nome', 'Paulo');

        $this->patchJson("/api/atividades-campo/{$id}", ['fim' => '2026-11-08T06:00:00-03:00'])->assertStatus(422);
        $this->patchJson("/api/atividades-campo/{$id}", ['fim' => Carbon::now()->addDay()->toIso8601String()])->assertStatus(422);
        $this->patchJson("/api/atividades-campo/{$id}", ['fim' => null])->assertStatus(422);
    }

    public function test_focal_corrige_a_hora_de_registro_da_equipe(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-11-08T18:00:00-03:00'));   // as horas abaixo são de 08/11; o limite de 24 h conta a partir de "agora"
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id, 'hora' => '2026-11-08T07:00:00-03:00'])->assertCreated();
        $this->postJson("/api/atividades-campo/{$id}/finalizar", ['hora' => '2026-11-08T11:00:00-03:00'])->assertOk();

        $focal = $this->pessoa('Focal', 'colaborador');
        $focal->forceFill(['focal_campo' => true])->save();
        Sanctum::actingAs($focal->fresh());
        $this->patchJson("/api/atividades-campo/{$id}", ['fim' => '2026-11-08T11:30:00-03:00', 'campo' => 'BRCB150'])
            ->assertOk()->assertJsonPath('minutos', 270)->assertJsonPath('campo', 'BRCB150')->assertJsonPath('editado_por_nome', 'Focal');
    }

    /* 09/11/2026 — lixeira: registro e campo vão para a lixeira e voltam; só gestor e admin apagam de vez */
    private function focal(string $nome = 'Focal'): Colaborador
    {
        $f = $this->pessoa($nome);
        $f->forceFill(['focal_campo' => true])->save();

        return $f->fresh();
    }

    public function test_dono_apaga_registro_que_some_e_volta_ao_restaurar(): void
    {
        $romario = $this->pessoa('Romario', 'colaborador', true);
        Sanctum::actingAs($romario);
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id])->assertCreated();

        $this->deleteJson("/api/atividades-campo/{$id}")->assertOk()->assertJsonPath('apagado_por_nome', 'Romario');
        $this->getJson('/api/atividades-campo')->assertOk()->assertJsonCount(0);
        $this->getJson('/api/atividades-campo/campos')->assertOk()->assertJsonCount(0);   // buscador não conta registro apagado
        $this->getJson('/api/atividades-campo/lixeira')->assertOk()->assertJsonCount(1)->assertJsonPath('0.id', $id);
        $this->postJson("/api/atividades-campo/{$id}/finalizar", [])->assertStatus(409);   // fila velha não mexe no apagado
        $this->patchJson("/api/atividades-campo/{$id}", ['campo' => 'X'])->assertNotFound();

        $this->postJson("/api/atividades-campo/{$id}/restaurar")->assertOk()->assertJsonPath('apagado_em', null);
        $this->getJson('/api/atividades-campo')->assertOk()->assertJsonCount(1);
        $this->getJson('/api/atividades-campo/lixeira')->assertOk()->assertJsonCount(0);
    }

    public function test_colega_nao_apaga_registro_dos_outros_e_dono_nao_apaga_de_vez(): void
    {
        $romario = $this->pessoa('Romario', 'colaborador', true);
        Sanctum::actingAs($romario);
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id])->assertCreated();

        Sanctum::actingAs($this->pessoa('Ana', 'colaborador', true));
        $this->deleteJson("/api/atividades-campo/{$id}")->assertNotFound();
        $this->getJson('/api/atividades-campo/lixeira')->assertOk()->assertJsonCount(0);

        Sanctum::actingAs($romario);
        $this->deleteJson("/api/atividades-campo/{$id}")->assertOk();
        $this->deleteJson("/api/atividades-campo/{$id}/definitivo")->assertForbidden();

        Sanctum::actingAs($this->focal());   // focal manda para a lixeira e restaura, mas não apaga de vez
        $this->getJson('/api/atividades-campo/lixeira')->assertOk()->assertJsonCount(1);
        $this->deleteJson("/api/atividades-campo/{$id}/definitivo")->assertForbidden();
        $this->assertSame(1, AtividadeCampo::count());
    }

    public function test_gestor_apaga_de_vez_so_o_que_esta_na_lixeira(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id])->assertCreated();

        Sanctum::actingAs($this->pessoa('Paulo', 'gestor'));
        $this->deleteJson("/api/atividades-campo/{$id}/definitivo")->assertStatus(409);
        $this->deleteJson("/api/atividades-campo/{$id}")->assertOk()->assertJsonPath('apagado_por_nome', 'Paulo');
        $this->deleteJson("/api/atividades-campo/{$id}/definitivo")->assertOk();
        $this->assertSame(0, AtividadeCampo::count());
    }

    public function test_restaurar_registro_aberto_fecha_quando_ja_ha_outro_depois(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $primeiro = (string) Str::uuid();
        $this->iniciar(['id' => $primeiro, 'hora' => Carbon::now()->subHours(3)->toIso8601String()])->assertCreated();
        $this->deleteJson("/api/atividades-campo/{$primeiro}")->assertOk();
        $this->iniciar(['campo' => 'BRCB148', 'hora' => Carbon::now()->subHour()->toIso8601String()])->assertCreated();

        $this->postJson("/api/atividades-campo/{$primeiro}/restaurar")->assertOk()
            ->assertJsonPath('em_campo', false)->assertJsonPath('fim_automatico', true)->assertJsonPath('minutos', 120);
    }

    public function test_campo_apagado_some_do_buscador_e_gestor_apaga_de_vez(): void
    {
        $paulo = $this->pessoa('Paulo', 'gestor');
        Sanctum::actingAs($paulo);
        $this->postJson('/api/atividades-campo/campos', ['fazenda' => 'Faz. Boa Vista', 'campo' => 'bv01'])->assertCreated();

        Sanctum::actingAs($this->focal());
        $this->postJson('/api/atividades-campo/campos/apagar', ['fazenda' => 'Boa Vista', 'campo' => 'BV01'])->assertOk();
        $this->getJson('/api/atividades-campo/campos')->assertOk()->assertJsonCount(0);
        $this->getJson('/api/atividades-campo/campos?com_apagados=1')->assertOk()->assertJsonPath('0.apagado', true);
        $this->getJson('/api/atividades-campo/campos/lixeira')->assertOk()->assertJsonCount(1)->assertJsonPath('0.apagado_por_nome', 'Focal');
        $this->postJson('/api/atividades-campo/campos/definitivo', ['fazenda' => 'Boa Vista', 'campo' => 'BV01'])->assertForbidden();
        $this->postJson('/api/atividades-campo/campos/restaurar', ['fazenda' => 'Boa Vista', 'campo' => 'BV01'])->assertOk();
        $this->getJson('/api/atividades-campo/campos')->assertOk()->assertJsonCount(1);

        Sanctum::actingAs($this->pessoa('Ana', 'colaborador', true));
        $this->postJson('/api/atividades-campo/campos/apagar', ['fazenda' => 'Boa Vista', 'campo' => 'BV01'])->assertForbidden();

        Sanctum::actingAs($paulo);
        $this->postJson('/api/atividades-campo/campos/definitivo', ['fazenda' => 'Boa Vista', 'campo' => 'BV01'])->assertStatus(409);   // fora da lixeira
        $this->postJson('/api/atividades-campo/campos/apagar', ['fazenda' => 'Boa Vista', 'campo' => 'BV01'])->assertOk();
        $this->postJson('/api/atividades-campo/campos/definitivo', ['fazenda' => 'Boa Vista', 'campo' => 'BV01'])->assertOk();
        $this->assertSame(0, \App\Models\CampoCadastro::count());
    }

    public function test_campo_so_dos_registros_vai_para_a_lixeira_e_de_vez_so_sem_registros(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id, 'campo' => 'errado1'])->assertCreated();

        Sanctum::actingAs($this->pessoa('Paulo', 'gestor'));
        $this->postJson('/api/atividades-campo/campos/apagar', ['fazenda' => 'São José', 'campo' => 'ERRADO1'])->assertOk();
        $this->getJson('/api/atividades-campo/campos')->assertOk()->assertJsonCount(0);   // escondido mesmo com registro
        $this->getJson('/api/atividades-campo')->assertOk()->assertJsonCount(1);         // o registro continua
        $this->getJson('/api/atividades-campo/campos/lixeira')->assertOk()->assertJsonPath('0.registros', 1);
        $this->postJson('/api/atividades-campo/campos/definitivo', ['fazenda' => 'São José', 'campo' => 'ERRADO1'])->assertStatus(409);

        $this->deleteJson("/api/atividades-campo/{$id}")->assertOk();   // registro na lixeira já não segura o campo
        $this->postJson('/api/atividades-campo/campos/definitivo', ['fazenda' => 'São José', 'campo' => 'ERRADO1'])->assertOk();
        $this->postJson('/api/atividades-campo/campos/apagar', ['fazenda' => 'Nada', 'campo' => 'NADA'])->assertNotFound();
    }

    public function test_cadastrar_campo_da_lixeira_restaura(): void
    {
        Sanctum::actingAs($this->pessoa('Paulo', 'gestor'));
        $this->postJson('/api/atividades-campo/campos', ['fazenda' => 'Boa Vista', 'campo' => 'BV01'])->assertCreated();
        $this->postJson('/api/atividades-campo/campos/apagar', ['fazenda' => 'Boa Vista', 'campo' => 'BV01'])->assertOk();
        $this->postJson('/api/atividades-campo/campos', ['fazenda' => 'Faz. Boa Vista', 'campo' => 'bv01'])->assertCreated()->assertJsonPath('restaurado', true);
        $this->getJson('/api/atividades-campo/campos')->assertOk()->assertJsonCount(1)->assertJsonPath('0.fazenda', 'Faz. Boa Vista');
        $this->assertSame(1, \App\Models\CampoCadastro::count());
    }

    public function test_equipe_ignora_registro_apagado(): void
    {
        Sanctum::actingAs($this->pessoa('Romario', 'colaborador', true));
        $id = (string) Str::uuid();
        $this->iniciar(['id' => $id])->assertCreated();
        $this->deleteJson("/api/atividades-campo/{$id}")->assertOk();

        Sanctum::actingAs($this->pessoa('Paulo', 'gestor'));
        $this->getJson('/api/atividades-campo/equipe')->assertOk()->assertJsonPath('0.ultima', null);
    }
}
