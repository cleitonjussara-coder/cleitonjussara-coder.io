<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Services\LeitorNota;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * 10/10/2026 — leitura de nota por IA de visão. A API da Anthropic é sempre
 * simulada (nenhum teste gasta dinheiro). O ponto principal é a VALIDAÇÃO:
 * a IA pode errar dígito, e o que não confere nunca chega ao formulário.
 */
class LeitorNotaTest extends TestCase
{
    use RefreshDatabase;

    /** CNPJ e chave reais de estrutura, com dígitos verificadores corretos. */
    private const CNPJ = '17117768000142';

    private function comDv(string $base43): string
    {
        $soma = 0;
        $peso = 2;
        for ($i = 42; $i >= 0; $i--) {
            $soma += (int) $base43[$i] * $peso;
            $peso = $peso === 9 ? 2 : $peso + 1;
        }
        $r = $soma % 11;

        return $base43.($r < 2 ? 0 : 11 - $r);
    }

    private function chaveValida(string $cnpj = self::CNPJ, string $ufAamm = "522610"): string
    {
        return $this->comDv($ufAamm.$cnpj."65"."001"."000012345"."1"."12345678");   // 43 dígitos + DV
    }

    private function colaborador(): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) \Illuminate\Support\Str::uuid(),
            'nome' => 'Colab', 'email' => 'colab@teste.local',
            'password' => 'segredo123', 'role' => 'colaborador',
        ]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function foto(): UploadedFile
    {
        return UploadedFile::fake()->image('nota.jpg', 600, 900);
    }

    private function ia(array $campos): array
    {
        return ['stop_reason' => 'end_turn', 'content' => [['type' => 'text', 'text' => "```json\n".json_encode($campos)."\n```"]]];
    }

    private function leitor(): LeitorNota
    {
        return app(LeitorNota::class);
    }

    public function test_aceita_campos_validos_e_normaliza(): void
    {
        $r = $this->leitor()->validar(json_encode([
            'cnpj' => '17.117.768/0001-42', 'razao_social' => "  PETERMANN   & MORAIS LTDA ME ",
            'valor' => '1.234,56', 'data' => now('America/Sao_Paulo')->format('Y-m-d'),
            'numero' => '000123', 'serie' => '001', 'chave' => null,
        ]));

        $this->assertSame(self::CNPJ, $r['cnpj']);
        $this->assertSame('PETERMANN & MORAIS LTDA ME', $r['razao_social']);
        $this->assertSame(1234.56, $r['valor']);
        $this->assertSame('123', $r['numero']);
        $this->assertSame('1', $r['serie']);
    }

    public function test_descarta_cnpj_e_chave_com_digito_errado(): void
    {
        $chaveRuim = substr($this->chaveValida(), 0, 43).'0';
        if ($chaveRuim === $this->chaveValida()) {
            $chaveRuim = substr($this->chaveValida(), 0, 43).'1';
        }
        $r = $this->leitor()->validar(json_encode(['cnpj' => '17117768000143', 'chave' => $chaveRuim, 'valor' => 10]));

        $this->assertNull($r['cnpj']);
        $this->assertNull($r['chave']);
        $this->assertSame(10.0, $r['valor']);
    }

    public function test_chave_valida_manda_no_cnpj(): void
    {
        $chave = $this->chaveValida();
        $outroCnpj = '11222333000181';                       // CNPJ válido, mas diferente do da chave
        $r = $this->leitor()->validar(json_encode(['cnpj' => $outroCnpj, 'chave' => $chave]));

        $this->assertSame($chave, $r['chave']);
        $this->assertSame(self::CNPJ, $r['cnpj']);
    }

    public function test_descarta_data_impossivel_futura_ou_antiga(): void
    {
        $amanha = now('America/Sao_Paulo')->addDays(3)->format('Y-m-d');
        foreach (['2026-02-31', $amanha, '1999-12-31', '10/09/2026', 'ontem', 20260910] as $d) {
            $this->assertNull($this->leitor()->validar(json_encode(['data' => $d]))['data'], "data $d");
        }
        $this->assertSame('2026-09-10', $this->leitor()->validar(json_encode(['data' => '2026-09-10']))['data']);
    }

    public function test_descarta_valor_invalido(): void
    {
        foreach ([0, -5, '0,00', 'abc', null, 'dez reais', 99999999, [12]] as $v) {
            $this->assertNull($this->leitor()->validar(json_encode(['valor' => $v]))['valor'], 'valor '.json_encode($v));
        }
        $this->assertSame(87.9, $this->leitor()->validar(json_encode(['valor' => 87.9]))['valor']);
        $this->assertSame(1500.0, $this->leitor()->validar(json_encode(['valor' => 'R$ 1.500,00']))['valor']);
        $this->assertSame(12.5, $this->leitor()->validar(json_encode(['valor' => '12.50']))['valor']);
    }

    public function test_texto_sem_json_ou_json_quebrado_devolve_tudo_nulo(): void
    {
        foreach (['não consegui ler', '{quebrado', '[]', ''] as $t) {
            $this->assertSame([null], array_values(array_unique($this->leitor()->validar($t))), "texto: $t");
        }
    }

    public function test_valor_ambiguo_ou_em_formato_us_nao_vira_valor_1000_vezes_errado(): void
    {
        foreach (["12,345", "1.234", "12.345", "123.456", "1,234", "1.234.567", "12.3456", "1.5.0", "1.500"] as $v) {
            $this->assertNull($this->leitor()->validar(json_encode(["valor" => $v]))["valor"], "valor $v");
        }
        $this->assertSame(1234.56, $this->leitor()->validar(json_encode(["valor" => "1,234.56"]))["valor"]);
        $this->assertNull($this->leitor()->validar(json_encode(["valor" => "1,234,567.89"]))["valor"]);   // acima de R$ 1 milhão
        $this->assertSame(123.45, $this->leitor()->validar(json_encode(["valor" => "123,45"]))["valor"]);
        $this->assertSame(10.0, $this->leitor()->validar(json_encode(["valor" => "10"]))["valor"]);
        $this->assertSame(999999.99, $this->leitor()->validar(json_encode(["valor" => 999999.99]))["valor"]);
        foreach ([1500000, 1234567] as $v) {
            $this->assertNull($this->leitor()->validar(json_encode(["valor" => $v]))["valor"], "valor $v");
        }
    }

    public function test_chave_com_uf_mes_modelo_ou_cnpj_embutido_impossiveis_e_descartada(): void
    {
        $maus = [
            "uf 99" => $this->comDv("99"."2610".self::CNPJ."65"."001"."000012345"."1"."12345678"),
            "mes 13" => $this->comDv("52"."2613".self::CNPJ."65"."001"."000012345"."1"."12345678"),
            "modelo 12" => $this->comDv("52"."2610".self::CNPJ."12"."001"."000012345"."1"."12345678"),
            "cnpj embutido invalido" => $this->comDv("52"."2610"."17117768000143"."65"."001"."000012345"."1"."12345678"),
        ];
        foreach ($maus as $quando => $chave) {
            $this->assertTrue($this->leitor()->chaveValida($chave), "o DV do caso '$quando' deveria conferir");
            $r = $this->leitor()->validar(json_encode(["chave" => $chave, "cnpj" => self::CNPJ]));
            $this->assertNull($r["chave"], $quando);
            $this->assertSame(self::CNPJ, $r["cnpj"], $quando);
        }
    }

    public function test_data_fora_do_mes_da_chave_e_descartada_e_razao_de_outra_empresa_tambem(): void
    {
        $chave = $this->chaveValida();                       // AAMM 2610
        $r = $this->leitor()->validar(json_encode(["chave" => $chave, "data" => "2026-05-10", "cnpj" => "11222333000181", "razao_social" => "TRANSPORTADORA XYZ LTDA"]));
        $this->assertNull($r["data"]);                       // mês 05 não é o da chave (10)
        $this->assertSame(self::CNPJ, $r["cnpj"]);           // a chave manda
        $this->assertNull($r["razao_social"]);               // o nome era da outra empresa

        $ok = $this->leitor()->validar(json_encode(["chave" => $chave, "data" => "2026-10-03", "cnpj" => self::CNPJ, "razao_social" => "POSTO TESTE"]));
        $this->assertSame("2026-10-03", $ok["data"]);
        $this->assertSame("POSTO TESTE", $ok["razao_social"]);
    }

    public function test_numero_e_serie_aceitam_um_unico_grupo_de_digitos(): void
    {
        foreach (["2026/123", "NFS-e 2026-45", "123/1", "1/2026", "Nº 123 Série 1", "A123", "", "abc", "0"] as $n) {
            $this->assertNull($this->leitor()->validar(json_encode(["numero" => $n]))["numero"], "numero $n");
        }
        $this->assertNull($this->leitor()->validar(json_encode(["serie" => "A1"]))["serie"]);
        $this->assertSame("4521", $this->leitor()->validar(json_encode(["numero" => "Nº 4521"]))["numero"]);
        $this->assertSame("12345", $this->leitor()->validar(json_encode(["numero" => "12.345"]))["numero"]);
        $this->assertSame("123", $this->leitor()->validar(json_encode(["numero" => 123]))["numero"]);
        $this->assertSame("0", $this->leitor()->validar(json_encode(["serie" => "000"]))["serie"]);
        $this->assertSame("1", $this->leitor()->validar(json_encode(["serie" => "001"]))["serie"]);
    }

    public function test_chave_de_nfse_de_50_digitos_so_com_estrutura_valida(): void
    {
        $ano = (int) now("America/Sao_Paulo")->format("y");
        $ok = substr(str_pad("52000"."0".self::CNPJ, 36, "0"), 0, 36).sprintf("%02d", $ano)."09".str_repeat("1", 10);
        $ok = substr_replace($ok, "2", 8, 1);
        $this->assertSame(50, strlen($ok));
        $this->assertSame($ok, $this->leitor()->validar(json_encode(["chave_nfse" => $ok]))["chave_nfse"]);

        $ufRuim = substr_replace($ok, "99", 0, 2);
        $mesRuim = substr_replace($ok, "13", 38, 2);
        $tpRuim = substr_replace($ok, "7", 8, 1);
        foreach ([$ufRuim, $mesRuim, $tpRuim, substr($ok, 0, 49)] as $mau) {
            $this->assertNull($this->leitor()->validar(json_encode(["chave_nfse" => $mau]))["chave_nfse"]);
        }
    }

    public function test_endpoint_le_a_nota_e_nao_devolve_cpf_nem_campos_extras(): void
    {
        config(['petermann.anthropic.key' => 'chave-de-teste']);
        Http::fake(['api.anthropic.com/*' => Http::response($this->ia([
            'cnpj' => self::CNPJ, 'razao_social' => 'POSTO TESTE LTDA', 'valor' => 123.45, 'data' => '2026-09-10',
            'numero' => '4521', 'serie' => '1', 'chave' => null, 'cpf_consumidor' => '12345678909',
        ]))]);
        Sanctum::actingAs($this->colaborador());

        $res = $this->post('/api/notas/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])
            ->assertOk()->assertJsonPath('dados.valor', 123.45)->assertJsonPath('dados.cnpj', self::CNPJ)
            ->assertJsonPath('dados.numero', '4521')->assertJsonPath('motivo', null);
        $this->assertArrayNotHasKey('cpf_consumidor', $res->json('dados'));

        Http::assertSent(fn ($req) => $req->hasHeader('x-api-key', 'chave-de-teste')
            && $req->data()['model'] === 'claude-haiku-5-5'
            && $req->data()['messages'][0]['content'][0]['type'] === 'image'
            && str_contains($req->data()['messages'][0]['content'][1]['text'], 'EMITENTE'));
    }

    public function test_sem_chave_erro_da_api_e_recusa_viram_sem_dados(): void
    {
        Sanctum::actingAs($this->colaborador());

        config(['petermann.anthropic.key' => null]);
        Http::fake();
        $this->post('/api/notas/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])
            ->assertOk()->assertJson(['dados' => null, 'motivo' => 'indisponivel']);
        Http::assertNothingSent();

        config(['petermann.anthropic.key' => 'k']);
        Http::fake(['api.anthropic.com/*' => Http::response(['error' => 'x'], 400)]);
        $this->post('/api/notas/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])
            ->assertOk()->assertJson(['dados' => null, 'motivo' => 'nao_leu']);

        Http::fake(['api.anthropic.com/*' => Http::response(['stop_reason' => 'refusal', 'content' => []])]);
        $this->post('/api/notas/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])
            ->assertOk()->assertJson(['dados' => null, 'motivo' => 'nao_leu']);
    }

    public function test_acesso_recusado_liga_o_disjuntor_e_a_segunda_chamada_nem_sai(): void
    {
        config(["petermann.anthropic.key" => "k"]);
        Sanctum::actingAs($this->colaborador());

        foreach ([401, 403] as $status) {
            Cache::flush();
            Http::fake(["api.anthropic.com/*" => Http::response(["error" => "x"], $status)]);
            $this->post("/api/notas/ler-foto", ["file" => $this->foto()], ["Accept" => "application/json"])
                ->assertOk()->assertJson(["dados" => null, "motivo" => "nao_leu"]);
            $this->post("/api/notas/ler-foto", ["file" => $this->foto()], ["Accept" => "application/json"])
                ->assertOk()->assertJson(["dados" => null, "motivo" => "indisponivel"]);
            Http::assertSentCount(1);   // só a 1ª chamada de cada rodada saiu; a 2ª parou no disjuntor
        }

        Cache::flush();
        Http::fake(["api.anthropic.com/*" => Http::response(["type" => "error", "error" => ["message" => "Your credit balance is too low to access the Anthropic API."]], 400)]);
        $this->post("/api/notas/ler-foto", ["file" => $this->foto()], ["Accept" => "application/json"])->assertJson(["motivo" => "nao_leu"]);
        $this->post("/api/notas/ler-foto", ["file" => $this->foto()], ["Accept" => "application/json"])->assertJson(["motivo" => "indisponivel"]);
    }

    public function test_limite_diario_proprio_das_notas_e_login_obrigatorio(): void
    {
        $this->post('/api/notas/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])->assertUnauthorized();

        config(['petermann.anthropic.key' => 'k', 'petermann.anthropic.limite_dia_notas' => 1]);
        Http::fake(['api.anthropic.com/*' => Http::response($this->ia(['valor' => 10]))]);
        Sanctum::actingAs($this->colaborador());

        $this->post('/api/notas/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])->assertJsonPath('dados.valor', 10);
        $this->post('/api/notas/ler-foto', ['file' => $this->foto()], ['Accept' => 'application/json'])
            ->assertOk()->assertJson(['dados' => null, 'motivo' => 'limite']);
        Http::assertSentCount(1);

        $this->post('/api/notas/ler-foto', ['file' => UploadedFile::fake()->create('x.pdf', 10, 'application/pdf')], ['Accept' => 'application/json'])
            ->assertStatus(422);
    }
}
