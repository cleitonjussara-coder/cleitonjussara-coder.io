<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Schema;

/** Pedido de planilha da equipe na fila (06/11/2026). Quem gera é o comando relatorios:processar. */
class RelatorioPedido extends Model
{
    protected $table = 'relatorios_pedidos';

    protected $keyType = 'string';

    public $incrementing = false;

    protected $fillable = ['id', 'user_id', 'tipo', 'parametros', 'estado', 'nome', 'arquivo', 'erro', 'iniciado_em', 'concluido_em'];

    protected $hidden = ['arquivo'];

    protected function casts(): array
    {
        return [
            'parametros' => 'array',
            'iniciado_em' => 'datetime',
            'concluido_em' => 'datetime',
        ];
    }

    /* API publicada antes da migração: sem a tabela, o app volta a gerar na própria requisição. */
    public static function tabelaExiste(): bool
    {
        try {
            return Schema::hasTable('relatorios_pedidos');
        } catch (\Throwable) {
            return false;
        }
    }
}
