<?php

namespace App\Services;

/**
 * Lê o odômetro de uma foto de painel com um modelo de visão da Anthropic
 * (09/10/2026). No app é a PRIMEIRA tentativa (com internet); o leitor do
 * aparelho (Tesseract) fica de reserva.
 *
 * Best-effort: qualquer falha (sem chave, rede, recusa, resposta fora do
 * formato) devolve null e o app segue com a digitação. O resultado é sempre
 * uma SUGESTÃO — quem chama não grava nada com ele.
 */
class LeitorOdometro
{
    private const PROMPT = 'Esta é a foto do painel de instrumentos de um veículo. Leia o ODÔMETRO TOTAL '
        .'(a quilometragem acumulada do carro, normalmente com 4 a 7 dígitos). IGNORE o hodômetro parcial '
        .'(TRIP, A, B), autonomia, velocidade, hora, temperatura e nível de combustível. '
        .'Responda SOMENTE com JSON no formato {"odometro": <número inteiro em km>} ou {"odometro": null} '
        .'se não der para ler o odômetro total com segurança. Não invente dígitos.';

    public function __construct(private VisaoIa $ia) {}

    public function disponivel(): bool
    {
        return $this->ia->disponivel();
    }

    /**
     * @param  string  $bytes  conteúdo da imagem (JPEG/PNG/WebP)
     * @return int|null odômetro em km, ou null se não leu
     */
    public function ler(string $bytes, string $mime = 'image/jpeg'): ?int
    {
        $texto = $this->ia->perguntar('odometro', (string) config('petermann.anthropic.modelo_odometro'), $bytes, $mime, self::PROMPT);

        return $texto === null ? null : $this->extrair([['type' => 'text', 'text' => $texto]]);
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
