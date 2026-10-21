<?php

namespace App\Services;

use DateTimeImmutable;

/**
 * Contas do histórico e do painel de KM (21/10/2026). Só funções puras, sem
 * banco: dá para testar cada regra com um punhado de leituras.
 *
 * Regra de ouro (a mesma da planilha de controle e do /frota/anual):
 *   km de uma leitura = odômetro − leitura anterior DO MESMO VEÍCULO
 *   (de qualquer pessoa); vai para o dia da leitura e para quem a fez.
 *   A primeira leitura de um veículo vale 0 — não há de onde partir.
 * Datas são sempre texto AAAA-MM-DD (sem fuso: a data do registro manda).
 * Semana de segunda a domingo.
 */
class KmCalculo
{
    /** Pulo de km entre duas leituras que merece um "confira" (igual ao do app). */
    public const SALTO_SUSPEITO = 2000;

    public const MODOS = ['dia', 'semana', 'mes'];

    /** Quantos períodos o gráfico mostra, por modo. */
    public const PONTOS_DA_SERIE = ['dia' => 14, 'semana' => 8, 'mes' => 12];

    /** Dia de hoje em Brasília (o servidor roda em UTC). */
    public static function hoje(): string
    {
        return now('America/Sao_Paulo')->format('Y-m-d');
    }

    /* ── Leituras → km ─────────────────────────────────────── */

    /**
     * Ordem cronológica de UM veículo: data, depois odômetro (nunca anda para
     * trás), depois hora do registro. Cada leitura: id, veiculo_id, user_id,
     * data (AAAA-MM-DD), odometro, criado (texto sortável, opcional).
     */
    public static function ordenar(array $leituras): array
    {
        usort($leituras, fn ($a, $b) => [$a['data'], $a['odometro'], (string) ($a['criado'] ?? ''), $a['id']]
            <=> [$b['data'], $b['odometro'], (string) ($b['criado'] ?? ''), $b['id']]);

        return $leituras;
    }

    /**
     * Acrescenta a cada leitura de UM veículo: `km` (rodado desde a anterior),
     * `anterior` (a leitura de onde partiu, ou null) e `alerta`
     * ('menor' = odômetro abaixo do anterior, 'salto' = pulo suspeito, ou null).
     * `$base` é a última leitura ANTES da janela carregada, para a primeira
     * leitura da janela não valer zero à toa.
     */
    public static function comKm(array $leituras, ?array $base = null): array
    {
        $prev = $base;
        $saida = [];
        foreach (self::ordenar($leituras) as $l) {
            $delta = $prev === null ? 0 : $l['odometro'] - $prev['odometro'];
            $alerta = null;
            if ($prev !== null && $delta < 0) {
                $alerta = 'menor';
            } elseif ($prev !== null && $delta > self::SALTO_SUSPEITO) {
                $alerta = 'salto';
            }
            $l['km'] = max(0, $delta);
            $l['anterior'] = $prev === null ? null : [
                'id' => $prev['id'], 'odometro' => $prev['odometro'], 'data' => $prev['data'],
                'user_id' => $prev['user_id'], 'criado' => $prev['criado'] ?? null,
            ];
            $l['alerta'] = $alerta;
            $saida[] = $l;
            $prev = $l;
        }

        return $saida;
    }

    /* ── Períodos ──────────────────────────────────────────── */

    /** ['ini' => AAAA-MM-DD, 'fim' => AAAA-MM-DD] do dia, da semana (seg–dom) ou do mês que contém $ref. */
    public static function periodo(string $modo, string $ref): array
    {
        $d = new DateTimeImmutable($ref);
        if ($modo === 'dia') {
            return ['ini' => $d->format('Y-m-d'), 'fim' => $d->format('Y-m-d')];
        }
        if ($modo === 'semana') {
            $ini = $d->modify('-'.((int) $d->format('N') - 1).' days');

            return ['ini' => $ini->format('Y-m-d'), 'fim' => $ini->modify('+6 days')->format('Y-m-d')];
        }
        $ini = $d->modify('first day of this month');

        return ['ini' => $ini->format('Y-m-d'), 'fim' => $ini->modify('last day of this month')->format('Y-m-d')];
    }

    /** Período imediatamente anterior ao de $ref (ontem, semana passada, mês passado). */
    public static function anterior(string $modo, string $ref): array
    {
        $p = self::periodo($modo, $ref);

        return self::periodo($modo, (new DateTimeImmutable($p['ini']))->modify('-1 day')->format('Y-m-d'));
    }

    /**
     * Período em andamento comparado com o anterior INTEIRO dá ▼ enganoso (quarta-feira
     * contra a semana passada toda). O comparável são os mesmos `$dias` primeiros dias
     * do período anterior, sem passar do fim dele.
     */
    public static function comparavel(array $anterior, int $dias): array
    {
        if ($dias <= 0) {
            return $anterior;
        }
        $fim = (new DateTimeImmutable($anterior['ini']))->modify('+'.($dias - 1).' days')->format('Y-m-d');

        return ['ini' => $anterior['ini'], 'fim' => min($anterior['fim'], $fim)];
    }

    /** O mesmo período deslocado `$n` períodos (negativo = passado). Devolve a data de referência. */
    public static function deslocar(string $modo, string $ref, int $n): string
    {
        $d = new DateTimeImmutable(self::periodo($modo, $ref)['ini']);
        $d = match ($modo) {
            'dia' => $d->modify(sprintf('%+d days', $n)),
            'semana' => $d->modify(sprintf('%+d days', $n * 7)),
            default => $d->modify(sprintf('%+d months', $n)),
        };

        return $d->format('Y-m-d');
    }

    /** Os `$n` períodos que terminam no que contém `$ate`, do mais antigo ao mais novo. */
    public static function serie(string $modo, string $ate, ?int $n = null): array
    {
        $n ??= self::PONTOS_DA_SERIE[$modo];
        $lista = [];
        for ($i = $n - 1; $i >= 0; $i--) {
            $lista[] = self::periodo($modo, self::deslocar($modo, $ate, -$i));
        }

        return $lista;
    }

    /* ── Somas ─────────────────────────────────────────────── */

    /** Km e nº de leituras das `$leituras` (já com `km`) que caem em [ini, fim]. */
    public static function somar(array $leituras, array $periodo): array
    {
        $km = 0;
        $n = 0;
        foreach ($leituras as $l) {
            if ($l['data'] >= $periodo['ini'] && $l['data'] <= $periodo['fim']) {
                $km += $l['km'];
                $n++;
            }
        }

        return ['km' => $km, 'leituras' => $n];
    }

    /** Variação em % sobre o período anterior; null quando não há base de comparação. */
    public static function variacao(int $atual, int $anterior): ?int
    {
        return $anterior > 0 ? (int) round(($atual - $anterior) / $anterior * 100) : null;
    }
}
