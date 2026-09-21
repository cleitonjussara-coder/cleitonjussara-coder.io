<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use Dompdf\Dompdf;

/**
 * Relatório da EQUIPE em PDF (20/09/2026) — o que a aba Equipe mostra no
 * mês, em papel: resumo geral, quadro por colaborador (gasto RDM/RDA,
 * recebido, saldo, pendências) e, em seguida, as notas e repasses de cada
 * um. Só gestor/admin. A4 paisagem, HTML enxuto (Dompdf).
 */
class RelatorioEquipePdf
{
    private const MESES = [1 => 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

    private const CAT = ['abastecimento' => 'Abastecimento', 'hospedagem' => 'Hospedagem', 'outros' => 'Outros'];

    /** @param string[]|null $ids só estes colaboradores (marcados na tela, 21/09/2026); null = todos */
    public function gerar(int $ano, int $mes, string $arquivo, ?Colaborador $gerador = null, ?array $ids = null): void
    {
        $colabs = Colaborador::query()->when($ids, fn ($q) => $q->whereIn('id', $ids))->orderBy('nome')->get();
        $notas = Nota::query()->where('deleted', false)->where('ano', $ano)->where('mes', $mes)
            ->orderBy('data')->orderBy('created_at')->get()->groupBy('user_id');
        $reps = Repasse::query()->where('deleted', false)->where('ano', $ano)->where('mes', $mes)
            ->orderBy('data')->get()->groupBy('user_id');

        $e = fn ($v) => htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
        $brl = fn ($v) => 'R$ '.number_format((float) $v, 2, ',', '.');
        $dt = fn ($d) => $d ? $d->format('d/m/Y') : '';
        $cnpj = fn ($v) => preg_match('/^\d{14}$/', (string) $v) ? preg_replace('/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/', '$1.$2.$3/$4-$5', $v) : (string) $v;
        $recebido = fn ($r) => ! $r->kind || $r->kind === 'received';
        $periodo = self::MESES[$mes].' / '.$ano;
        $geradoEm = now(PontoCalculo::TZ)->format('d/m/Y H:i');

        /* ── linhas do quadro ─────────────────────────────────── */
        $linhas = [];
        $tot = ['notas' => 0, 'rdm' => 0.0, 'rda' => 0.0, 'gasto' => 0.0, 'rec' => 0.0, 'semFoto' => 0, 'semValor' => 0, 'pend' => 0];
        foreach ($colabs as $c) {
            $ns = $notas->get($c->id, collect());
            $rs = $reps->get($c->id, collect());
            if ($ns->isEmpty() && $rs->isEmpty()) {
                continue;   // quem não movimentou no mês não entra no quadro
            }
            $rdm = (float) $ns->where('tipo', 'RDM')->sum('valor');
            $rda = (float) $ns->where('tipo', 'RDA')->sum('valor');
            $rec = (float) $rs->filter($recebido)->sum('valor');
            $l = [
                'c' => $c, 'ns' => $ns, 'rs' => $rs,
                'notas' => $ns->count(), 'rdm' => $rdm, 'rda' => $rda, 'gasto' => $rdm + $rda, 'rec' => $rec,
                'semFoto' => $ns->filter(fn ($n) => ! $n->foto_path)->count(),
                'semValor' => $ns->filter(fn ($n) => (float) $n->valor <= 0)->count(),
                'pend' => $rs->reject($recebido)->filter(fn ($r) => ! $r->atendido_em)->count(),   // pedido já pago não é pendência (21/09/2026)
            ];
            foreach (['notas', 'rdm', 'rda', 'gasto', 'rec', 'semFoto', 'semValor', 'pend'] as $k) {
                $tot[$k] += $l[$k];
            }
            $linhas[] = $l;
        }
        $saldoTot = $tot['rec'] - $tot['gasto'];

        $h = [];
        /* ── página 1: resumo + quadro ─────────────────────────── */
        $q = '<div class="faixa">RELATÓRIO DA EQUIPE — '.$e(mb_strtoupper($periodo)).'</div>'
            .'<div class="meta">Petermann &amp; Morais · Serviços Agronômicos · gerado em '.$geradoEm.($gerador ? ' por '.$e($gerador->nome ?: $gerador->email) : '').'</div>'
            .'<table class="kpis"><tr>'
            .'<td><span class="lbl">Gasto no mês</span><span class="val">'.$brl($tot['gasto']).'</span><span class="sub">RDA '.$brl($tot['rda']).' · RDM '.$brl($tot['rdm']).'</span></td>'
            .'<td><span class="lbl">Recebido</span><span class="val">'.$brl($tot['rec']).'</span><span class="sub">'.($tot['pend'] ? $tot['pend'].' pedido(s) pendente(s)' : 'repasses do mês').'</span></td>'
            .'<td><span class="lbl">Saldo</span><span class="val '.($saldoTot < 0 ? 'vermelho' : '').'">'.$brl($saldoTot).'</span><span class="sub">recebido − gasto</span></td>'
            .'<td><span class="lbl">Notas</span><span class="val">'.$tot['notas'].'</span><span class="sub">'.count($linhas).' colaborador(es) · '.$tot['semFoto'].' sem foto · '.$tot['semValor'].' sem valor</span></td>'
            .'</tr></table>';

        $q .= '<table class="quadro"><tr><th class="esq">Colaborador</th><th>Notas</th><th>RDM (R$)</th><th>RDA (R$)</th><th>Gasto (R$)</th><th>Recebido (R$)</th><th>Saldo (R$)</th><th>Sem foto</th><th>Sem valor</th><th>Pedidos pend.</th></tr>';
        if (! $linhas) {
            $q .= '<tr><td colspan="10" class="vazio">Nenhum lançamento em '.$e($periodo).'.</td></tr>';
        }
        foreach ($linhas as $l) {
            $s = $l['rec'] - $l['gasto'];
            $q .= '<tr><td class="esq"><b>'.$e($l['c']->nome ?: $l['c']->email).'</b>'.($l['c']->ativo === false ? ' <span class="cinza">(desativado)</span>' : '').'<br><span class="cinza">'.$e($l['c']->email).' · '.$e($l['c']->role).'</span></td>'
                .'<td>'.$l['notas'].'</td><td class="num">'.$brl($l['rdm']).'</td><td class="num">'.$brl($l['rda']).'</td><td class="num"><b>'.$brl($l['gasto']).'</b></td>'
                .'<td class="num">'.$brl($l['rec']).'</td><td class="num '.($s < 0 ? 'vermelho' : 'verde').'"><b>'.$brl($s).'</b></td>'
                .'<td class="'.($l['semFoto'] ? 'alerta' : '').'">'.$l['semFoto'].'</td><td class="'.($l['semValor'] ? 'alerta' : '').'">'.$l['semValor'].'</td><td class="'.($l['pend'] ? 'alerta' : '').'">'.$l['pend'].'</td></tr>';
        }
        $q .= '<tr class="tot"><td class="esq">TOTAL</td><td>'.$tot['notas'].'</td><td class="num">'.$brl($tot['rdm']).'</td><td class="num">'.$brl($tot['rda']).'</td><td class="num">'.$brl($tot['gasto']).'</td>'
            .'<td class="num">'.$brl($tot['rec']).'</td><td class="num '.($saldoTot < 0 ? 'vermelho' : 'verde').'">'.$brl($saldoTot).'</td><td>'.$tot['semFoto'].'</td><td>'.$tot['semValor'].'</td><td>'.$tot['pend'].'</td></tr></table>';
        $h[] = '<div class="pagina">'.$q.'</div>';

        /* ── um bloco por colaborador: notas + repasses ────────── */
        foreach ($linhas as $l) {
            $c = $l['c'];
            $s = $l['rec'] - $l['gasto'];
            $b = '<div class="bloco"><div class="faixa2">'.$e(mb_strtoupper($c->nome ?: $c->email)).'<span class="dir">Gasto '.$brl($l['gasto']).' · Recebido '.$brl($l['rec']).' · Saldo <span class="'.($s < 0 ? 'vermelho' : '').'">'.$brl($s).'</span></span></div>';
            $b .= '<table class="notas"><tr><th>Data</th><th>Tipo</th><th>Categoria</th><th class="esq">Fornecedor</th><th>CNPJ</th><th>Nº</th><th>Valor (R$)</th><th>Anexo</th></tr>';
            if ($l['ns']->isEmpty()) {
                $b .= '<tr><td colspan="8" class="vazio">Nenhuma nota no mês.</td></tr>';
            }
            foreach ($l['ns'] as $n) {
                $cat = $n->tipo === 'RDA' ? 'Alimentação' : (self::CAT[mb_strtolower((string) $n->subtipo)] ?? ($n->subtipo ?: 'Outros'));
                $b .= '<tr><td>'.$dt($n->data).'</td><td><span class="tipo '.$e($n->tipo).'">'.$e($n->tipo).'</span></td><td>'.$e($cat).'</td>'
                    .'<td class="esq">'.$e(mb_substr((string) ($n->razao_social ?: '—'), 0, 42)).'</td><td>'.$e($cnpj($n->cnpj)).'</td><td>'.$e($n->numero ?? '').'</td>'
                    .'<td class="num '.((float) $n->valor <= 0 ? 'alerta' : '').'">'.$brl($n->valor).'</td><td>'.($n->foto_path ? '✔' : '<span class="alerta">falta</span>').'</td></tr>';
            }
            $b .= '<tr class="tot"><td colspan="6" class="esq">TOTAL DE GASTOS ('.$l['notas'].' nota'.($l['notas'] === 1 ? '' : 's').')</td><td class="num">'.$brl($l['gasto']).'</td><td></td></tr></table>';
            if ($l['rs']->isNotEmpty()) {
                $b .= '<table class="notas reps"><tr><th>Data</th><th>Tipo</th><th class="esq">Repasse</th><th>Situação</th><th>Valor (R$)</th></tr>';
                foreach ($l['rs'] as $r) {
                    $b .= '<tr><td>'.$dt($r->data).'</td><td><span class="tipo '.$e($r->tipo).'">'.$e($r->tipo).'</span></td><td class="esq">'.$e($r->descricao ?: ($recebido($r) ? 'Repasse recebido' : 'Solicitação de repasse')).'</td>'
                        .'<td>'.($recebido($r) ? 'recebido' : '<span class="alerta">pedido pendente</span>').'</td><td class="num">'.$brl($r->valor).'</td></tr>';
                }
                $b .= '<tr class="tot"><td colspan="4" class="esq">TOTAL RECEBIDO</td><td class="num">'.$brl($l['rec']).'</td></tr></table>';
            }
            $h[] = $b.'</div>';
        }

        $css = '
        @page { size: A4 landscape; margin: 9mm 8mm; }
        body { font-family: DejaVu Sans, Arial, sans-serif; font-size: 8.5pt; color: #111; }
        .pagina { page-break-after: always; }
        .faixa { background: #00B050; color: #000; font-size: 14pt; font-weight: bold; padding: 5px 8px; }
        .meta { font-size: 8pt; color: #555; margin: 3px 0 8px; }
        table.kpis { width: 100%; border-collapse: separate; border-spacing: 6px 0; margin: 0 -6px 8px; }
        table.kpis td { border: 1px solid #999; border-radius: 4px; padding: 6px 10px; width: 25%; vertical-align: top; background: #f7fbf8; }
        .lbl { display: block; font-size: 8pt; font-weight: bold; text-transform: uppercase; color: #555; }
        .val { display: block; font-size: 15pt; font-weight: bold; margin: 2px 0; }
        .sub { display: block; font-size: 7.5pt; color: #555; }
        table.quadro, table.notas { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
        table.quadro th, table.quadro td, table.notas th, table.notas td { border: 1px solid #999; padding: 3px 5px; text-align: center; font-size: 8pt; }
        table.quadro th, table.notas th { background: #e2efda; }
        table.notas th, table.notas td { font-size: 7.5pt; padding: 2px 4px; }
        .esq { text-align: left !important; }
        .num { text-align: right !important; white-space: nowrap; }
        tr.tot td { font-weight: bold; background: #fff8c5; }
        .vermelho { color: #C00000; } .verde { color: #1B7A3A; } .cinza { color: #666; font-size: 7pt; } .alerta { color: #b45309; font-weight: bold; }
        .vazio { color: #777; text-align: center; padding: 8px; }
        .bloco { page-break-inside: avoid; margin-bottom: 10px; }
        .faixa2 { background: #FFFF00; font-size: 11pt; font-weight: bold; padding: 4px 8px; border: 1px solid #999; margin-bottom: 3px; }
        .faixa2 .dir { float: right; font-size: 8.5pt; font-weight: normal; }
        .tipo { display: inline-block; padding: 0 5px; border-radius: 3px; font-weight: bold; font-size: 7pt; }
        .tipo.RDA { background: #e8f5ee; color: #1B4332; } .tipo.RDM { background: #eef4ff; color: #23427a; }
        table.reps { margin-top: 2px; }
        ';
        $html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'.$css.'</style></head><body>'.implode('', $h).'</body></html>';
        $d = new Dompdf(['isRemoteEnabled' => false, 'defaultFont' => 'DejaVu Sans']);
        $d->setPaper('A4', 'landscape');
        $d->loadHtml($html);
        $d->render();
        file_put_contents($arquivo, $d->output());
    }
}
