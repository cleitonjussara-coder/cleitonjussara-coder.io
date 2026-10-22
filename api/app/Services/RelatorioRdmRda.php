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
 *   R.D.A           12 blocos de 15 linhas em DUAS colunas (B–D e E–G): 30 notas/mês (fevereiro: 14 linhas).
 *                   Jan e Fev têm uma linha de cabeçalho abaixo do rótulo; Mar–Dez começam os dados na linha
 *                   seguinte — ver primeiraLinhaRda().
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

        /* 25/09/2026: nota de Faturamento (pagamento=empresa) não é gasto DO
           colaborador — sai da planilha individual dele, só soma no painel geral. */
        $notas = Nota::query()->where('user_id', $c->id)->where('deleted', false)->where('ano', $ano)
            ->where(fn ($q) => $q->where('pagamento', '!=', 'empresa')->orWhereNull('pagamento'))
            ->orderBy('data')->orderBy('created_at')->get();

        /* ── R.D.M. ─────────────────────────────────────────── */
        $rdm = $ss->getSheetByName('R.D.M.');
        $rda = $ss->getSheetByName('R.D.A');
        /* 15/10/2026: o modelo traz SALDO = gasto − recebido (J2 =D2-G2), o que dá negativo para quem recebeu mais do que gastou.
           Saldo é recebido − gasto, como no PDF e na aba BANCO DE DADOS. */
        $rdm->setCellValue('J2', '=G2-D2');

        /* 15/10/2026: lançou mais do que cabe no bloco do mês → o bloco ganha linhas (antes as notas excedentes eram descartadas
           com um aviso). As linhas entram antes da última de dados, para que as fórmulas SUM do TOTAL e as referências da aba
           BANCO DE DADOS acompanhem; os blocos seguintes descem junto, e $blocosRdm/$blocosRda guardam as posições já deslocadas. */
        $contaRdm = [];
        foreach ($notas->where('tipo', 'RDM') as $n) {
            $contaRdm[(int) $n->mes][$this->categoriaRdm($n)] = ($contaRdm[(int) $n->mes][$this->categoriaRdm($n)] ?? 0) + 1;
        }
        $contaRda = [];
        foreach ($notas->where('tipo', 'RDA') as $n) {
            $contaRda[(int) $n->mes] = ($contaRda[(int) $n->mes] ?? 0) + 1;
        }
        $extraRdm = [];
        foreach (self::RDM as $m => [$ini, $tot]) {
            $extraRdm[$m] = max(0, max($contaRdm[$m] ?? [0]) - ($tot - $ini - 1));
        }
        $extraRda = [];
        foreach (self::RDA as $m => [$ini, $tot]) {
            $extraRda[$m] = max(0, (int) ceil(($contaRda[$m] ?? 0) / 2) - ($tot - $this->primeiraLinhaRda($rda, $ini)));
        }
        $this->abrirLinhas($rdm, self::RDM, $extraRdm, 10);
        $this->abrirLinhas($rda, self::RDA, $extraRda, 7);
        $blocosRdm = $this->deslocar(self::RDM, $extraRdm);
        $blocosRda = $this->deslocar(self::RDA, $extraRda);
        if (array_sum($extraRdm) + array_sum($extraRda) > 0) {
            /* o PhpSpreadsheet não reescreve referências a abas com ponto no nome (R.D.M., R.D.A): refaz as da BANCO DE DADOS */
            $bd0 = $ss->getSheetByName('BANCO DE DADOS');
            $somaRda = [];
            foreach ($blocosRdm as $m => [$ini, $tot]) {
                $bd0->setCellValue([12 + $m, 6], '=R.D.M.!E'.($tot + 1));       // M6:X6 — total do mês, 1 linha abaixo do TOTAL
            }
            foreach ($blocosRda as $m => [$ini, $tot]) {
                $bd0->setCellValue([12 + $m, 8], '=R.D.A!G'.$tot);               // M8:X8
                $somaRda[] = 'R.D.A!G'.$tot;
            }
            $bd0->setCellValue('F9', '=SUM('.implode('+', $somaRda).')');
        }

        foreach ($blocosRdm as [$ini, $tot]) {
            $this->limpar($rdm, 2, $ini + 1, 10, $tot - 1);
        }
        $prox = [];
        $fora = 0;
        $doRdm = $notas->where('tipo', 'RDM');
        foreach ($doRdm as $n) {
            $m = (int) $n->mes;
            if (! isset($blocosRdm[$m])) {
                continue;
            }
            [$ini, $tot] = $blocosRdm[$m];
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
        foreach ($blocosRda as [$ini, $tot]) {
            $this->limpar($rda, 2, $this->primeiraLinhaRda($rda, $ini), 7, $tot - 1);
        }
        $idx = [];
        foreach ($notas->where('tipo', 'RDA') as $n) {
            $m = (int) $n->mes;
            if (! isset($blocosRda[$m])) {
                continue;
            }
            [$ini, $tot] = $blocosRda[$m];
            $primeira = $this->primeiraLinhaRda($rda, $ini);
            $linhas = $tot - $primeira;                   // 15 (14 em fevereiro, que tem cabeçalho e uma linha a menos)
            $i = $idx[$m] ?? 0;
            if ($i >= $linhas * 2) {
                $fora++;
                continue;
            }
            $col = $i < $linhas ? 2 : 5;                 // B–D depois E–G
            $row = $primeira + ($i % $linhas);
            $this->linha($rda, $col, $row, $n);
            $idx[$m] = $i + 1;
        }
        /* 15/10/2026 (pedido do cliente): linhas em branco ficam ocultas — cada mês só mostra as linhas usadas. */
        foreach ($blocosRdm as $m => [$ini, $tot]) {
            $usadas = max(0, ...array_values(array_map(fn ($r) => $r - ($ini + 1), $prox[$m] ?? [$ini + 1])));
            /* 21/10/2026: o modelo traz as linhas de dados do R.D.M. ocultas (todos os meses menos setembro): as usadas precisam reaparecer */
            $this->mostrarLinhas($rdm, $ini + 1, $ini + $usadas);
            $this->ocultarLinhas($rdm, $ini + 1 + $usadas, $tot - 1);
        }
        foreach ($blocosRda as $m => [$ini, $tot]) {
            $primeira = $this->primeiraLinhaRda($rda, $ini);
            $usadas = min($idx[$m] ?? 0, $tot - $primeira);   // a 2ª coluna só começa depois da 1ª cheia
            $this->ocultarLinhas($rda, $primeira + $usadas, $tot - 1);
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

    /**
     * Primeira linha de dados do bloco do mês no R.D.A (15/10/2026). O modelo NÃO é uniforme: janeiro e fevereiro trazem uma
     * linha de cabeçalho (DATA | CNPJ | R$) logo abaixo do rótulo do mês; de março a dezembro os dados começam já na linha
     * seguinte ao rótulo (as fórmulas SUM do modelo confirmam: =SUM(D40:D54,…) em março, =SUM(D6:D20,…) em janeiro). Assumir
     * "rótulo + 2" sempre deixava a linha de exemplo do modelo — de outra pessoa — em março a setembro, e a planilha do Edson
     * (só RDA de outubro) saía com lançamentos de meses em que ele não tinha nada. Detecta pelo cabeçalho, não pelo número do mês.
     */
    private function primeiraLinhaRda(Worksheet $ws, int $ini): int
    {
        $abaixoDoRotulo = mb_strtolower(trim((string) $ws->getCell([2, $ini + 1])->getValue()));

        return $abaixoDoRotulo === 'data' ? $ini + 2 : $ini + 1;
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

    /** insere $extra[mês] linhas no fim de cada bloco (de baixo para cima, para não deslocar as posições ainda por usar) */
    private function abrirLinhas(Worksheet $ws, array $blocos, array $extra, int $ultimaColuna): void
    {
        $ultima = \PhpOffice\PhpSpreadsheet\Cell\Coordinate::stringFromColumnIndex($ultimaColuna + 1);   // uma coluna além da última de dados
        foreach (array_reverse($blocos, true) as $m => [$ini, $tot]) {
            $n = $extra[$m] ?? 0;
            if ($n < 1) {
                continue;
            }
            $modelo = $tot - 2;                       // penúltima linha de dados: fonte do estilo
            $ws->insertNewRowBefore($tot - 1, $n);    // a última linha de dados desce; a faixa do SUM cresce
            $altura = $ws->getRowDimension($modelo)->getRowHeight();
            for ($r = $tot - 1; $r < $tot - 1 + $n; $r++) {
                $ws->duplicateStyle($ws->getStyle("A{$modelo}:{$ultima}{$modelo}"), "A{$r}:{$ultima}{$r}");
                $ws->getRowDimension($r)->setRowHeight($altura);
            }
        }
    }

    /** posições [rótulo, TOTAL] de cada mês depois das linhas inseridas nos meses anteriores e nele mesmo */
    private function deslocar(array $blocos, array $extra): array
    {
        $saida = [];
        $acum = 0;
        foreach ($blocos as $m => [$ini, $tot]) {
            $saida[$m] = [$ini + $acum, $tot + $acum + ($extra[$m] ?? 0)];
            $acum += $extra[$m] ?? 0;
        }

        return $saida;
    }

    private function ocultarLinhas(Worksheet $ws, int $r1, int $r2): void
    {
        for ($r = $r1; $r <= $r2; $r++) {
            $ws->getRowDimension($r)->setVisible(false);
        }
    }

    private function mostrarLinhas(Worksheet $ws, int $r1, int $r2): void
    {
        for ($r = $r1; $r <= $r2; $r++) {
            $ws->getRowDimension($r)->setVisible(true);
        }
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
