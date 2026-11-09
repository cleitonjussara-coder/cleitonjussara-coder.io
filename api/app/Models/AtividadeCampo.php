<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\Schema;

/** Uma atividade em campo (08/11/2026): início e fim numa fazenda/campo, com a localização de cada toque. */
class AtividadeCampo extends Model
{
    protected $table = 'atividades_campo';

    protected $keyType = 'string';

    public $incrementing = false;

    protected $fillable = ['id', 'user_id', 'fazenda', 'campo', 'inicio', 'fim', 'fim_automatico',
        'lat_inicio', 'lng_inicio', 'precisao_inicio', 'lat_fim', 'lng_fim', 'precisao_fim', 'observacao'];

    protected function casts(): array
    {
        return [
            'inicio' => 'datetime', 'fim' => 'datetime', 'fim_automatico' => 'boolean',
            'lat_inicio' => 'float', 'lng_inicio' => 'float', 'lat_fim' => 'float', 'lng_fim' => 'float',
            'precisao_inicio' => 'integer', 'precisao_fim' => 'integer',
        ];
    }

    /* Protege o período entre publicar a API nova e a migração rodar (mesmo padrão de Justificativa). */
    public static function tabelaExiste(): bool
    {
        static $tem = null;
        if ($tem === null) {
            try {
                $tem = Schema::hasTable('atividades_campo');
            } catch (\Throwable) {
                $tem = false;
            }
        }

        return $tem;
    }

    public function colaborador(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'user_id');
    }

    /* Dono vê as próprias; gestor e admin veem todas. O Contador não entra: é controle de segurança, não despesa. */
    public function scopeVisiveisPara(Builder $q, Colaborador $u): Builder
    {
        return $u->acompanhaCampo() ? $q : $q->where('user_id', $u->id);   // gestor, admin e focal (09/11/2026)
    }
}
