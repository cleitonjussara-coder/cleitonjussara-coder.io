<?php

namespace App\Services;

use App\Models\Feriado;
use App\Models\Ponto;
use Carbon\Carbon;

/**
 * Regras de cálculo do ponto (18/09/2026). Tudo em MINUTOS.
 *
 *   jornada   segunda a sexta: 8h (480 min); sábado: 4h (240); domingo: 0.
 *   normal    até a jornada do dia.
 *   extra 50% o que passa da jornada em dia útil/sábado.
 *   extra 100% TODA a hora trabalhada em domingo ou feriado.
 *   intervalo  = volta − saída do intervalo (não conta como trabalho).
 *
 * Marcação incompleta (sem saída) não gera horas — aparece como "em aberto".
 * As regras são as usuais da CLT como ponto de partida; se a empresa tiver
 * acordo diferente (banco de horas, escala 12x36), muda-se aqui, num lugar só.
 */
class PontoCalculo
{
    public const TZ = 'America/Sao_Paulo';

    public const JORNADA = [1 => 480, 2 => 480, 3 => 480, 4 => 480, 5 => 480, 6 => 240, 0 => 0]; // dayOfWeek: 0=dom

    /** @var array<string,string> data → nome */
    private array $feriados = [];

    public function __construct()
    {
        $this->feriados = Feriado::query()->pluck('nome', 'data')->all();
    }

    public function ehFeriado(string $data): ?string
    {
        return $this->feriados[$data] ?? null;
    }

    /** @return array{minutos:int, intervalo:int, normal:int, extra50:int, extra100:int, domingo:bool, feriado:?string, aberto:bool, jornada:int} */
    public function calcular(Ponto $p): array
    {
        $data = $p->data->format('Y-m-d');
        $dow = (int) Carbon::parse($data)->dayOfWeek;
        $domingo = $dow === 0;
        $feriado = $this->ehFeriado($data);
        $jornada = self::JORNADA[$dow];
        if ($feriado) {
            $jornada = 0;
        }

        $minutos = 0;
        $intervalo = 0;
        $aberto = false;
        if ($p->tipo_dia === 'trabalho' && $p->entrada) {
            if ($p->saida) {
                $minutos = max(0, (int) floor($p->entrada->diffInMinutes($p->saida, false)));
                if ($p->saida_intervalo && $p->volta_intervalo) {
                    $intervalo = max(0, (int) floor($p->saida_intervalo->diffInMinutes($p->volta_intervalo, false)));
                    $minutos = max(0, $minutos - $intervalo);
                }
            } else {
                $aberto = true;
            }
        }

        if ($domingo || $feriado) {
            $normal = 0;
            $extra50 = 0;
            $extra100 = $minutos;
        } else {
            $normal = min($minutos, $jornada);
            $extra50 = max(0, $minutos - $jornada);
            $extra100 = 0;
        }

        return compact('minutos', 'intervalo', 'normal', 'extra50', 'extra100', 'domingo', 'feriado', 'aberto', 'jornada');
    }

    public static function hm(int $min): string
    {
        return sprintf('%d:%02d', intdiv($min, 60), $min % 60);
    }
}
