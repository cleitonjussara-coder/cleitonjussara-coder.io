<?php

namespace App\Services;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Chamada única à API de mensagens da Anthropic com UMA imagem e um pedido de
 * texto (10/10/2026). Base do leitor de odômetro e do leitor de notas.
 *
 * Usa o cliente HTTP do Laravel em vez do SDK PHP de propósito: a hospedagem
 * está sem shell remoto e o SDK exigiria subir vendor/ inteiro. A chave vem só
 * do .env (config petermann.anthropic.key). Best-effort: qualquer falha (sem
 * chave, rede, saldo, recusa) devolve null — quem chama segue sem a IA.
 *
 * Disjuntor: se a Anthropic recusa o acesso (chave inválida, sem saldo) ou cai
 * (5xx, 429, timeout), `disponivel()` passa a dizer não por alguns minutos — o
 * app cai direto no Tesseract, sem segurar um worker PHP nem gastar a cota
 * diária. Recusa de acesso também manda e-mail ao dono (no máximo 1 por hora).
 */
class VisaoIa
{
    private const URL = 'https://api.anthropic.com/v1/messages';

    private const DISJUNTOR = 'visao-ia-fora';

    /**
     * Por que a ÚLTIMA chamada não devolveu texto (14/10/2026): 'indisponivel', 'http_<status>', 'erro',
     * 'recusou' (o modelo recusou), 'max_tokens' (o raciocínio gastou o limite e não sobrou resposta) ou
     * 'sem_texto' (a API respondeu sem nenhum bloco de texto). Null quando houve texto. Quem chama usa
     * isto para decidir se vale tentar de novo: só 'max_tokens' e 'sem_texto' são passageiros.
     */
    public ?string $ultimoMotivo = null;

    public function disponivel(): bool
    {
        return (string) config('petermann.anthropic.key') !== '' && ! Cache::has(self::DISJUNTOR);
    }

    /**
     * @param  string  $origem  rótulo do chamador para o log (ex.: "odometro", "nota")
     * @return string|null texto da resposta do modelo
     */
    public function perguntar(string $origem, string $modelo, string $bytes, string $mime, string $pedido, int $maxTokens = 1024, string $effort = 'low', int $timeout = 20): ?string
    {
        $this->ultimoMotivo = null;
        if (! $this->disponivel() || $bytes === '') {
            $this->ultimoMotivo = 'indisponivel';

            return null;
        }
        if (! in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true)) {
            $mime = 'image/jpeg';
        }

        try {
            $req = Http::withHeaders([
                'x-api-key' => (string) config('petermann.anthropic.key'),
                'anthropic-version' => '2023-06-01',
            ])->acceptJson()->timeout($timeout)->connectTimeout(6);
            if ($ca = config('petermann.ca_bundle')) {
                $req = $req->withOptions(['verify' => $ca]);
            }

            $res = $req->post(self::URL, [
                'model' => $modelo,
                'max_tokens' => $maxTokens,                 // folga: o raciocínio do modelo também conta
                'output_config' => ['effort' => $effort],
                'messages' => [[
                    'role' => 'user',
                    'content' => [
                        ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => $mime, 'data' => base64_encode($bytes)]],
                        ['type' => 'text', 'text' => $pedido],
                    ],
                ]],
            ]);

            if (! $res->successful()) {
                $st = $res->status();
                $this->ultimoMotivo = 'http_'.$st;
                Log::warning("VisaoIa[$origem]: API respondeu $st", ['corpo' => mb_substr($res->body(), 0, 300)]);
                if (in_array($st, [401, 402, 403], true) || ($st === 400 && stripos($res->body(), 'credit balance') !== false)) {
                    app(AlertaErro::class)->avisar(
                        "IA de leitura (notas/odômetro) sem acesso (HTTP $st)",
                        "A Anthropic recusou a chamada ($origem). Confira a chave e o saldo no console da Anthropic. Enquanto isso o app lê pelo Tesseract do aparelho.",
                        'visao-ia-acesso',
                    );
                    Cache::put(self::DISJUNTOR, 1, now()->addMinutes(5));   // curto: ao recarregar o saldo, a IA volta em poucos minutos
                } elseif ($st >= 500 || $st === 429) {
                    Cache::put(self::DISJUNTOR, 1, now()->addMinutes(5));
                }

                return null;
            }
            $stop = (string) ($res->json('stop_reason') ?? '');
            if ($stop === 'refusal') {
                $this->ultimoMotivo = 'recusou';
                Log::warning("VisaoIa[$origem]: o modelo recusou a imagem (stop_reason=refusal)");

                return null;
            }
            $tipos = [];
            foreach ($res->json('content') ?? [] as $b) {
                $tipos[] = (string) ($b['type'] ?? '?');
                if (($b['type'] ?? '') === 'text' && trim((string) ($b['text'] ?? '')) !== '') {
                    return (string) $b['text'];
                }
            }

            /* 200 OK sem texto aproveitável — antes isto sumia sem rastro (caso de 12/10/2026). Agora o log diz
               por quê: com max_tokens o raciocínio do modelo gastou o limite inteiro. */
            $this->ultimoMotivo = $stop === 'max_tokens' ? 'max_tokens' : 'sem_texto';
            Log::warning("VisaoIa[$origem]: resposta sem texto ({$this->ultimoMotivo})", [
                'stop_reason' => $stop,
                'blocos' => $tipos,
                'max_tokens' => $maxTokens,
                'saida_tokens' => $res->json('usage.output_tokens'),
            ]);

            return null;
        } catch (Throwable $e) {
            $this->ultimoMotivo = 'erro';
            Log::warning("VisaoIa[$origem]: ".$e->getMessage());
            Cache::put(self::DISJUNTOR, 1, now()->addMinutes(5));

            return null;
        }
    }
}
