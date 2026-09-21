<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/** Convite por link para criar conta com papel pré-definido (21/09/2026). */
class Convite extends Model
{
    protected $table = 'convites';

    protected $keyType = 'string';

    public $incrementing = false;

    protected $fillable = ['id', 'token', 'role', 'nome', 'criado_por', 'usado_por', 'usado_em', 'expira_em'];

    protected $casts = ['usado_em' => 'datetime', 'expira_em' => 'datetime'];

    public function valido(): bool
    {
        return $this->usado_em === null && $this->expira_em->isFuture();
    }

    public function criador()
    {
        return $this->belongsTo(Colaborador::class, 'criado_por');
    }
}
