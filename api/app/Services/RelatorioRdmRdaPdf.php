<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use Dompdf\Dompdf;

/**
 * PDF da "PLANILHA DE RDM E RDA" (21/09/2026) — regime RDM/RDA. Como no
 * RelatorioCvPdf, o PDF é montado direto dos dados reproduzindo o modelo
 * (não converte a planilha: 1000 linhas × 4 abas não cabem no Dompdf):
 *   capa · BANCO DE DADOS (RDM e RDA separados + quadro mês/trimestre) ·
 *   R.D.M. (3 categorias por mês) · R.D.A (lista por mês).
 * Só os meses com lançamento entram. Paisagem A4.
 */
class RelatorioRdmRdaPdf
{
    private const MESES = [1 => 'JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];

    private const MES_CURTO = [1 => 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

    private const CATS = ['Abastecimento' => 'ABASTECIMENTO', 'Hospedagem' => 'HOSPEDAGENS', 'Outros' => "OUTROS (BORRACHARIA/OFICINA/EPI'S)"];

    public function gerar(Colaborador $c, int $ano, string $arquivo): void
    {
        $d = new Dompdf(['isRemoteEnabled' => false, 'defaultFont' => 'DejaVu Sans']);
        $d->setPaper('A4', 'landscape');
        $d->loadHtml($this->html($c, $ano));
        $d->render();
        file_put_contents($arquivo, $d->output());
    }

    /** O HTML do PDF (separado para inspeção no navegador). */
    public function html(Colaborador $c, int $ano): string
    {
        $notas = Nota::query()->where('user_id', $c->id)->where('deleted', false)->where('ano', $ano)
            ->orderBy('data')->orderBy('created_at')->get();
        $reps = Repasse::query()->where('user_id', $c->id)->where('deleted', false)->where('ano', $ano)
            ->where('kind', 'received')->whereNotNull('confirmado_em')->orderBy('data')->get();

        $rdm = [];   // mês → categoria → notas
        $rda = [];   // mês → notas
        $mesRdm = array_fill(1, 12, 0.0);
        $mesRda = array_fill(1, 12, 0.0);
        foreach ($notas as $n) {
            $m = (int) $n->mes;
            if ($m < 1 || $m > 12) {
                continue;
            }
            if ($n->tipo === 'RDA') {
                $rda[$m][] = $n;
                $mesRda[$m] += (float) $n->valor;
            } else {
                $rdm[$m][$this->categoriaRdm($n)][] = $n;
                $mesRdm[$m] += (float) $n->valor;
            }
        }
        ksort($rdm);
        ksort($rda);
        $gastoRdm = array_sum($mesRdm);
        $gastoRda = array_sum($mesRda);
        $repsRdm = $reps->where('tipo', 'RDM');
        $repsRda = $reps->where('tipo', 'RDA');
        $recRdm = (float) $repsRdm->sum('valor');
        $recRda = (float) $repsRda->sum('valor');

        $nome = mb_strtoupper($c->nome ?: $c->email);
        $safra = sprintf('%02d/%02d', ($ano - 1) % 100, $ano % 100);
        $e = fn ($v) => htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
        $brl = fn ($v) => 'R$ '.number_format((float) $v, 2, ',', '.');
        $num = fn ($v) => number_format((float) $v, 2, ',', '.');
        $dt = fn ($d) => $d ? $d->format('d/m/Y') : '';
        $cnpj = fn ($v) => preg_match('/^\d{14}$/', (string) $v) ? preg_replace('/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/', '$1.$2.$3/$4-$5', $v) : (string) $v;
        $neg = fn ($v) => $v < 0 ? 'vermelho' : '';

        $h = [];
        /* ── CAPA (CABEÇALHO) ───────────────────────────────── */
        $h[] = '<div class="capa"><div class="empresa">PETERMANN &amp; MORAIS LTDA ME - CNPJ 17.117.768/0001-42<br>Rua Natal Vasconcelos Montes, 185 - Sala 01. Centro. CEP.: 75.503-340 · Itumbiara, Goiás</div>'
            .'<div class="titulo-capa-top">DESPESAS CORPORATIVAS | PETERMANN &amp; MORAIS LTDA</div>'
            .'<table class="cab"><tr><th>FUNCIONÁRIO:</th><td class="vermelho">'.$e($nome).'</td></tr>'
            .'<tr><th>SAFRA:</th><td>'.$safra.'</td><th class="dir">ANO DO EXERCÍCIO:</th><td>'.$ano.'</td></tr></table>'
            .'<div class="titulo-capa">RELATÓRIO DE DESPESAS MENSAIS (RDM) E RELATÓRIO DE DESPESAS COM ALIMENTAÇÃO (RDA)</div></div>';

        /* ── BANCO DE DADOS ─────────────────────────────────── */
        $ext = function ($lista) use ($dt, $brl) {
            $s = '';
            foreach ($lista as $r) {
                $s .= '<tr><td>'.$dt($r->data).'</td><td class="num">'.$brl($r->valor).'</td></tr>';
            }

            return $s ?: '<tr><td colspan="2" class="vazio">—</td></tr>';
        };
        $trim = function (array $mes) {
            return [array_sum(array_slice($mes, 0, 3)), array_sum(array_slice($mes, 3, 3)), array_sum(array_slice($mes, 6, 3)), array_sum(array_slice($mes, 9, 3))];
        };
        $tRdm = $trim(array_values($mesRdm));
        $tRda = $trim(array_values($mesRda));
        $quadro = '<table class="quadro"><tr><th></th>';
        foreach (self::MES_CURTO as $mc) {
            $quadro .= '<th>'.$mc.'</th>';
        }
        $quadro .= '<th class="tot">TOTAL</th></tr><tr><th class="esq">RDM</th>';
        foreach ($mesRdm as $v) {
            $quadro .= '<td class="num">'.($v ? $num($v) : '') .'</td>';
        }
        $quadro .= '<td class="num tot">'.$num($gastoRdm).'</td></tr><tr><th class="esq">RDA</th>';
        foreach ($mesRda as $v) {
            $quadro .= '<td class="num">'.($v ? $num($v) : '').'</td>';
        }
        $quadro .= '<td class="num tot">'.$num($gastoRda).'</td></tr><tr class="tot"><th class="esq">TOTAL/MÊS</th>';
        foreach ($mesRdm as $m => $v) {
            $t = $v + $mesRda[$m];
            $quadro .= '<td class="num">'.($t ? $num($t) : '').'</td>';
        }
        $quadro .= '<td class="num">'.$num($gastoRdm + $gastoRda).'</td></tr></table>'
            .'<table class="quadro" style="margin-top:4px"><tr><th class="esq">Trimestres</th><th>1º (Jan–Mar)</th><th>2º (Abr–Jun)</th><th>3º (Jul–Set)</th><th>4º (Out–Dez)</th><th class="tot">TOTAL GERAL</th></tr>'
            .'<tr><th class="esq">RDM</th>'.implode('', array_map(fn ($v) => '<td class="num">'.$num($v).'</td>', $tRdm)).'<td class="num tot">'.$num($gastoRdm).'</td></tr>'
            .'<tr><th class="esq">RDA</th>'.implode('', array_map(fn ($v) => '<td class="num">'.$num($v).'</td>', $tRda)).'<td class="num tot">'.$num($gastoRda).'</td></tr>'
            .'<tr class="tot"><th class="esq">TOTAL/TRIM</th>'.implode('', array_map(fn ($i) => '<td class="num">'.$num($tRdm[$i] + $tRda[$i]).'</td>', [0, 1, 2, 3])).'<td class="num">'.$num($gastoRdm + $gastoRda).'</td></tr></table>';

        $h[] = '<div class="pagina"><h2 class="verde">BANCO DE DADOS — '.$e($nome).' — EXERCÍCIO DE '.$ano.'</h2>'
            .'<table class="resumo"><tr>'
            .'<td><b>CUSTOS TOTAIS DE RDM RECEBIDO</b><br><span class="big">'.$brl($recRdm).'</span></td>'
            .'<td><b>CUSTOS TOTAIS DE RDA RECEBIDO</b><br><span class="big">'.$brl($recRda).'</span></td></tr><tr>'
            .'<td><b>TOTAL DE GASTO ACUMULADO DE RDM</b><br><span class="big">'.$brl($gastoRdm).'</span></td>'
            .'<td><b>TOTAL DE GASTO ACUMULADO DE RDA</b><br><span class="big">'.$brl($gastoRda).'</span></td></tr><tr>'
            .'<td><b>SALDO DE RDM RECEBIDO</b><br><span class="big '.$neg($recRdm - $gastoRdm).'">'.$brl($recRdm - $gastoRdm).'</span></td>'
            .'<td><b>SALDO DE RDA RECEBIDO</b><br><span class="big '.$neg($recRda - $gastoRda).'">'.$brl($recRda - $gastoRda).'</span></td></tr></table>'
            .'<table class="tres"><tr><td class="col2">'
            .'<h3>EXTRATO DE RDM RECEBIDO</h3><table class="grade"><tr><th>DATA</th><th>R$</th></tr>'.$ext($repsRdm)
            .'<tr class="tot"><td>TOTAL</td><td class="num">'.$brl($recRdm).'</td></tr></table></td>'
            .'<td class="col2"><h3>EXTRATO DE RDA RECEBIDO</h3><table class="grade"><tr><th>DATA</th><th>R$</th></tr>'.$ext($repsRda)
            .'<tr class="tot"><td>TOTAL</td><td class="num">'.$brl($recRda).'</td></tr></table></td></tr></table>'
            .'<h3 style="margin-top:8px">GASTO POR MÊS E TRIMESTRE</h3>'.$quadro.'</div>';

        /* ── R.D.M. ─────────────────────────────────────────── */
        $s = '<div class="pagina"><div class="faixa verde">RELATÓRIO DE DESPESAS MENSAIS (R.D.M.) — '.$e($nome).' — '.$ano.'</div>'
            .'<table class="topo"><tr><td class="amarelo"><b>TOTAL DE GASTO ACUMULADO</b> '.$brl($gastoRdm).'</td>'
            .'<td><b>TOTAL RECEBIDO</b> '.$brl($recRdm).'</td>'
            .'<td><b>SALDO</b> <span class="'.$neg($recRdm - $gastoRdm).'">'.$brl($recRdm - $gastoRdm).'</span></td></tr></table>';
        if (! $rdm) {
            $s .= '<p class="vazio">Nenhuma nota RDM em '.$ano.'.</p>';
        }
        foreach ($rdm as $mes => $cats) {
            $linhas = max(array_map('count', $cats));
            $totMes = 0;
            $s .= '<div class="bloco-mes"><div class="mes amarelo">'.self::MESES[$mes].'</div><table class="grade3">'
                .'<tr class="larg">'.str_repeat('<td style="width:8%"></td><td style="width:17.3%"></td><td style="width:8%"></td>', 3).'</tr><tr>';
            foreach (self::CATS as $rot) {
                $s .= '<th colspan="3" class="cat">'.$e($rot).'</th>';
            }
            $s .= '</tr><tr>'.str_repeat('<th>DATA</th><th>CNPJ DA NOTA</th><th>R$</th>', 3).'</tr>';
            for ($i = 0; $i < $linhas; $i++) {
                $s .= '<tr>';
                foreach (self::CATS as $k => $rot) {
                    $n = $cats[$k][$i] ?? null;
                    $s .= $n
                        ? '<td>'.$dt($n->data).'</td><td class="cnpj">'.$e($n->cnpj ? $cnpj($n->cnpj) : ($n->razao_social ?? '')).'</td><td class="num">'.$num($n->valor).'</td>'
                        : '<td></td><td></td><td></td>';
                }
                $s .= '</tr>';
            }
            $s .= '<tr class="tot">';
            foreach (self::CATS as $k => $rot) {
                $t = array_sum(array_map(fn ($n) => (float) $n->valor, $cats[$k] ?? []));
                $totMes += $t;
                $s .= '<td colspan="2">TOTAL DE GASTOS</td><td class="num">'.$num($t).'</td>';
            }
            $s .= '</tr><tr class="totmes"><td colspan="9">TOTAL DO MÊS: <span class="vermelho">'.$brl($totMes).'</span></td></tr></table></div>';
        }
        $h[] = $s.'</div>';

        /* ── R.D.A ──────────────────────────────────────────── */
        $s = '<div class="pagina"><div class="faixa verde">RELATÓRIO DE DESPESAS COM ALIMENTAÇÃO (R.D.A) — '.$e($nome).' — '.$ano.'</div>'
            .'<table class="topo"><tr><td class="amarelo"><b>TOTAL DE GASTO ACUMULADO</b> '.$brl($gastoRda).'</td>'
            .'<td><b>TOTAL RECEBIDO</b> '.$brl($recRda).'</td>'
            .'<td><b>SALDO</b> <span class="'.$neg($recRda - $gastoRda).'">'.$brl($recRda - $gastoRda).'</span></td></tr></table>';
        if (! $rda) {
            $s .= '<p class="vazio">Nenhuma nota RDA em '.$ano.'.</p>';
        }
        foreach ($rda as $mes => $lista) {
            /* duas colunas como no modelo: metade de cada lado */
            $meio = (int) ceil(count($lista) / 2);
            $esq = array_slice($lista, 0, $meio);
            $dir = array_slice($lista, $meio);
            $s .= '<div class="bloco-mes"><div class="mes amarelo">'.self::MESES[$mes].'</div><table class="grade2">'
                .'<tr class="larg">'.str_repeat('<td style="width:10%"></td><td style="width:28%"></td><td style="width:12%"></td>', 2).'</tr>'
                .'<tr>'.str_repeat('<th>DATA</th><th>CNPJ</th><th>R$</th>', 2).'</tr>';
            for ($i = 0; $i < $meio; $i++) {
                $s .= '<tr>';
                foreach ([$esq, $dir] as $col) {
                    $n = $col[$i] ?? null;
                    $s .= $n
                        ? '<td>'.$dt($n->data).'</td><td class="cnpj">'.$e($n->cnpj ? $cnpj($n->cnpj) : ($n->razao_social ?? '')).'</td><td class="num">'.$num($n->valor).'</td>'
                        : '<td></td><td></td><td></td>';
                }
                $s .= '</tr>';
            }
            $s .= '<tr class="totmes"><td colspan="6">TOTAL DO MÊS: <span class="vermelho">'.$brl($mesRda[$mes]).'</span></td></tr></table></div>';
        }
        $h[] = $s.'</div>';

        $css = '
        @page { size: A4 landscape; margin: 9mm 8mm; }
        body { font-family: DejaVu Sans, Arial, sans-serif; font-size: 8pt; color: #111; background: #fff; }
        .pagina { page-break-before: always; }
        .capa { text-align: left; padding-top: 40mm; }
        .empresa { font-size: 9pt; color: #333; margin-bottom: 14mm; line-height: 1.5; }
        .titulo-capa-top { font-size: 12pt; font-weight: bold; margin-bottom: 10mm; }
        .cab { font-size: 11pt; margin-bottom: 16mm; }
        .cab th { text-align: left; padding: 3px 10px 3px 0; }
        .cab th.dir { padding-left: 40px; }
        .titulo-capa { font-size: 20pt; font-weight: normal; line-height: 1.3; }
        .vermelho { color: #FF0000; }
        h2.verde, .faixa.verde { background: #00B050; color: #000; font-size: 13pt; font-weight: bold; padding: 4px 8px; margin: 0 0 6px; }
        .amarelo { background: #FFFF00; }
        .topo td { border: 1px solid #999; padding: 4px 8px; font-size: 9pt; }
        .topo { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
        .bloco-mes { page-break-inside: avoid; }
        .mes { font-size: 16pt; font-weight: bold; color: #FF0000; padding: 3px 8px; margin-top: 8px; border: 1px solid #999; }
        table.grade3, table.grade2 { width: 100%; border-collapse: collapse; table-layout: fixed; margin-bottom: 4px; }
        table.grade3 th, table.grade3 td, table.grade2 th, table.grade2 td { border: 1px solid #999; padding: 2px 3px; font-size: 7.2pt; overflow: hidden; white-space: nowrap; }
        table.grade3 th, table.grade2 th { background: #f2f2f2; }
        tr.larg td { border: none !important; padding: 0 !important; height: 0; font-size: 0; line-height: 0; }
        table.grade3 th.cat { font-size: 8pt; background: #e2efda; white-space: normal; line-height: 1.15; }
        td.num { text-align: right; }
        td.cnpj { font-size: 6.6pt; letter-spacing: -0.2px; }
        tr.tot td { font-weight: bold; background: #fafafa; }
        tr.totmes td { font-weight: bold; font-size: 9pt; text-align: right; background: #fff8c5; }
        table.resumo { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
        table.resumo td { border: 1px solid #999; padding: 5px 8px; width: 50%; vertical-align: top; }
        .big { font-size: 12pt; font-weight: bold; }
        table.tres { width: 100%; border-collapse: separate; border-spacing: 8px 0; }
        table.tres td.col2 { width: 50%; vertical-align: top; }
        table.grade { width: 100%; border-collapse: collapse; }
        table.grade th, table.grade td { border: 1px solid #999; padding: 2px 4px; }
        table.grade th { background: #f2f2f2; }
        table.quadro { width: 100%; border-collapse: collapse; }
        table.quadro th, table.quadro td { border: 1px solid #999; padding: 3px 4px; font-size: 7.5pt; text-align: center; }
        table.quadro th { background: #e2efda; }
        table.quadro th.esq { text-align: left; background: #f2f2f2; }
        table.quadro .tot, table.quadro tr.tot td { font-weight: bold; background: #fff8c5; }
        h3 { font-size: 9.5pt; margin: 4px 0; }
        .vazio { color: #777; text-align: center; }
        ';
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'.$css.'</style></head><body>'.implode('', $h).'</body></html>';
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
}
