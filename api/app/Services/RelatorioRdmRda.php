<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use PhpOffice\PhpSpreadsheet\IOFactory;
use PhpOffice\PhpSpreadsheet\Shared\Date as XlsDate;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use PhpOffice\PhpSpreadsheet\Worksheet\Worksheet;
use PhpOffice\PhpSpreadsheet\Writer\Xlsx;

/**
 * "PLANILHA DE RDM E RDA" (21/09/2026): modelo oficial da empresa para quem
 * está no regime RDM/RDA (recebe dinheiro em conta). Igual ao RelatorioCv,
 * preenche o PRÓPRIO arquivo-modelo (resources/modelos/PLANILHA_RDM_RDA.xlsx)
 * — abas, fórmulas, molduras e fontes são as do arquivo; só entram valores.
 * O arquivo veio com dados de exemplo: tudo é limpo antes de preencher.
 *
 * Mapa:
 *   CABEÇALHO       B6 funcionário · B7 safra · I7 ano
 *   R.D.M.          12 blocos mensais; 3 categorias lado a lado com DATA | CNPJ | R$:
 *                   Abastecimento B–D · Hospedagens E–G · Outros H–J
 *   R.D.A           12 blocos de 15 linhas em DUAS colunas (B–D e E–G): 30 notas/mês
 *   BANCO DE DADOS  extrato RDM recebido B15:C94 (80 linhas) · RDA recebido F15:H26 (12 linhas)
 */
class RelatorioRdmRda
{
    /** R.D.M.: [linha do rótulo do mês, linha do TOTAL] — Jan tem 31 linhas de dados, os outros 44 */
    private const RDM = [
        1 => [5, 37], 2 => [39, 84], 3 => [86, 131], 4 => [133, 178], 5 => [180, 225], 6 => [227, 272],
        7 => [274, 319], 8 => [321, 366], 9 => [368, 413], 10 => [415, 460], 11 => [462, 507], 12 => [509, 554],
    ];

    /** R.D.A: [linha do rótulo, linha do TOTAL] — dados de rótulo+2 até total−1 (15 linhas × 2 colunas) */
    private const RDA = [
        1 => [4, 21], 2 => [22, 38], 3 => [39, 55], 4 => [56, 72], 5 => [73, 89], 6 => [90, 106],
        7 => [107, 123], 8 => [124, 140], 9 => [141, 157], 10 => [158, 174], 11 => [175, 191], 12 => [192, 208],
    ];

    /** coluna inicial (A=1) de cada categoria no R.D.M. */
    private const COL_RDM = ['Abastecimento' => 2, 'Hospedagem' => 5, 'Outros' => 8];

    public function modelo(): string
    {
        return resource_path('modelos/PLANILHA_RDM_RDA.xlsx');
    }

    public function gerar(Colaborador $c, int $ano): Spreadsheet
    {
        $ss = IOFactory::load($this->modelo());

        /* ── CABEÇALHO ─────────────────────────────────────── */
        $cab = $ss->getSheetByName('CABEÇALHO');
        $cab->setCellValue('B6', mb_strtoupper($c->nome ?: $c->email));
        $cab->setCellValue('B7', sprintf('%02d/%02d', ($ano - 1) % 100, $ano % 100));   // safra: "25/26" para 2026, como no exemplo
        $cab->setCellValue('I7', $ano);

        $notas = Nota::query()->where('user_id', $c->id)->where('deleted', false)->where('ano', $ano)
            ->orderBy('data')->orderBy('created_at')->get();

        /* ── R.D.M. ─────────────────────────────────────────── */
        $rdm = $ss->getSheetByName('R.D.M.');
        foreach (self::RDM as [$ini, $tot]) {
            $this->limpar($rdm, 2, $ini + 1, 10, $tot - 1);
        }
        $prox = [];
        $fora = 0;
        foreach ($notas->where('tipo', 'RDM') as $n) {
            $m = (int) $n->mes;
            if (! isset(self::RDM[$m])) {
                continue;
            }
            [$ini, $tot] = self::RDM[$m];
            $cat = $this->categoriaRdm($n);
            $row = $prox[$m][$cat] ?? ($ini + 1);
            if ($row >= $tot) {
                $fora++;
                continue;
            }
            $col = self::COL_RDM[$cat];
            $this->linha($rdm, $col, $row, $n);
            $prox[$m][$cat] = $row + 1;
        }

        /* ── R.D.A (duas colunas por mês) ───────────────────── */
        $rda = $ss->getSheetByName('R.D.A');
        foreach (self::RDA as [$ini, $tot]) {
            $this->limpar($rda, 2, $ini + 2, 7, $tot - 1);
        }
        $idx = [];
        foreach ($notas->where('tipo', 'RDA') as $n) {
            $m = (int) $n->mes;
            if (! isset(self::RDA[$m])) {
                continue;
            }
            [$ini, $tot] = self::RDA[$m];
            $linhas = $tot - 1 - ($ini + 2) + 1;          // 15
            $i = $idx[$m] ?? 0;
            if ($i >= $linhas * 2) {
                $fora++;
                continue;
            }
            $col = $i < $linhas ? 2 : 5;                 // B–D depois E–G
            $row = $ini + 2 + ($i % $linhas);
            $this->linha($rda, $col, $row, $n);
            $idx[$m] = $i + 1;
        }
        if ($fora) {
            $cab->setCellValue('A10', "ATENÇÃO: {$fora} nota(s) não couberam no bloco do mês (limite do modelo).");
        }

        /* ── BANCO DE DADOS: extratos de repasse recebido ──── */
        $bd = $ss->getSheetByName('BANCO DE DADOS');
        $this->limpar($bd, 2, 15, 3, 94);     // RDM: B15:C94
        $this->limpar($bd, 6, 15, 6, 26);     // RDA: F15 (data, mesclada F:G)
        $this->limpar($bd, 8, 15, 8, 26);     //      H15 (R$)
        $reps = Repasse::query()->where('user_id', $c->id)->where('deleted', false)->where('ano', $ano)
            ->where('kind', 'received')->whereNotNull('confirmado_em')->orderBy('data')->get();
        $r1 = 15;
        $r2 = 15;
        foreach ($reps as $r) {
            $dt = XlsDate::PHPToExcel($r->data->format('Y-m-d'));
            if ($r->tipo === 'RDA') {
                if ($r2 > 26) {
                    continue;
                }
                $bd->setCellValue([6, $r2], $dt);
                $bd->setCellValue([8, $r2], (float) $r->valor);
                $r2++;
            } else {
                if ($r1 > 94) {
                    continue;
                }
                $bd->setCellValue([2, $r1], $dt);
                $bd->setCellValue([3, $r1], (float) $r->valor);
                $r1++;
            }
        }

        $ss->setActiveSheetIndex(0);

        return $ss;
    }

    /** DATA | CNPJ (formatado, como o modelo traz) | R$ a partir de $col */
    private function linha(Worksheet $ws, int $col, int $row, Nota $n): void
    {
        $ws->setCellValue([$col, $row], XlsDate::PHPToExcel($n->data->format('Y-m-d')));
        $cnpj = (string) $n->cnpj;
        if (preg_match('/^\d{14}$/', $cnpj)) {
            $cnpj = preg_replace('/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/', '$1.$2.$3/$4-$5', $cnpj);
        } elseif ($cnpj === '' && $n->razao_social) {
            $cnpj = $n->razao_social;
        }
        $ws->setCellValueExplicit([$col + 1, $row], $cnpj, \PhpOffice\PhpSpreadsheet\Cell\DataType::TYPE_STRING);
        $ws->setCellValue([$col + 2, $row], (float) $n->valor);
    }

    private function categoriaRdm(Nota $n): string
    {
        $s = mb_strtolower((string) $n->subtipo);
        if (str_starts_with($s, 'abast')) {
            return 'Abastecimento';
        }
        if (str_starts_with($s, 'hosp')) {
            return 'Hospedagem';
        }

        return 'Outros';
    }

    /** Apaga só os VALORES do retângulo (o modelo veio com dados de exemplo); estilos ficam. */
    private function limpar(Worksheet $ws, int $c1, int $r1, int $c2, int $r2): void
    {
        for ($r = $r1; $r <= $r2; $r++) {
            for ($c = $c1; $c <= $c2; $c++) {
                $cell = $ws->getCell([$c, $r]);
                $v = $cell->getValue();
                if ($v !== null && ! (is_string($v) && str_starts_with($v, '='))) {
                    $cell->setValue(null);
                }
            }
        }
    }

    public function xlsx(Spreadsheet $ss, string $arquivo): void
    {
        (new Xlsx($ss))->save($arquivo);
    }
}
