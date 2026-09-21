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
        /* Regime (reunião de 21/09/2026):
           • CV (cartão corporativo): RDM_RDA ← notas pagas no cartão;
             CV REEMBOLSO ← notas pagas do próprio bolso (pagamento=reembolso) —
             é dela que o BANCO DE DADOS tira o "REEMBOLSO DE" (gastos − total pago).
           • RDM/RDA (dinheiro em conta): como antes (19/09/2026) — as duas
             grades recebem os MESMOS lançamentos. */
        if ($c->ehCV()) {
            $doBolso = $notas->filter(fn (Nota $n) => $n->pagamento === 'reembolso');
            $noCartao = $notas->reject(fn (Nota $n) => $n->pagamento === 'reembolso');
            if ($ws = $ss->getSheetByName('RDM_RDA')) {
                $this->preencherGrade($ws, $noCartao);
            }
            if ($ws = $ss->getSheetByName('CV REEMBOLSO')) {
                $this->preencherGrade($ws, $doBolso);
            }
        } else {
            foreach (['RDM_RDA', 'CV REEMBOLSO'] as $aba) {
                $ws = $ss->getSheetByName($aba);
                if ($ws) {
                    $this->preencherGrade($ws, $notas);
                }
            }
        }

        /* ── BANCO DE DADOS: extrato de valor recebido ─────── */
        $bd = $ss->getSheetByName('BANCO DE DADOS');
        $reps = Repasse::query()->where('user_id', $c->id)->where('deleted', false)->where('ano', $ano)
            ->where('kind', 'received')->orderBy('data')->get();
        /* RDM/RDA (19/09/2026): repasse RECEBIDO entra nas duas colunas —
           "EXTRATO DE VALOR RECEBIDO" (B/C), que alimenta o saldo de C.V., e
           "REEMBOLSO DE / TOTAL PAGO" (I/J).
           CV (21/09/2026): o colaborador não recebe dinheiro para despesas (o
           cartão paga); o que ele recebe é REEMBOLSO do que saiu do bolso →
           só TOTAL PAGO (I/J). O extrato B/C fica vazio. */
        $row = 15;
        foreach ($reps as $r) {
            if ($row > 94) {
                break;
            }
            $dt = XlsDate::PHPToExcel($r->data->format('Y-m-d'));
            if (! $c->ehCV()) {
                $bd->setCellValue([2, $row], $dt);
                $bd->setCellValue([3, $row], (float) $r->valor);
            }
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
     * Um arquivo só com a Planilha de C.V. de vários colaboradores (21/09/2026):
     * as 4 abas com dados de cada um (CABEÇALHO, BANCO DE DADOS, RDM_RDA, CV
     * REEMBOLSO) entram com o primeiro nome na frente — "Ana_RDM_RDA". NORMAS e
     * AJUDA DE CUSTOS ficam de fora (são iguais para todos e não têm dado do app).
     *
     * O prefixo não tem espaço nem acento de propósito: ao renomear a aba a
     * biblioteca troca o nome dentro das fórmulas (=CABEÇALHO!B5 vira
     * =Ana_CABEÇALHO!B5) mas não põe as aspas que o Excel exige quando há
     * espaço — com "Ana · CABEÇALHO" a fórmula quebrava. Limite do Excel: 31
     * caracteres por aba; a maior das quatro tem 14, sobra 16 para o prefixo.
     */
    public function gerarUnico(iterable $colabs, int $ano): Spreadsheet
    {
        $master = new Spreadsheet();
        $master->removeSheetByIndex(0);
        $this->abaResumo($master, $colabs, $ano);   // primeira aba: somatório geral
        $usados = [];
        foreach ($colabs as $c) {
            $prefixo = $this->prefixoAba($c->nome ?: $c->email, $usados);
            /* cada um no modelo do seu regime (21/09/2026): CV → PLANILHA_CV;
               RDM/RDA → PLANILHA_RDM_RDA (abas CABEÇALHO, BANCO DE DADOS, R.D.M., R.D.A) */
            $ss = $c->ehCV() ? $this->gerar($c, $ano) : app(RelatorioRdmRda::class)->gerar($c, $ano);
            foreach (['NORMAS', 'AJUDA DE CUSTOS'] as $t) {
                if ($ws = $ss->getSheetByName($t)) {
                    $ss->removeSheetByIndex($ss->getIndex($ws));
                }
            }
            foreach ($ss->getAllSheets() as $ws) {
                $ws->setTitle($prefixo.'_'.$ws->getTitle());   // atualiza as fórmulas que apontam para a aba
            }
            foreach ($ss->getAllSheets() as $ws) {
                $master->addExternalSheet($ws);
            }
            $ss->disconnectWorksheets();
            unset($ss);
        }
        $master->setActiveSheetIndex(0);

        return $master;
    }

    /**
     * Aba RESUMO (21/09/2026): o somatório de todo mundo numa aba só, para o
     * gestor não caçar os totais nas abas de cada pessoa. Três quadros:
     * por colaborador, por mês (equipe inteira) e colaborador × mês, cada um
     * com TOTAL GERAL. Valores calculados aqui (não fórmulas), com a mesma
     * regra de categoria da grade RDM_RDA; "Recebido" = repasse received.
     */
    public function abaResumo(Spreadsheet $master, iterable $colabs, int $ano): void
    {
        $colabs = collect($colabs)->values();
        $ids = $colabs->pluck('id')->all();
        $cats = ['abastecimento' => 'Abastecimento', 'hospedagem' => 'Hospedagem', 'alimentacao' => 'Alimentação (RDA)', 'outros' => 'Outros'];
        $meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

        /* ── agrega: [user][cat], [user][mes], [mes][cat], recebido por user e por mes ── */
        $gCat = $gMes = $mCat = $rec = $recMes = [];
        foreach ($ids as $id) {
            $gCat[$id] = array_fill_keys(array_keys($cats), 0.0);
            $gMes[$id] = array_fill(1, 12, 0.0);
            $rec[$id] = 0.0;
        }
        for ($m = 1; $m <= 12; $m++) {
            $mCat[$m] = array_fill_keys(array_keys($cats), 0.0);
            $recMes[$m] = 0.0;
        }
        Nota::query()->whereIn('user_id', $ids)->where('deleted', false)->where('ano', $ano)
            ->select('user_id', 'tipo', 'subtipo', 'valor', 'mes')->cursor()->each(function (Nota $n) use (&$gCat, &$gMes, &$mCat) {
                $m = (int) $n->mes;
                if ($m < 1 || $m > 12) {
                    return;
                }
                $c = $this->categoria($n);
                $v = (float) $n->valor;
                $gCat[$n->user_id][$c] += $v;
                $gMes[$n->user_id][$m] += $v;
                $mCat[$m][$c] += $v;
            });
        Repasse::query()->whereIn('user_id', $ids)->where('deleted', false)->where('ano', $ano)->where('kind', 'received')
            ->select('user_id', 'valor', 'mes')->cursor()->each(function (Repasse $r) use (&$rec, &$recMes) {
                $m = (int) $r->mes;
                $rec[$r->user_id] += (float) $r->valor;
                if ($m >= 1 && $m <= 12) {
                    $recMes[$m] += (float) $r->valor;
                }
            });

        /* ── estilos ── */
        $ws = $master->createSheet();
        $ws->setTitle('RESUMO');
        $verde = '2D6A4F';
        $brl = 'R$ #,##0.00;[Red]-R$ #,##0.00';
        $hdr = ['font' => ['bold' => true, 'color' => ['rgb' => 'FFFFFF']], 'fill' => ['fillType' => 'solid', 'startColor' => ['rgb' => $verde]],
            'alignment' => ['horizontal' => 'center', 'vertical' => 'center', 'wrapText' => true], 'borders' => ['allBorders' => ['borderStyle' => 'thin', 'color' => ['rgb' => 'BBBBBB']]]];
        $cel = ['borders' => ['allBorders' => ['borderStyle' => 'thin', 'color' => ['rgb' => 'DDDDDD']]]];
        $tot = ['font' => ['bold' => true], 'fill' => ['fillType' => 'solid', 'startColor' => ['rgb' => 'D1FAE5']],
            'borders' => ['allBorders' => ['borderStyle' => 'thin', 'color' => ['rgb' => 'BBBBBB']], 'top' => ['borderStyle' => 'medium', 'color' => ['rgb' => $verde]]]];
        $titulo = ['font' => ['bold' => true, 'size' => 13, 'color' => ['rgb' => $verde]]];
        $nomeColab = fn ($c) => $c->nome ?: $c->email;
        $colL = fn (int $n) => \PhpOffice\PhpSpreadsheet\Cell\Coordinate::stringFromColumnIndex($n);

        $r = 1;
        $ws->mergeCells([1, $r, 14, $r]);
        $ws->setCellValue([1, $r], "PETERMANN — RESUMO GERAL DA PLANILHA DE C.V. · {$ano}");
        $ws->getStyle([1, $r])->applyFromArray(['font' => ['bold' => true, 'size' => 15, 'color' => ['rgb' => $verde]]]);
        $r++;
        $ws->mergeCells([1, $r, 14, $r]);
        $ws->setCellValue([1, $r], sprintf('%d colaborador(es) · gerado em %s · Saldo = Recebido − Total gasto (negativo = a reembolsar)', $colabs->count(), now('America/Sao_Paulo')->format('d/m/Y H:i')));
        $ws->getStyle([1, $r])->getFont()->setItalic(true)->setSize(10)->setColor(new \PhpOffice\PhpSpreadsheet\Style\Color('FF666666'));
        $r += 2;

        /* ── Quadro 1: por colaborador ── */
        $ws->mergeCells([1, $r, 8, $r]);
        $ws->setCellValue([1, $r], '1 · POR COLABORADOR');
        $ws->getStyle([1, $r])->applyFromArray($titulo);
        $r++;
        $cab = array_merge(['Colaborador'], array_values($cats), ['Total gasto', 'Recebido', 'Saldo']);
        foreach ($cab as $i => $h) {
            $ws->setCellValue([$i + 1, $r], $h);
        }
        $ws->getStyle([1, $r, count($cab), $r])->applyFromArray($hdr);
        $ws->getRowDimension($r)->setRowHeight(28);
        $hdr1 = $r;
        $r++;
        $ini1 = $r;
        $totCat = array_fill_keys(array_keys($cats), 0.0);
        $totRec = 0.0;
        foreach ($colabs as $c) {
            $id = $c->id;
            $gasto = array_sum($gCat[$id]);
            $ws->setCellValue([1, $r], $nomeColab($c));
            $i = 2;
            foreach (array_keys($cats) as $k) {
                $ws->setCellValue([$i++, $r], round($gCat[$id][$k], 2));
                $totCat[$k] += $gCat[$id][$k];
            }
            $ws->setCellValue([$i++, $r], round($gasto, 2));
            $ws->setCellValue([$i++, $r], round($rec[$id], 2));
            $ws->setCellValue([$i, $r], round($rec[$id] - $gasto, 2));
            $totRec += $rec[$id];
            $r++;
        }
        $fim1 = $r - 1;
        $ws->setCellValue([1, $r], 'TOTAL GERAL');
        $i = 2;
        foreach (array_keys($cats) as $k) {
            $ws->setCellValue([$i++, $r], round($totCat[$k], 2));
        }
        $totGasto = array_sum($totCat);
        $ws->setCellValue([$i++, $r], round($totGasto, 2));
        $ws->setCellValue([$i++, $r], round($totRec, 2));
        $ws->setCellValue([$i, $r], round($totRec - $totGasto, 2));
        $ws->getStyle([1, $ini1, count($cab), $fim1])->applyFromArray($cel);
        $ws->getStyle([1, $r, count($cab), $r])->applyFromArray($tot);
        $ws->getStyle([2, $ini1, count($cab), $r])->getNumberFormat()->setFormatCode($brl);
        $ws->setAutoFilter([1, $hdr1, count($cab), $fim1]);
        $r += 3;

        /* ── Quadro 2: por mês (equipe inteira) ── */
        $ws->mergeCells([1, $r, 8, $r]);
        $ws->setCellValue([1, $r], '2 · POR MÊS (EQUIPE INTEIRA)');
        $ws->getStyle([1, $r])->applyFromArray($titulo);
        $r++;
        $cab2 = array_merge(['Mês'], array_values($cats), ['Total gasto', 'Recebido', 'Saldo']);
        foreach ($cab2 as $i => $h) {
            $ws->setCellValue([$i + 1, $r], $h);
        }
        $ws->getStyle([1, $r, count($cab2), $r])->applyFromArray($hdr);
        $ws->getRowDimension($r)->setRowHeight(28);
        $r++;
        $ini2 = $r;
        for ($m = 1; $m <= 12; $m++) {
            $gasto = array_sum($mCat[$m]);
            $ws->setCellValue([1, $r], $meses[$m - 1]);
            $i = 2;
            foreach (array_keys($cats) as $k) {
                $ws->setCellValue([$i++, $r], round($mCat[$m][$k], 2));
            }
            $ws->setCellValue([$i++, $r], round($gasto, 2));
            $ws->setCellValue([$i++, $r], round($recMes[$m], 2));
            $ws->setCellValue([$i, $r], round($recMes[$m] - $gasto, 2));
            $r++;
        }
        $ws->setCellValue([1, $r], 'TOTAL GERAL');
        for ($c = 2; $c <= count($cab2); $c++) {
            $L = $colL($c);
            $ws->setCellValue([$c, $r], "=SUM({$L}{$ini2}:{$L}".($r - 1).')');
        }
        $ws->getStyle([1, $ini2, count($cab2), $r - 1])->applyFromArray($cel);
        $ws->getStyle([1, $r, count($cab2), $r])->applyFromArray($tot);
        $ws->getStyle([2, $ini2, count($cab2), $r])->getNumberFormat()->setFormatCode($brl);
        $r += 3;

        /* ── Quadro 3: colaborador × mês (gasto total) ── */
        $ws->mergeCells([1, $r, 14, $r]);
        $ws->setCellValue([1, $r], '3 · GASTO POR COLABORADOR × MÊS');
        $ws->getStyle([1, $r])->applyFromArray($titulo);
        $r++;
        $cab3 = array_merge(['Colaborador'], $meses, ['Total']);
        foreach ($cab3 as $i => $h) {
            $ws->setCellValue([$i + 1, $r], $h);
        }
        $ws->getStyle([1, $r, count($cab3), $r])->applyFromArray($hdr);
        $r++;
        $ini3 = $r;
        foreach ($colabs as $c) {
            $ws->setCellValue([1, $r], $nomeColab($c));
            for ($m = 1; $m <= 12; $m++) {
                $ws->setCellValue([$m + 1, $r], round($gMes[$c->id][$m], 2));
            }
            $ws->setCellValue([14, $r], "=SUM(B{$r}:M{$r})");
            $r++;
        }
        $ws->setCellValue([1, $r], 'TOTAL GERAL');
        for ($c = 2; $c <= 14; $c++) {
            $L = $colL($c);
            $ws->setCellValue([$c, $r], "=SUM({$L}{$ini3}:{$L}".($r - 1).')');
        }
        $ws->getStyle([1, $ini3, 14, $r - 1])->applyFromArray($cel);
        $ws->getStyle([1, $r, 14, $r])->applyFromArray($tot);
        $ws->getStyle([2, $ini3, 14, $r])->getNumberFormat()->setFormatCode('#,##0.00;[Red]-#,##0.00');
        $ws->getStyle([14, $ini3, 14, $r])->getFont()->setBold(true);

        /* ── larguras e painel ── */
        $ws->getColumnDimension('A')->setWidth(30);
        for ($c = 2; $c <= 14; $c++) {
            $ws->getColumnDimension($colL($c))->setWidth(15);
        }
        $ws->freezePane('B5');
        $ws->getSheetView()->setZoomScale(90);
        $ws->getPageSetup()->setOrientation(\PhpOffice\PhpSpreadsheet\Worksheet\PageSetup::ORIENTATION_LANDSCAPE)->setFitToWidth(1)->setFitToHeight(0);
    }

    /** Grava sem pré-calcular: com dezenas de abas o cálculo aqui demora e o Excel recalcula ao abrir. */
    public function xlsxSemCalculo(Spreadsheet $ss, string $arquivo): void
    {
        $w = new Xlsx($ss);
        $w->setPreCalculateFormulas(false);
        $w->save($arquivo);
    }

    /** Primeiro nome sem acento/espaço, até 14 letras, único entre os já usados (Ana, Ana2, Ana3…). */
    private function prefixoAba(string $nome, array &$usados): string
    {
        $primeiro = strtok(trim($nome), " \t@") ?: 'Colab';
        $ascii = \Illuminate\Support\Str::ascii($primeiro);
        $base = preg_replace('/[^A-Za-z0-9]/', '', $ascii) ?: 'Colab';
        $base = mb_substr($base, 0, 14);
        $p = $base;
        for ($i = 2; isset($usados[$p]); $i++) {
            $p = $base.$i;
        }
        $usados[$p] = true;

        return $p;
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
