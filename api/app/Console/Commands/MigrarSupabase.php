<?php

namespace App\Console\Commands;

use App\Models\CnpjCache;
use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use App\Models\RepasseEmail;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Throwable;

/**
 * Copia TUDO do Supabase para cá: perfis + senhas, notas, repasses, cache de
 * CNPJ, registro de e-mails e os anexos do Storage para o disco.
 *
 * Idempotente: pode rodar quantas vezes precisar (upsert pelo id; foto que
 * já está no disco não baixa de novo). Nunca escreve no Supabase.
 *
 * Precisa no .env:
 *   SUPABASE_DB_URL      postgres://postgres:SENHA@db.<ref>.supabase.co:5432/postgres
 *   SUPABASE_URL         https://<ref>.supabase.co
 *   SUPABASE_SERVICE_KEY chave service_role (Project Settings > API)
 *
 * Uso:
 *   php artisan migrar:supabase            tudo
 *   php artisan migrar:supabase --sem-fotos   só o banco
 *   php artisan migrar:supabase --so-fotos    só os anexos
 */
class MigrarSupabase extends Command
{
    protected $signature = 'migrar:supabase
        {--sem-fotos : Não baixa os anexos do Storage}
        {--so-fotos : Só baixa os anexos (banco já migrado)}';

    protected $description = 'Migra dados e anexos do Supabase para o MySQL + disco desta hospedagem';

    private const BUCKET = 'notas-fotos';

    public function handle(): int
    {
        if (! env('SUPABASE_DB_URL')) {
            $this->error('SUPABASE_DB_URL não está no .env');

            return self::FAILURE;
        }

        if (! $this->option('so-fotos')) {
            $this->colaboradores();
            $this->notas();
            $this->repasses();
            $this->cnpj();
            $this->emails();
        }
        if (! $this->option('sem-fotos')) {
            $this->fotos();
        }

        $this->newLine();
        $this->info('Migração concluída.');

        return self::SUCCESS;
    }

    /* ── perfis + senhas ─────────────────────────────────────── */
    private function colaboradores(): void
    {
        $this->info('Colaboradores…');
        /* Senha: bcrypt $2a$ do GoTrue — o password_verify do PHP aceita
           igual, então a pessoa entra com a mesma senha. Google: o `sub` fica
           em auth.identities (provider_id). */
        $rows = DB::connection('supabase')->select(<<<'SQL'
            select c.id, c.nome, c.email, c.role, c.nucleo, c.created_at, c.updated_at,
                   u.encrypted_password, u.email_confirmed_at,
                   (select i.provider_id from auth.identities i
                     where i.user_id = u.id and i.provider = 'google' limit 1) as google_id
              from public.colaboradores c
              left join auth.users u on u.id = c.id
        SQL);

        $n = 0;
        foreach ($rows as $r) {
            /* GoTrue grava bcrypt com prefixo $2a$; o PHP só reconhece $2y$ como
               bcrypt (password_get_info) e o Hash::check do Laravel recusa. É o
               MESMO algoritmo — só a etiqueta muda, a senha continua valendo. */
            $senha = $r->encrypted_password;
            if ($senha !== null && str_starts_with($senha, '$2a$')) {
                $senha = '$2y$'.substr($senha, 4);
            }
            if ($senha !== null && ! str_starts_with($senha, '$2y$')) {
                $senha = null;               // hash de outro formato: força "esqueci a senha"
            }
            Colaborador::query()->upsert([[
                'id' => $r->id,
                'nome' => $r->nome ?? '',
                'email' => strtolower($r->email ?: ''),
                'password' => $senha,
                'role' => in_array($r->role, Colaborador::ROLES, true) ? $r->role : 'colaborador',
                'nucleo' => $r->nucleo ?: 'Cristalina',
                'google_id' => $r->google_id,
                'email_verified_at' => $r->email_confirmed_at,
                'created_at' => $r->created_at,
                'updated_at' => $r->updated_at,
            ]], ['id'], ['nome', 'email', 'password', 'role', 'nucleo', 'google_id', 'email_verified_at', 'updated_at']);
            $n++;
        }
        $this->line("  {$n} perfis");
    }

    /* ── notas ───────────────────────────────────────────────── */
    private function notas(): void
    {
        $this->info('Notas…');
        $n = 0;
        DB::connection('supabase')->table('public.notas')->orderBy('created_at')
            ->chunk(500, function ($rows) use (&$n) {
                $lote = [];
                foreach ($rows as $r) {
                    $lote[] = [
                        'id' => $r->id,
                        'user_id' => $r->user_id,
                        'created_by' => $r->created_by,
                        'updated_by' => $r->updated_by,
                        'tipo' => $r->tipo,
                        'subtipo' => $r->subtipo,
                        'cnpj' => $r->cnpj ? preg_replace('/\D/', '', $r->cnpj) ?: null : null,
                        'razao_social' => $r->razao_social,
                        'valor' => $r->valor,
                        'data' => $r->data,
                        'mes' => $r->mes,
                        'ano' => $r->ano,
                        'metodo_captura' => $r->metodo_captura ?: 'manual',
                        'chave_nfce' => $r->chave_nfce ? preg_replace('/\D/', '', $r->chave_nfce) ?: null : null,
                        'uf' => $r->uf,
                        'modelo' => $r->modelo,
                        'foto_path' => $r->foto_path,
                        'qr_url' => $r->qr_url ?? null,
                        'observacao' => $r->observacao,
                        'deleted' => (bool) $r->deleted,
                        'created_at' => $r->created_at,
                        'updated_at' => $r->updated_at,
                    ];
                }
                Nota::query()->upsert($lote, ['id']);
                $n += count($lote);
            });
        $this->line("  {$n} notas");
    }

    /* ── repasses ────────────────────────────────────────────── */
    private function repasses(): void
    {
        $this->info('Repasses…');
        $n = 0;
        DB::connection('supabase')->table('public.repasses')->orderBy('created_at')
            ->chunk(500, function ($rows) use (&$n) {
                $lote = [];
                foreach ($rows as $r) {
                    $lote[] = [
                        'id' => $r->id,
                        'user_id' => $r->user_id,
                        'tipo' => $r->tipo,
                        'valor' => $r->valor,
                        'data' => $r->data,
                        'mes' => $r->mes,
                        'ano' => $r->ano,
                        'descricao' => $r->descricao,
                        'kind' => $r->kind ?: 'received',
                        'email_sent' => (bool) ($r->email_sent ?? false),
                        'deleted' => (bool) $r->deleted,
                        'created_at' => $r->created_at,
                        'updated_at' => $r->updated_at,
                    ];
                }
                Repasse::query()->upsert($lote, ['id']);
                $n += count($lote);
            });
        $this->line("  {$n} repasses");
    }

    private function cnpj(): void
    {
        $this->info('Cache de CNPJ…');
        $rows = DB::connection('supabase')->table('public.cnpj_cache')->get();
        foreach ($rows->chunk(500) as $chunk) {
            CnpjCache::query()->upsert($chunk->map(fn ($r) => [
                'cnpj' => $r->cnpj,
                'razao_social' => $r->razao_social,
                'nome_fantasia' => $r->nome_fantasia,
                'consultado_em' => $r->consultado_em,
            ])->all(), ['cnpj']);
        }
        $this->line("  {$rows->count()} CNPJs");
    }

    private function emails(): void
    {
        $this->info('Registro de e-mails de repasse…');
        try {
            $rows = DB::connection('supabase')->table('public.repasse_emails')->get();
        } catch (Throwable) {
            $this->line('  (tabela não existe lá — pulando)');

            return;
        }
        $n = 0;
        foreach ($rows as $r) {
            if (! Repasse::whereKey($r->repasse_id)->exists()) {
                continue;
            }
            RepasseEmail::query()->upsert([[
                'id' => $r->id,
                'repasse_id' => $r->repasse_id,
                'provider_id' => $r->request_id ? 'pg_net:'.$r->request_id : null,
                'erro' => $r->erro ?? null,
                'created_at' => $r->created_at,
            ]], ['id']);
            $n++;
        }
        $this->line("  {$n} registros");
    }

    /* ── anexos: Storage → disco ─────────────────────────────── */
    private function fotos(): void
    {
        $base = rtrim((string) env('SUPABASE_URL'), '/');
        $key = (string) env('SUPABASE_SERVICE_KEY');
        if (! $base || ! $key) {
            $this->warn('SUPABASE_URL / SUPABASE_SERVICE_KEY ausentes — anexos não baixados.');

            return;
        }

        $this->info('Anexos (Storage → disco)…');
        $disk = Storage::disk('fotos');
        $paths = Nota::query()->whereNotNull('foto_path')->where('foto_path', '<>', '')
            ->orderBy('user_id')->pluck('foto_path');

        $ok = $ja = $falha = 0;
        $erros = [];
        $bar = $this->output->createProgressBar($paths->count());
        foreach ($paths as $p) {
            $bar->advance();
            if ($disk->exists($p)) {
                $ja++;

                continue;
            }
            $r = null;
            foreach ([1, 2] as $tentativa) {
                try {
                    $r = Http::withHeaders(['Authorization' => "Bearer {$key}", 'apikey' => $key])
                        ->timeout(60)->get("{$base}/storage/v1/object/".self::BUCKET.'/'.$p);
                    if ($r->ok()) {
                        break;
                    }
                } catch (Throwable $e) {
                    $r = null;
                }
                if ($tentativa === 1) {
                    usleep(1_500_000);
                }
            }
            if (! $r || ! $r->ok()) {
                $falha++;
                $erros[] = $p.' → '.($r ? 'HTTP '.$r->status() : 'sem resposta');

                continue;
            }
            $disk->put($p, $r->body());
            $ok++;
        }
        $bar->finish();
        $this->newLine();
        $this->line("  {$ok} baixados, {$ja} já estavam no disco, {$falha} falharam");
        foreach (array_slice($erros, 0, 30) as $e) {
            $this->line('    '.$e);
        }
        if ($falha) {
            $this->warn('  Rode de novo com --so-fotos para tentar as que faltaram.');
        }
    }
}
