<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Leitura do odômetro de um veículo, feita por um colaborador. */
class KmRegistro extends Model
{
    protected $table = 'km_registros';

    protected $keyType = 'string';

    public $incrementing = false;

    protected $fillable = ['id', 'veiculo_id', 'user_id', 'data', 'odometro', 'observacao', 'foto_path', 'deleted'];

    protected function casts(): array
    {
        return [
            'data' => 'date:Y-m-d',
            'odometro' => 'integer',
            'deleted' => 'boolean',
        ];
    }

    public function veiculo(): BelongsTo
    {
        return $this->belongsTo(Veiculo::class, 'veiculo_id');
    }

    public function colaborador(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'user_id');
    }

    /* Mesma regra das notas: dono vê os seus; gestor/admin veem tudo. */
    public function scopeVisiveisPara(Builder $q, Colaborador $u): Builder
    {
        return $u->veTudo() ? $q : $q->where('user_id', $u->id);
    }
}
