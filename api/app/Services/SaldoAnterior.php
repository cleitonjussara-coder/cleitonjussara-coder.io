<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;

/**
 * Saldo trazido dos anos anteriores (04/11/2026, pedido do dono: "valores acumulativo de um ano, acumula para o ano
 * posterior, com especificação de saldo de ano anterior"). Todo saldo por ano passa a ser
 *     saldo do ano anterior + o que entrou no ano − o que saiu no ano.
 * Este serviço é o único lugar da API que soma os anos passados: planilhas, PDFs, Arquivos e o aviso do cartão leem daqui.
 *
 * Soma TODOS os anos antes de $ano, não só o último. Ano futuro nunca entra; pedir $ano + 1 dá o acumulado até dezembro de $ano.
 *
 * A conta é a de sempre:
 *   gasto    = nota não apagada, sem Faturamento (pagamento='empresa');
 *   cartão   = nota fora de carteira/empresa; bolso = pagamento='carteira';
 *   recebido = repasse não apagado, kind vazio ou received, confirmado, fora a recarga;
 *   recarga  = destino='recarga': é do cartão, um saldo só, sem separar RDM e RDA.
 *
 * O regime é o de HOJE (o banco não guarda o regime de cada ano). Por isso as contas dos dois regimes saem sempre juntas:
 * quem mudou de regime lê a do regime atual, a mesma que as telas mostram.
 * Limite conhecido, para o dono decidir: quem veio do RDM/RDA para o C.V. traz o gasto antigo sem pagamento gravado como cartão
 * (a regra é "cartão = fora de carteira/empresa") e o repasse antigo como crédito de reembolso, então o cartão pode sair
 * negativo sem ser. Separar isso pede a data da mudança de regime, que o banco não tem.
 */
class SaldoAnterior
{
    /** Rótulo da linha em planilhas e PDFs, em maiúsculas como os outros rótulos dos modelos. */
    public const ROTULO = 'SALDO DO ANO ANTERIOR';

    /**
     * @param  iterable<string>|null  $ids  só estes colaboradores; null = todos
     * @return array<string, array<string, mixed>> por user_id; quem não tem nada antes de $ano não aparece (ver zerado())
     */
    public function deTodos(int $ano, ?iterable $ids = null): array
    {
        return $this->somar(fn ($q) => $q->where('ano', '<', $ano), $ids);
    }

    /**
     * O mesmo saldo, com corte no FIM do mês (04/11/2026): o PDF mensal da equipe mostra o C.V. até o mês do relatório, e
     * lançamento posterior não pode entrar. Em dezembro dá o mesmo que deTodos($ano + 1).
     *
     * @param  iterable<string>|null  $ids  só estes colaboradores; null = todos
     * @return array<string, array<string, mixed>> por user_id; quem não tem nada até lá não aparece (ver zerado())
     */
    public function ateMes(int $ano, int $mes, ?iterable $ids = null): array
    {
        return $this->somar(fn ($q) => $q->whereRaw('(ano * 12 + mes) <= ?', [$ano * 12 + $mes]), $ids);
    }

    /** @param  callable  $corte  recebe a consulta e limita o período, igual para notas e repasses */
    private function somar(callable $corte, ?iterable $ids): array
    {
        $ids = $ids === null ? null : collect($ids)->values()->all();

        $gastos = $corte(Nota::query()->where('deleted', false)->whereNotNull('user_id'))
            ->where(fn ($q) => $q->where('pagamento', '!=', 'empresa')->orWhereNull('pagamento'))
            ->when($ids !== null, fn ($q) => $q->whereIn('user_id', $ids))
            ->selectRaw('user_id, tipo, pagamento, SUM(valor) AS v')->groupBy('user_id', 'tipo', 'pagamento')->get();
        $repasses = self::recebidos($corte(Repasse::query()->where('deleted', false)))
            ->when($ids !== null, fn ($q) => $q->whereIn('user_id', $ids))
            ->selectRaw('user_id, tipo, destino, SUM(valor) AS v')->groupBy('user_id', 'tipo', 'destino')->get();

        $a = [];
        foreach ($gastos as $g) {
            $a[$g->user_id] ??= self::zerado();
            $t = self::tipo($g->tipo);
            $v = (float) $g->v;
            $a[$g->user_id]['gasto'][$t] += $v;
            if ($g->pagamento === 'carteira') {
                $a[$g->user_id]['bolso'][$t] += $v;
            } else {
                $a[$g->user_id]['cartao_gasto'] += $v;
            }
        }
        foreach ($repasses as $r) {
            $a[$r->user_id] ??= self::zerado();
            if ($r->destino === 'recarga') {
                $a[$r->user_id]['recarga'] += (float) $r->v;
            } else {
                $a[$r->user_id]['recebido'][self::tipo($r->tipo)] += (float) $r->v;
            }
        }

        return array_map(fn (array $x) => self::fechar($x), $a);
    }

    /** O saldo trazido de um colaborador só. */
    public function de(Colaborador $c, int $ano): array
    {
        return $this->deTodos($ano, [$c->id])[$c->id] ?? self::zerado();
    }

    /**
     * Quem não tem nada antes do ano. Campos, com saldo no sinal recebido − gasto (negativo = a empresa deve):
     *   cartao     recargas − gasto no cartão;
     *   reembolso  [RDM, RDA] recebido − gasto do bolso: é o saldo de quem está no C.V.;
     *   saldo      [RDM, RDA] recebido − gasto: é o saldo de quem está no RDM/RDA.
     * O resto (recarga, cartao_gasto, gasto, bolso, recebido) são as parcelas brutas de cada conta.
     */
    public static function zerado(): array
    {
        $tipos = ['RDM' => 0.0, 'RDA' => 0.0];

        return [
            'recarga' => 0.0, 'cartao_gasto' => 0.0, 'cartao' => 0.0,
            'gasto' => $tipos, 'bolso' => $tipos, 'recebido' => $tipos, 'saldo' => $tipos, 'reembolso' => $tipos,
        ];
    }

    /** [RDM, RDA] que valem para o regime atual dele: reembolso no C.V., saldo no RDM/RDA. */
    public function porTipo(Colaborador $c, array $s): array
    {
        return $c->usaCartao() ? $s['reembolso'] : $s['saldo'];
    }

    /**
     * Quem entra num relatório da equipe mesmo sem lançar nada no ano (04/11/2026): tem saldo trazido na conta do regime
     * atual. Olha cada conta sozinha, porque +100 no RDA e −100 no RDM não se anulam.
     *
     * @return array<int, string> ids
     */
    public function quemCarrega(int $ano): array
    {
        $anteriores = $this->deTodos($ano);

        return Colaborador::query()->whereIn('id', array_keys($anteriores))->get()
            ->filter(fn (Colaborador $c) => array_filter([...array_values($this->porTipo($c, $anteriores[$c->id])), $c->usaCartao() ? $anteriores[$c->id]['cartao'] : 0.0]) !== [])
            ->pluck('id')->all();
    }

    /** Quem deve, em palavras: mesma frase de Gestor.sentidoSaldo, no sinal daqui (negativo = a empresa deve). */
    public static function sentido(float $v): string
    {
        $x = round($v, 2);

        return $x == 0 ? '' : ($x < 0 ? 'a empresa deve' : 'a favor da empresa');
    }

    /** Só o que conta como dinheiro recebido: kind vazio ou received, confirmado, sem pedido pendente. Recarga ainda passa. */
    public static function recebidos($q)
    {
        return $q->where(fn ($w) => $w->whereNull('kind')->orWhereIn('kind', ['', 'received']))->whereNotNull('confirmado_em');
    }

    /** Tira a recarga do cartão, que não é dinheiro recebido (SQL: destino nulo também fica). */
    public static function semRecarga($q)
    {
        return $q->where(fn ($w) => $w->whereNull('destino')->orWhere('destino', '!=', 'recarga'));
    }

    /** Como as planilhas: RDA é RDA; o resto cai em RDM. */
    private static function tipo(?string $tipo): string
    {
        return $tipo === 'RDA' ? 'RDA' : 'RDM';
    }

    /** Arredonda só no fim, para os centavos não derivarem soma a soma. */
    private static function fechar(array $x): array
    {
        $x['cartao'] = $x['recarga'] - $x['cartao_gasto'];
        foreach (['RDM', 'RDA'] as $t) {
            $x['saldo'][$t] = $x['recebido'][$t] - $x['gasto'][$t];
            $x['reembolso'][$t] = $x['recebido'][$t] - $x['bolso'][$t];
        }
        foreach ($x as $k => $v) {
            $x[$k] = is_array($v) ? array_map(fn ($n) => round($n, 2) + 0.0, $v) : round($v, 2) + 0.0;
        }

        return $x;
    }
}
