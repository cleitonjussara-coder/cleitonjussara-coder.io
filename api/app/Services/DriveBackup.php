<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * Cópia do backup semanal para o Google Drive (21/09/2026).
 *
 * Backup que mora só na Locaweb não protege contra a Locaweb: se o disco
 * some, somem as cópias junto. Depois que `backup:gerar` fecha o zip, este
 * serviço sobe o arquivo para a pasta "Backups Petermann App" no Drive do
 * admin e aplica lá a mesma rotação (BackupCompleto::paraApagar).
 *
 * Autorização: o admin conecta UMA vez pelo Perfil (Google pede permissão
 * `drive.file` — só arquivos que este app criar, nada mais do Drive dele).
 * O refresh_token fica em storage/app/drive-backup.json, fora do web root.
 * Sem esse arquivo, o backup semanal segue normal, só não sobe.
 */
class DriveBackup
{
    public const ARQUIVO = 'drive-backup.json';

    public const PASTA = 'Backups Petermann App';

    public const SCOPE = 'https://www.googleapis.com/auth/drive.file';

    private const TOKEN_URL = 'https://oauth2.googleapis.com/token';

    private const API = 'https://www.googleapis.com/drive/v3';

    private const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

    public function conectado(): bool
    {
        return ! empty($this->dados()['refresh_token']);
    }

    /** O que o Perfil mostra: conta, quando conectou, último envio. Nada de token. */
    public function status(): array
    {
        $d = $this->dados();

        return [
            'conectado' => ! empty($d['refresh_token']),
            'email' => $d['email'] ?? null,
            'conectado_em' => $d['conectado_em'] ?? null,
            'ultimo_envio' => $d['ultimo_envio'] ?? null,
            'ultimo_arquivo' => $d['ultimo_arquivo'] ?? null,
            'ultimo_erro' => $d['ultimo_erro'] ?? null,
            'pasta' => self::PASTA,
        ];
    }

    /** Guarda o refresh_token vindo do callback do Google. */
    public function conectar(string $refreshToken, string $email): void
    {
        $this->salvar([
            'refresh_token' => $refreshToken,
            'email' => $email,
            'conectado_em' => now(PontoCalculo::TZ)->toIso8601String(),
            'pasta_id' => null,
        ]);
    }

    public function desconectar(): void
    {
        $d = $this->dados();
        if (! empty($d['refresh_token'])) {
            try {
                Http::asForm()->timeout(10)->post('https://oauth2.googleapis.com/revoke', ['token' => $d['refresh_token']]);
            } catch (\Throwable) {
            }
        }
        @unlink($this->caminho());
    }

    /**
     * Sobe o zip para a pasta e poda os antigos lá. Devolve
     * ['id' => …, 'nome' => …, 'apagados' => n]. Lança RuntimeException se
     * falhar (o chamador decide se avisa por e-mail).
     */
    public function enviar(string $arquivo, int $manter = 12, int $meses = 12): array
    {
        if (! is_file($arquivo)) {
            throw new RuntimeException('Arquivo de backup não existe: '.$arquivo);
        }
        try {
            $tok = $this->accessToken();
            $pasta = $this->pastaId($tok);
            $nome = basename($arquivo);

            /* já existe no Drive (reenvio manual)? substitui em vez de duplicar */
            foreach ($this->listar($tok, $pasta) as $f) {
                if ($f['nome'] === $nome) {
                    Http::withToken($tok)->timeout(20)->delete(self::API.'/files/'.$f['id']);
                }
            }

            $tam = filesize($arquivo);
            $inicio = Http::withToken($tok)->timeout(30)
                ->withHeaders(['X-Upload-Content-Type' => 'application/zip', 'X-Upload-Content-Length' => (string) $tam])
                ->post(self::UPLOAD.'?uploadType=resumable', ['name' => $nome, 'parents' => [$pasta], 'mimeType' => 'application/zip']);
            $local = $inicio->header('Location');
            if (! $inicio->successful() || ! $local) {
                throw new RuntimeException('Drive não abriu o upload: '.($inicio->json('error.message') ?: $inicio->status()));
            }
            @ini_set('memory_limit', '512M');
            $envio = Http::withToken($tok)->timeout(900)
                ->withBody(file_get_contents($arquivo), 'application/zip')
                ->put($local);
            if (! $envio->successful() || ! $envio->json('id')) {
                throw new RuntimeException('Drive não recebeu o arquivo: '.($envio->json('error.message') ?: $envio->status()));
            }

            $apagados = 0;
            foreach (BackupCompleto::paraApagar($this->listar($tok, $pasta), $manter, $meses) as $f) {
                if (Http::withToken($tok)->timeout(20)->delete(self::API.'/files/'.$f['id'])->successful()) {
                    $apagados++;
                }
            }

            $this->salvar(['ultimo_envio' => now(PontoCalculo::TZ)->toIso8601String(), 'ultimo_arquivo' => $nome, 'ultimo_erro' => null] + $this->dados());

            return ['id' => $envio->json('id'), 'nome' => $nome, 'apagados' => $apagados];
        } catch (\Throwable $e) {
            $this->salvar(['ultimo_erro' => now(PontoCalculo::TZ)->format('d/m/Y H:i').' — '.mb_substr($e->getMessage(), 0, 200)] + $this->dados());
            throw $e instanceof RuntimeException ? $e : new RuntimeException($e->getMessage(), 0, $e);
        }
    }

    /** Arquivos petermann-*.zip na pasta do Drive, mais novo primeiro. */
    public function listarNoDrive(): array
    {
        $tok = $this->accessToken();

        return $this->listar($tok, $this->pastaId($tok));
    }

    /* ── Google ─────────────────────────────────────────────── */

    private function accessToken(): string
    {
        $d = $this->dados();
        if (empty($d['refresh_token'])) {
            throw new RuntimeException('Drive não conectado — Perfil → Backup → Conectar Google Drive');
        }
        $r = Http::asForm()->timeout(15)->post(self::TOKEN_URL, [
            'client_id' => config('petermann.google.client_id'),
            'client_secret' => config('petermann.google.client_secret'),
            'refresh_token' => $d['refresh_token'],
            'grant_type' => 'refresh_token',
        ]);
        if (! $r->ok() || ! $r->json('access_token')) {
            $erro = $r->json('error') ?: (string) $r->status();
            if ($erro === 'invalid_grant') {
                $erro .= ' (a autorização foi revogada ou expirou — conecte de novo pelo Perfil)';
            }
            throw new RuntimeException('Google não renovou o acesso: '.$erro);
        }

        return $r->json('access_token');
    }

    private function pastaId(string $tok): string
    {
        $d = $this->dados();
        if (! empty($d['pasta_id'])) {
            $chk = Http::withToken($tok)->timeout(15)->get(self::API.'/files/'.$d['pasta_id'], ['fields' => 'id,trashed']);
            if ($chk->ok() && ! $chk->json('trashed')) {
                return $d['pasta_id'];
            }
        }
        $q = sprintf("name = '%s' and mimeType = 'application/vnd.google-apps.folder' and trashed = false", addslashes(self::PASTA));
        $r = Http::withToken($tok)->timeout(15)->get(self::API.'/files', ['q' => $q, 'fields' => 'files(id)', 'pageSize' => 1]);
        $id = $r->json('files.0.id');
        if (! $id) {
            $c = Http::withToken($tok)->timeout(15)->post(self::API.'/files', ['name' => self::PASTA, 'mimeType' => 'application/vnd.google-apps.folder']);
            $id = $c->json('id');
            if (! $id) {
                throw new RuntimeException('Não consegui criar a pasta no Drive: '.($c->json('error.message') ?: $c->status()));
            }
        }
        $this->salvar(['pasta_id' => $id] + $this->dados());

        return $id;
    }

    private function listar(string $tok, string $pasta): array
    {
        $q = sprintf("'%s' in parents and trashed = false and name contains 'petermann-'", $pasta);
        $r = Http::withToken($tok)->timeout(20)->get(self::API.'/files', ['q' => $q, 'fields' => 'files(id,name,size,createdTime)', 'pageSize' => 200]);
        if (! $r->ok()) {
            throw new RuntimeException('Drive não listou a pasta: '.($r->json('error.message') ?: $r->status()));
        }
        $out = array_map(fn ($f) => ['id' => $f['id'], 'nome' => $f['name'], 'bytes' => (int) ($f['size'] ?? 0), 'em' => $f['createdTime'] ?? null], $r->json('files') ?? []);
        usort($out, fn ($a, $b) => strcmp($b['nome'], $a['nome']));

        return $out;
    }

    /* ── arquivo local ──────────────────────────────────────── */

    private function caminho(): string
    {
        return storage_path('app/'.self::ARQUIVO);
    }

    private function dados(): array
    {
        $f = $this->caminho();
        if (! is_file($f)) {
            return [];
        }
        $d = json_decode((string) file_get_contents($f), true);

        return is_array($d) ? $d : [];
    }

    private function salvar(array $d): void
    {
        file_put_contents($this->caminho(), json_encode($d, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
        @chmod($this->caminho(), 0600);
    }
}
