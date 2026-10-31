<?php

namespace App\Services;

use PhpOffice\PhpSpreadsheet\Spreadsheet;
use PhpOffice\PhpSpreadsheet\Style\Alignment;
use PhpOffice\PhpSpreadsheet\Style\Border;
use PhpOffice\PhpSpreadsheet\Style\Fill;
use PhpOffice\PhpSpreadsheet\Worksheet\Worksheet;
use PhpOffice\PhpSpreadsheet\Writer\Xlsx;

/**
 * "PLANILHA DE KM" (31/10/2026): modelo visual de quilometragem no padrão das planilhas de notas
 * (verde Petermann, título, cabeçalho verde, zebrado, TOTAL em faixa). Montada no servidor para o
 * estilo chegar certo em qualquer aparelho. Entrada = a resposta de GET /frota/anual
 * (leituras com user_id e odometro_anterior) + as pessoas escolhidas.
 *   RESUMO     colaborador × mês (mapa de calor) · filtro
 *   DIA A DIA  o mês dia a dia, uma coluna por pessoa · fim de semana em amarelo · filtro
 *   <pessoa>   leituras do ano da pessoa · filtro
 * Os TOTAIS usam SUBTOTAL: acompanham o filtro.
 */
class RelatorioKm
{
    private const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    private const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
    private const VERDE = '2D6A4F';
    private const ZEBRA = 'F0F4F1';
    private const FDS = 'FEF3C7';
    private const TOTAL = 'D1FAE5';
    private const FMT = '#,##0;-#,##0;"–"';

    /** @param list<array{user_id:string,nome:string}> $pessoas */
    public function gerar(array $anual, array $pessoas, int $mes): Spreadsheet
    {
        $mes = max(1, min(12, $mes));
        $ss = new Spreadsheet();
        $ss->removeSheetByIndex(0);
        $this->resumo($ss->createSheet(), $anual, $pessoas);
        $this->diaADia($ss->createSheet(), $anual, $pessoas, $mes);
        $usados = ['resumo', 'dia a dia'];
        foreach ($pessoas as $p) {
            $this->leituras($ss->createSheet(), $anual, $p, $this->nomeAba($p['nome'], $usados));
        }
        $ss->setActiveSheetIndex(0);

        return $ss;
    }

    /**
     * Planilha de CONTROLE da frota (o Excel do quadro "Planilhas de controle" do Painel): veículo × mês,
     * motorista × mês e todas as leituras do ano — no mesmo visual da planilha de KM por colaborador.
     */
    public function gerarControle(array $anual): Spreadsheet
    {
        $ss = new Spreadsheet();
        $ss->removeSheetByIndex(0);
        $this->matrizMeses($ss->createSheet(), 'VEÍCULOS', 'FROTA — KM POR VEÍCULO — '.$anual['ano'], 'Veículo',
            array_map(fn ($v) => [$v['placa'].($v['modelo'] ? ' · '.$v['modelo'] : ''), $v['meses'], $v['total'], [$v['leituras'], $v['odometro_inicial'], $v['odometro_final'], $v['responsavel_nome'] ?? '']], $anual['veiculos'] ?? []),
            ['Leituras', 'Odômetro inicial', 'Odômetro final', 'Responsável']);
        $this->matrizMeses($ss->createSheet(), 'MOTORISTAS', 'FROTA — KM POR MOTORISTA — '.$anual['ano'], 'Motorista',
            array_map(fn ($m) => [$m['nome'], $m['meses'], $m['total'], [$m['leituras']]], $anual['motoristas'] ?? []),
            ['Leituras']);
        $this->todasLeituras($ss->createSheet(), $anual);
        $ss->setActiveSheetIndex(0);

        return $ss;
    }

    /** @param list<array{0:string,1:array,2:int,3:array}> $linhas  [rótulo, 12 meses, total, extras] */
    private function matrizMeses(Worksheet $ws, string $aba, string $titulo, string $rotulo, array $linhas, array $extras): void
    {
        $ws->setTitle($aba);
        $nE = count($extras);
        $nC = 14 + $nE;
        $this->cabecalho($ws, $titulo, 'Km rodado por mês. Quanto mais km, mais forte o verde. Use as setas do cabeçalho para ordenar ou filtrar; o TOTAL acompanha o filtro.', $nC);
        $this->cabecaTabela($ws, [$rotulo, ...self::MESES, 'TOTAL', ...$extras]);
        $max = 0;
        foreach ($linhas as $l) {
            $max = max($max, ...($l[1] ?: [0]));
        }
        $r = 4;
        foreach ($linhas as $i => $l) {
            $ws->setCellValue([1, $r], $l[0]);
            foreach ($l[1] as $j => $v) {
                $ws->setCellValue([2 + $j, $r], (int) round($v));
                if ($cor = $this->calor((float) $v, (float) $max)) {
                    $this->pintar($ws, $this->col(2 + $j).$r, $cor);
                } elseif ($i % 2) {
                    $this->pintar($ws, $this->col(2 + $j).$r, self::ZEBRA);
                }
            }
            $ws->setCellValue([14, $r], (int) round($l[2]));
            foreach ($l[3] as $k => $v) {
                if ($v !== null && $v !== '') {
                    $ws->setCellValue([15 + $k, $r], is_numeric($v) ? (int) $v : (string) $v);
                }
            }
            if ($i % 2) {
                $this->pintar($ws, "A{$r}", self::ZEBRA);
                $this->pintar($ws, 'N'.$r.':'.$this->col($nC).$r, self::ZEBRA);
            }
            $ws->getStyle("N{$r}")->getFont()->setBold(true);
            $r++;
        }
        $rl = max(4, $r - 1);
        $ult = $this->col($nC);
        $ws->getStyle("B4:{$ult}{$rl}")->getNumberFormat()->setFormatCode(self::FMT);
        $ws->getStyle("B4:{$ult}{$rl}")->getAlignment()->setHorizontal(Alignment::HORIZONTAL_RIGHT);
        $this->bordas($ws, "A4:{$ult}{$rl}");
        $this->total($ws, $r, $nC, range(2, 15), 4, $rl);   // meses, TOTAL e Leituras somam; odômetros e responsável não
        $ws->getColumnDimension('A')->setWidth(max(24, min(36, 2 + max(array_map(fn ($l) => mb_strlen($l[0]), $linhas) ?: [0]))));
        foreach (range(2, 13) as $c) {
            $ws->getColumnDimension($this->col($c))->setWidth(8);
        }
        foreach (range(14, $nC) as $c) {
            $ws->getColumnDimension($this->col($c))->setWidth($c === $nC && $nE > 1 ? 24 : 15);
        }
        $ws->setAutoFilter("A3:{$ult}{$rl}");
        $ws->freezePane('B4');
    }

    private function todasLeituras(Worksheet $ws, array $anual): void
    {
        $ws->setTitle('LEITURAS');
        $this->cabecalho($ws, 'LEITURAS DE ODÔMETRO — '.$anual['ano'], 'Todas as leituras do ano. Km rodado = leitura menos a leitura anterior do mesmo veículo. Filtre por mês, placa ou motorista nas setas do cabeçalho; o TOTAL acompanha o filtro.', 11);
        $this->cabecaTabela($ws, ['Data', 'Dia', 'Mês', 'Placa', 'Modelo', 'Motorista', 'Leitura anterior', 'Leitura', 'Km rodado', 'Observação', 'Foto']);
        $ls = $anual['leituras'] ?? [];
        usort($ls, fn ($a, $b) => strcmp($a['data'], $b['data']) ?: $a['odometro'] <=> $b['odometro']);
        $max = $ls ? max(array_column($ls, 'km_rodado')) : 0;
        $r = 4;
        foreach ($ls as $i => $l) {
            $dow = (int) date('w', strtotime($l['data']));
            $ws->setCellValue([1, $r], date('d/m/Y', strtotime($l['data'])));
            $ws->setCellValue([2, $r], self::SEMANA[$dow]);
            $ws->setCellValue([3, $r], self::MESES[$l['mes'] - 1]);
            $ws->setCellValue([4, $r], $l['placa']);
            $ws->setCellValue([5, $r], $l['modelo'] ?? '');
            $ws->setCellValue([6, $r], $l['motorista'] ?? '');
            if ($l['odometro_anterior'] !== null) {
                $ws->setCellValue([7, $r], (int) $l['odometro_anterior']);
            }
            $ws->setCellValue([8, $r], (int) $l['odometro']);
            $ws->setCellValue([9, $r], (int) $l['km_rodado']);
            $ws->setCellValue([10, $r], $l['observacao'] ?? '');
            $ws->setCellValue([11, $r], ! empty($l['foto']) ? 'sim' : '');
            $base = ($dow === 0 || $dow === 6) ? self::FDS : ($i % 2 ? self::ZEBRA : null);
            if ($base) {
                $this->pintar($ws, "A{$r}:K{$r}", $base);
            }
            if ($cor = $this->calor((float) $l['km_rodado'], (float) $max)) {
                $this->pintar($ws, "I{$r}", $cor);
            }
            $r++;
        }
        $rl = max(4, $r - 1);
        $ws->getStyle("A4:D{$rl}")->getAlignment()->setHorizontal(Alignment::HORIZONTAL_CENTER);
        $ws->getStyle("K4:K{$rl}")->getAlignment()->setHorizontal(Alignment::HORIZONTAL_CENTER);
        $ws->getStyle("G4:I{$rl}")->getNumberFormat()->setFormatCode(self::FMT);
        $ws->getStyle("G4:I{$rl}")->getAlignment()->setHorizontal(Alignment::HORIZONTAL_RIGHT);
        $ws->getStyle("I4:I{$rl}")->getFont()->setBold(true);
        $this->bordas($ws, "A4:K{$rl}");
        $this->total($ws, $r, 11, [9], 4, $rl);
        foreach (['A' => 12, 'B' => 7, 'C' => 7, 'D' => 11, 'E' => 16, 'F' => 22, 'G' => 14, 'H' => 12, 'I' => 12, 'J' => 40, 'K' => 7] as $c => $w) {
            $ws->getColumnDimension($c)->setWidth($w);
        }
        $ws->setAutoFilter("A3:K{$rl}");
        $ws->freezePane('A4');
    }

    public function xlsx(Spreadsheet $ss, string $arquivo): void
    {
        (new Xlsx($ss))->save($arquivo);
    }

    private function nomeAba(string $nome, array &$usados): string
    {
        $b = trim(mb_substr(preg_replace('/[\\\\\/?*\[\]:]/', ' ', $nome ?: 'Colaborador'), 0, 28)) ?: 'Colaborador';
        $n = $b;
        $i = 2;
        while (in_array(mb_strtolower($n), $usados, true)) {
            $n = mb_substr($b, 0, 26).' '.$i++;
        }
        $usados[] = mb_strtolower($n);

        return $n;
    }

    private function cabecalho(Worksheet $ws, string $titulo, string $sub, int $nCols): void
    {
        $ult = $this->col($nCols);
        $ws->setCellValue('A1', $titulo);
        $ws->mergeCells("A1:{$ult}1");
        $ws->getStyle('A1')->getFont()->setBold(true)->setSize(16)->getColor()->setRGB(self::VERDE);
        $ws->getRowDimension(1)->setRowHeight(26);
        $ws->setCellValue('A2', $sub);
        $ws->mergeCells("A2:{$ult}2");
        $ws->getStyle('A2')->getFont()->setSize(10)->getColor()->setRGB('5A6E60');
        $ws->getStyle('A2')->getAlignment()->setWrapText(true)->setVertical(Alignment::VERTICAL_CENTER);
        $ws->getRowDimension(2)->setRowHeight(30);
        $ws->setShowGridlines(false);
        $ws->getPageSetup()->setOrientation('landscape')->setFitToWidth(1)->setFitToHeight(0);
        $ws->getSheetView()->setZoomScale(110);
    }

    /** @param list<string> $cols */
    private function cabecaTabela(Worksheet $ws, array $cols): void
    {
        foreach ($cols as $i => $t) {
            $ws->setCellValue([$i + 1, 3], $t);
        }
        $r = 'A3:'.$this->col(count($cols)).'3';
        $s = $ws->getStyle($r);
        $s->getFont()->setBold(true)->setSize(10)->getColor()->setRGB('FFFFFF');
        $s->getFill()->setFillType(Fill::FILL_SOLID)->getStartColor()->setRGB(self::VERDE);
        $s->getAlignment()->setHorizontal(Alignment::HORIZONTAL_CENTER)->setVertical(Alignment::VERTICAL_CENTER)->setWrapText(true);
        $this->bordas($ws, $r);
        $ws->getRowDimension(3)->setRowHeight(24);
    }

    private function bordas(Worksheet $ws, string $range): void
    {
        $ws->getStyle($range)->getBorders()->getAllBorders()->setBorderStyle(Border::BORDER_THIN)->getColor()->setRGB('B7C4BB');
    }

    private function col(int $n): string
    {
        return \PhpOffice\PhpSpreadsheet\Cell\Coordinate::stringFromColumnIndex($n);
    }

    private function pintar(Worksheet $ws, string $range, string $rgb): void
    {
        $ws->getStyle($range)->getFill()->setFillType(Fill::FILL_SOLID)->getStartColor()->setRGB($rgb);
    }

    private function calor(float $v, float $max): ?string
    {
        if ($v <= 0 || $max <= 0) {
            return null;
        }
        $p = $v / $max;

        return $p > 0.66 ? '95D5B2' : ($p > 0.33 ? 'B7E4C7' : 'D8F3DC');
    }

    /** linha TOTAL: rótulo + SUBTOTAL(109) nas colunas numéricas $cols (índices 1-base) */
    private function total(Worksheet $ws, int $linha, int $nCols, array $cols, int $r0, int $r1): void
    {
        $ult = $this->col($nCols);
        $ws->setCellValue([1, $linha], 'TOTAL');
        foreach ($cols as $c) {
            $L = $this->col($c);
            $ws->setCellValue([$c, $linha], "=SUBTOTAL(109,{$L}{$r0}:{$L}{$r1})");
        }
        $s = $ws->getStyle("A{$linha}:{$ult}{$linha}");
        $s->getFont()->setBold(true)->setSize(11)->getColor()->setRGB(self::VERDE);
        $this->pintar($ws, "A{$linha}:{$ult}{$linha}", self::TOTAL);
        $s->getBorders()->getTop()->setBorderStyle(Border::BORDER_MEDIUM)->getColor()->setRGB(self::VERDE);
        $s->getBorders()->getBottom()->setBorderStyle(Border::BORDER_MEDIUM)->getColor()->setRGB(self::VERDE);
        $ws->getStyle("A{$linha}")->getAlignment()->setHorizontal(Alignment::HORIZONTAL_CENTER);
        foreach ($cols as $c) {
            $ws->getStyle([$c, $linha])->getNumberFormat()->setFormatCode('#,##0');
            $ws->getStyle([$c, $linha])->getAlignment()->setHorizontal(Alignment::HORIZONTAL_RIGHT);
        }
        $ws->getRowDimension($linha)->setRowHeight(20);
    }

    private function resumo(Worksheet $ws, array $anual, array $pessoas): void
    {
        $ws->setTitle('RESUMO');
        $nC = 15;
        $this->cabecalho($ws, 'KM POR COLABORADOR — '.$anual['ano'], 'Km rodado por mês. Quanto mais km, mais forte o verde. Use as setas do cabeçalho para ordenar ou filtrar; o TOTAL acompanha o filtro.', $nC);
        $this->cabecaTabela($ws, ['Colaborador', ...self::MESES, 'TOTAL', 'Leituras']);
        $porId = [];
        foreach ($anual['motoristas'] ?? [] as $m) {
            $porId[$m['user_id']] = $m;
        }
        $max = 0;
        foreach ($pessoas as $p) {
            $max = max($max, ...($porId[$p['user_id']]['meses'] ?? [0]));
        }
        $r = 4;
        foreach ($pessoas as $i => $p) {
            $m = $porId[$p['user_id']] ?? ['meses' => array_fill(0, 12, 0), 'total' => 0, 'leituras' => 0];
            $ws->setCellValue([1, $r], $p['nome']);
            foreach ($m['meses'] as $j => $v) {
                $ws->setCellValue([2 + $j, $r], (int) round($v));
                if ($cor = $this->calor((float) $v, (float) $max)) {
                    $this->pintar($ws, $this->col(2 + $j).$r, $cor);
                } elseif ($i % 2) {
                    $this->pintar($ws, $this->col(2 + $j).$r, self::ZEBRA);
                }
            }
            $ws->setCellValue([14, $r], (int) round($m['total']));
            $ws->setCellValue([15, $r], (int) $m['leituras']);
            if ($i % 2) {
                $this->pintar($ws, "A{$r}", self::ZEBRA);
                $this->pintar($ws, "N{$r}:O{$r}", self::ZEBRA);
            }
            $ws->getStyle("N{$r}")->getFont()->setBold(true);
            $r++;
        }
        $rl = max(4, $r - 1);
        $ws->getStyle("B4:O{$rl}")->getNumberFormat()->setFormatCode(self::FMT);
        $ws->getStyle("B4:O{$rl}")->getAlignment()->setHorizontal(Alignment::HORIZONTAL_RIGHT);
        $this->bordas($ws, "A4:O{$rl}");
        $this->total($ws, $r, $nC, range(2, 15), 4, $rl);
        $ws->getColumnDimension('A')->setWidth(max(22, min(32, 2 + max(array_map(fn ($p) => mb_strlen($p['nome']), $pessoas) ?: [0]))));
        foreach (range(2, 13) as $c) {
            $ws->getColumnDimension($this->col($c))->setWidth(8);
        }
        $ws->getColumnDimension('N')->setWidth(11);
        $ws->getColumnDimension('O')->setWidth(10);
        $ws->setAutoFilter("A3:O{$rl}");
        $ws->freezePane('B4');
    }

    private function diaADia(Worksheet $ws, array $anual, array $pessoas, int $mes): void
    {
        $ws->setTitle('DIA A DIA');
        $ano = (int) $anual['ano'];
        $varias = count($pessoas) > 1;
        $nP = count($pessoas);
        $nC = 2 + $nP + ($varias ? 1 : 0);
        $this->cabecalho($ws, 'KM POR DIA — '.mb_strtoupper(self::MESES[$mes - 1]).'/'.$ano, 'Km rodado por dia, por colaborador. Sábados e domingos em amarelo; quanto mais km, mais forte o verde. Use as setas do cabeçalho para filtrar; o TOTAL acompanha o filtro.', $nC);
        $this->cabecaTabela($ws, ['Data', 'Dia', ...array_column($pessoas, 'nome'), ...($varias ? ['TOTAL DO DIA'] : [])]);
        $porPD = [];
        foreach ($anual['leituras'] ?? [] as $l) {
            if ((int) $l['mes'] === $mes) {
                $k = $l['user_id'].'|'.(int) substr($l['data'], 8);
                $porPD[$k] = ($porPD[$k] ?? 0) + (int) $l['km_rodado'];
            }
        }
        $max = $porPD ? max($porPD) : 0;
        $dias = (int) date('t', mktime(0, 0, 0, $mes, 1, $ano));
        $r = 4;
        for ($d = 1; $d <= $dias; $d++, $r++) {
            $dow = (int) date('w', mktime(0, 0, 0, $mes, $d, $ano));
            $fds = $dow === 0 || $dow === 6;
            $ws->setCellValue([1, $r], sprintf('%02d/%02d/%d', $d, $mes, $ano));
            $ws->setCellValue([2, $r], self::SEMANA[$dow]);
            $base = $fds ? self::FDS : ($d % 2 === 0 ? self::ZEBRA : null);
            if ($base) {
                $this->pintar($ws, 'A'.$r.':'.$this->col($nC).$r, $base);
            }
            $soma = 0;
            foreach ($pessoas as $j => $p) {
                $v = $porPD[$p['user_id'].'|'.$d] ?? 0;
                $soma += $v;
                $ws->setCellValue([3 + $j, $r], $v);
                if ($cor = $this->calor((float) $v, (float) $max)) {
                    $this->pintar($ws, $this->col(3 + $j).$r, $cor);
                }
            }
            if ($varias) {
                $ws->setCellValue([3 + $nP, $r], $soma);
                $ws->getStyle([3 + $nP, $r])->getFont()->setBold(true);
            }
        }
        $rl = $r - 1;
        $ult = $this->col($nC);
        $ws->getStyle("A4:B{$rl}")->getAlignment()->setHorizontal(Alignment::HORIZONTAL_CENTER);
        $ws->getStyle('C4:'.$ult.$rl)->getNumberFormat()->setFormatCode(self::FMT);
        $ws->getStyle('C4:'.$ult.$rl)->getAlignment()->setHorizontal(Alignment::HORIZONTAL_RIGHT);
        $this->bordas($ws, "A4:{$ult}{$rl}");
        $this->total($ws, $r, $nC, range(3, $nC), 4, $rl);
        $ws->getColumnDimension('A')->setWidth(12);
        $ws->getColumnDimension('B')->setWidth(7);
        $larg = max(14, min(24, 2 + max(array_map(fn ($p) => mb_strlen($p['nome']), $pessoas) ?: [0])));
        foreach (range(3, 2 + $nP) as $c) {
            $ws->getColumnDimension($this->col($c))->setWidth($larg);
        }
        if ($varias) {
            $ws->getColumnDimension($this->col(3 + $nP))->setWidth(14);
        }
        $ws->setAutoFilter("A3:{$ult}{$rl}");
        $ws->freezePane('C4');
    }

    private function leituras(Worksheet $ws, array $anual, array $p, string $aba): void
    {
        $ws->setTitle($aba);
        $this->cabecalho($ws, $p['nome'].' — LEITURAS DE '.$anual['ano'], 'Km rodado = leitura menos a leitura anterior do mesmo veículo (que pode ser de outra pessoa). Filtre por mês, placa ou dia da semana nas setas do cabeçalho; o TOTAL acompanha o filtro.', 9);
        $this->cabecaTabela($ws, ['Data', 'Dia', 'Mês', 'Placa', 'Modelo', 'Leitura anterior', 'Leitura', 'Km rodado', 'Observação']);
        $ls = array_values(array_filter($anual['leituras'] ?? [], fn ($l) => $l['user_id'] === $p['user_id']));
        usort($ls, fn ($a, $b) => strcmp($a['data'], $b['data']) ?: $a['odometro'] <=> $b['odometro']);
        $max = $ls ? max(array_column($ls, 'km_rodado')) : 0;
        $r = 4;
        foreach ($ls as $i => $l) {
            $dow = (int) date('w', strtotime($l['data']));
            $ws->setCellValue([1, $r], date('d/m/Y', strtotime($l['data'])));
            $ws->setCellValue([2, $r], self::SEMANA[$dow]);
            $ws->setCellValue([3, $r], self::MESES[$l['mes'] - 1]);
            $ws->setCellValue([4, $r], $l['placa']);
            $ws->setCellValue([5, $r], $l['modelo'] ?? '');
            if ($l['odometro_anterior'] !== null) {
                $ws->setCellValue([6, $r], (int) $l['odometro_anterior']);
            }
            $ws->setCellValue([7, $r], (int) $l['odometro']);
            $ws->setCellValue([8, $r], (int) $l['km_rodado']);
            $ws->setCellValue([9, $r], $l['observacao'] ?? '');
            $base = ($dow === 0 || $dow === 6) ? self::FDS : ($i % 2 ? self::ZEBRA : null);
            if ($base) {
                $this->pintar($ws, "A{$r}:I{$r}", $base);
            }
            if ($cor = $this->calor((float) $l['km_rodado'], (float) $max)) {
                $this->pintar($ws, "H{$r}", $cor);
            }
            $r++;
        }
        $rl = max(4, $r - 1);
        $ws->getStyle("A4:D{$rl}")->getAlignment()->setHorizontal(Alignment::HORIZONTAL_CENTER);
        $ws->getStyle("F4:H{$rl}")->getNumberFormat()->setFormatCode(self::FMT);
        $ws->getStyle("F4:H{$rl}")->getAlignment()->setHorizontal(Alignment::HORIZONTAL_RIGHT);
        $ws->getStyle("H4:H{$rl}")->getFont()->setBold(true);
        $ws->getStyle("I4:I{$rl}")->getAlignment()->setWrapText(true);
        $this->bordas($ws, "A4:I{$rl}");
        $this->total($ws, $r, 9, [8], 4, $rl);
        foreach (['A' => 12, 'B' => 7, 'C' => 7, 'D' => 11, 'E' => 16, 'F' => 14, 'G' => 12, 'H' => 12, 'I' => 40] as $c => $w) {
            $ws->getColumnDimension($c)->setWidth($w);
        }
        $ws->setAutoFilter("A3:I{$rl}");
        $ws->freezePane('A4');
    }
}
