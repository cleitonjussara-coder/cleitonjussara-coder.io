<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Lixeira da atividade em campo (09/11/2026, pedido do Cleiton): registro e campo cadastrado podem ser apagados.
 * Apagar manda para a lixeira (apagado_em/apagado_por) e dá para restaurar; só gestor e admin apagam de vez.
 * Campo cadastrado na lixeira some do buscador; um nome que só existia nos registros entra no cadastro já apagado
 * (é o jeito de escondê-lo sem mexer nos registros).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('atividades_campo', function (Blueprint $table) {
            $table->dateTime('apagado_em')->nullable();
            $table->char('apagado_por', 36)->nullable();
        });
        Schema::table('campos_cadastro', function (Blueprint $table) {
            $table->dateTime('apagado_em')->nullable();
            $table->char('apagado_por', 36)->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('atividades_campo', function (Blueprint $table) {
            $table->dropColumn(['apagado_em', 'apagado_por']);
        });
        Schema::table('campos_cadastro', function (Blueprint $table) {
            $table->dropColumn(['apagado_em', 'apagado_por']);
        });
    }
};
