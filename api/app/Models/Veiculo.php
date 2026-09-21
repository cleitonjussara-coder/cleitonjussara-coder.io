<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Veiculo extends Model
{
    protected $table = 'veiculos';

    protected $keyType = 'string';

    public $incrementing = false;

    protected $fillable = ['id', 'placa', 'modelo', 'responsavel_id', 'ativo'];

    protected function casts(): array
    {
        return ['ativo' => 'boolean'];
    }

    public function responsavel(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'responsavel_id');
    }

    public function registros(): HasMany
    {
        return $this->hasMany(KmRegistro::class, 'veiculo_id');
    }
}
