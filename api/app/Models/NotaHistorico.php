<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Schema;

/**
 * Uma alteração de uma nota (06/11/2026): quem, quando e o antes e depois de cada campo.
 * Quem grava e quem monta a leitura é App\Services\HistoricoNota; ninguém escreve aqui pelo corpo de uma requisição.
 */
class NotaHistorico extends Model
{
    protected $table = 'notas_historico';

    public $timestamps = false;

    protected $fillable = ['nota_id', 'acao', 'campos', 'alterado_por', 'alterado_papel', 'alterado_em'];

    protected function casts(): array
    {
        return [
            'campos' => 'array',
            'alterado_em' => 'datetime',
        ];
    }

    /* A tabela existe? (memorizado por requisição/processo). API publicada antes da migração não pode quebrar nenhum PUT. */
    private static ?bool $existe = null;

    public static function tabelaExiste(): bool
    {
        if (self::$existe === null) {
            try {
                self::$existe = Schema::hasTable('notas_historico');
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
