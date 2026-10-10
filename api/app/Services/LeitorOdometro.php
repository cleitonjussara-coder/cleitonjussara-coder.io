<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Lê o odômetro de uma foto de painel com um modelo de visão da Anthropic
 * (09/10/2026). É a SEGUNDA tentativa do app: o leitor do próprio aparelho
 * (Tesseract) vai primeiro, e só quando ele falha ou lê um número
 * implausível o app manda o recorte do número para cá.
 *
 * Chama a API por HTTP (cliente do Laravel) em vez do SDK PHP de propósito:
 * a hospedagem está sem shell remoto e o SDK exigiria subir vendor/ inteiro.
 *
 * Best-effort: qualquer falha (sem chave, rede, recusa, resposta fora do
 * formato) devolve null e o app segue com a digitação. O resultado é sempre
 * uma SUGESTÃO — quem chama não grava nada com ele.
 */
class LeitorOdometro
{
    private const URL = 'https://api.anthropic.com/v1/messages';

    private const PROMPT = 'Esta é a foto do painel de instrumentos de um veículo. Leia o ODÔMETRO TOTAL '
        .'(a quilometragem acumulada do carro, normalmente com 4 a 7 dígitos). IGNORE o hodômetro parcial '
        .'(TRIP, A, B), autonomia, velocidade, hora, temperatura e nível de combustível. '
        .'Responda SOMENTE com JSON no formato {"odometro": <número inteiro em km>} ou {"odometro": null} '
        .'se não der para ler o odômetro total com segurança. Não invente dígitos.';

    public function disponivel(): bool
    {
        return (string) config('petermann.anthropic.key') !== '';
    }

    /**
     * @param  string  $bytes  conteúdo da imagem (JPEG/PNG/WebP)
     * @return int|null odômetro em km, ou null se não leu
     */
    public function ler(string $bytes, string $mime = 'image/jpeg'): ?int
    {
        if (! $this->disponivel() || $bytes === '') {
            return null;
        }
        if (! in_array($mime, ['image/jpeg', 'image/png', 'image/webp'], true)) {
            $mime = 'image/jpeg';
        }

        try {
            $req = Http::withHeaders([
                'x-api-key' => (string) config('petermann.anthropic.key'),
                'anthropic-version' => '2023-06-01',
            ])->acceptJson()->timeout(20)->connectTimeout(6);
            if ($ca = config('petermann.ca_bundle')) {
                $req = $req->withOptions(['verify' => $ca]);
            }

            $res = $req->post(self::URL, [
                'model' => config('petermann.anthropic.modelo_odometro'),
                'max_tokens' => 1024,                      // folga: o raciocínio do modelo também conta
                'output_config' => ['effort' => 'low'],
                'messages' => [[
                    'role' => 'user',
                    'content' => [
                        ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => $mime, 'data' => base64_encode($bytes)]],
                        ['type' => 'text', 'text' => self::PROMPT],
                    ],
                ]],
            ]);

            if (! $res->successful()) {
                Log::warning('LeitorOdometro: API respondeu '.$res->status(), ['corpo' => mb_substr($res->body(), 0, 300)]);

                return null;
            }
            if (($res->json('stop_reason') ?? '') === 'refusal') {
                return null;
            }

            return $this->extrair($res->json('content') ?? []);
        } catch (Throwable $e) {
            Log::warning('LeitorOdometro: '.$e->getMessage());

            return null;
        }
    }

    /** Pega o JSON do primeiro bloco de texto e valida o número. */
    public function extrair(array $content): ?int
    {
        foreach ($content as $b) {
            if (($b['type'] ?? '') !== 'text') {
                continue;
            }
            if (! preg_match('/\{[^{}]*\}/', (string) ($b['text'] ?? ''), $m)) {
                continue;
            }
            $j = json_decode($m[0], true);
            $v = is_array($j) ? ($j['odometro'] ?? null) : null;
            if (is_string($v) && preg_match('/^\d{3,7}$/', $v)) {
                $v = (int) $v;
            }
            if (is_int($v) && $v >= 0 && $v <= 9999999) {
                return $v;
            }

            return null;
        }

        return null;
    }
}
