<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\Nota;
use Dompdf\Dompdf;

/**
 * Relatório de FATURAMENTO em PDF (26/09/2026) — as notas pagas direto pela
 * empresa (pagamento='empresa'), fora das planilhas-modelo (CV / RDM_RDA)
 * de propósito, porque o modelo da empresa não tem coluna pra isso. Aqui
 * sim: uma lista simples pra contabilidade, com quem é a nota, quem lançou
 * e o total. Só gestor/admin/contabilidade. A4 retrato, Dompdf.
 */
class RelatorioFaturamentoPdf
{
    private const MESES = [1 => 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

    private const CAT = ['abastecimento' => 'Abastecimento', 'hospedagem' => 'Hospedagem', 'outros' => 'Outros'];

    public function gerar(int $ano, int $mes, string $arquivo, ?Colaborador $gerador = null): void
    {
        $notas = Nota::query()->where('deleted', false)->where('ano', $ano)->where('mes', $mes)
            ->where('pagamento', 'empresa')
            ->orderBy('data')->orderBy('created_at')->get();

        $colabIds = $notas->pluck('user_id')->merge($notas->pluck('created_by'))->filter()->unique();
        $pessoas = Colaborador::query()->whereIn('id', $colabIds)->get()->keyBy('id');

        $e = fn ($v) => htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
        $brl = fn ($v) => 'R$ '.number_format((float) $v, 2, ',', '.');
        $dt = fn ($d) => $d ? $d->format('d/m/Y') : '';
        $cnpj = fn ($v) => preg_match('/^\d{14}$/', (string) $v) ? preg_replace('/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/', '$1.$2.$3/$4-$5', $v) : (string) $v;
        $nomeDe = fn (?string $id) => $id && $pessoas->has($id) ? ($pessoas[$id]->nome ?: $pessoas[$id]->email) : 'Desconhecido';
        /* 28/09/2026: user_id nulo aqui é sempre Faturamento sem colaborador
           (a nota escolheu não apontar ninguém) — 'Desconhecido' soaria como
           um erro de dado; isto é intencional. */
        $nomeDono = fn (?string $id) => $id === null ? 'Sem colaborador específico' : $nomeDe($id);
        $periodo = self::MESES[$mes].' / '.$ano;
        $geradoEm = now(PontoCalculo::TZ)->format('d/m/Y H:i');

        $total = (float) $notas->sum('valor');

        $h = '<div class="faixa">FATURAMENTO — PAGO DIRETO PELA EMPRESA — '.$e(mb_strtoupper($periodo)).'</div>'
            .'<div class="meta">Petermann &amp; Morais · Serviços Agronômicos · gerado em '.$geradoEm.($gerador ? ' por '.$e($gerador->nome ?: $gerador->email) : '').'</div>'
            .'<p class="nota">Notas pagas direto pela empresa, sem passar pelo colaborador — não entram no saldo nem nas planilhas de RDM/RDA ou C.V. de ninguém.</p>'
            .'<table class="kpis"><tr>'
            .'<td><span class="lbl">Total no período</span><span class="val">'.$brl($total).'</span><span class="sub">'.$notas->count().' nota'.($notas->count() === 1 ? '' : 's').'</span></td>'
            .'</tr></table>';

        $h .= '<table class="quadro"><tr><th>Data</th><th class="esq">Colaborador</th><th>Tipo</th><th>Categoria</th><th class="esq">Fornecedor</th><th>CNPJ</th><th>Valor (R$)</th><th class="esq">Lançado por</th></tr>';
        if ($notas->isEmpty()) {
            $h .= '<tr><td colspan="8" class="vazio">Nenhuma nota de Faturamento em '.$e($periodo).'.</td></tr>';
        }
        foreach ($notas as $n) {
            $cat = $n->tipo === 'RDA' ? 'Alimentação' : (self::CAT[mb_strtolower((string) $n->subtipo)] ?? ($n->subtipo ?: 'Outros'));
            $h .= '<tr><td>'.$dt($n->data).'</td><td class="esq">'.$e($nomeDono($n->user_id)).'</td>'
                .'<td><span class="tipo '.$e($n->tipo).'">'.$e($n->tipo).'</span></td><td>'.$e($cat).'</td>'
                .'<td class="esq">'.$e(mb_substr((string) ($n->razao_social ?: '—'), 0, 40)).'</td><td>'.$e($cnpj($n->cnpj)).'</td>'
                .'<td class="num">'.$brl($n->valor).'</td><td class="esq">'.$e($nomeDe($n->created_by)).'</td></tr>';
        }
        $h .= '<tr class="tot"><td colspan="6" class="esq">TOTAL</td><td class="num">'.$brl($total).'</td><td></td></tr></table>';

        $css = '
        @page { size: A4 portrait; margin: 12mm 10mm; }
        body { font-family: DejaVu Sans, Arial, sans-serif; font-size: 9pt; color: #111; }
        .faixa { background: #00B050; color: #000; font-size: 13pt; font-weight: bold; padding: 5px 8px; }
        .meta { font-size: 8pt; color: #555; margin: 3px 0 2px; }
        .nota { font-size: 8pt; color: #555; margin: 0 0 8px; }
        table.kpis { width: 100%; border-collapse: separate; margin: 0 0 10px; }
        table.kpis td { border: 1px solid #999; border-radius: 4px; padding: 8px 12px; background: #f7fbf8; }
        .lbl { display: block; font-size: 8pt; font-weight: bold; text-transform: uppercase; color: #555; }
        .val { display: block; font-size: 16pt; font-weight: bold; margin: 2px 0; }
        .sub { display: block; font-size: 8pt; color: #555; }
        table.quadro { width: 100%; border-collapse: collapse; }
        table.quadro th, table.quadro td { border: 1px solid #999; padding: 4px 6px; text-align: center; font-size: 8.5pt; }
        table.quadro th { background: #e2efda; }
        .esq { text-align: left !important; }
        .num { text-align: right !important; white-space: nowrap; }
        tr.tot td { font-weight: bold; background: #fff8c5; }
        .vazio { color: #777; text-align: center; padding: 8px; }
        .tipo { display: inline-block; padding: 0 5px; border-radius: 3px; font-weight: bold; font-size: 7.5pt; }
        .tipo.RDA { background: #e8f5ee; color: #1B4332; } .tipo.RDM { background: #eef4ff; color: #23427a; }
        ';
        $html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'.$css.'</style></head><body>'.$h.'</body></html>';
        $d = new Dompdf(['isRemoteEnabled' => false, 'defaultFont' => 'DejaVu Sans']);
        $d->setPaper('A4', 'portrait');
        $d->loadHtml($html);
        $d->render();
        file_put_contents($arquivo, $d->output());
    }
}
