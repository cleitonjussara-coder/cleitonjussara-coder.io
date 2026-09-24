<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** Um aparelho inscrito para receber notificação (24/09/2026). */
class PushSubscription extends Model
{
    protected $table = 'push_subscriptions';

    protected $fillable = ['user_id', 'endpoint', 'endpoint_hash', 'p256dh', 'auth', 'aparelho'];

    public function dono(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'user_id');
    }
}
