<?php

namespace Tests\Feature;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\BackupCompleto;
use App\Services\DriveBackup;
use App\Services\FotoStorage;
use Illuminate\Foundation\Testing\Concerns\InteractsWithTime;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Laravel\Sanctum\Sanctum;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\TestCase;

/**
 * 06/11/2026 — cartão "Saúde do sistema" (GET /admin/saude).
 *
 * O cartão só vale se "tudo certo" for verdade: por isso os testes olham o atraso de cada
 * backup, o dia legítimo sem foto nova e a virada do dia entre Brasília e o servidor em
 * UTC. Banco em arquivo temporário e storage próprio, para não tocar no database.sqlite
 * local nem nos logs da pasta.
 */
class SaudeSistemaTest extends TestCase
{
    use InteractsWithTime;

    private const AGORA_UTC = '2026-11-06 15:00:00';   // 12:00 em Brasília

    private string $tmp;

    protected function setUp(): void
    {
        parent::setUp();
        $this->tmp = sys_get_temp_dir().'/saude-teste-'.Str::random(8);
        mkdir($this->tmp.'/app/backups', 0777, true);
        mkdir($this->tmp.'/logs', 0777, true);
        $this->app->useStoragePath($this->tmp);

        touch($this->tmp.'/banco.sqlite');
        config(['database.connections.sqlite.database' => $this->tmp.'/banco.sqlite']);
        DB::purge('sqlite');
        Artisan::call('migrate', ['--force' => true]);

        Storage::fake('fotos');
        Http::preventStrayRequests();   // qualquer chamada ao Google derruba o teste
        $this->travelTo(Carbon::parse(self::AGORA_UTC, 'UTC'));
    }

    protected function tearDown(): void
    {
        DB::disconnect('sqlite');
        File::deleteDirectory($this->tmp);
        parent::tearDown();
    }

    private function pessoa(string $role): Colaborador
    {
        $c = new Colaborador([
            'id' => (string) Str::uuid(), 'nome' => ucfirst($role), 'email' => $role.'-'.Str::random(5).'@teste.local',
            'password' => 'segredo123', 'role' => $role,
        ]);
        $c->forceFill(['ativo' => true]);
        if (Colaborador::temConfirmacao()) {
            $c->forceFill(['confirmado_em' => now()]);
        }
        $c->save();

        return $c;
    }

    private function saude(): TestResponse
    {
        Sanctum::actingAs($this->pessoa('gestor'));

        return $this->getJson('/api/admin/saude')->assertOk();
    }

    /** Zip com a hora de Brasília no nome. A data do arquivo fica de propósito em "agora". */
    private function zip(string $prefixo, string $quandoBrasilia, string $conteudo = 'zip'): string
    {
        $nome = $prefixo.'-'.Carbon::parse($quandoBrasilia, 'America/Sao_Paulo')->format('Y-m-d-Hi').'.zip';
        file_put_contents($this->tmp.'/app/backups/'.$nome, $conteudo);

        return $nome;
    }

    private function emDia(): void
    {
        $this->zip('banco', '2026-11-06 02:30');
        $this->zip('fotos', '2026-11-06 02:45');
        $this->zip('petermann', '2026-11-01 03:30');
    }

    private function anexo(string $rel, string $quandoUtc): void
    {
        $disco = app(FotoStorage::class)->disk();
        $disco->put($rel, 'foto');
        touch($disco->path($rel), Carbon::parse($quandoUtc, 'UTC')->getTimestamp());
    }

    private function driveConectado(array $mais = []): void
    {
        file_put_contents($this->tmp.'/app/'.DriveBackup::ARQUIVO, json_encode($mais + ['refresh_token' => 'tok', 'email' => 'a@b.c']));
    }

    private function log(string $dia, array $linhas): void
    {
        file_put_contents($this->tmp.'/logs/laravel-'.$dia.'.log', implode("\n", $linhas)."\n");
    }

    /* ── permissão ───────────────────────────────────────────── */

    #[DataProvider('papeis')]
    public function test_so_gestor_e_admin_abrem(string $role, int $status): void
    {
        Sanctum::actingAs($this->pessoa($role));

        $this->getJson('/api/admin/saude')->assertStatus($status);
    }

    public static function papeis(): array
    {
        return [
            'gestor' => ['gestor', 200],
            'admin' => ['admin', 200],
            'colaborador' => ['colaborador', 403],
            'contador' => ['contabilidade', 403],
        ];
    }

    public function test_sem_login_nao_abre(): void
    {
        $this->getJson('/api/admin/saude')->assertUnauthorized();
    }

    /* ── resumo ──────────────────────────────────────────────── */

    public function test_tudo_em_dia_da_tudo_certo_sem_chamar_o_google(): void
    {
        $this->emDia();
        $this->driveConectado();

        $r = $this->saude();

        $r->assertJsonPath('resumo.estado', 'ok');
        $r->assertJsonPath('resumo.olhar', []);
        $r->assertJsonPath('gerado_em', '2026-11-06T12:00:00-03:00');
    }

    public function test_cada_problema_entra_na_lista_do_que_olhar(): void
    {
        $this->zip('banco', '2026-11-04 02:30');
        $this->zip('petermann', '2026-11-01 03:30');
        $this->anexo('a/nova.jpg', '2026-11-05 12:00:00');   // 27 h sem cópia
        $this->log('2026-11-06', ['[2026-11-06 14:00:00] production.ERROR: falhou']);

        $r = $this->saude();

        $r->assertJsonPath('resumo.estado', 'atencao');
        $olhar = implode(' | ', $r->json('resumo.olhar'));
        $this->assertStringContainsString('Backup do banco atrasado', $olhar);
        $this->assertStringContainsString('Nenhum backup das fotos', $olhar);
        $this->assertStringContainsString('Agendador de tarefas', $olhar);
        $this->assertStringContainsString('Google Drive desligada', $olhar);
        $this->assertStringContainsString('1 erro no log', $olhar);
    }

    /* ── backups ─────────────────────────────────────────────── */

    public function test_backups_novos_trazem_arquivo_data_e_tamanho(): void
    {
        $nome = $this->zip('banco', '2026-11-06 02:30', 'conteudo12');

        $r = $this->saude();

        $r->assertJsonPath('backups.banco.estado', 'ok');
        $r->assertJsonPath('backups.banco.arquivo', $nome);
        $r->assertJsonPath('backups.banco.em', '2026-11-06T02:30:00-03:00');
        $r->assertJsonPath('backups.banco.bytes', 10);
    }

    public function test_banco_atrasa_depois_de_26_horas(): void
    {
        $this->zip('banco', '2026-11-05 10:00');   // 26 h exatas: ainda no prazo
        $this->saude()->assertJsonPath('backups.banco.estado', 'ok');

        $this->travel(1)->minutes();
        $this->saude()->assertJsonPath('backups.banco.estado', 'atrasado');
    }

    public function test_completo_atrasa_depois_de_8_dias(): void
    {
        $this->zip('petermann', '2026-10-29 12:00');   // 8 dias exatos: ainda no prazo
        $this->saude()->assertJsonPath('backups.completo.estado', 'ok');

        $this->travel(1)->minutes();
        $this->saude()->assertJsonPath('backups.completo.estado', 'atrasado');
    }

    public function test_arquivo_recopiado_nao_esconde_backup_velho(): void
    {
        $this->zip('banco', '2026-10-20 02:30');   // o filemtime é de agora, o nome é o que vale

        $this->saude()->assertJsonPath('backups.banco.estado', 'atrasado');
    }

    public function test_backup_ausente_conta_como_atrasado_e_sem_arquivo(): void
    {
        $r = $this->saude();

        foreach (['banco', 'completo'] as $tipo) {
            $r->assertJsonPath("backups.{$tipo}.estado", 'atrasado');
            $r->assertJsonPath("backups.{$tipo}.arquivo", null);
            $r->assertJsonPath("backups.{$tipo}.em", null);
        }
    }

    public function test_tipos_nao_se_misturam(): void
    {
        $this->zip('banco', '2026-11-06 02:30');

        $r = $this->saude();

        $r->assertJsonPath('backups.banco.estado', 'ok');
        $r->assertJsonPath('backups.completo.estado', 'atrasado');
    }

    /* ── fotos ───────────────────────────────────────────────── */

    public function test_fotos_em_dia_sem_olhar_os_anexos(): void
    {
        $this->zip('fotos', '2026-11-06 02:45');
        $this->anexo('a/nova.jpg', '2026-11-06 12:00:00');   // a madrugada que vem pega

        $r = $this->saude();

        $r->assertJsonPath('backups.fotos.estado', 'ok');
        $r->assertJsonPath('backups.fotos.sem_foto_nova', false);
    }

    public function test_dia_sem_foto_nova_nao_e_atraso(): void
    {
        $nome = $this->zip('fotos', '2026-11-03 02:45');
        $this->anexo('a/velha.jpg', '2026-11-02 12:00:00');

        $r = $this->saude();

        $r->assertJsonPath('backups.fotos.estado', 'ok');
        $r->assertJsonPath('backups.fotos.sem_foto_nova', true);
        $r->assertJsonPath('backups.fotos.aguardando_rodada', false);
        $r->assertJsonPath('backups.fotos.arquivo', $nome);
    }

    public function test_zip_velho_com_anexo_novo_e_atraso(): void
    {
        $this->zip('fotos', '2026-11-03 02:45');
        $this->anexo('a/nova.jpg', '2026-11-05 12:00:00');
        $this->anexo('a/recente.jpg', '2026-11-06 14:00:00');   // a recente não esconde a que espera há 27 h

        $this->saude()->assertJsonPath('backups.fotos.estado', 'atrasado');
    }

    /**
     * Achado do revisor (06/11/2026): depois de um fim de semana sem foto, a primeira foto
     * de segunda acendia "atrasado" sem nenhuma rodada perdida. Usa gerar() e gerarFotos()
     * reais para o zip que falta ser o que o backup de verdade não gera.
     */
    public function test_foto_depois_de_dias_sem_foto_espera_a_rodada_sem_alarme(): void
    {
        $brasilia = fn (string $q) => Carbon::parse($q, 'America/Sao_Paulo');
        $backup = app(BackupCompleto::class);

        $this->anexo('a/velha.jpg', '2026-10-30 13:00:00');
        $this->zip('fotos', '2026-11-01 02:45');
        $this->travelTo($brasilia('2026-11-01 03:30'));
        $backup->gerar();
        $this->travelTo($brasilia('2026-11-02 02:45'));
        $this->assertNull($backup->gerarFotos()['arquivo']);

        $this->anexo('a/nova.jpg', '2026-11-02 11:00:00');   // segunda, 08:00 em Brasília

        foreach (['2026-11-02 08:05', '2026-11-02 18:00', '2026-11-03 02:30'] as $agora) {
            $this->travelTo($brasilia($agora));
            $r = $this->saude();

            $r->assertJsonPath('backups.fotos.estado', 'ok');
            $r->assertJsonPath('backups.fotos.sem_foto_nova', false);
            $r->assertJsonPath('backups.fotos.aguardando_rodada', true);
            $this->assertStringNotContainsString('das fotos', implode(' | ', $r->json('resumo.olhar')));
        }

        $this->travelTo($brasilia('2026-11-03 02:45'));
        $this->assertNotNull($backup->gerarFotos()['arquivo']);
        $this->travelTo($brasilia('2026-11-03 08:00'));

        $r = $this->saude();
        $r->assertJsonPath('backups.fotos.estado', 'ok');
        $r->assertJsonPath('backups.fotos.aguardando_rodada', false);
    }

    public function test_cron_parado_aparece_26_horas_depois_do_anexo(): void
    {
        $this->zip('fotos', '2026-11-03 02:45');
        $this->anexo('a/nova.jpg', '2026-11-05 13:00:00');   // 26 h exatas: ainda no prazo

        $r = $this->saude();
        $r->assertJsonPath('backups.fotos.estado', 'ok');
        $r->assertJsonPath('backups.fotos.aguardando_rodada', true);

        $this->travel(1)->minutes();

        $r = $this->saude();
        $r->assertJsonPath('backups.fotos.estado', 'atrasado');
        $r->assertJsonPath('backups.fotos.aguardando_rodada', false);
        $this->assertStringContainsString('Backup das fotos atrasado', implode(' | ', $r->json('resumo.olhar')));
    }

    public function test_primeira_foto_sem_zip_nenhum_espera_a_rodada(): void
    {
        $this->anexo('a/recente.jpg', '2026-11-06 12:00:00');

        $r = $this->saude();

        $r->assertJsonPath('backups.fotos.estado', 'ok');
        $r->assertJsonPath('backups.fotos.arquivo', null);
        $r->assertJsonPath('backups.fotos.aguardando_rodada', true);
    }

    public function test_miniatura_e_gravacao_em_andamento_nao_sao_foto_nova(): void
    {
        $this->zip('fotos', '2026-11-03 02:45');
        $this->anexo('a/'.FotoStorage::MINI_DIR.'/refeita.jpg', '2026-11-05 12:00:00');
        $this->anexo('a/.tmp-envio.jpg', '2026-11-05 12:00:00');

        $this->saude()->assertJsonPath('backups.fotos.estado', 'ok');
    }

    public function test_completo_mais_novo_que_o_zip_cobre_o_anexo(): void
    {
        $this->zip('fotos', '2026-10-30 02:45');
        $this->zip('petermann', '2026-11-01 03:30');
        $this->anexo('a/coberta.jpg', '2026-10-31 12:00:00');

        $this->saude()->assertJsonPath('backups.fotos.estado', 'ok');
    }

    public function test_sem_zip_de_fotos_e_sem_anexo_esta_ok(): void
    {
        $r = $this->saude();

        $r->assertJsonPath('backups.fotos.estado', 'ok');
        $r->assertJsonPath('backups.fotos.arquivo', null);
    }

    public function test_sem_zip_nenhum_com_anexo_e_atraso(): void
    {
        $this->anexo('a/sem-copia.jpg', '2026-10-01 12:00:00');

        $this->saude()->assertJsonPath('backups.fotos.estado', 'atrasado');
    }

    /* ── Drive ───────────────────────────────────────────────── */

    public function test_drive_traz_envio_de_cada_tipo_e_o_erro(): void
    {
        $this->driveConectado([
            'ultimo_envio' => '2026-11-01T03:40:00-03:00',
            'banco_ultimo_envio' => '2026-11-06T02:31:00-03:00',
            'fotos_ultimo_envio' => '2026-11-06T02:46:00-03:00',
            'fotos_ultimo_erro' => '06/11/2026 02:46 — cota estourada',
        ]);

        $r = $this->saude();

        $r->assertJsonPath('drive.conectado', true);
        $r->assertJsonPath('drive.ultimo_envio.banco', '2026-11-06T02:31:00-03:00');
        $r->assertJsonPath('drive.ultimo_envio.fotos', '2026-11-06T02:46:00-03:00');
        $r->assertJsonPath('drive.ultimo_envio.completo', '2026-11-01T03:40:00-03:00');
        $this->assertStringContainsString('cota estourada', $r->json('drive.ultimo_erro'));
        $this->assertContains('O envio ao Google Drive registrou erro.', $r->json('resumo.olhar'));
    }

    public function test_drive_desligado_entra_na_atencao(): void
    {
        $this->emDia();

        $r = $this->saude();

        $r->assertJsonPath('drive.conectado', false);
        $r->assertJsonPath('resumo.estado', 'atencao');
    }

    /* ── log ─────────────────────────────────────────────────── */

    public function test_conta_error_e_critical_sem_expor_o_texto(): void
    {
        $this->log('2026-11-06', [
            '[2026-11-06 14:00:00] production.ERROR: TEXTO-SIGILOSO-A {"exception":"x"}',
            '[stacktrace]',
            '#0 production.ERROR: isto é stack trace, não conta',
            '[2026-11-06 14:01:00] production.CRITICAL: TEXTO-SIGILOSO-B',
            '[2026-11-06 14:02:00] production.WARNING: aviso não conta',
            '[2026-11-06 14:03:00] production.INFO: backup ok',
        ]);

        $r = $this->saude();

        $r->assertJsonPath('erros_hoje.quantidade', 2);
        $this->assertStringNotContainsString('SIGILOSO', $r->getContent());
    }

    public function test_log_ausente_e_dia_sem_erro(): void
    {
        $r = $this->saude();

        $r->assertJsonPath('erros_hoje.disponivel', true);
        $r->assertJsonPath('erros_hoje.quantidade', 0);
    }

    public function test_depois_das_21h_de_brasilia_le_os_dois_arquivos_do_dia(): void
    {
        $this->travelTo(Carbon::parse('2026-11-07 01:30:00', 'UTC'));   // 22:30 do dia 6 em Brasília
        $this->log('2026-11-06', [
            '[2026-11-06 02:59:59] production.ERROR: ainda era dia 5 em Brasília',
            '[2026-11-06 03:00:00] production.ERROR: primeiro segundo do dia 6',
            '[2026-11-06 20:00:00] production.ERROR: tarde do dia 6',
        ]);
        $this->log('2026-11-07', ['[2026-11-07 01:00:00] production.CRITICAL: noite do dia 6']);

        $this->saude()->assertJsonPath('erros_hoje.quantidade', 3);
    }

    public function test_linha_gigante_nao_conta_o_que_esta_no_meio_dela(): void
    {
        /* o falso erro cai bem no começo do segundo pedaço lido, onde a falha apareceria */
        $this->log('2026-11-06', [
            str_repeat('x', 8191).'[2026-11-06 14:00:00] production.ERROR: no meio da linha',
            '[2026-11-06 14:01:00] production.ERROR: de verdade',
        ]);

        $this->saude()->assertJsonPath('erros_hoje.quantidade', 1);
    }

    /* ── migrações ───────────────────────────────────────────── */

    public function test_em_dia_nao_tem_migracao_pendente(): void
    {
        $this->saude()->assertJsonPath('migracoes.pendentes', []);
    }

    public function test_migracao_nao_aplicada_aparece(): void
    {
        $nome = DB::table('migrations')->orderByDesc('id')->value('migration');
        DB::table('migrations')->where('migration', $nome)->delete();

        $r = $this->saude();

        $r->assertJsonPath('migracoes.pendentes', [$nome]);
        $this->assertContains('1 migração pendente: use "Atualizar estrutura do banco".', $r->json('resumo.olhar'));
    }

    /* ── movimento ───────────────────────────────────────────── */

    private function nota(string $updatedUtc, string $createdUtc, bool $deleted = false): void
    {
        $id = (string) Str::uuid();
        $dono = $this->pessoa('colaborador');
        DB::table('notas')->insert([
            'id' => $id, 'user_id' => $dono->id, 'tipo' => 'RDA', 'subtipo' => 'Outros', 'valor' => 10,
            'data' => '2026-11-01', 'mes' => 11, 'ano' => 2026, 'deleted' => $deleted,
            'created_at' => $createdUtc, 'updated_at' => $updatedUtc,
        ]);
    }

    public function test_movimento_usa_o_relogio_do_servidor_em_brasilia(): void
    {
        $this->nota('2026-11-06 13:00:00', '2026-11-02 09:00:00');   // ficou 4 dias na fila do aparelho
        $this->nota('2026-11-05 15:00:00', '2026-11-05 15:00:00');   // 24 h exatas: ainda conta
        $this->nota('2026-11-05 14:59:59', '2026-11-05 14:59:59');
        $this->nota('2026-11-06 14:00:00', '2026-11-06 14:00:00', deleted: true);

        $r = $this->saude();

        $r->assertJsonPath('movimento.ultima_em', '2026-11-06T10:00:00-03:00');
        $r->assertJsonPath('movimento.ultimas_24h', 2);
    }

    public function test_sem_nota_nenhuma_nao_e_problema(): void
    {
        $this->emDia();
        $this->driveConectado();

        $r = $this->saude();

        $r->assertJsonPath('movimento.ultima_em', null);
        $r->assertJsonPath('movimento.ultimas_24h', 0);
        $r->assertJsonPath('resumo.estado', 'ok');
    }

    /* ── falha isolada ───────────────────────────────────────── */

    public function test_log_ilegivel_nao_derruba_o_resto(): void
    {
        $this->emDia();
        $this->driveConectado();
        mkdir($this->tmp.'/logs/laravel-2026-11-06.log');   // no lugar do arquivo, uma pasta

        $r = $this->saude();

        $r->assertJsonPath('erros_hoje', ['disponivel' => false]);
        $r->assertJsonPath('backups.banco.estado', 'ok');
        $r->assertJsonPath('movimento.disponivel', true);
        $r->assertJsonPath('resumo.estado', 'atencao');
        $r->assertJsonPath('resumo.olhar', ['Não consegui ler o log de hoje.']);
    }

    public function test_banco_sem_tabela_derruba_so_o_movimento(): void
    {
        $this->emDia();
        $this->driveConectado();
        Sanctum::actingAs($this->pessoa('gestor'));
        Schema::drop('notas');

        $r = $this->getJson('/api/admin/saude')->assertOk();

        $r->assertJsonPath('movimento', ['disponivel' => false]);
        $r->assertJsonPath('backups.banco.disponivel', true);
        $r->assertJsonPath('resumo.olhar', ['Não consegui ler o movimento de notas.']);
    }

    public function test_tabela_de_migracoes_sumida_nao_vira_em_dia(): void
    {
        Sanctum::actingAs($this->pessoa('gestor'));
        Schema::drop('migrations');

        $r = $this->getJson('/api/admin/saude')->assertOk();

        $r->assertJsonPath('migracoes', ['disponivel' => false]);
    }

    public function test_falha_nos_backups_e_no_drive_nao_vaza_a_mensagem(): void
    {
        $falha = new RuntimeException('/home/storage/app/segredo-da-falha');
        $this->mock(BackupCompleto::class)->shouldReceive('listar')->andThrow($falha);
        $this->mock(DriveBackup::class)->shouldReceive('status')->andThrow($falha);

        $r = $this->saude();

        $r->assertJsonPath('backups.banco', ['disponivel' => false]);
        $r->assertJsonPath('backups.fotos', ['disponivel' => false]);
        $r->assertJsonPath('backups.completo', ['disponivel' => false]);
        $r->assertJsonPath('drive', ['disponivel' => false]);
        $r->assertJsonPath('erros_hoje.disponivel', true);
        $this->assertStringNotContainsString('segredo-da-falha', $r->getContent());
    }

    /* ── segredos ────────────────────────────────────────────── */

    public function test_nenhum_segredo_nem_caminho_no_json(): void
    {
        $this->emDia();
        $token = 'ya29.a0AfB_byC1234567890abcdefghijklmnopqrstuv';
        $this->driveConectado([
            'refresh_token' => '1//0gRefreshSecretoDoGoogle',
            'email' => 'dono-do-drive@gmail.com',
            'pasta_id' => '1AbCdEfPastaIdSecreta',
            'ultimo_erro' => '06/11/2026 03:40 — Arquivo de backup não existe: /home/usuario/api-petermann/storage/app/backups/petermann-2026-11-01-0330.zip',
            'banco_ultimo_erro' => '06/11/2026 02:31 — Falhou em https://www.googleapis.com/upload/drive/v3/files?upload_id=ABCsegredoDaSessao com '.$token,
            'fotos_ultimo_erro' => '06/11/2026 02:46 — Não abriu '.$this->tmp.'/app/backups/fotos.zip nem C:\\Users\\user\\app\\fotos.zip',
        ]);

        $r = $this->saude();

        $corpo = $r->getContent();
        $legivel = json_decode($corpo, true, flags: JSON_THROW_ON_ERROR);
        $tudo = json_encode($legivel, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        foreach ([
            'RefreshSecreto', 'dono-do-drive', 'PastaIdSecreta', '/home/', 'api-petermann', 'upload_id', 'ABCsegredo',
            $token, 'googleapis', $this->tmp, str_replace('\\', '/', $this->tmp), 'C:\\', 'Users', base_path(), 'APP_KEY',
        ] as $proibido) {
            $this->assertStringNotContainsString($proibido, $tudo);
        }
        $this->assertStringContainsString('Arquivo de backup não existe', $r->json('drive.ultimo_erro'));
    }
}
