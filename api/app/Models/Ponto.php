<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Um dia de ponto de um colaborador (até quatro marcações). */
class Ponto extends Model
{
    public const TIPOS_DIA = ['trabalho', 'folga', 'atestado', 'falta'];

    public const MARCACOES = ['entrada', 'saida_intervalo', 'volta_intervalo', 'saida'];

    protected $table = 'pontos';

    protected $keyType = 'string';

    public $incrementing = false;

    protected $fillable = ['id', 'user_id', 'data', 'entrada', 'saida_intervalo', 'volta_intervalo', 'saida', 'tipo_dia', 'observacao', 'lat', 'lng', 'deleted'];

    protected function casts(): array
    {
        return [
            'data' => 'date:Y-m-d',
            'entrada' => 'datetime', 'saida_intervalo' => 'datetime', 'volta_intervalo' => 'datetime', 'saida' => 'datetime',
            'deleted' => 'boolean',
        ];
    }

    public function colaborador(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'user_id');
    }

    public function scopeVisiveisPara(Builder $q, Colaborador $u): Builder
    {
        return $u->veTudo() ? $q : $q->where('user_id', $u->id);
    }
}
