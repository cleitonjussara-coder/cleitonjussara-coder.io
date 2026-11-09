<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Corrigir registro de atividade em campo (09/11/2026, pedido do Cleiton). O dono corrige fazenda, campo e observação;
 * gestor/admin também a hora de início e de fim. A localização nunca muda. Estas colunas marcam que o registro foi
 * corrigido, quando e por quem, para o cartão mostrar "editado".
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('atividades_campo', function (Blueprint $table) {
            $table->dateTime('editado_em')->nullable();
            $table->char('editado_por', 36)->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('atividades_campo', function (Blueprint $table) {
            $table->dropColumn(['editado_em', 'editado_por']);
        });
    }
};
