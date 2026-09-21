<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\Nota;

/**
 * Nomenclatura da pasta modelo da empresa, agora no servidor (19/09/2026).
 * Espelha o que o gdrive.js montava no Drive:
 *   {Colaborador}/{Ano}/RDM DESPESAS CORPORATIVAS/{CATEGORIA}/{01 jan}
 *   {Colaborador}/{Ano}/RDA ALIMENTAÇÃO/{01 jan}
 * Usada pela tela Arquivos (trilha de cada nota) e pelo ZIP (caminho dentro
 * do arquivo). Mudou aqui, muda nos dois.
 */
class PastaModelo
{
    public const MESES = ['', '01 jan', '02 fev', '03 mar', '04 abr', '05 mai', '06 jun',
        '07 jul', '08 ago', '09 set', '10 out', '11 nov', '12 dez'];

    public const GRUPO_RDM = 'RDM DESPESAS CORPORATIVAS';

    public const GRUPO_RDA = 'RDA ALIMENTAÇÃO';

    /* subtipo gravado na nota → categoria da pasta (a planilha diz
       "Hospedagem", a pasta diz "HOSPEDAGENS") */
    public const CATEGORIA_RDM = ['abastecimento' => 'ABASTECIMENTO', 'hospedagem' => 'HOSPEDAGENS'];

    public static function mesPasta(?int $mes): string
    {
        return ($mes >= 1 && $mes <= 12) ? self::MESES[$mes] : 'sem-mes';
    }

    /** ['RDA ALIMENTAÇÃO'] ou ['RDM DESPESAS CORPORATIVAS', 'ABASTECIMENTO'] */
    public static function trilhaGrupo(Nota $n): array
    {
        if (strtoupper((string) $n->tipo) === 'RDA') {
            return [self::GRUPO_RDA];
        }
        $sub = strtolower(trim((string) $n->subtipo));

        return [self::GRUPO_RDM, self::CATEGORIA_RDM[$sub] ?? 'OUTROS'];
    }

    /** Rótulo curto do grupo para a tela: "RDA", "RDM · ABASTECIMENTO"… */
    public static function grupoCurto(Nota $n): string
    {
        $t = self::trilhaGrupo($n);

        return count($t) === 1 ? 'RDA ALIMENTAÇÃO' : 'RDM · '.$t[1];
    }

    public static function nomeColaborador(Colaborador $c): string
    {
        $nome = self::limparNome((string) $c->nome);
        if ($nome !== '') {
            return $nome;
        }
        $email = trim((string) $c->email);

        return str_contains($email, '@') ? strtolower(strstr($email, '@', true)) : 'colaborador-'.substr($c->id, 0, 8);
    }

    /** Mês/ano da nota; registros antigos podem não ter os campos → cai na data. */
    public static function mesAno(Nota $n): array
    {
        $m = (int) $n->mes;
        $a = (int) $n->ano;
        if (! ($m >= 1 && $m <= 12) || ! ($a >= 2000 && $a <= 2100)) {
            $d = $n->data ? $n->data->format('Y-m') : '';
            if (preg_match('/^(\d{4})-(\d{2})$/', $d, $x)) {
                $a = (int) $x[1];
                $m = (int) $x[2];
            }
        }

        return [$m, $a];
    }

    /** Pasta da nota dentro do ZIP (sem o nome do arquivo). */
    public static function pastaDaNota(Colaborador $c, Nota $n): string
    {
        [$m, $a] = self::mesAno($n);
        $partes = [self::nomeColaborador($c), $a >= 2000 ? (string) $a : 'sem-ano', ...self::trilhaGrupo($n), self::mesPasta($m)];

        return implode('/', $partes);
    }

    /** "2026-01-15 POSTO IPIRANGA R$120,00.jpg" — legível na pasta, sem depender do app. */
    public static function nomeArquivo(Nota $n, string $ext): string
    {
        $data = $n->data ? $n->data->format('Y-m-d') : 'sem-data';
        $forn = self::limparNome((string) $n->razao_social);
        $forn = $forn !== '' ? mb_substr($forn, 0, 40) : 'sem-fornecedor';
        $valor = 'R$'.number_format((float) $n->valor, 2, ',', '.');

        return "{$data} {$forn} {$valor}.{$ext}";
    }

    private static function limparNome(string $s): string
    {
        $s = preg_replace('~[\\\\/:*?"<>|]~u', ' ', $s);

        return trim(preg_replace('/\s+/u', ' ', $s));
    }
}
