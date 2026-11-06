<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Quem fechou e reabriu cada mês, quando e por quê (06/11/2026). Só cresce; grava App\Services\FechamentoMes. */
class MesFechadoHistorico extends Model
{
    protected $table = 'meses_fechados_historico';

    public $timestamps = false;

    protected $fillable = ['ano', 'mes', 'acao', 'motivo', 'feito_por', 'feito_papel', 'feito_em'];

    protected function casts(): array
    {
        return [
            'ano' => 'integer',
            'mes' => 'integer',
            'feito_em' => 'datetime',
        ];
    }
}
