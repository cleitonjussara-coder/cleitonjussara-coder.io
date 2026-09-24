<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Repasse extends Model
{
    public const KINDS = ['received', 'requested'];

    /** Só para o regime CV: para onde o dinheiro foi (24/09/2026).
     *  recarga   → cartão pré-pago Alelo (BANCO DE DADOS, colunas B/C)
     *  reembolso → conta do colaborador, pelo que ele pagou do bolso (I/J) */
    public const DESTINOS = ['recarga', 'reembolso'];

    protected $table = 'repasses';

    protected $keyType = 'string';

    public $incrementing = false;

    /* email_sent fica de fora de propósito: quem decide é o servidor (ver
       RepasseEmailService). O app manda o registro inteiro no upsert e a
       cópia local pode estar com false mesmo depois de o e-mail ter saído. */
    protected $fillable = [
        'id', 'user_id', 'tipo', 'valor', 'data', 'mes', 'ano', 'descricao',
        'kind', 'destino', 'deleted', 'created_at',
    ];
    /* confirmado_em/confirmado_por ficam fora do fillable de propósito: são
       o carimbo de quem registrou o repasse e quando, posto pelo SERVIDOR —
       um upsert vindo do aparelho não escreve isso sozinho (23/09/2026). */

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
            'confirmado_em' => 'datetime',
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
