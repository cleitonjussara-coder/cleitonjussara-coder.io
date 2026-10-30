<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\Nota;
use PhpOffice\PhpSpreadsheet\Cell\Coordinate;
use PhpOffice\PhpSpreadsheet\Cell\DataType;
use PhpOffice\PhpSpreadsheet\Shared\Date as XlsDate;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use PhpOffice\PhpSpreadsheet\Style\Color;
use PhpOffice\PhpSpreadsheet\Worksheet\PageSetup;
use PhpOffice\PhpSpreadsheet\Worksheet\Worksheet;
use PhpOffice\PhpSpreadsheet\Writer\Xlsx;

/**
 * Planilha própria de FATURAMENTO (22/10/2026) — as notas pagas direto pela empresa (pagamento='empresa'), de
 * qualquer colaborador ou sem colaborador. Os modelos da empresa (CV e RDM/RDA) não têm lugar para elas, então esta
 * é montada do zero, no mesmo visual do RESUMO das planilhas da equipe:
 *   RESUMO  → por mês × categoria, por colaborador × categoria e colaborador × mês, cada quadro com TOTAL GERAL;
 *   Jan…Dez → uma aba por mês (sempre as 12), uma linha por nota, com filtro e total que acompanha o filtro.
 * Ano inteiro, como as outras planilhas. Só gestor/admin/contabilidade (o controller confere).
 */
class RelatorioFaturamentoXlsx
{
    public const MESES = [1 => 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

    private const MESES_LONGO = [1 => 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

    /** chave interna → rótulo da coluna; a mesma divisão do RESUMO da equipe e do PDF de Faturamento */
    private const CATS = ['alimentacao' => 'Alimentação (RDA)', 'abastecimento' => 'Abastecimento', 'hospedagem' => 'Hospedagem', 'locacao' => 'Locação de Veículos', 'outros' => 'Outros'];

    private const ROTULO_CAT = ['alimentacao' => 'Alimentação', 'abastecimento' => 'Abastecimento', 'hospedagem' => 'Hospedagem', 'locacao' => 'Locação de Veículos', 'outros' => 'Outros'];

    private const DOCS = ['nfce' => 'NFC-e', 'nfe' => 'NF-e', 'danfe' => 'DANFE', 'nfse' => 'NFS-e', 'outro' => 'Outro'];

    public const SEM_COLABORADOR = 'Sem colaborador específico';

    private const VERDE = '2D6A4F';

    private const BRL = 'R$ #,##0.00;[Red]-R$ #,##0.00';

    /** colunas das abas de mês; "Valor" é a que soma */
    private const COLUNAS = ['Data', 'Colaborador', 'Tipo', 'Categoria', 'Fornecedor', 'CNPJ', 'Documento', 'Número', 'Valor (R$)', 'Lançado por', 'Observação', 'Anexo'];

    private const COL_VALOR = 9;

    public function __construct(private FotoStorage $fotos) {}

    public function gerar(int $ano, ?Colaborador $gerador = null): Spreadsheet
    {
        $notas = Nota::query()->where('pagamento', 'empresa')->where('deleted', false)->where('ano', $ano)
            ->orderBy('data')->orderBy('created_at')->get();

        $ids = $notas->pluck('user_id')->merge($notas->pluck('created_by'))->filter()->unique();
        $pessoas = Colaborador::query()->whereIn('id', $ids)->get()->keyBy('id');
        $nomeDe = fn (?string $id) => $id && $pessoas->has($id) ? ($pessoas[$id]->nome ?: $pessoas[$id]->email) : 'Desconhecido';

        /* Rótulo do dono, um por cadastro: o RESUMO agrupa pelo id, e dois cadastros com o mesmo nome (homônimos, ou
           um antigo inativo e um novo) ganham o e-mail — senão viravam uma pessoa só, sem dar para separar os valores.
           user_id nulo é sempre Faturamento sem colaborador (a nota escolheu não apontar ninguém), não dado perdido. */
        $donos = $notas->pluck('user_id')->filter()->unique()->values();
        $repetidos = $donos->countBy(fn ($id) => mb_strtolower($nomeDe($id)))->filter(fn ($q) => $q > 1);
        $rotulos = [];
        foreach ($donos as $id) {
            $nome = $nomeDe($id);
            if ($repetidos->has(mb_strtolower($nome))) {
                $nome .= $pessoas->has($id) ? ' ('.$pessoas[$id]->email.')' : ' ('.substr($id, 0, 8).')';
            }
            $rotulos[$id] = $nome;
        }
        $donoDe = fn (?string $id) => $id === null ? self::SEM_COLABORADOR : $rotulos[$id];

        $porMes = array_fill(1, 12, []);
        foreach ($notas as $n) {
            $m = (int) $n->mes;
            if ($m >= 1 && $m <= 12) {
                $porMes[$m][] = $n;
            }
        }

        $ss = new Spreadsheet();
        $ss->removeSheetByIndex(0);
        $ss->getProperties()->setCreator('Petermann — Notas PM')->setTitle("Faturamento {$ano}");

        $this->abaResumo($ss, $ano, $porMes, $donoDe, $gerador);
        foreach ($porMes as $m => $doMes) {
            $this->abaMes($ss, $ano, $m, $doMes, $donoDe, $nomeDe);
        }
        $ss->setActiveSheetIndex(0);

        return $ss;
    }

    public function xlsx(Spreadsheet $ss, string $arquivo): void
    {
        (new Xlsx($ss))->save($arquivo);
    }

    public static function categoria(Nota $n): string
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
        if (str_starts_with($s, 'loca')) {
            return 'locacao';
        }

        return 'outros';
    }

    private function abaResumo(Spreadsheet $ss, int $ano, array $porMes, \Closure $donoDe, ?Colaborador $gerador): void
    {
        $ws = $ss->createSheet();
        $ws->setTitle('RESUMO');

        /* ── agrega: [mes][cat], [dono][cat], [dono][mes] — dono pelo id ('' = sem colaborador), nunca pelo nome ── */
        $mCat = $mQtd = [];
        $pCat = $pMes = $pQtd = $pNome = [];
        $qtd = 0;
        foreach ($porMes as $m => $doMes) {
            $mCat[$m] = array_fill_keys(array_keys(self::CATS), 0.0);
            $mQtd[$m] = count($doMes);
            foreach ($doMes as $n) {
                $c = self::categoria($n);
                $v = (float) $n->valor;
                $quem = (string) $n->user_id;
                $pNome[$quem] ??= $donoDe($n->user_id);
                $pCat[$quem] ??= array_fill_keys(array_keys(self::CATS), 0.0);
                $pMes[$quem] ??= array_fill(1, 12, 0.0);
                $pQtd[$quem] = ($pQtd[$quem] ?? 0) + 1;
                $mCat[$m][$c] += $v;
                $pCat[$quem][$c] += $v;
                $pMes[$quem][$m] += $v;
                $qtd++;
            }
        }
        /* por nome; "Sem colaborador específico" fica por último */
        uksort($pCat, fn ($a, $b) => [$a === '', mb_strtolower($pNome[$a])] <=> [$b === '', mb_strtolower($pNome[$b])]);

        [$hdr, $cel, $tot, $titulo] = $this->estilos();
        $ncol = 14;

        $r = 1;
        $ws->mergeCells([1, $r, $ncol, $r]);
        $ws->setCellValue([1, $r], "PETERMANN — FATURAMENTO · PAGO DIRETO PELA EMPRESA · {$ano}");
        $ws->getStyle([1, $r])->applyFromArray(['font' => ['bold' => true, 'size' => 15, 'color' => ['rgb' => self::VERDE]]]);
        $r++;
        $ws->mergeCells([1, $r, $ncol, $r]);
        $ws->setCellValue([1, $r], sprintf(
            '%d nota%s · gerado em %s%s · notas pagas direto pela empresa: não entram no saldo nem nas planilhas de RDM/RDA ou C.V. de ninguém',
            $qtd, $qtd === 1 ? '' : 's', now(PontoCalculo::TZ)->format('d/m/Y H:i'), $gerador ? ' por '.($gerador->nome ?: $gerador->email) : ''
        ));
        $ws->getStyle([1, $r])->getFont()->setItalic(true)->setSize(10)->setColor(new Color('FF666666'));
        $r += 2;

        /* ── Quadro 1: por mês × categoria ── */
        $cab = array_merge(['Mês'], array_values(self::CATS), ['Total', 'Notas']);
        $r = $this->tituloQuadro($ws, $r, '1 · POR MÊS', $titulo);
        $this->cabecalho($ws, $r, $cab, $hdr);
        $r++;
        $ini = $r;
        for ($m = 1; $m <= 12; $m++) {
            $linha = array_merge([self::MESES_LONGO[$m]], array_map(fn ($v) => round($v, 2), array_values($mCat[$m])), [round(array_sum($mCat[$m]), 2), $mQtd[$m]]);
            $ws->fromArray($linha, null, 'A'.$r, true);
            $r++;
        }
        $this->linhaTotal($ws, $r, $ini, count($cab), $cel, $tot);
        $ws->getStyle([2, $ini, count($cab) - 1, $r])->getNumberFormat()->setFormatCode(self::BRL);
        $r += 3;

        /* ── Quadro 2: por colaborador × categoria ── */
        $cab = array_merge(['Colaborador'], array_values(self::CATS), ['Total', 'Notas']);
        $r = $this->tituloQuadro($ws, $r, '2 · POR COLABORADOR', $titulo);
        $this->cabecalho($ws, $r, $cab, $hdr);
        $r++;
        $ini = $r;
        foreach ($pCat as $quem => $cats) {
            $ws->setCellValueExplicit([1, $r], $pNome[$quem], DataType::TYPE_STRING);
            $ws->fromArray(array_merge(array_map(fn ($v) => round($v, 2), array_values($cats)), [round(array_sum($cats), 2), $pQtd[$quem]]), null, 'B'.$r, true);
            $r++;
        }
        if (! $pCat) {
            $ws->setCellValue([1, $r], "Nenhuma nota de Faturamento em {$ano}.");
            $ws->getStyle([1, $r])->getFont()->setItalic(true)->setColor(new Color('FF777777'));
            $r++;
        }
        $this->linhaTotal($ws, $r, $ini, count($cab), $cel, $tot);
        $ws->getStyle([2, $ini, count($cab) - 1, $r])->getNumberFormat()->setFormatCode(self::BRL);
        $r += 3;

        /* ── Quadro 3: colaborador × mês ── */
        $cab = array_merge(['Colaborador'], array_values(self::MESES), ['Total']);
        $r = $this->tituloQuadro($ws, $r, '3 · POR COLABORADOR × MÊS', $titulo);
        $this->cabecalho($ws, $r, $cab, $hdr);
        $r++;
        $ini = $r;
        foreach (array_keys($pCat) as $quem) {
            $ws->setCellValueExplicit([1, $r], $pNome[$quem], DataType::TYPE_STRING);
            $ws->fromArray(array_map(fn ($v) => round($v, 2), array_values($pMes[$quem])), null, 'B'.$r, true);
            $ws->setCellValue([14, $r], "=SUM(B{$r}:M{$r})");
            $r++;
        }
        if (! $pCat) {
            $ws->setCellValue([1, $r], "Nenhuma nota de Faturamento em {$ano}.");
            $ws->getStyle([1, $r])->getFont()->setItalic(true)->setColor(new Color('FF777777'));
            $r++;
        }
        $this->linhaTotal($ws, $r, $ini, count($cab), $cel, $tot);
        $ws->getStyle([2, $ini, count($cab), $r])->getNumberFormat()->setFormatCode('#,##0.00;[Red]-#,##0.00');
        $ws->getStyle([count($cab), $ini, count($cab), $r])->getFont()->setBold(true);

        $ws->getColumnDimension('A')->setWidth(32);
        for ($c = 2; $c <= $ncol; $c++) {
            $ws->getColumnDimension(Coordinate::stringFromColumnIndex($c))->setWidth(15);
        }
        $ws->getSheetView()->setZoomScale(90);
        $ws->getPageSetup()->setOrientation(PageSetup::ORIENTATION_LANDSCAPE)->setPaperSize(PageSetup::PAPERSIZE_A4)->setFitToWidth(1)->setFitToHeight(0);
    }

    private function abaMes(Spreadsheet $ss, int $ano, int $m, array $notas, \Closure $donoDe, \Closure $nomeDe): void
    {
        $ws = $ss->createSheet();
        $ws->setTitle(self::MESES[$m]);
        [$hdr, $cel, $tot] = $this->estilos();
        $ncol = count(self::COLUNAS);

        $ws->mergeCells([1, 1, $ncol, 1]);
        $ws->setCellValue([1, 1], 'FATURAMENTO — PAGO DIRETO PELA EMPRESA — '.mb_strtoupper(self::MESES_LONGO[$m]).' / '.$ano);
        $ws->getStyle([1, 1])->applyFromArray(['font' => ['bold' => true, 'size' => 13, 'color' => ['rgb' => self::VERDE]]]);
        $total = array_sum(array_map(fn ($n) => (float) $n->valor, $notas));
        $ws->mergeCells([1, 2, $ncol, 2]);
        $ws->setCellValue([1, 2], sprintf('%d nota%s · R$ %s', count($notas), count($notas) === 1 ? '' : 's', number_format($total, 2, ',', '.')));
        $ws->getStyle([1, 2])->getFont()->setItalic(true)->setSize(10)->setColor(new Color('FF666666'));

        $hdrRow = 4;
        $this->cabecalho($ws, $hdrRow, self::COLUNAS, $hdr);
        $r = $hdrRow + 1;
        $ini = $r;
        foreach ($notas as $n) {
            if ($n->data) {
                $ws->setCellValue([1, $r], XlsDate::PHPToExcel($n->data->format('Y-m-d')));
            }
            $txt = [
                2 => $donoDe($n->user_id), 3 => (string) $n->tipo, 4 => self::ROTULO_CAT[self::categoria($n)],
                5 => (string) $n->razao_social, 6 => $n->cnpjFormatado(),
                7 => self::DOCS[(string) $n->documento] ?? (string) $n->documento, 8 => (string) $n->numero,
                10 => $nomeDe($n->created_by), 11 => (string) $n->observacao,
                12 => $this->fotos->existe($n->foto_path) ? 'Sim' : 'Não',
            ];
            foreach ($txt as $c => $v) {
                if ($v !== '') {
                    $ws->setCellValueExplicit([$c, $r], $v, DataType::TYPE_STRING);   // texto puro: número da nota não vira 1,2E+10 nem fórmula
                }
            }
            $ws->setCellValue([self::COL_VALOR, $r], round((float) $n->valor, 2));
            $r++;
        }
        $fim = $r - 1;
        if (! $notas) {
            $ws->mergeCells([1, $r, $ncol, $r]);
            $ws->setCellValue([1, $r], 'Nenhuma nota de Faturamento em '.self::MESES_LONGO[$m].' de '.$ano.'.');
            $ws->getStyle([1, $r])->getFont()->setItalic(true)->setColor(new Color('FF777777'));
            $fim = $r;
            $r++;
        }

        /* SUBTOTAL(9) e não SUM: com o filtro ligado o total acompanha só as linhas visíveis */
        $L = Coordinate::stringFromColumnIndex(self::COL_VALOR);
        $ws->setCellValue([1, $r], 'TOTAL');
        $ws->setCellValue([self::COL_VALOR, $r], "=SUBTOTAL(9,{$L}{$ini}:{$L}{$fim})");
        $ws->getStyle([1, $ini, $ncol, $fim])->applyFromArray($cel);
        $ws->getStyle([1, $r, $ncol, $r])->applyFromArray($tot);
        $ws->getStyle([1, $ini, 1, $fim])->getNumberFormat()->setFormatCode('dd/mm/yyyy');
        $ws->getStyle([self::COL_VALOR, $ini, self::COL_VALOR, $r])->getNumberFormat()->setFormatCode(self::BRL);
        $ws->getStyle([1, $ini, $ncol, $r])->getAlignment()->setVertical('top');
        $ws->getStyle([11, $ini, 11, $fim])->getAlignment()->setWrapText(true);
        if ($notas) {
            $ws->setAutoFilter([1, $hdrRow, $ncol, $fim]);
        }

        foreach ([12, 28, 8, 15, 34, 20, 11, 14, 14, 24, 36, 8] as $i => $w) {
            $ws->getColumnDimension(Coordinate::stringFromColumnIndex($i + 1))->setWidth($w);
        }
        $ws->freezePane('A'.($hdrRow + 1));
        $ws->getSheetView()->setZoomScale(90);
        $ws->getPageSetup()->setOrientation(PageSetup::ORIENTATION_LANDSCAPE)->setPaperSize(PageSetup::PAPERSIZE_A4)
            ->setFitToWidth(1)->setFitToHeight(0)->setRowsToRepeatAtTopByStartAndEnd($hdrRow, $hdrRow);
    }

    /** [cabeçalho, célula, linha de total, título de quadro] — os mesmos do RESUMO da equipe (RelatorioCv::abaResumo) */
    private function estilos(): array
    {
        $borda = fn ($cor) => ['allBorders' => ['borderStyle' => 'thin', 'color' => ['rgb' => $cor]]];

        return [
            ['font' => ['bold' => true, 'color' => ['rgb' => 'FFFFFF']], 'fill' => ['fillType' => 'solid', 'startColor' => ['rgb' => self::VERDE]],
                'alignment' => ['horizontal' => 'center', 'vertical' => 'center', 'wrapText' => true], 'borders' => $borda('BBBBBB')],
            ['borders' => $borda('DDDDDD')],
            ['font' => ['bold' => true], 'fill' => ['fillType' => 'solid', 'startColor' => ['rgb' => 'D1FAE5']],
                'borders' => $borda('BBBBBB') + ['top' => ['borderStyle' => 'medium', 'color' => ['rgb' => self::VERDE]]]],
            ['font' => ['bold' => true, 'size' => 13, 'color' => ['rgb' => self::VERDE]]],
        ];
    }

    private function tituloQuadro(Worksheet $ws, int $r, string $texto, array $estilo): int
    {
        $ws->mergeCells([1, $r, 8, $r]);
        $ws->setCellValue([1, $r], $texto);
        $ws->getStyle([1, $r])->applyFromArray($estilo);

        return $r + 1;
    }

    private function cabecalho(Worksheet $ws, int $r, array $cab, array $estilo): void
    {
        foreach ($cab as $i => $h) {
            $ws->setCellValue([$i + 1, $r], $h);
        }
        $ws->getStyle([1, $r, count($cab), $r])->applyFromArray($estilo);
        $ws->getRowDimension($r)->setRowHeight(28);
    }

    /** TOTAL GERAL com =SUM de cada coluna numérica (da 2ª à última) */
    private function linhaTotal(Worksheet $ws, int $r, int $ini, int $ncol, array $cel, array $tot): void
    {
        $ws->setCellValue([1, $r], 'TOTAL GERAL');
        for ($c = 2; $c <= $ncol; $c++) {
            $L = Coordinate::stringFromColumnIndex($c);
            $ws->setCellValue([$c, $r], $r > $ini ? "=SUM({$L}{$ini}:{$L}".($r - 1).')' : 0);
        }
        if ($r > $ini) {
            $ws->getStyle([1, $ini, $ncol, $r - 1])->applyFromArray($cel);
        }
        $ws->getStyle([1, $r, $ncol, $r])->applyFromArray($tot);
    }
}
