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
 * Mapa (aba CARTÃO CORPORATIVO — "CV ALELO" no arquivo-modelo, renomeada ao
 * gerar (14/10/2026); "RDM_RDA" nos modelos antigos —, 12 blocos mensais
 * de 4 categorias):
 *   RDM · Abastecimento → colunas A–D     RDM · Hospedagem → E–H
 *   RDA (alimentação)   → colunas I–L     RDM · Outros     → M–P
 *   colunas: DATA | CNPJ DA NOTA | Nº DA NOTA | R$
 * BANCO DE DADOS: repasses recebidos no "EXTRATO DE VALOR RECEBIDO" (B15:C94).
 * CABEÇALHO: B5 funcionário, B6 safra, I6 ano.
 * CV REEMBOLSO recebe os mesmos lançamentos da aba do cartão (RDA+RDM unificados).
 * AJUDA DE CUSTOS fica como está: o Cleiton pediu para tirar do app em
 * 24/09/2026, e a aba volta a ser preenchida à mão, se for o caso.
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

    /** Nome da aba dos gastos no cartão corporativo (pedido de 14/10/2026; o modelo ainda a chama "CV ALELO"). */
    public const ABA_CARTAO = 'CARTÃO CORPORATIVO';

    /** Como o extrato dos valores de recarga do cartão se chama (pedido de 15/10/2026; o modelo diz "RECARGA ALELO"). */
    public const ROTULO_RECARGA = 'RECARGA DE CARTÃO';


    public function modelo(): string
    {
        return resource_path('modelos/PLANILHA_CV.xlsx');
    }

    public function gerar(Colaborador $c, int $ano): Spreadsheet
    {
        $ss = IOFactory::load($this->modelo());
        /* 14/10/2026: "CV ALELO" passa a se chamar CARTÃO CORPORATIVO na planilha entregue. setTitle() já troca o nome
           dentro das fórmulas (BANCO DE DADOS!B9 = 'CV ALELO'!F2 vira 'CARTÃO CORPORATIVO'!F2, com as aspas). */
        if (($abaCartao = $this->abaDoCartao($ss)) && $abaCartao->getTitle() !== self::ABA_CARTAO) {
            $abaCartao->setTitle(self::ABA_CARTAO);
        }

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
             CV REEMBOLSO ← notas pagas do próprio bolso (pagamento=carteira, era
             'reembolso') — é dela que o BANCO DE DADOS tira o "REEMBOLSO DE"
             (gastos − total pago).
           • RDM/RDA (dinheiro em conta): como antes (19/09/2026) — as duas
             grades recebem os MESMOS lançamentos.
           25/09/2026: nota de Faturamento (pagamento=empresa) não entra em nenhuma
           das duas grades — a planilha não tem coluna pra isso; ela só soma no
           painel geral da equipe, não na planilha individual do colaborador. */
        if ($c->usaCartao()) {
            $doBolso = $notas->filter(fn (Nota $n) => $n->pagamento === 'carteira');
            $noCartao = $notas->reject(fn (Nota $n) => in_array($n->pagamento, ['carteira', 'empresa'], true));
            if ($ws = $this->abaDoCartao($ss)) {
                $this->preencherGrade($ws, $noCartao);
            }
            if ($ws = $ss->getSheetByName('CV REEMBOLSO')) {
                $this->preencherGrade($ws, $doBolso);
            }
        } else {
            $semFaturamento = $notas->reject(fn (Nota $n) => $n->pagamento === 'empresa');
            foreach ([$this->abaDoCartao($ss), $ss->getSheetByName('CV REEMBOLSO')] as $ws) {
                if ($ws) {
                    $this->preencherGrade($ws, $semFaturamento);
                }
            }
        }

        /* ── BANCO DE DADOS: extrato de valor recebido ─────── */
        $bd = $ss->getSheetByName('BANCO DE DADOS');
        /* 15/10/2026: o rótulo do extrato de recarga deixa de citar a marca do cartão. O título é mesclado (B13:C13) e
           ganha 2 letras; o texto encolhe para caber em vez de ser cortado na borda. */
        $rotulo = (string) $bd->getCell('B13')->getValue();
        if (str_contains($rotulo, 'RECARGA ALELO')) {
            $bd->setCellValue('B13', str_replace('RECARGA ALELO', self::ROTULO_RECARGA, $rotulo));
            $bd->getStyle('B13')->getAlignment()->setShrinkToFit(true);
        }
        /* 04/11/2026: mesma regra de recebido do saldo anterior, para o ano não somar diferente dos anos passados */
        $reps = SaldoAnterior::recebidos(Repasse::query()->where('user_id', $c->id)->where('deleted', false)->where('ano', $ano))
            ->when(! $c->usaCartao(), fn ($q) => SaldoAnterior::semRecarga($q))->orderBy('data')->get();
        /* RDM/RDA (19/09/2026): repasse RECEBIDO entra nas duas colunas —
           "EXTRATO DE VALOR RECEBIDO" (B/C), que alimenta o saldo de C.V., e
           "REEMBOLSO DE / TOTAL PAGO" (I/J).
           CV (24/09/2026): são dois caminhos distintos, e cada um tem a sua
           coluna — RECARGA do cartão pré-pago em B/C (é dela que sai o saldo
           do cartão) e REEMBOLSO ao colaborador em I/J. Lançamento antigo,
           sem destino gravado, conta como reembolso: era assim que o
           relatório o tratava antes desta separação. */
        $this->separarReembolso($bd);
        $linhaExtrato = 15;      // B/C — recarga
        $linhaReembolso = ['RDM' => 15, 'RDA' => 15];    // I/J — reembolso RDM; L/M — reembolso RDA
        foreach ($reps as $r) {
            $dt = XlsDate::PHPToExcel($r->data->format('Y-m-d'));
            $ehRecarga = $c->usaCartao() && $r->destino === 'recarga';
            if (! $c->usaCartao() || $ehRecarga) {
                if ($linhaExtrato <= 94) {
                    $bd->setCellValue([2, $linhaExtrato], $dt);
                    $bd->setCellValue([3, $linhaExtrato], (float) $r->valor);
                    $linhaExtrato++;
                }
            }
            if (! $ehRecarga) {
                $tipo = $r->tipo === 'RDA' ? 'RDA' : 'RDM';
                $col = $tipo === 'RDA' ? 12 : 9;
                if ($linhaReembolso[$tipo] <= 94) {
                    $bd->setCellValue([$col, $linhaReembolso[$tipo]], $dt);
                    $bd->setCellValue([$col + 1, $linhaReembolso[$tipo]], (float) $r->valor);
                    $linhaReembolso[$tipo]++;
                }
            }
        }

        $this->abrirTotalRecebido($ss);
        $this->escreverSaldoAnterior($c, $ano, $bd);

        $ss->setActiveSheetIndex(0);

        return $ss;
    }

    /**
     * "Saldo do ano anterior" no BANCO DE DADOS (04/11/2026), em células livres do modelo, sem deslocar nada:
     *   I6:J7 cartão, ao lado do quadro B:D (F:H ficam ocultas no modelo; o logo ocupa A1:E4). B11 passa a somar I7;
     *   I12/J12 e L12/M12 reembolso RDM e RDA, logo acima de cada "REEMBOLSO DE:", que desconta J12/M12 (separarReembolso).
     * Fora do C.V. não há cartão: I7 traz RDM + RDA, porque ali o extrato B/C recebe os dois.
     */
    private function escreverSaldoAnterior(Colaborador $c, int $ano, \PhpOffice\PhpSpreadsheet\Worksheet\Worksheet $bd): void
    {
        $svc = app(SaldoAnterior::class);
        $saldo = $svc->de($c, $ano);
        $tipos = $svc->porTipo($c, $saldo);

        $bd->mergeCells('I6:J6');
        $bd->mergeCells('I7:J7');
        foreach (['B6' => 'I6', 'D6' => 'J6', 'B7' => 'I7', 'D7' => 'J7'] as $de => $para) {
            $bd->duplicateStyle($bd->getStyle($de), $para);
        }
        $bd->setCellValue('I6', SaldoAnterior::ROTULO.($c->usaCartao() ? ' (CARTÃO)' : ''));
        $bd->setCellValue('I7', $c->usaCartao() ? $saldo['cartao'] : round($tipos['RDM'] + $tipos['RDA'], 2));
        $bd->setCellValue('B11', '=B7+I7-B9');

        foreach ([['I', 'J', 'RDM'], ['L', 'M', 'RDA']] as [$rotulo, $valor, $tipo]) {
            $bd->duplicateStyle($bd->getStyle("{$rotulo}13"), "{$rotulo}12");
            $bd->duplicateStyle($bd->getStyle("{$valor}13"), "{$valor}12");
            $bd->getStyle("{$rotulo}12")->getAlignment()->setWrapText(true)->setVertical('center');
            $bd->getStyle("{$valor}12")->getAlignment()->setVertical('center');
            $bd->setCellValue("{$rotulo}12", SaldoAnterior::ROTULO.' '.$tipo);
            $bd->setCellValue("{$valor}12", $tipos[$tipo]);
        }
    }

    /**
     * Reembolso separado em RDM e RDA no BANCO DE DADOS (03/11/2026, pedido do Cleiton): I/J fica com o RDM e L/M, com o
     * mesmo visual, com o RDA. Cada bloco tem o seu "REEMBOLSO DE" (gasto da aba CV REEMBOLSO − total pago dele) e J96 soma
     * os dois TOTAL PAGO, para a faixa da aba CV REEMBOLSO. Na grade, RDA é a coluna Alimentação (L) e RDM são as outras três
     * (D, H e P): é a mesma regra de categoria(), que manda toda nota RDA para Alimentação e nenhuma RDM para lá.
     */
    private function separarReembolso(\PhpOffice\PhpSpreadsheet\Worksheet\Worksheet $bd): void
    {
        foreach (range(13, 95) as $linha) {
            $bd->duplicateStyle($bd->getStyle("I$linha"), "L$linha");
            $bd->duplicateStyle($bd->getStyle("J$linha"), "M$linha");
        }
        $bd->getColumnDimension('K')->setWidth(4);
        foreach (['I' => 22, 'J' => 16.3, 'L' => 22, 'M' => 16.3] as $col => $largura) {
            $bd->getColumnDimension($col)->setWidth($largura);
        }

        $gasto = fn (array $colunas) => 'SUM('.implode(',', array_merge(...array_map(
            fn (string $col) => array_map(fn (array $b) => "'CV REEMBOLSO'!$col{$b[1]}", array_values(self::BLOCOS)),
            $colunas
        ))).')';
        $bd->setCellValue('I13', 'REEMBOLSO RDM DE:');
        /* 04/11/2026: J12/M12 = saldo do ano anterior (recebido − gasto); negativo aumenta o que falta reembolsar */
        $bd->setCellValue('J13', '='.$gasto(['D', 'H', 'P']).'-J95-J12');
        $bd->setCellValue('L13', 'REEMBOLSO RDA DE:');
        $bd->setCellValue('M13', '='.$gasto(['L']).'-M95-M12');
        $bd->setCellValue('L14', 'DATA');
        $bd->setCellValue('M14', 'R$');
        $bd->setCellValue('I95', 'TOTAL PAGO RDM');
        $bd->setCellValue('L95', 'TOTAL PAGO RDA');
        $bd->setCellValue('M95', '=SUM(M15:M94)');

        $bd->duplicateStyle($bd->getStyle('I95'), 'I96');
        $bd->duplicateStyle($bd->getStyle('J95'), 'J96');
        $bd->setCellValue('I96', 'TOTAL PAGO');
        $bd->setCellValue('J96', '=J95+M95');
    }

    /**
     * Faixa do topo das abas de gasto — TOTAL DE GASTO ACUMULADO | TOTAL RECEBIDO | SALDO (16/10/2026, pedido do Cleiton).
     *
     * No modelo, "TOTAL RECEBIDO" é um rótulo mesclado em G2:J2 e o valor fica em K2 — coluna OCULTA (C, G, K e O são as
     * colunas "Nº DA NOTA"), então o valor nunca aparecia na tela. Aqui o rótulo encolhe para G2:I2 e o valor passa para
     * J2, visível, como nos outros dois quadros (rótulo mesclado + valor ao lado).
     *
     * Cada aba usa o SEU recebido, o mesmo que o PDF já usava: CARTÃO CORPORATIVO = recargas (BANCO DE DADOS!C95) e
     * CV REEMBOLSO = reembolsos pagos, RDM + RDA (BANCO DE DADOS!J96). O modelo ligava as duas ao total de recargas.
     *
     * O SALDO do modelo era "=D2-H2", células vazias de rótulos mesclados: dava sempre R$ 0,00. Vira recebido − gasto,
     * como o "SALDO DE C.V. RECEBIDO" do BANCO DE DADOS e como o PDF (negativo = a empresa ainda deve).
     *
     * 04/11/2026: a linha 1 abre "SALDO DO ANO ANTERIOR" bem acima do SALDO (L1:O1 e P1), que passa a somá-lo. A linha 2 está
     * cheia e o título mesclado A1:P1 encolhe para A1:J1 (K é oculta). Os valores vêm do BANCO DE DADOS, um número só.
     */
    private function abrirTotalRecebido(Spreadsheet $ss): void
    {
        $abas = [
            [$this->abaDoCartao($ss), "='BANCO DE DADOS'!C95", "='BANCO DE DADOS'!I7"],
            [$ss->getSheetByName('CV REEMBOLSO'), "='BANCO DE DADOS'!J96", "='BANCO DE DADOS'!J12+'BANCO DE DADOS'!M12"],
        ];
        foreach ($abas as [$ws, $recebido, $anterior]) {
            /* só mexe se o modelo for o que conhecemos (rótulo em G2): outro layout fica como está */
            if (! $ws || (string) $ws->getCell('G2')->getValue() !== 'TOTAL RECEBIDO') {
                continue;
            }
            $ws->unmergeCells('G2:J2');
            $ws->mergeCells('G2:I2');
            $ws->duplicateStyle($ws->getStyle('K2'), 'J2');   // cinza, negrito 16, centralizado, contorno do quadro
            $ws->getStyle('J2')->getNumberFormat()->setFormatCode('"R$"\\ #,##0.00');   // o mesmo formato dos outros valores
            $ws->setCellValue('J2', $recebido);
            $ws->setCellValue('K2', null);

            $ws->unmergeCells('A1:P1');
            $ws->mergeCells('A1:J1');
            $ws->mergeCells('L1:O1');
            foreach (['L', 'M', 'N', 'O', 'P'] as $col) {
                $ws->duplicateStyle($ws->getStyle("{$col}2"), "{$col}1");
            }
            $ws->setCellValue('L1', SaldoAnterior::ROTULO);
            $ws->setCellValue('P1', $anterior);
            $ws->setCellValue('P2', '=P1+J2-F2');
        }
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
            if ($n->temCnpj() && preg_match('/^\d{14}$/', $n->cnpj)) {
                $ws->setCellValue([$col + 1, $row], (int) $n->cnpj);   // o modelo formata 00.000.000/0000-00
            } elseif ($n->cnpjParaPlanilha() !== '') {
                /* sem CNPJ vale a razão social (como sempre); os 14 zeros (21/10/2026) não viram 00.000.000/0000-00 */
                $ws->setCellValueExplicit([$col + 1, $row], $n->cnpjParaPlanilha(), \PhpOffice\PhpSpreadsheet\Cell\DataType::TYPE_STRING);
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

    /**
     * A aba dos gastos no cartão: na planilha entregue chama-se CARTÃO CORPORATIVO;
     * no arquivo-modelo oficial de 2026 ainda é "CV ALELO"; nos modelos anteriores
     * era "RDM_RDA". Aceitar os três evita que uma planilha antiga volte com a
     * grade vazia e sem aviso (24/09/2026).
     */
    private function abaDoCartao(\PhpOffice\PhpSpreadsheet\Spreadsheet $ss): ?\PhpOffice\PhpSpreadsheet\Worksheet\Worksheet
    {
        foreach ([self::ABA_CARTAO, 'CV ALELO', 'RDM_RDA'] as $nome) {
            if ($ws = $ss->getSheetByName($nome)) {
                return $ws;
            }
        }

        return null;
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
     * caracteres por aba; a maior das quatro (CARTÃO CORPORATIVO) tem 18, sobram 12 para o prefixo.
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
            $ss = $c->usaCartao() ? $this->gerar($c, $ano) : app(RelatorioRdmRda::class)->gerar($c, $ano);
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
     * regra de categoria da grade RDM_RDA; "Recebido" = repasse received, sem a recarga do cartão.
     *
     * 04/11/2026, decisão do dono: com C.V. na lista não existe um Saldo só. Cartão, reembolso e RDM/RDA saem em colunas
     * separadas, cada total só com a sua conta, nos números da planilha de cada um (SaldoAnterior). A soma antiga fazia um
     * crédito de cartão esconder o reembolso que a empresa deve. Sem ninguém do C.V., a aba segue igual.
     */
    public function abaResumo(Spreadsheet $master, iterable $colabs, int $ano): void
    {
        $colabs = collect($colabs)->values();
        $ids = $colabs->pluck('id')->all();
        $cats = ['abastecimento' => 'Abastecimento', 'hospedagem' => 'Hospedagem', 'alimentacao' => 'Alimentação (RDA)', 'outros' => 'Outros'];
        $meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
        $usaCartao = $colabs->mapWithKeys(fn ($c) => [$c->id => $c->usaCartao()]);
        $temCv = $usaCartao->contains(true);

        /* as contas que esta lista tem: de quem cada uma é e como se lê do SaldoAnterior */
        $somaTipos = fn (array $t) => round($t['RDM'] + $t['RDA'], 2);
        $contas = [];
        if ($temCv) {
            $contas['cartao'] = ['nome' => 'Cartão C.V.', 'cv' => true, 'saldo' => fn (array $s) => $s['cartao']];
            $contas['reembolso'] = ['nome' => 'Reembolso C.V.', 'cv' => true, 'saldo' => fn (array $s) => $somaTipos($s['reembolso'])];
        }
        if (! $temCv || $usaCartao->contains(false)) {
            $contas['rdm'] = ['nome' => 'RDM/RDA', 'cv' => false, 'saldo' => fn (array $s) => $somaTipos($s['saldo'])];
        }
        $rotulo = fn (array $conta, string $t) => $temCv ? "{$conta['nome']}: {$t}" : ucfirst($t);

        /* ── agrega: [user][cat], [user][mes], [mes][cat], recebido e recarga por user e por mes, movimento de cada conta por mes ── */
        $gCat = $gMes = $mCat = $rec = $recMes = $recarga = $recargaMes = $movMes = [];
        foreach ($ids as $id) {
            $gCat[$id] = array_fill_keys(array_keys($cats), 0.0);
            $gMes[$id] = array_fill(1, 12, 0.0);
            $rec[$id] = 0.0;
            $recarga[$id] = 0.0;
        }
        for ($m = 1; $m <= 12; $m++) {
            $mCat[$m] = array_fill_keys(array_keys($cats), 0.0);
            $recMes[$m] = 0.0;
            $recargaMes[$m] = 0.0;
            $movMes[$m] = ['cartao' => 0.0, 'reembolso' => 0.0, 'rdm' => 0.0];
        }
        /* 22/10/2026: sem as notas de Faturamento (pagamento=empresa), como nas abas de cada um e nos outros relatórios —
           a empresa pagou direto, não é gasto do colaborador. Antes entravam aqui e o Saldo do RESUMO saía negativo à toa. */
        Nota::query()->whereIn('user_id', $ids)->where('deleted', false)->where('ano', $ano)
            ->where(fn ($q) => $q->where('pagamento', '!=', 'empresa')->orWhereNull('pagamento'))
            ->select('user_id', 'tipo', 'subtipo', 'valor', 'mes', 'pagamento')->cursor()->each(function (Nota $n) use (&$gCat, &$gMes, &$mCat, &$movMes, $usaCartao) {
                $m = (int) $n->mes;
                if ($m < 1 || $m > 12) {
                    return;
                }
                $c = $this->categoria($n);
                $v = (float) $n->valor;
                $gCat[$n->user_id][$c] += $v;
                $gMes[$n->user_id][$m] += $v;
                $mCat[$m][$c] += $v;
                $movMes[$m][! $usaCartao[$n->user_id] ? 'rdm' : ($n->pagamento === 'carteira' ? 'reembolso' : 'cartao')] -= $v;
            });
        /* 04/11/2026: recarga não é dinheiro recebido. No C.V. tem coluna própria e entra no cartão; no RDM/RDA fica fora, como
           em gerar(), senão o Saldo não fecha com a planilha da pessoa nem com Arquivos */
        SaldoAnterior::recebidos(Repasse::query()->whereIn('user_id', $ids)->where('deleted', false)->where('ano', $ano))
            ->select('user_id', 'valor', 'mes', 'destino')->cursor()->each(function (Repasse $r) use (&$rec, &$recMes, &$recarga, &$recargaMes, &$movMes, $usaCartao) {
                $cv = $usaCartao[$r->user_id];
                if ($r->destino === 'recarga' && ! $cv) {
                    return;
                }
                $m = (int) $r->mes;
                $noAno = $m >= 1 && $m <= 12;
                $v = (float) $r->valor;
                if ($r->destino === 'recarga') {
                    $recarga[$r->user_id] += $v;
                    if ($noAno) {
                        $recargaMes[$m] += $v;
                        $movMes[$m]['cartao'] += $v;
                    }

                    return;
                }
                $rec[$r->user_id] += $v;
                if ($noAno) {
                    $recMes[$m] += $v;
                    $movMes[$m][$cv ? 'reembolso' : 'rdm'] += $v;
                }
            });

        /* ── estilos ── */
        $ws = $master->createSheet();
        $ws->setTitle('RESUMO');
        $verde = '2D6A4F';
        $brl = 'R$ #,##0.00;[Red]-R$ #,##0.00';
        /* mesma frase de SaldoAnterior::sentido; a célula continua número, então o filtro e as somas do Excel funcionam */
        $brlSentido = 'R$ #,##0.00" a favor da empresa";[Red]-R$ #,##0.00" a empresa deve";R$ 0.00';
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
        $legenda = $temCv
            ? 'Contas separadas, que não se somam: '.implode(', ', array_column($contas, 'nome')).'. Cada total soma só a sua conta. Saldo = saldo do ano anterior + o que entrou − o que saiu'
            : 'Saldo = Saldo do ano anterior + Recebido − Total gasto (negativo = a reembolsar)';
        $ws->setCellValue([1, $r], sprintf('%d colaborador(es) · gerado em %s · %s', $colabs->count(), now('America/Sao_Paulo')->format('d/m/Y H:i'), $legenda));
        $ws->getStyle([1, $r])->getFont()->setItalic(true)->setSize(10)->setColor(new \PhpOffice\PhpSpreadsheet\Style\Color('FF666666'));
        $r += 2;

        /* ── Quadro 1: por colaborador ── */
        $ws->mergeCells([1, $r, 8, $r]);
        $ws->setCellValue([1, $r], '1 · POR COLABORADOR');
        $ws->getStyle([1, $r])->applyFromArray($titulo);
        $r++;
        /* 04/11/2026: cada conta tem o saldo trazido e o saldo; quem não é do regime da conta fica em branco, não em zero */
        $cab = array_merge(['Colaborador'], array_values($cats), ['Total gasto', 'Recebido'], $temCv ? ['Recargas do cartão'] : []);
        foreach ($contas as $conta) {
            array_push($cab, $rotulo($conta, 'saldo do ano anterior'), $rotulo($conta, 'saldo'));
        }
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
        $totRecarga = 0.0;
        $totAnt = array_fill_keys(array_keys($contas), 0.0);
        $totSaldo = $totAnt;
        $svcSaldo = app(SaldoAnterior::class);
        $anteriores = $svcSaldo->deTodos($ano, $ids);
        $fins = $svcSaldo->deTodos($ano + 1, $ids);   // pedir o ano seguinte dá o saldo até dezembro, o mesmo da planilha de cada um
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
            if ($temCv) {
                $ws->setCellValue([$i++, $r], $usaCartao[$id] ? round($recarga[$id], 2) : null);
            }
            foreach ($contas as $k => $conta) {
                if ($conta['cv'] === $usaCartao[$id]) {
                    $ant = $conta['saldo']($anteriores[$id] ?? SaldoAnterior::zerado());
                    $saldo = $conta['saldo']($fins[$id] ?? SaldoAnterior::zerado());
                    $ws->setCellValue([$i, $r], $ant);
                    $ws->setCellValue([$i + 1, $r], $saldo);
                    $totAnt[$k] += $ant;
                    $totSaldo[$k] += $saldo;
                }
                $i += 2;
            }
            $totRec += $rec[$id];
            $totRecarga += $recarga[$id];
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
        if ($temCv) {
            $ws->setCellValue([$i++, $r], round($totRecarga, 2));
        }
        $iniContas = $i;
        foreach (array_keys($contas) as $k) {
            $ws->setCellValue([$i++, $r], round($totAnt[$k], 2));
            $ws->setCellValue([$i++, $r], round($totSaldo[$k], 2));
        }
        $ws->getStyle([1, $ini1, count($cab), $fim1])->applyFromArray($cel);
        $ws->getStyle([1, $r, count($cab), $r])->applyFromArray($tot);
        $ws->getStyle([2, $ini1, count($cab), $r])->getNumberFormat()->setFormatCode($brl);
        if ($temCv) {
            $ws->getStyle([$iniContas, $ini1, count($cab), $r])->getNumberFormat()->setFormatCode($brlSentido);
        }
        $ws->setAutoFilter([1, $hdr1, count($cab), $fim1]);
        $r += 3;

        /* ── Quadro 2: por mês (equipe inteira) ── */
        $ws->mergeCells([1, $r, 8, $r]);
        $ws->setCellValue([1, $r], '2 · POR MÊS (EQUIPE INTEIRA)');
        $ws->getStyle([1, $r])->applyFromArray($titulo);
        $r++;
        $cab2 = array_merge(['Mês'], array_values($cats), ['Total gasto', 'Recebido'], $temCv ? ['Recargas do cartão'] : [], array_map(fn ($conta) => $rotulo($conta, 'saldo'), array_values($contas)));
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
            if ($temCv) {
                $ws->setCellValue([$i++, $r], round($recargaMes[$m], 2));
            }
            foreach (array_keys($contas) as $k) {
                $ws->setCellValue([$i++, $r], round($movMes[$m][$k], 2));
            }
            $r++;
        }
        /* a linha entra na soma do TOTAL GERAL de cada conta, que assim fecha com o quadro 1 */
        $ws->setCellValue([1, $r], 'Saldo do ano anterior');
        $iniContas2 = count($cab2) - count($contas) + 1;
        foreach (array_keys($contas) as $n => $k) {
            $ws->setCellValue([$iniContas2 + $n, $r], round($totAnt[$k], 2));
        }
        $r++;
        $ws->setCellValue([1, $r], 'TOTAL GERAL');
        for ($c = 2; $c <= count($cab2); $c++) {
            $L = $colL($c);
            $ws->setCellValue([$c, $r], "=SUM({$L}{$ini2}:{$L}".($r - 1).')');
        }
        $ws->getStyle([1, $ini2, count($cab2), $r - 1])->applyFromArray($cel);
        $ws->getStyle([1, $r, count($cab2), $r])->applyFromArray($tot);
        $ws->getStyle([2, $ini2, count($cab2), $r])->getNumberFormat()->setFormatCode($brl);
        if ($temCv) {   // nos meses é movimento, não saldo: a frase só no que é saldo mesmo
            $ws->getStyle([$iniContas2, $r - 1, count($cab2), $r])->getNumberFormat()->setFormatCode($brlSentido);
        }
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
        if ($temCv) {   // com a frase, a largura de 15 viraria ##### no Excel
            for ($c = $iniContas2; $c <= count($cab); $c++) {
                $ws->getColumnDimension($colL($c))->setWidth(32);
            }
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

    /**
     * Primeiro nome sem acento/espaço, único entre os já usados (Ana, Ana2, Ana3…).
     * Prefixo + "_" + a maior aba (CARTÃO CORPORATIVO, 18) cabe nos 31 caracteres do Excel
     * com no máximo 12 — o limite conta o número que desempata (14/10/2026: eram 14 letras
     * quando a maior aba tinha 14; com o nome novo a aba estouraria e o setTitle() lançaria exceção).
     */
    private function prefixoAba(string $nome, array &$usados): string
    {
        $primeiro = strtok(trim($nome), " \t@") ?: 'Colab';
        $ascii = \Illuminate\Support\Str::ascii($primeiro);
        $base = preg_replace('/[^A-Za-z0-9]/', '', $ascii) ?: 'Colab';
        $max = 31 - 1 - mb_strlen(self::ABA_CARTAO);
        for ($i = 1;; $i++) {
            $sufixo = $i > 1 ? (string) $i : '';
            $p = mb_substr($base, 0, $max - strlen($sufixo)).$sufixo;
            if (! isset($usados[$p])) {
                break;
            }
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
        $this->enxugar($ss, 'BANCO DE DADOS', 'N', 96);
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
