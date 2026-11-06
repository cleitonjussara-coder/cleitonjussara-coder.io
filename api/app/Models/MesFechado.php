<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Schema;

/**
 * Um mês fechado da empresa inteira (06/11/2026). A linha existir é o que fecha; reabrir a apaga.
 * Quem decide e grava é App\Services\FechamentoMes; ninguém escreve aqui pelo corpo de uma requisição.
 */
class MesFechado extends Model
{
    protected $table = 'meses_fechados';

    public $timestamps = false;

    protected $fillable = ['ano', 'mes', 'fechado_em', 'fechado_por'];

    protected function casts(): array
    {
        return [
            'ano' => 'integer',
            'mes' => 'integer',
            'fechado_em' => 'datetime',
        ];
    }

    /* A tabela existe? (memorizado). API publicada antes da migração funciona como sem fechamento: nenhum PUT quebra. */
    private static ?bool $existe = null;

    public static function tabelaExiste(): bool
    {
        if (self::$existe === null) {
            try {
                self::$existe = Schema::hasTable('meses_fechados');
            } catch (\Throwable) {
                self::$existe = false;
            }
        }

        return self::$existe;
    }

    /** Só para teste: esquece o que foi memorizado. */
    public static function esquecerTabela(): void
    {
        self::$existe = null;
    }
}
