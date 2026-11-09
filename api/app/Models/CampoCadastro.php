<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Schema;

/** Campo cadastrado por gestor, admin ou focal (09/11/2026), sem precisar de atividade registrada. */
class CampoCadastro extends Model
{
    protected $table = 'campos_cadastro';

    protected $keyType = 'string';

    public $incrementing = false;

    protected $fillable = ['id', 'fazenda', 'campo', 'chave', 'criado_por', 'apagado_em', 'apagado_por'];

    protected function casts(): array
    {
        return ['apagado_em' => 'datetime'];
    }

    /* Lixeira (09/11/2026): sem a coluna (API antes da migração), nada está apagado. */
    public static function temLixeira(): bool
    {
        static $tem = null;
        if ($tem === null) {
            try {
                $tem = Schema::hasColumn('campos_cadastro', 'apagado_em');
            } catch (\Throwable) {
                $tem = false;
            }
        }

        return $tem;
    }

    public function getApagadoAttribute(): bool
    {
        return self::temLixeira() && ($this->getAttributes()['apagado_em'] ?? null) !== null;
    }

    /** Mesma chave do buscador: "Faz. São José" e "São José" são a mesma fazenda; campo em maiúsculas. */
    public static function chave(string $fazenda, string $campo): string
    {
        return mb_strtoupper(preg_replace('/^faz(enda)?\.?\s*/iu', '', trim($fazenda))).'|'.mb_strtoupper(trim($campo));
    }

    /* A API nova pode chegar antes da migração rodar. */
    public static function tabelaExiste(): bool
    {
        static $tem = null;
        if ($tem === null) {
            try {
                $tem = Schema::hasTable('campos_cadastro');
            } catch (\Throwable) {
                $tem = false;
            }
        }

        return $tem;
    }
}
