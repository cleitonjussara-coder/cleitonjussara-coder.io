<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Repasse extends Model
{
    public const KINDS = ['received', 'requested'];

    protected $table = 'repasses';

    protected $keyType = 'string';

    public $incrementing = false;

    /* email_sent fica de fora de propósito: quem decide é o servidor (ver
       RepasseEmailService). O app manda o registro inteiro no upsert e a
       cópia local pode estar com false mesmo depois de o e-mail ter saído. */
    protected $fillable = [
        'id', 'user_id', 'tipo', 'valor', 'data', 'mes', 'ano', 'descricao',
        'kind', 'deleted', 'created_at',
    ];

    protected function casts(): array
    {
        return [
            'valor' => 'float',       // JSON numérico, como o PostgREST devolvia (o app soma direto)
            'data' => 'date:Y-m-d',
            'mes' => 'integer',
            'ano' => 'integer',
            'email_sent' => 'boolean',
            'deleted' => 'boolean',
            'atendido_em' => 'datetime',
        ];
    }

    public function dono(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'user_id');
    }

    public function emails(): HasMany
    {
        return $this->hasMany(RepasseEmail::class, 'repasse_id');
    }

    public function scopeVisiveisPara(Builder $q, Colaborador $u): Builder
    {
        return $u->veTudo() ? $q : $q->where('user_id', $u->id);
    }
}
