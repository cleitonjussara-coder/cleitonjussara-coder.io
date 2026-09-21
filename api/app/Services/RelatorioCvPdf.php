<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use Dompdf\Dompdf;

/**
 * PDF da "PLANILHA DE CV" (19/09/2026). Converter a planilha inteira
 * (3 abas × 712 linhas) pelo Dompdf estourava memória e não cabia na
 * página. Aqui o PDF é montado direto dos dados, reproduzindo o modelo:
 * mesmos títulos, cores (verde do título, amarelo dos totais, mês em
 * vermelho), blocos de 4 categorias por mês e o BANCO DE DADOS com os
 * três extratos. Só os meses com lançamento entram. Paisagem A4.
 */
class RelatorioCvPdf
{
    private const MESES = [1 => 'JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];

    private const CATS = [
        'abastecimento' => 'ABASTECIMENTO',
        'hospedagem' => 'HOSPEDAGENS',
        'alimentacao' => 'ALIMENTAÇÃO',
        'outros' => "OUTROS (BORRACHARIA/OFICINA/EPI'S)",
    ];

    public function gerar(Colaborador $c, int $ano, string $arquivo): void
    {
        $notas = Nota::query()->where('user_id', $c->id)->where('deleted', false)->where('ano', $ano)
            ->orderBy('data')->orderBy('created_at')->get();
        $reps = Repasse::query()->where('user_id', $c->id)->where('deleted', false)->where('ano', $ano)
            ->where('kind', 'received')->orderBy('data')->get();

        /* agrupa: mês → categoria → notas */
        $grade = [];
        foreach ($notas as $n) {
            $grade[(int) $n->mes][$this->categoria($n)][] = $n;
        }
        ksort($grade);
        $gastoTotal = (float) $notas->sum('valor');
        $recebido = (float) $reps->sum('valor');
        $nome = mb_strtoupper($c->nome ?: $c->email);
        $e = fn ($v) => htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
        $brl = fn ($v) => 'R$ '.number_format((float) $v, 2, ',', '.');
        $num = fn ($v) => number_format((float) $v, 2, ',', '.');   // grade: sem prefixo, cabe na coluna
        $dt = fn ($d) => $d ? $d->format('d/m/Y') : '';
        $cnpj = fn ($v) => preg_match('/^\d{14}$/', (string) $v) ? preg_replace('/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/', '$1.$2.$3/$4-$5', $v) : (string) $v;

        $h = [];
        /* ── CABEÇALHO ─────────────────────────────────────── */
        $h[] = '<div class="capa"><table class="cab"><tr><th>FUNCIONÁRIO:</th><td class="vermelho">'.$e($nome).'</td></tr>'
            .'<tr><th>SAFRA:</th><td>'.$ano.'</td><th class="dir">ANO DO EXERCÍCIO:</th><td>'.$ano.'</td></tr></table>'
            .'<div class="titulo-capa">RELATÓRIO DE CUSTOS VARIÁVEIS (C.V.).</div></div>';

        /* ── BANCO DE DADOS ─────────────────────────────────── */
        $extrato = '';
        foreach ($reps as $r) {
            $extrato .= '<tr><td>'.$dt($r->data).'</td><td class="num">'.$brl($r->valor).'</td></tr>';
        }
        $h[] = '<div class="pagina"><h2 class="verde">BANCO DE DADOS — '.$e($nome).'</h2>'
            .'<table class="resumo"><tr>'
            .'<td><b>CUSTOS TOTAIS DE C.V. RECEBIDO</b><br><span class="big">'.$brl($recebido).'</span></td>'
            .'<td><b>AJUDA DE CUSTOS RECEBIDA</b><br><span class="big">'.$brl(0).'</span></td>'
            .'<td><b>REEMBOLSO DE:</b><br><span class="big">'.$brl($gastoTotal - $recebido).'</span></td></tr><tr>'
            .'<td><b>TOTAL DE GASTO ACUMULADO DE C.V.</b><br><span class="big">'.$brl($gastoTotal).'</span></td>'
            .'<td><b>TOTAL DE GASTO ACUMULADO DE AJUDA DE CUSTOS</b><br><span class="big">'.$brl(0).'</span></td>'
            .'<td><b>TOTAL PAGO</b><br><span class="big">'.$brl($recebido).'</span></td></tr><tr>'
            .'<td><b>SALDO DE C.V. RECEBIDO</b><br><span class="big '.($recebido - $gastoTotal < 0 ? 'vermelho' : '').'">'.$brl($recebido - $gastoTotal).'</span></td>'
            .'<td><b>SALDO DE AJUDA DE CUSTOS RECEBIDO</b><br><span class="big">'.$brl(0).'</span></td><td></td></tr></table>'
            .'<table class="tres"><tr><td class="col">'
            .'<h3>EXTRATO DE VALOR RECEBIDO</h3><table class="grade"><tr><th>DATA</th><th>R$</th></tr>'.($extrato ?: '<tr><td colspan="2" class="vazio">—</td></tr>')
            .'<tr class="tot"><td>TOTAL</td><td class="num">'.$brl($recebido).'</td></tr></table></td>'
            .'<td class="col"><h3>AJUDA DE CUSTO RECEBIDO</h3><table class="grade"><tr><th>DATA</th><th>R$</th></tr><tr><td colspan="2" class="vazio">—</td></tr><tr class="tot"><td>TOTAL</td><td class="num">'.$brl(0).'</td></tr></table></td>'
            .'<td class="col"><h3>REEMBOLSO DE: <span class="num">'.$brl($gastoTotal - $recebido).'</span></h3><table class="grade"><tr><th>DATA</th><th>R$</th></tr>'.($extrato ?: '<tr><td colspan="2" class="vazio">—</td></tr>')
            .'<tr class="tot"><td>TOTAL PAGO</td><td class="num">'.$brl($recebido).'</td></tr></table></td></tr></table></div>';

        /* ── RDM_RDA e CV REEMBOLSO (mesma grade) ──────────── */
        foreach (['RDM_RDA', 'CV REEMBOLSO'] as $aba) {
            $s = '<div class="pagina"><div class="faixa verde">CUSTOS VARIÁVEIS (C.V.) — '.$aba.' — '.$e($nome).'</div>'
                .'<table class="topo"><tr><td class="amarelo"><b>TOTAL DE GASTO ACUMULADO</b> '.$brl($gastoTotal).'</td>'
                .'<td><b>TOTAL RECEBIDO</b> '.$brl($recebido).'</td>'
                .'<td><b>SALDO</b> <span class="'.($recebido - $gastoTotal < 0 ? 'vermelho' : '').'">'.$brl($recebido - $gastoTotal).'</span></td></tr></table>';
            if (! $grade) {
                $s .= '<p class="vazio">Nenhum lançamento em '.$ano.'.</p>';
            }
            foreach ($grade as $mes => $cats) {
                $linhas = max(array_map('count', $cats));
                $totMes = 0;
                $s .= '<div class="bloco-mes"><div class="mes amarelo">'.self::MESES[$mes].'</div><table class="grade4">'
                    /* Dompdf ignora <col>: a 1ª linha (invisível) fixa as larguras */
                    .'<tr class="larg">'.str_repeat('<td style="width:5.5%"></td><td style="width:10.2%"></td><td style="width:4.3%"></td><td style="width:5%"></td>', 4).'</tr><tr>';
                foreach (self::CATS as $k => $rot) {
                    $s .= '<th colspan="4" class="cat">'.$e($rot).'</th>';
                }
                $s .= '</tr><tr>';
                foreach (self::CATS as $k => $rot) {
                    $s .= '<th>DATA</th><th>CNPJ DA NOTA</th><th>Nº NOTA</th><th>R$</th>';
                }
                $s .= '</tr>';
                for ($i = 0; $i < $linhas; $i++) {
                    $s .= '<tr>';
                    foreach (self::CATS as $k => $rot) {
                        $n = $cats[$k][$i] ?? null;
                        $s .= $n
                            ? '<td>'.$dt($n->data).'</td><td class="cnpj">'.$e($n->cnpj ? $cnpj($n->cnpj) : ($n->razao_social ?? '')).'</td><td>'.$e($n->numero ?? '').'</td><td class="num">'.$num($n->valor).'</td>'
                            : '<td></td><td></td><td></td><td></td>';
                    }
                    $s .= '</tr>';
                }
                $s .= '<tr class="tot">';
                foreach (self::CATS as $k => $rot) {
                    $t = array_sum(array_map(fn ($n) => (float) $n->valor, $cats[$k] ?? []));
                    $totMes += $t;
                    $s .= '<td colspan="3">TOTAL DE GASTOS</td><td class="num">'.$num($t).'</td>';
                }
                $s .= '</tr><tr class="totmes"><td colspan="16">TOTAL DO MÊS: <span class="vermelho">'.$brl($totMes).'</span></td></tr></table></div>';
            }
            $h[] = $s.'</div>';
        }

        $css = '
        @page { size: A4 landscape; margin: 9mm 8mm; }
        body { font-family: DejaVu Sans, Arial, sans-serif; font-size: 8pt; color: #111; }
        .pagina { page-break-before: always; }
        .capa { text-align: left; padding-top: 60mm; }
        .cab { font-size: 11pt; margin-bottom: 20mm; }
        .cab th { text-align: left; padding: 3px 10px 3px 0; }
        .cab th.dir { padding-left: 40px; }
        .titulo-capa { font-size: 30pt; font-weight: normal; }
        .vermelho { color: #FF0000; }
        h2.verde, .faixa.verde { background: #00B050; color: #000; font-size: 13pt; font-weight: bold; padding: 4px 8px; margin: 0 0 6px; }
        .amarelo { background: #FFFF00; }
        .topo td { border: 1px solid #999; padding: 4px 8px; font-size: 9pt; }
        .topo { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
        .bloco-mes { page-break-inside: avoid; }   /* título do mês nunca fica sozinho no fim da página */
        .mes { font-size: 16pt; font-weight: bold; color: #FF0000; padding: 3px 8px; margin-top: 8px; border: 1px solid #999; }
        table.grade4 { width: 100%; border-collapse: collapse; table-layout: fixed; margin-bottom: 4px; }
        table.grade4 th, table.grade4 td { border: 1px solid #999; padding: 2px 1px; font-size: 6.8pt; overflow: hidden; white-space: nowrap; }
        table.grade4 th { background: #f2f2f2; }
        table.grade4 tr.larg td { border: none; padding: 0; height: 0; font-size: 0; line-height: 0; }
        table.grade4 th.cat { font-size: 8pt; background: #e2efda; white-space: normal; line-height: 1.15; }
        td.num { text-align: right; }
        td.cnpj { font-size: 6pt; letter-spacing: -0.2px; }
        tr.tot td { font-weight: bold; background: #fafafa; }
        tr.totmes td { font-weight: bold; font-size: 9pt; text-align: right; background: #fff8c5; }
        table.resumo { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
        table.resumo td { border: 1px solid #999; padding: 5px 8px; width: 33%; vertical-align: top; }
        .big { font-size: 12pt; font-weight: bold; }
        table.tres { width: 100%; border-collapse: separate; border-spacing: 8px 0; }
        table.tres td.col { width: 33%; vertical-align: top; }
        table.grade { width: 100%; border-collapse: collapse; }
        table.grade th, table.grade td { border: 1px solid #999; padding: 2px 4px; }
        table.grade th { background: #f2f2f2; }
        h3 { font-size: 9.5pt; margin: 4px 0; }
        .vazio { color: #777; text-align: center; }
        ';
        $html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'.$css.'</style></head><body>'.implode('', $h).'</body></html>';
        $d = new Dompdf(['isRemoteEnabled' => false, 'defaultFont' => 'DejaVu Sans']);
        $d->setPaper('A4', 'landscape');
        $d->loadHtml($html);
        $d->render();
        file_put_contents($arquivo, $d->output());
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
}
