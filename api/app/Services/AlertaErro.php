<?php

namespace App\Services;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;
use Resend\Laravel\Facades\Resend;
use Throwable;

/**
 * Aviso de erro por e-mail (20/09/2026). Antes, uma exceção na API só ia
 * para storage/logs — que ninguém abre numa hospedagem sem terminal.
 *
 * Regras:
 *   • só o que o Laravel considera "reportável" chega aqui (404, 403, 422,
 *     401 e throttle ficam de fora — ver bootstrap/app.php);
 *   • 1 e-mail por erro (classe + mensagem + arquivo:linha) a cada hora,
 *     e no máximo ALERTA_MAX_DIA por dia — nunca vira enxurrada;
 *   • falha ao mandar o aviso nunca derruba a requisição: registra no log e
 *     segue.
 * Destinatário: ALERTA_EMAIL_TO (cai no e-mail do repasse se não houver).
 */
class AlertaErro
{
    public const TZ = 'America/Sao_Paulo';

    /** Exceção não tratada (chamado pelo handler global). */
    public function excecao(Throwable $e): void
    {
        $arquivo = str_replace(base_path().DIRECTORY_SEPARATOR, '', $e->getFile()).':'.$e->getLine();
        $chave = md5(get_class($e).'|'.mb_substr($e->getMessage(), 0, 120).'|'.$arquivo);
        $titulo = class_basename($e).': '.mb_substr($e->getMessage() ?: '(sem mensagem)', 0, 90);

        $linhas = [
            'Erro: '.get_class($e),
            'Mensagem: '.($e->getMessage() ?: '(sem mensagem)'),
            'Onde: '.$arquivo,
        ];
        $req = app()->bound('request') ? app('request') : null;
        if ($req instanceof Request && $req->path() !== '/') {
            $linhas[] = 'Requisição: '.$req->method().' '.$req->fullUrl();
            $u = null;
            try {
                $u = $req->user();
            } catch (Throwable) {
            }
            if ($u) {
                $linhas[] = 'Usuário: '.($u->email ?? $u->id);
            }
            $linhas[] = 'IP: '.$req->ip().' · '.mb_substr((string) $req->userAgent(), 0, 100);
        } else {
            $linhas[] = 'Origem: linha de comando (artisan / crontab)';
        }
        $linhas[] = '';
        $linhas[] = 'Pilha (início):';
        foreach (array_slice(explode("\n", $e->getTraceAsString()), 0, 12) as $l) {
            $linhas[] = '  '.str_replace(base_path().DIRECTORY_SEPARATOR, '', $l);
        }

        $this->avisar($titulo, implode("\n", $linhas), $chave);
    }

    /**
     * Aviso avulso (ex.: backup falhou). $chave agrupa repetições; sem ela,
     * usa o título.
     */
    public function avisar(string $titulo, string $detalhe, ?string $chave = null): bool
    {
        $chave = $chave ?: md5($titulo);
        try {
            if (! Cache::add('alerta:'.$chave, 1, now()->addSeconds((int) config('petermann.alerta.intervalo', 3600)))) {
                return false;   // mesmo erro na última hora: já avisou
            }
            $hoje = 'alerta:dia:'.now(self::TZ)->format('Y-m-d');
            Cache::add($hoje, 0, now()->addDay());
            if (Cache::increment($hoje) > (int) config('petermann.alerta.max_dia', 20)) {
                Log::warning('alerta: limite diário de e-mails atingido; '.$titulo);

                return false;
            }
        } catch (Throwable $e) {
            Log::warning('alerta: cache indisponível ('.$e->getMessage().'); avisando mesmo assim');
        }

        /* ALERTA_EMAIL_TO aceita vários endereços separados por vírgula */
        $para = array_values(array_filter(array_map('trim', explode(',', (string) config('petermann.alerta.to')))));
        if (! $para || ! config('resend.api_key')) {
            Log::error('alerta sem destino/RESEND_API_KEY: '.$titulo."\n".$detalhe);

            return false;
        }

        $quando = now(self::TZ)->format('d/m/Y H:i:s');
        $texto = "Petermann App — aviso automático do servidor\n"
            ."Quando: {$quando}\n"
            .'Ambiente: '.config('app.env').' · '.gethostname()."\n\n"
            .$detalhe."\n\n"
            ."— Este e-mail sai no máximo 1x por hora para o mesmo erro e "
            .config('petermann.alerta.max_dia', 20)." x por dia no total.\n"
            ."Log completo: api-petermann/storage/logs/laravel.log";

        try {
            Resend::emails()->send([
                'from' => config('petermann.repasse.from'),
                'to' => $para,
                'subject' => '[Petermann App] ⚠️ '.$titulo,
                'text' => $texto,
            ]);

            return true;
        } catch (Throwable $e) {
            Log::error('alerta: não consegui enviar o e-mail ('.$e->getMessage().'): '.$titulo);

            return false;
        }
    }
}
