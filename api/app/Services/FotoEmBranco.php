<?php

namespace App\Services;

/**
 * Foto SEM DADOS de nota (21/10/2026): o colaborador anexou uma foto de papel liso e o app deixou lançar.
 *
 * Mede quanto "conteúdo" a imagem tem, sem tentar ler nada — leitura por IA/OCR que volta vazia não prova que a
 * foto está em branco (a IA já devolve vazio por falha técnica, e o Tesseract falha em cupom amassado). A medida:
 * a foto vai a 640 px em tons de cinza e cada pixel é comparado com a MÉDIA da vizinhança (janela 25×25). "Tinta"
 * é a porcentagem de pixels que diferem mais de 20 níveis dessa média. Degradê e sombra suave não contam (a média
 * acompanha); texto, borda de papel, dobra e rabisco contam.
 *
 * Calibragem (21/10/2026): foto real do caso = 0,000 %; papel liso com sombra, ruído até σ=9, lente tampada e
 * parede lisa = 0,000 %; manuscrito curto "R$ 14,00" num papel enorme = 0,55 %; cupom térmico desbotado = 1,1 %;
 * 127 fotos reais de nota = mínimo 6,7 %. Em branco só abaixo de 0,01 % — nada além de poeira. Erra para o lado
 * seguro: ruído, textura ou qualquer marca a mais fazem a foto contar como "tem conteúdo".
 *
 * A mesma regra roda no aparelho (rda-rdm-app/js/foto-branca.js); mantenha as duas iguais.
 */
class FotoEmBranco
{
    public const LADO = 640;

    public const RAIO = 12;

    public const DIFERENCA = 20;

    /** % de pixels com "tinta" abaixo da qual a foto é considerada em branco. */
    public const TINTA_MIN = 0.01;

    /** Acima disto (megapixels) o GD estouraria os 128 MB do PHP: não mede (null). */
    private const MAX_PIXELS = 16_000_000;

    public const EXTS_IMAGEM = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

    /** A foto está em branco? null = não deu para medir (PDF, HEIC, imagem enorme ou ilegível): nunca é "em branco". */
    public static function emBranco(string $bin): ?bool
    {
        $tinta = self::tinta($bin);

        return $tinta === null ? null : $tinta < self::TINTA_MIN;
    }

    /** % de pixels com tinta, ou null se a imagem não pôde ser medida. */
    public static function tinta(string $bin): ?float
    {
        if ($bin === '' || ! function_exists('imagecreatefromstring')) {
            return null;
        }
        $info = @getimagesizefromstring($bin);
        if (! $info || $info[0] < 1 || $info[1] < 1 || $info[0] * $info[1] > self::MAX_PIXELS) {
            return null;
        }
        $img = @imagecreatefromstring($bin);
        if (! $img) {
            return null;
        }
        $ow = imagesx($img);
        $oh = imagesy($img);
        $k = min(1, self::LADO / max($ow, $oh));
        $w = max(8, (int) round($ow * $k));
        $h = max(8, (int) round($oh * $k));
        $p = imagecreatetruecolor($w, $h);
        imagefill($p, 0, 0, imagecolorallocate($p, 255, 255, 255));   // png transparente → fundo branco
        imagecopyresampled($p, $img, 0, 0, 0, 0, $w, $h, $ow, $oh);
        imagedestroy($img);

        $g = [];
        for ($y = 0; $y < $h; $y++) {
            for ($x = 0; $x < $w; $x++) {
                $c = imagecolorat($p, $x, $y);
                $g[] = (($c >> 16) & 255) * 0.299 + (($c >> 8) & 255) * 0.587 + ($c & 255) * 0.114;
            }
        }
        imagedestroy($p);

        return self::tintaDoCinza($g, $w, $h);
    }

    /**
     * @param  list<float|int>  $g  tons de cinza, linha a linha (w*h valores)
     * @return float % de pixels que diferem mais de DIFERENCA níveis da média da vizinhança
     */
    public static function tintaDoCinza(array $g, int $w, int $h): float
    {
        $W = $w + 1;
        $S = array_fill(0, $W * ($h + 1), 0);          // imagem integral: soma de qualquer janela em 4 leituras
        for ($y = 0; $y < $h; $y++) {
            $lin = 0;
            for ($x = 0; $x < $w; $x++) {
                $lin += $g[$y * $w + $x];
                $S[($y + 1) * $W + $x + 1] = $S[$y * $W + $x + 1] + $lin;
            }
        }
        $com = 0;
        for ($y = 0; $y < $h; $y++) {
            $y0 = max(0, $y - self::RAIO);
            $y1 = min($h, $y + self::RAIO + 1);
            for ($x = 0; $x < $w; $x++) {
                $x0 = max(0, $x - self::RAIO);
                $x1 = min($w, $x + self::RAIO + 1);
                $soma = $S[$y1 * $W + $x1] - $S[$y0 * $W + $x1] - $S[$y1 * $W + $x0] + $S[$y0 * $W + $x0];
                $media = $soma / (($x1 - $x0) * ($y1 - $y0));
                if (abs($g[$y * $w + $x] - $media) > self::DIFERENCA) {
                    $com++;
                }
            }
        }

        return $com / ($w * $h) * 100;
    }
}
