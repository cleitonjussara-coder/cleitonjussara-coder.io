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
 *
 * 04/11/2026, decisão do dono: quem é C.V. sai num quadro próprio, com Cartão e Reembolso separados, nos números da planilha
 * e de Arquivos (SaldoAnterior) e com corte no fim do mês do relatório. Substitui o recebido − gasto sem a recarga de
 * 01/10/2026, que mostrava uma dívida que não existe (a diferença eram as recargas). RDM/RDA segue a conta de sempre.
 */
class RelatorioEquipePdf
{
    private const MESES = [1 => 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

    private const CAT = ['abastecimento' => 'Abastecimento', 'hospedagem' => 'Hospedagem', 'outros' => 'Outros'];

    /** @param string[]|null $ids só estes colaboradores (marcados na tela, 21/09/2026); null = todos */
    public function gerar(int $ano, int $mes, string $arquivo, ?Colaborador $gerador = null, ?array $ids = null): void
    {
        $d = new Dompdf(['isRemoteEnabled' => false, 'defaultFont' => 'DejaVu Sans']);
        $d->setPaper('A4', 'landscape');
        $d->loadHtml($this->html($ano, $mes, $gerador, $ids));
        $d->render();
        file_put_contents($arquivo, $d->output());
    }

    /** @param string[]|null $ids só estes colaboradores; o HTML do relatório (separado de gerar() para poder ser conferido sem renderizar o PDF) */
    public function html(int $ano, int $mes, ?Colaborador $gerador = null, ?array $ids = null): string
    {
        $colabs =Colaborador::query()->when($ids, fn ($q) => $q->whereIn('id', $ids))->orderBy('nome')->get();
        /* 25/09/2026: nota de Faturamento (pagamento=empresa) não é gasto DO
           colaborador — sai do quadro individual, não infla o RDM/RDA de ninguém. */
        $notas = Nota::query()->where('deleted', false)->where('ano', $ano)->where('mes', $mes)->noRelatorio()
            ->where(fn ($q) => $q->where('pagamento', '!=', 'empresa')->orWhereNull('pagamento'))
            ->orderBy('data')->orderBy('created_at')->get()->groupBy('user_id');
        $reps = Repasse::query()->where('deleted', false)->where('ano', $ano)->where('mes', $mes)
            ->orderBy('data')->get()->groupBy('user_id');

        $antPorUser = $this->saldoAnterior($ano, $mes, $ids);
        $contas = $this->contasCv($ano, $mes, $ids);

        $e = fn ($v) => self::e($v);
        $brl = fn ($v) => self::brl($v);
        $dt = fn ($d) => $d ? $d->format('d/m/Y') : '';
        /* 23/09/2026: só entra no relatório o repasse que o colaborador confirmou */
        $recebido = fn ($r) => (! $r->kind || $r->kind === 'received') && $r->confirmado_em;
        /* o que CONTA no saldo: recarga do cartão (CV) vai para o cartão, não é dinheiro
           que a pessoa recebeu (regra de 28/09/2026, igual ao app e à ficha do gestor) */
        $conta = fn ($r) => $recebido($r) && $r->destino !== 'recarga';
        $periodo = self::MESES[$mes].' / '.$ano;
        $geradoEm = now(PontoCalculo::TZ)->format('d/m/Y H:i');

        /* ── linhas do quadro ─────────────────────────────────── */
        $linhas = [];
        $tot = ['notas' => 0, 'rdm' => 0.0, 'rda' => 0.0, 'gasto' => 0.0, 'ant' => 0.0, 'rec' => 0.0, 'saldo' => 0.0, 'semFoto' => 0, 'semValor' => 0, 'pend' => 0];
        $geral = $tot;   // 04/11/2026: $tot fecha o quadro RDM/RDA; $geral é a equipe toda, só para o que tem a mesma natureza (gasto, recebido, notas)
        foreach ($colabs as $c) {
            $ns = $notas->get($c->id, collect());
            $rs = $reps->get($c->id, collect());
            $cv = $contas[$c->id] ?? null;
            /* o saldo é por TIPO (RDM e RDA independentes, como na lista da Equipe e na ficha): quem tem
               +500 num e −500 no outro NÃO está zerado — entra no quadro mesmo somando 0 */
            $antT = $antPorUser[$c->id] ?? ['RDM' => 0.0, 'RDA' => 0.0];
            $antRdm = round($antT['RDM'], 2);
            $antRda = round($antT['RDA'], 2);
            $ant = round($antRdm + $antRda, 2);
            /* C.V.: olha cada conta sozinha, no fim do mês; sem movimento no mês é o mesmo que trouxe. Só de cartão também entra. */
            $carrega = $cv
                ? array_filter([$cv['saldo']['cartao'], ...array_values($cv['saldo']['reembolso'])], fn ($v) => abs($v) >= 0.005) !== []
                : abs($antRdm) >= 0.005 || abs($antRda) >= 0.005;
            if ($ns->isEmpty() && $rs->isEmpty() && ! $carrega) {
                continue;   // quem não movimentou no mês E não carrega saldo de meses anteriores não entra no quadro
            }
            $rdm = (float) $ns->where('tipo', 'RDM')->sum('valor');
            $rda = (float) $ns->where('tipo', 'RDA')->sum('valor');
            $rec = (float) $rs->filter($conta)->sum('valor');
            $l = [
                'c' => $c, 'ns' => $ns, 'rs' => $rs, 'cv' => $cv,
                'notas' => $ns->count(), 'rdm' => $rdm, 'rda' => $rda, 'gasto' => $rdm + $rda, 'rec' => $rec,
                'ant' => $ant, 'antRdm' => $antRdm, 'antRda' => $antRda, 'saldo' => round($ant + $rec - ($rdm + $rda), 2),
                'semFoto' => $ns->filter(fn ($n) => ! $n->foto_path)->count(),
                'semValor' => $ns->filter(fn ($n) => (float) $n->valor <= 0)->count(),
                'pend' => $rs->reject($recebido)->filter(fn ($r) => ! $r->atendido_em)->count(),   // pedido já pago não é pendência (21/09/2026)
            ];
            foreach (['notas', 'rdm', 'rda', 'gasto', 'rec', 'semFoto', 'semValor', 'pend'] as $campo) {
                $geral[$campo] += $l[$campo];
            }
            if (! $cv) {
                foreach (['notas', 'rdm', 'rda', 'gasto', 'ant', 'rec', 'saldo', 'semFoto', 'semValor', 'pend'] as $campo) {
                    $tot[$campo] += $l[$campo];
                }
            } else {
                $l['mes'] = [
                    'bolso' => (float) $ns->where('pagamento', 'carteira')->sum('valor'),
                    'recarga' => (float) $rs->filter(fn ($r) => $recebido($r) && $r->destino === 'recarga')->sum('valor'),
                ];
                $l['mes']['cartao'] = $l['gasto'] - $l['mes']['bolso'];
            }
            $linhas[] = $l;
        }
        $saldoTot = round($tot['saldo'], 2);
        $linhasCv = array_values(array_filter($linhas, fn ($l) => $l['cv']));
        $linhasRdm = array_values(array_filter($linhas, fn ($l) => ! $l['cv']));

        $h = [];
        /* ── página 1: resumo + quadro ─────────────────────────── */
        /* 04/11/2026: com C.V. no relatório não existe um saldo único: um cartão por conta, e o de RDM/RDA diz que é só dele */
        $kpiSaldo = $linhasRdm || ! $linhasCv
            ? '<td><span class="lbl">Saldo acumulado'.($linhasCv ? ' RDM/RDA' : '').'</span><span class="val '.($saldoTot < 0 ? 'vermelho' : '').'">'.$brl($saldoTot).'</span><span class="sub">anterior '.$brl($tot['ant']).' + recebido − gasto</span></td>'
            : '';
        $q = '<div class="faixa">RELATÓRIO DA EQUIPE — '.$e(mb_strtoupper($periodo)).'</div>'
            .'<div class="meta">Petermann &amp; Morais · Serviços Agronômicos · gerado em '.$geradoEm.($gerador ? ' por '.$e($gerador->nome ?: $gerador->email) : '').'</div>'
            .NotasAguardando::html(NotasAguardando::doPeriodo($ano, $mes, $ids ?: null, 'neste relatório'))
            .'<table class="kpis'.($linhasCv ? ' kpis-cv' : '').'"><tr>'
            .'<td><span class="lbl">Gasto no mês</span><span class="val">'.$brl($geral['gasto']).'</span><span class="sub">RDA '.$brl($geral['rda']).' · RDM '.$brl($geral['rdm']).'</span></td>'
            .'<td><span class="lbl">Recebido</span><span class="val">'.$brl($geral['rec']).'</span><span class="sub">'.($geral['pend'] ? $geral['pend'].' pedido(s) pendente(s)' : 'repasses do mês').($linhasCv ? ' · recargas do cartão à parte: '.$brl(array_sum(array_map(fn ($l) => $l['mes']['recarga'], $linhasCv))) : '').'</span></td>'
            .$kpiSaldo.$this->kpisCv($linhasCv)
            .'<td><span class="lbl">Notas</span><span class="val">'.$geral['notas'].'</span><span class="sub">'.count($linhas).' colaborador(es) · '.$geral['semFoto'].' sem foto · '.$geral['semValor'].' sem valor</span></td>'
            .'</tr></table>';

        if ($linhasRdm || ! $linhasCv) {
            $q .= ($linhasCv ? '<div class="regime">Regime RDM/RDA</div>' : '').'<table class="quadro"><tr><th class="esq">Colaborador</th><th>Notas</th><th>RDM (R$)</th><th>RDA (R$)</th><th>Gasto (R$)</th><th>Saldo anterior (R$)</th><th>Recebido (R$)</th><th>Saldo acumulado (R$)</th><th>Sem foto</th><th>Sem valor</th><th>Pedidos pend.</th></tr>';
            if (! $linhas) {
                $q .= '<tr><td colspan="11" class="vazio">Nenhum lançamento em '.$e($periodo).'.</td></tr>';
            }
            foreach ($linhasRdm as $l) {
                $s = $l['saldo'];
                $q .= '<tr><td class="esq"><b>'.$e($l['c']->nome ?: $l['c']->email).'</b>'.($l['c']->ativo === false ? ' <span class="cinza">(desativado)</span>' : '').($l['ns']->isEmpty() && $l['rs']->isEmpty() ? ' <span class="cinza">(sem lançamento no mês)</span>' : '').'<br><span class="cinza">'.$e($l['c']->email).' · '.$e($l['c']->role).'</span></td>'
                    .'<td>'.$l['notas'].'</td><td class="num">'.$brl($l['rdm']).'</td><td class="num">'.$brl($l['rda']).'</td><td class="num"><b>'.$brl($l['gasto']).'</b></td>'
                    .'<td class="num '.($l['ant'] < 0 ? 'vermelho' : '').'">'.$brl($l['ant']).'</td>'
                    .'<td class="num">'.$brl($l['rec']).'</td><td class="num '.($s < 0 ? 'vermelho' : 'verde').'"><b>'.$brl($s).'</b></td>'
                    .'<td class="'.($l['semFoto'] ? 'alerta' : '').'">'.$l['semFoto'].'</td><td class="'.($l['semValor'] ? 'alerta' : '').'">'.$l['semValor'].'</td><td class="'.($l['pend'] ? 'alerta' : '').'">'.$l['pend'].'</td></tr>';
            }
            $q .= '<tr class="tot"><td class="esq">TOTAL</td><td>'.$tot['notas'].'</td><td class="num">'.$brl($tot['rdm']).'</td><td class="num">'.$brl($tot['rda']).'</td><td class="num">'.$brl($tot['gasto']).'</td>'
                .'<td class="num">'.$brl($tot['ant']).'</td>'
                .'<td class="num">'.$brl($tot['rec']).'</td><td class="num '.($saldoTot < 0 ? 'vermelho' : 'verde').'">'.$brl($saldoTot).'</td><td>'.$tot['semFoto'].'</td><td>'.$tot['semValor'].'</td><td>'.$tot['pend'].'</td></tr></table>';
        }
        if ($linhasCv) {
            $q .= $this->quadroCv($linhasCv, $periodo);
        }
        $h[] = '<div class="pagina">'.$q.'</div>';

        /* ── um bloco por colaborador: notas + repasses ────────── */
        foreach ($linhas as $l) {
            $c = $l['c'];
            $s = $l['saldo'];
            $cv = $l['cv'];
            $faixa = $cv
                ? 'Gasto no mês '.$brl($l['gasto']).' · Recebido '.$brl($l['rec']).' · Recargas '.$brl($l['mes']['recarga'])
                : 'Anterior RDM '.$brl($l['antRdm']).' · RDA '.$brl($l['antRda']).' · Gasto '.$brl($l['gasto']).' · Recebido '.$brl($l['rec']).' · Saldo acumulado <span class="'.($s < 0 ? 'vermelho' : '').'">'.$brl($s).'</span>';
            $b = '<div class="bloco"><div class="faixa2">'.$e(mb_strtoupper($c->nome ?: $c->email)).'<span class="dir">'.$faixa.'</span></div>';
            if ($cv) {
                $b .= $this->contasDoColaborador($cv, $periodo);
            }
            $b .= '<table class="notas"><tr><th>Data</th><th>Tipo</th><th>Categoria</th>'.($cv ? '<th>Conta</th>' : '').'<th class="esq">Fornecedor</th><th>CNPJ</th><th>Nº</th><th>Valor (R$)</th><th>Anexo</th></tr>';
            if ($l['ns']->isEmpty()) {
                $b .= '<tr><td colspan="'.($cv ? 9 : 8).'" class="vazio">Nenhuma nota no mês.</td></tr>';
            }
            foreach ($l['ns'] as $n) {
                $cat = $n->tipo === 'RDA' ? 'Alimentação' : (self::CAT[mb_strtolower((string) $n->subtipo)] ?? ($n->subtipo ?: 'Outros'));
                $b .= '<tr><td>'.$dt($n->data).'</td><td><span class="tipo '.$e($n->tipo).'">'.$e($n->tipo).'</span></td><td>'.$e($cat).'</td>'
                    .($cv ? '<td>'.($n->pagamento === 'carteira' ? 'Reembolso' : 'Cartão').'</td>' : '')
                    .'<td class="esq">'.$e(mb_substr((string) ($n->razao_social ?: '—'), 0, 42)).'</td><td>'.$e($n->cnpjFormatado()).'</td><td>'.$e($n->numero ?? '').'</td>'
                    .'<td class="num '.((float) $n->valor <= 0 ? 'alerta' : '').'">'.$brl($n->valor).'</td><td>'.($n->foto_path ? '✔' : '<span class="alerta">falta</span>').'</td></tr>';
            }
            $b .= '<tr class="tot"><td colspan="'.($cv ? 7 : 6).'" class="esq">TOTAL DE GASTOS ('.$l['notas'].' nota'.($l['notas'] === 1 ? '' : 's').')</td><td class="num">'.$brl($l['gasto']).'</td><td></td></tr></table>';
            if ($l['rs']->isNotEmpty()) {
                $b .= '<table class="notas reps"><tr><th>Data</th><th>Tipo</th><th class="esq">Repasse</th><th>Situação</th><th>Valor (R$)</th></tr>';
                foreach ($l['rs'] as $r) {
                    $b .= '<tr><td>'.$dt($r->data).'</td><td><span class="tipo '.$e($r->tipo).'">'.$e($r->tipo).'</span></td><td class="esq">'.$e($r->descricao ?: ($recebido($r) ? 'Repasse recebido' : 'Solicitação de repasse')).'</td>'
                        .'<td>'.($recebido($r) ? ($r->destino === 'recarga' ? ($cv ? 'recarga do cartão' : 'recarga do cartão (fora do saldo)') : 'recebido') : '<span class="alerta">pedido pendente</span>').'</td><td class="num">'.$brl($r->valor).'</td></tr>';
                }
                $b .= ($cv ? '<tr class="tot"><td colspan="4" class="esq">TOTAL DE RECARGAS (CARTÃO)</td><td class="num">'.$brl($l['mes']['recarga']).'</td></tr>' : '')
                    .'<tr class="tot"><td colspan="4" class="esq">TOTAL RECEBIDO'.($cv ? ' (REEMBOLSO)' : '').'</td><td class="num">'.$brl($l['rec']).'</td></tr></table>';
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
        if ($linhasCv) {
            $css .= '
        table.kpis.kpis-cv td { width: 17%; padding: 5px 7px; }
        table.kpis.kpis-cv .val { font-size: 12pt; }
        .regime { font-size: 9.5pt; font-weight: bold; margin: 6px 0 2px; }
        .regime-nota { font-size: 7.5pt; color: #555; margin-bottom: 3px; }
        .inteiro { white-space: nowrap; }
        .regime, .regime-nota, table.quadro-cv thead tr { page-break-after: avoid; }   /* título do quadro nunca fica sozinho no pé da página */
        table.quadro-cv tr { page-break-inside: avoid; }
        table.quadro-cv th, table.quadro-cv td { font-size: 7.5pt; padding: 2px 3px; }
        table.quadro-cv td.esq { width: 13%; word-wrap: break-word; }
        table.quadro-cv th.larga { width: 15%; }   /* RDM/RDA com a frase numa linha só: a linha da pessoa encolhe e cabe mais gente por página */
        table.quadro-cv .cinza { white-space: normal; }
        table.contas { margin-bottom: 3px; }
        ';
        }

        return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'.$css.'</style></head><body>'.implode('', $h).'</body></html>';
    }

    /**
     * As contas de quem é C.V. no fim do mês (04/11/2026), todas no sinal recebido − gasto (negativo = a empresa deve):
     *   anterior  saldo do ano anterior, o mesmo da planilha e de Arquivos;
     *   saldo     anterior + o que entrou − o que saiu no ano, até o fim de $mes;
     *   ano       as parcelas de janeiro até $mes: recarga, cartao_gasto, recebido e bolso por tipo.
     * Vem sempre uma entrada por colaborador C.V., mesmo zerada. Quem é RDM/RDA não aparece.
     *
     * @param  string[]|null  $ids
     * @return array<string, array<string, mixed>>
     */
    public function contasCv(int $ano, int $mes, ?array $ids = null): array
    {
        $ids = $ids ?: null;
        $svc = app(SaldoAnterior::class)->doRelatorio();
        $anteriores = $svc->deTodos($ano, $ids);
        $ate = $svc->ateMes($ano, $mes, $ids);
        $lado = fn (array $s) => ['cartao' => $s['cartao'], 'reembolso' => $s['reembolso'], 'reembolsoTotal' => round($s['reembolso']['RDM'] + $s['reembolso']['RDA'], 2)];

        $out = [];
        foreach (Colaborador::query()->when($ids, fn ($q) => $q->whereIn('id', $ids))->get() as $c) {
            if (! $c->usaCartao()) {
                continue;
            }
            $p = $anteriores[$c->id] ?? SaldoAnterior::zerado();
            $x = $ate[$c->id] ?? SaldoAnterior::zerado();
            $porTipo = fn (string $k) => ['RDM' => round($x[$k]['RDM'] - $p[$k]['RDM'], 2), 'RDA' => round($x[$k]['RDA'] - $p[$k]['RDA'], 2)];
            $out[$c->id] = [
                'anterior' => $lado($p),
                'saldo' => $lado($x),
                'ano' => [
                    'recarga' => round($x['recarga'] - $p['recarga'], 2), 'cartao_gasto' => round($x['cartao_gasto'] - $p['cartao_gasto'], 2),
                    'recebido' => $porTipo('recebido'), 'bolso' => $porTipo('bolso'),
                ],
            ];
        }

        return $out;
    }

    /** Cartões do topo: cartão e reembolso, cada um somado só com a mesma conta dos colegas. */
    private function kpisCv(array $linhas): string
    {
        if (! $linhas) {
            return '';
        }
        $soma = fn (callable $f) => round(array_sum(array_map(fn ($l) => $f($l['cv']), $linhas)), 2);
        $cartao = $soma(fn ($v) => $v['saldo']['cartao']);
        $reembolso = $soma(fn ($v) => $v['saldo']['reembolsoTotal']);
        /* inteiro numa linha só: o Dompdf quebrava logo depois do menos e o valor parecia positivo (visto no PDF, 04/11/2026) */
        $inteiro = fn (float $x) => trim('<span class="inteiro">'.self::brl($x).'</span> '.SaldoAnterior::sentido($x));
        $kpi = fn (string $rotulo, float $v, float $anterior, string $resto) => '<td><span class="lbl">'.$rotulo.'</span><span class="val '.($v < 0 ? 'vermelho' : '').'">'.self::brl($v).'</span>'
            .'<span class="sub">'.self::comSentido($v).'</span><span class="sub">Saldo do ano anterior<br>'.$inteiro($anterior).'</span>'.$resto.'</td>';

        return $kpi('Cartão C.V.', $cartao, $soma(fn ($v) => $v['anterior']['cartao']), '')
            .$kpi('Reembolso C.V.', $reembolso, $soma(fn ($v) => $v['anterior']['reembolsoTotal']),
                '<span class="sub">RDM '.$inteiro($soma(fn ($v) => $v['saldo']['reembolso']['RDM'])).'<br>RDA '.$inteiro($soma(fn ($v) => $v['saldo']['reembolso']['RDA'])).'</span>');
    }

    /** Quadro do C.V.: as duas contas lado a lado, sem coluna que some uma com a outra. */
    private function quadroCv(array $linhas, string $periodo): string
    {
        $celula = function (float $v, float $doMes) {
            return '<td class="num">'.self::brl($v).'<br><span class="cinza"><span class="inteiro">no mês '.self::brl($doMes).'</span></span></td>';
        };
        $saldo = fn (float $v, bool $negrito = true) => '<td class="num '.($v < 0 ? 'vermelho' : ($negrito ? 'verde' : '')).'">'.($negrito ? '<b>'.self::brl($v).'</b>' : self::brl($v)).'<br><span class="cinza">'.self::comSentido($v).'</span>';
        $parcela = fn (string $tipo, float $v) => trim('<span class="inteiro">'.$tipo.' '.self::brl($v).'</span> '.SaldoAnterior::sentido($v));
        $tipos = fn (array $t) => $t['RDM'] || $t['RDA'] ? '<br><span class="cinza">'.$parcela('RDM', $t['RDM']).'<br>'.$parcela('RDA', $t['RDA']).'</span>' : '';

        $q = '<div class="regime">Regime C.V.</div>'
            .'<div class="regime-nota">Cartão e reembolso são contas separadas e não se somam. Mesmos números da planilha e de Arquivos, até o fim de '.self::e($periodo).'. Negativo = a empresa deve. Recargas, repasses e gastos: de janeiro até o mês do relatório.</div>'
            /* thead: sem ele, nas páginas seguintes as colunas saíam sem título e não dava para saber o que era cartão (revisão, 04/11/2026) */
            .'<table class="quadro quadro-cv"><thead><tr><th class="esq" rowspan="2">Colaborador</th><th rowspan="2">Notas</th><th colspan="4">Cartão (R$)</th><th colspan="4">Reembolso (R$)</th><th rowspan="2">Sem foto / sem valor / pedidos</th></tr>'
            .'<tr><th>Saldo do ano anterior</th><th>Recargas</th><th>Gasto</th><th>Saldo</th><th class="larga">Saldo do ano anterior</th><th>Repasses</th><th>Gasto</th><th class="larga">Saldo</th></tr></thead><tbody>';

        $t = ['notas' => 0, 'semFoto' => 0, 'semValor' => 0, 'pend' => 0, 'cAnt' => 0.0, 'cRec' => 0.0, 'cGasto' => 0.0, 'cSaldo' => 0.0, 'rAnt' => 0.0, 'rRep' => 0.0, 'rGasto' => 0.0, 'rSaldo' => 0.0];
        foreach ($linhas as $l) {
            $c = $l['c'];
            $v = $l['cv'];
            $repasse = round($v['ano']['recebido']['RDM'] + $v['ano']['recebido']['RDA'], 2);
            $bolso = round($v['ano']['bolso']['RDM'] + $v['ano']['bolso']['RDA'], 2);
            $q .= '<tr><td class="esq"><b>'.self::e($c->nome ?: $c->email).'</b>'.($c->ativo === false ? ' <span class="cinza">(desativado)</span>' : '').($l['ns']->isEmpty() && $l['rs']->isEmpty() ? ' <span class="cinza">(sem lançamento no mês)</span>' : '').'<br><span class="cinza">'.self::e($c->email).' · '.self::e($c->role).'</span></td>'
                .'<td>'.$l['notas'].'</td>'
                .$saldo($v['anterior']['cartao'], false).'</td>'.$celula($v['ano']['recarga'], $l['mes']['recarga']).$celula($v['ano']['cartao_gasto'], $l['mes']['cartao']).$saldo($v['saldo']['cartao']).'</td>'
                .$saldo($v['anterior']['reembolsoTotal'], false).$tipos($v['anterior']['reembolso']).'</td>'.$celula($repasse, $l['rec']).$celula($bolso, $l['mes']['bolso']).$saldo($v['saldo']['reembolsoTotal']).$tipos($v['saldo']['reembolso']).'</td>'
                .'<td class="'.($l['semFoto'] || $l['semValor'] || $l['pend'] ? 'alerta' : '').'">'.$l['semFoto'].' / '.$l['semValor'].' / '.$l['pend'].'</td></tr>';
            foreach (['notas', 'semFoto', 'semValor', 'pend'] as $k) {
                $t[$k] += $l[$k];
            }
            $t['cAnt'] += $v['anterior']['cartao'];
            $t['cRec'] += $v['ano']['recarga'];
            $t['cGasto'] += $v['ano']['cartao_gasto'];
            $t['cSaldo'] += $v['saldo']['cartao'];
            $t['rAnt'] += $v['anterior']['reembolsoTotal'];
            $t['rRep'] += $repasse;
            $t['rGasto'] += $bolso;
            $t['rSaldo'] += $v['saldo']['reembolsoTotal'];
        }
        $n = fn (float $x) => '<td class="num">'.self::brl(round($x, 2)).'</td>';
        $s = fn (float $x) => $saldo(round($x, 2), false).'</td>';

        return $q.'<tr class="tot"><td class="esq">TOTAL</td><td>'.$t['notas'].'</td>'
            .$s($t['cAnt']).$n($t['cRec']).$n($t['cGasto']).$s($t['cSaldo']).$s($t['rAnt']).$n($t['rRep']).$n($t['rGasto']).$s($t['rSaldo'])
            .'<td>'.$t['semFoto'].' / '.$t['semValor'].' / '.$t['pend'].'</td></tr></tbody></table>';
    }

    /** A conta de cada um, por extenso, no bloco dele: anterior + entrou − gasto = saldo, com o reembolso por tipo. */
    private function contasDoColaborador(array $v, string $periodo): string
    {
        $celula = fn (float $x) => '<td class="num '.($x < 0 ? 'vermelho' : '').'">'.self::brl($x).($x ? ' <span class="cinza">'.self::comSentido($x).'</span>' : '').'</td>';
        $linha = fn (string $rotulo, float $ant, float $entrou, float $gasto, float $saldo, string $cls = '') => '<tr'.($cls ? ' class="'.$cls.'"' : '').'><td class="esq">'.$rotulo.'</td>'.$celula($ant)
            .'<td class="num">'.self::brl($entrou).'</td><td class="num">'.self::brl($gasto).'</td>'.$celula($saldo).'</tr>';
        $ano = $v['ano'];

        return '<table class="notas contas"><tr><th class="esq">Conta (R$)</th><th>Saldo do ano anterior</th><th>Entrou no ano</th><th>Gasto no ano</th><th>Saldo até o fim de '.self::e($periodo).'</th></tr>'
            .$linha('Cartão', $v['anterior']['cartao'], $ano['recarga'], $ano['cartao_gasto'], $v['saldo']['cartao'])
            .$linha('Reembolso RDM', $v['anterior']['reembolso']['RDM'], $ano['recebido']['RDM'], $ano['bolso']['RDM'], $v['saldo']['reembolso']['RDM'])
            .$linha('Reembolso RDA', $v['anterior']['reembolso']['RDA'], $ano['recebido']['RDA'], $ano['bolso']['RDA'], $v['saldo']['reembolso']['RDA'])
            .$linha('Reembolso (RDM + RDA)', $v['anterior']['reembolsoTotal'], round($ano['recebido']['RDM'] + $ano['recebido']['RDA'], 2), round($ano['bolso']['RDM'] + $ano['bolso']['RDA'], 2), $v['saldo']['reembolsoTotal'], 'tot')
            .'</table>';
    }

    private static function brl($v): string
    {
        return 'R$ '.number_format((float) $v, 2, ',', '.');
    }

    private static function e($v): string
    {
        return htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
    }

    private static function comSentido(float $v): string
    {
        return SaldoAnterior::sentido($v) ?: 'zerado';
    }

    /**
     * Saldo ANTERIOR ao mês ($ano, $mes), por colaborador e por TIPO:
     * user_id => ['RDM' => saldo, 'RDA' => saldo].
     * Desde 04/11/2026 só vale para quem é RDM/RDA; o C.V. usa contasCv().
     *
     * 01/10/2026 — "sempre somar os saldos acumulados dos meses anteriores": o
     * saldo de cada colaborador é o que sobrou (ou faltou) de TODOS os meses
     * anteriores + recebido − gasto do mês, RDM e RDA independentes. Mesma conta
     * de _saldoAcumuladoAte (app.js) e da ficha do gestor: gasto sem Faturamento
     * (pagamento=empresa), recebido sem pedido pendente e sem recarga do cartão
     * (CV). Duas somas agrupadas (todos os anos), em vez de carregar notas antigas
     * na memória.
     *
     * @param string[]|null $ids
     * @return array<string, array{RDM: float, RDA: float}>
     */
    public function saldoAnterior(int $ano, int $mes, ?array $ids = null): array
    {
        $k = $ano * 12 + $mes;
        $gasto = Nota::query()->where('deleted', false)->whereNotNull('user_id')
            ->whereRaw('(ano * 12 + mes) < ?', [$k])->noRelatorio()
            ->where(fn ($q) => $q->where('pagamento', '!=', 'empresa')->orWhereNull('pagamento'))
            ->when($ids, fn ($q) => $q->whereIn('user_id', $ids))
            ->selectRaw('user_id, tipo, SUM(valor) AS v')->groupBy('user_id', 'tipo')->get();
        $recebido = Repasse::query()->where('deleted', false)
            ->whereRaw('(ano * 12 + mes) < ?', [$k])
            ->where(fn ($q) => $q->whereNull('kind')->orWhereIn('kind', ['', 'received']))   // 04/11/2026: kind vazio também é recebido, como no mês aberto, no app e em SaldoAnterior
            ->whereNotNull('confirmado_em')
            ->where(fn ($q) => $q->whereNull('destino')->orWhere('destino', '!=', 'recarga'))
            ->when($ids, fn ($q) => $q->whereIn('user_id', $ids))
            ->selectRaw('user_id, tipo, SUM(valor) AS v')->groupBy('user_id', 'tipo')->get();

        $saldo = [];
        foreach ($recebido as $r) {
            if ($r->tipo === 'RDM' || $r->tipo === 'RDA') {
                $saldo[$r->user_id] ??= ['RDM' => 0.0, 'RDA' => 0.0];
                $saldo[$r->user_id][$r->tipo] += (float) $r->v;
            }
        }
        foreach ($gasto as $n) {
            if ($n->tipo === 'RDM' || $n->tipo === 'RDA') {
                $saldo[$n->user_id] ??= ['RDM' => 0.0, 'RDA' => 0.0];
                $saldo[$n->user_id][$n->tipo] -= (float) $n->v;
            }
        }

        return $saldo;
    }
}
