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
        'lat_inicio', 'lng_inicio', 'precisao_inicio', 'lat_fim', 'lng_fim', 'precisao_fim', 'observacao', 'editado_em', 'editado_por', 'apagado_em', 'apagado_por'];

    protected function casts(): array
    {
        return [
            'inicio' => 'datetime', 'fim' => 'datetime', 'fim_automatico' => 'boolean', 'editado_em' => 'datetime', 'apagado_em' => 'datetime',
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

    /* Colunas da correção (09/11/2026): a API nova pode chegar antes da migração rodar. */
    public static function temEdicao(): bool
    {
        static $tem = null;
        if ($tem === null) {
            try {
                $tem = Schema::hasColumn('atividades_campo', 'editado_em');
            } catch (\Throwable) {
                $tem = false;
            }
        }

        return $tem;
    }

    /* Lixeira (09/11/2026): a API nova pode chegar antes da migração rodar; sem a coluna, nada está apagado. */
    public static function temLixeira(): bool
    {
        static $tem = null;
        if ($tem === null) {
            try {
                $tem = Schema::hasColumn('atividades_campo', 'apagado_em');
            } catch (\Throwable) {
                $tem = false;
            }
        }

        return $tem;
    }

    /* Registros fora da lixeira: é o que o histórico, o painel, a planilha e o buscador mostram. */
    public function scopeVivos(Builder $q): Builder
    {
        return self::temLixeira() ? $q->whereNull('apagado_em') : $q;
    }

    public function scopeNaLixeira(Builder $q): Builder
    {
        return self::temLixeira() ? $q->whereNotNull('apagado_em') : $q->whereRaw('1 = 0');
    }

    public function apagador(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'apagado_por');
    }

    public function colaborador(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'user_id');
    }

    public function editor(): BelongsTo
    {
        return $this->belongsTo(Colaborador::class, 'editado_por');
    }

    /* Dono vê as próprias; gestor e admin veem todas. O Contador não entra: é controle de segurança, não despesa. */
    public function scopeVisiveisPara(Builder $q, Colaborador $u): Builder
    {
        return $u->acompanhaCampo() ? $q : $q->where('user_id', $u->id);   // gestor, admin e focal (09/11/2026)
    }
}
