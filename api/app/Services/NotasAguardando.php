<?php

namespace App\Services;

use App\Models\Nota;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Collection;
use PhpOffice\PhpSpreadsheet\Cell\DataType;
use PhpOffice\PhpSpreadsheet\Worksheet\Worksheet;

/**
 * O aviso escrito nos relatórios (06/11/2026, decisão do dono): nota que entrou com o mês já fechado fica fora do arquivo até a
 * conferência, mas é dinheiro de verdade, então o arquivo diz que ela existe, com quantidade e valor. Quem fica de fora decide o
 * escopo Nota::noRelatorio; aqui só se conta e se escreve. Sem pendência, tudo aqui devolve vazio e o arquivo sai como sempre.
 */
class NotasAguardando
{
    /** "2 notas (R$ 287,49) aguardam conferência e não entram nesta planilha"; null sem nota. */
    public static function frase(int $qtd, float $valor, string $onde, string $origem = ''): ?string
    {
        if ($qtd < 1) {
            return null;
        }
        $dinheiro = 'R$ '.number_format($valor, 2, ',', '.');
        $quantas = $qtd === 1 ? "1 nota ({$dinheiro})" : "{$qtd} notas ({$dinheiro})";
        $verbo = $qtd === 1 ? 'aguarda conferência e não entra' : 'aguardam conferência e não entram';

        return trim("{$quantas} {$origem}")." {$verbo} {$onde}";
    }

    /**
     * Avisos de um relatório de colaboradores: o que ficou fora do período e, em separado, o que ficou fora do saldo trazido.
     * A segunda frase existe porque o saldo anterior do relatório também deixa a nota de fora (ver SaldoAnterior::doRelatorio):
     * sem ela, a planilha do ano seguinte esconderia a nota sem dizer nada. Faturamento não é gasto de colaborador e fica fora,
     * como nestes relatórios.
     *
     * @param  array<int, string>|null  $ids  só estes colaboradores; null = todos
     * @return array<int, string>
     */
    public static function doPeriodo(int $ano, ?int $mes = null, ?array $ids = null, string $onde = 'nesta planilha'): array
    {
        $base = fn () => Nota::query()->aguardandoConferencia()->whereNotNull('user_id')
            ->where(fn ($q) => $q->where('pagamento', '!=', 'empresa')->orWhereNull('pagamento'))
            ->when($ids !== null, fn ($q) => $q->whereIn('user_id', $ids));

        $noPeriodo = $base()->where('ano', $ano)->when($mes, fn ($q) => $q->where('mes', $mes));
        $antes = $mes ? $base()->whereRaw('(ano * 12 + mes) < ?', [$ano * 12 + $mes]) : $base()->where('ano', '<', $ano);

        return array_values(array_filter([
            self::fraseDa($noPeriodo, $onde),
            self::fraseDa($antes, $mes ? 'no saldo trazido dos meses anteriores' : 'no saldo do ano anterior', $mes ? 'de meses anteriores' : 'de anos anteriores'),
        ]));
    }

    /**
     * Faturamento não tem saldo, então é uma frase só.
     *
     * @return array<int, string>
     */
    public static function doFaturamento(int $ano, ?int $mes = null, string $onde = 'nesta planilha'): array
    {
        $q = Nota::query()->aguardandoConferencia()->where('pagamento', 'empresa')->where('ano', $ano)->when($mes, fn ($w) => $w->where('mes', $mes));

        return array_values(array_filter([self::fraseDa($q, $onde)]));
    }

    /** O aviso e a lista das notas, para o .txt que vai no ZIP no lugar do anexo que ficou de fora. */
    public static function texto(Collection $notas, string $onde): string
    {
        $txt = self::frase($notas->count(), (float) $notas->sum('valor'), $onde).".\n\n";
        foreach ($notas as $n) {
            $txt .= sprintf("%s  %-40s  R$ %s  [%s]\n", $n->data?->format('Y-m-d') ?: 'sem-data', mb_substr((string) $n->razao_social, 0, 40), number_format((float) $n->valor, 2, ',', '.'), PastaModelo::grupoCurto($n));
        }

        return $txt."\nDepois de conferidas pela gestão, as notas e os anexos passam a sair aqui.\n";
    }

    /**
     * Escreve numa área livre da aba, sem deslocar nada: quem chama escolhe células que nenhuma fórmula usa.
     * $linha: em faixa de uma linha só, o Excel não aumenta a altura de célula mesclada sozinho, então a altura vai aqui.
     */
    public static function estampar(?Worksheet $ws, string $faixa, array $avisos, ?int $linha = null, int $alturaPorAviso = 16): void
    {
        if (! $ws || ! $avisos) {
            return;
        }
        $ws->mergeCells($faixa);
        $ws->setCellValueExplicit(explode(':', $faixa)[0], implode("\n", $avisos), DataType::TYPE_STRING);
        $ws->getStyle($faixa)->applyFromArray([
            'font' => ['bold' => true, 'size' => 9, 'color' => ['rgb' => '9C0006']],
            'fill' => ['fillType' => 'solid', 'startColor' => ['rgb' => 'FFF2CC']],
            'alignment' => ['horizontal' => 'left', 'vertical' => 'center', 'wrapText' => true],
            'borders' => ['outline' => ['borderStyle' => 'thin', 'color' => ['rgb' => '9C0006']]],
        ]);
        if ($linha !== null) {
            $ws->getRowDimension($linha)->setRowHeight($alturaPorAviso * count($avisos));
        }
    }

    /** A faixa do PDF, com estilo próprio para valer igual nos quatro PDFs. Vazia sem aviso. */
    public static function html(array $avisos): string
    {
        if (! $avisos) {
            return '';
        }
        $linhas = array_map(fn (string $a) => htmlspecialchars($a, ENT_QUOTES, 'UTF-8'), $avisos);

        return '<div class="aguarda-conferencia" style="background:#FFF2CC;border:1px solid #9C0006;color:#9C0006;font-weight:bold;font-size:9pt;padding:4px 8px;margin:4px 0 8px">'.implode('<br>', $linhas).'</div>';
    }

    private static function fraseDa(Builder $q, string $onde, string $origem = ''): ?string
    {
        $soma = $q->selectRaw('COUNT(*) AS q, COALESCE(SUM(valor), 0) AS v')->first();

        return self::frase((int) ($soma->q ?? 0), (float) ($soma->v ?? 0), $onde, $origem);
    }
}
