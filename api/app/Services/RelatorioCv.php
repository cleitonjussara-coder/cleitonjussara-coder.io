<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use PhpOffice\PhpSpreadsheet\IOFactory;
use PhpOffice\PhpSpreadsheet\Shared\Date as XlsDate;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use PhpOffice\PhpSpreadsheet\Writer\Pdf\Dompdf as PdfWriter;
use PhpOffice\PhpSpreadsheet\Writer\Xlsx;

/**
 * "PLANILHA DE CV" (19/09/2026): preenche o PRÓPRIO arquivo-modelo da
 * empresa (resources/modelos/PLANILHA_CV.xlsx) com as notas e repasses de um
 * colaborador no ano. Nada do formato é recriado — abas, fórmulas, molduras
 * e fontes são as do arquivo; só entram valores nas linhas de dados.
 *
 * Mapa (aba RDM_RDA, 12 blocos mensais de 4 categorias):
 *   RDM · Abastecimento → colunas A–D     RDM · Hospedagem → E–H
 *   RDA (alimentação)   → colunas I–L     RDM · Outros     → M–P
 *   colunas: DATA | CNPJ DA NOTA | Nº DA NOTA | R$
 * BANCO DE DADOS: repasses recebidos no "EXTRATO DE VALOR RECEBIDO" (B15:C94).
 * CABEÇALHO: B5 funcionário, B6 safra, I6 ano.
 * CV REEMBOLSO recebe os mesmos lançamentos de RDM_RDA (RDA+RDM unificados).
 * AJUDA DE CUSTOS fica como está (sem fonte de dados no app).
 */
class RelatorioCv
{
    /** linha do rótulo do mês e linha do "TOTAL DE GASTOS" de cada bloco (RDM_RDA) */
    private const BLOCOS = [
        1 => [5, 58], 2 => [61, 117], 3 => [120, 176], 4 => [179, 235], 5 => [238, 294], 6 => [297, 353],
        7 => [356, 412], 8 => [415, 471], 9 => [474, 530], 10 => [533, 590], 11 => [593, 650], 12 => [653, 710],
    ];

    /** coluna inicial de cada categoria (A=1) */
    private const COL = ['abastecimento' => 1, 'hospedagem' => 5, 'alimentacao' => 9, 'outros' => 13];

    public function modelo(): string
    {
        return resource_path('modelos/PLANILHA_CV.xlsx');
    }

    public function gerar(Colaborador $c, int $ano): Spreadsheet
    {
        $ss = IOFactory::load($this->modelo());

        /* ── CABEÇALHO ─────────────────────────────────────── */
        $cab = $ss->getSheetByName('CABEÇALHO');
        $cab->setCellValue('B5', mb_strtoupper($c->nome ?: $c->email));
        $cab->setCellValue('B6', (string) $ano);
        $cab->setCellValue('I6', $ano);

        /* ── RDM_RDA e CV REEMBOLSO ────────────────────────── */
        $notas = Nota::query()->where('user_id', $c->id)->where('deleted', false)->where('ano', $ano)
            ->orderBy('data')->orderBy('created_at')->get();
        /* CV REEMBOLSO tem a mesma grade e recebe os MESMOS lançamentos (RDA +
           RDM unificados) — é dela que o BANCO DE DADOS tira o "REEMBOLSO DE"
           (gastos − total pago). Confirmado pelo usuário em 19/09/2026. */
        foreach (['RDM_RDA', 'CV REEMBOLSO'] as $aba) {
            $ws = $ss->getSheetByName($aba);
            if ($ws) {
                $this->preencherGrade($ws, $notas);
            }
        }

        /* ── BANCO DE DADOS: extrato de valor recebido ─────── */
        $bd = $ss->getSheetByName('BANCO DE DADOS');
        $reps = Repasse::query()->where('user_id', $c->id)->where('deleted', false)->where('ano', $ano)
            ->where('kind', 'received')->orderBy('data')->get();
        /* Repasse RECEBIDO registrado no app entra nas duas colunas do modelo
           (confirmado em 19/09/2026): "EXTRATO DE VALOR RECEBIDO" (B/C), que
           alimenta o saldo de C.V., e "REEMBOLSO DE / TOTAL PAGO" (I/J), que
           alimenta o "REEMBOLSO DE:" (gastos do CV REEMBOLSO − pago). */
        $row = 15;
        foreach ($reps as $r) {
            if ($row > 94) {
                break;
            }
            $dt = XlsDate::PHPToExcel($r->data->format('Y-m-d'));
            $bd->setCellValue([2, $row], $dt);
            $bd->setCellValue([3, $row], (float) $r->valor);
            $bd->setCellValue([9, $row], $dt);
            $bd->setCellValue([10, $row], (float) $r->valor);
            $row++;
        }

        $ss->setActiveSheetIndex(0);

        return $ss;
    }

    /** Lança as notas na grade mensal de 4 categorias (RDM_RDA / CV REEMBOLSO). */
    private function preencherGrade(\PhpOffice\PhpSpreadsheet\Worksheet\Worksheet $ws, $notas): void
    {
        $prox = [];          // [mes][categoria] => próxima linha livre
        $fora = 0;           // notas que não couberam no bloco do mês
        foreach ($notas as $n) {
            $mes = (int) $n->mes;
            if (! isset(self::BLOCOS[$mes])) {
                continue;
            }
            $cat = $this->categoria($n);
            [$ini, $tot] = self::BLOCOS[$mes];
            $row = $prox[$mes][$cat] ?? ($ini + 1);
            if ($row >= $tot) {              // bloco cheio (52–56 linhas): não invade o TOTAL
                $fora++;
                continue;
            }
            $col = self::COL[$cat];
            $ws->setCellValue([$col, $row], XlsDate::PHPToExcel($n->data->format('Y-m-d')));
            if ($n->cnpj && preg_match('/^\d{14}$/', $n->cnpj)) {
                $ws->setCellValue([$col + 1, $row], (int) $n->cnpj);   // o modelo formata 00.000.000/0000-00
            } elseif ($n->razao_social) {
                $ws->setCellValue([$col + 1, $row], $n->razao_social);
            }
            if ($n->numero) {
                $ws->setCellValue([$col + 2, $row], is_numeric($n->numero) ? (int) $n->numero : $n->numero);
            }
            $ws->setCellValue([$col + 3, $row], (float) $n->valor);
            $prox[$mes][$cat] = $row + 1;
        }
        if ($fora) {
            $ws->setCellValue('A712', "ATENÇÃO: {$fora} nota(s) não couberam no bloco do mês (limite do modelo).");
        }
    }

    private function categoria(Nota $n): string
    {
        if ($n->tipo === 'RDA') {
            return 'alimentacao';
        }
        $s = mb_strtolower((string) $n->subtipo);
        if (str_starts_with($s, 'abast')) {
            return 'abastecimento';
        }
        if (str_starts_with($s, 'hosp')) {
            return 'hospedagem';
        }

        return 'outros';
    }

    public function xlsx(Spreadsheet $ss, string $arquivo): void
    {
        (new Xlsx($ss))->save($arquivo);
    }

    /**
     * PDF: o Dompdf não dá conta das 3 abas de 712 linhas (mais de 2 min).
     * Para o PDF, então, os meses SEM lançamento saem da grade (removidos, não
     * só ocultos — o motor ainda os renderizaria) e as abas que ficaram vazias
     * (CV REEMBOLSO, AJUDA DE CUSTOS, NORMAS) não entram. O Excel continua
     * completo; o PDF é a versão "para imprimir" do que tem dado.
     */
    public function pdf(Spreadsheet $ss, string $arquivo): void
    {
        $this->podar($ss);
        /* HTML do PhpSpreadsheet + CSS nosso por cima: tabela na largura da
           página (paisagem), colunas fixas e fonte menor — sem isso as 16
           colunas de RDM_RDA estouravam a folha (19/09/2026). */
        $h = new \PhpOffice\PhpSpreadsheet\Writer\Html($ss);
        $h->setUseInlineCss(true);
        $h->writeAllSheets();
        $html = $h->generateHTMLAll();
        $css = '<style>
            @page { size: A4 landscape; margin: 10mm 8mm; }
            body { font-family: DejaVu Sans, Arial, sans-serif; }
            table { width: 100% !important; table-layout: fixed; border-collapse: collapse; page-break-inside: auto; }
            col { width: auto !important; }
            td { font-size: 7.5pt !important; padding: 1px 2px !important; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; line-height: 1.25; }
            tr { page-break-inside: avoid; }
            hr { page-break-after: always; border: 0; margin: 0; }
        </style>';
        $html = preg_replace('/<style[^>]*>.*?<\/style>/is', '', $html, 1);
        $html = str_replace('</head>', $css.'</head>', $html);
        $html = preg_replace('/<table[^>]*>/i', '<table>', $html);
        $html = preg_replace('/<col[^>]*>/i', '<col>', $html);
        $d = new \Dompdf\Dompdf(['isRemoteEnabled' => false, 'defaultFont' => 'DejaVu Sans']);
        $d->setPaper('A4', 'landscape');
        $d->loadHtml($html);
        $d->render();
        file_put_contents($arquivo, $d->output());
    }

    /** Tira do arquivo os meses e abas sem dados (usado só para o PDF). */
    public function podar(Spreadsheet $ss): void
    {
        foreach (['RDM_RDA', 'CV REEMBOLSO'] as $nome) {
            $ws = $ss->getSheetByName($nome);
            if (! $ws) {
                continue;
            }
            $vazios = [];
            foreach (self::BLOCOS as $mes => [$ini, $tot]) {
                $temDado = false;
                for ($r = $ini + 1; $r < $tot && ! $temDado; $r++) {
                    foreach ([4, 8, 12, 16] as $c) {
                        if ($ws->getCell([$c, $r])->getValue() !== null) {
                            $temDado = true;
                            break;
                        }
                    }
                }
                if (! $temDado) {
                    $vazios[] = [$ini, $tot];
                }
            }
            if (count($vazios) === 12) {
                $ss->removeSheetByIndex($ss->getIndex($ws));   // aba sem nenhum dado no ano
                continue;
            }
            /* de baixo para cima, para os índices de cima não mudarem; o bloco vai
               do rótulo do mês até a linha em branco depois do total mensal */
            foreach (array_reverse($vazios) as [$ini, $tot]) {
                $ws->removeRow($ini, $tot + 2 - $ini + 1);
            }
            $ws->getPageSetup()->setOrientation('landscape');
        }
        foreach (['AJUDA DE CUSTOS', 'NORMAS'] as $nome) {
            $ws = $ss->getSheetByName($nome);
            if ($ws && $this->semDados($ws)) {
                $ss->removeSheetByIndex($ss->getIndex($ws));
            }
        }
        /* o modelo tem células formatadas muito além da área útil (CABEÇALHO até
           AE137, RDM_RDA até AO) — cada uma vira HTML; cortamos o excesso */
        $this->enxugar($ss, 'CABEÇALHO', 'I', 34);
        $this->enxugar($ss, 'BANCO DE DADOS', 'K', 95);
        $this->enxugar($ss, 'RDM_RDA', 'P', null);
        $this->enxugar($ss, 'CV REEMBOLSO', 'P', null);
        $this->enxugar($ss, 'AJUDA DE CUSTOS', 'E', null);
        foreach ($ss->getAllSheets() as $ws) {
            $ws->getPageSetup()->setFitToWidth(1)->setFitToHeight(0);
        }
        $ss->setActiveSheetIndex(0);
    }

    private function enxugar(Spreadsheet $ss, string $aba, string $ultimaCol, ?int $ultimaLinha): void
    {
        $ws = $ss->getSheetByName($aba);
        if (! $ws) {
            return;
        }
        $maxCol = \PhpOffice\PhpSpreadsheet\Cell\Coordinate::columnIndexFromString($ws->getHighestColumn());
        $lim = \PhpOffice\PhpSpreadsheet\Cell\Coordinate::columnIndexFromString($ultimaCol);
        if ($maxCol > $lim) {
            $ws->removeColumnByIndex($lim + 1, $maxCol - $lim);
        }
        $maxRow = $ws->getHighestRow();
        if ($ultimaLinha !== null && $maxRow > $ultimaLinha) {
            $ws->removeRow($ultimaLinha + 1, $maxRow - $ultimaLinha);
        }
    }

    private function semDados(\PhpOffice\PhpSpreadsheet\Worksheet\Worksheet $ws): bool
    {
        foreach ($ws->getRowIterator() as $row) {
            foreach ($row->getCellIterator() as $cell) {
                $v = $cell->getValue();
                if (is_numeric($v) && ! is_string($v)) {
                    return false;
                }
            }
        }

        return true;
    }
}
