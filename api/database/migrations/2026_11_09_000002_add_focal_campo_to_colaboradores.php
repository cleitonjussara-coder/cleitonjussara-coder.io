<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Focal da atividade em campo (09/11/2026, pedido do Cleiton). Uma chave por pessoa, ligada pelo gestor/admin:
 * quem é focal acompanha a equipe em campo com os mesmos poderes do gestor e do admin NESSA função (quem está em campo,
 * todos os registros, painel e planilha). Fora dela continua colaborador: não vê despesas, repasses nem a Equipe.
 * Chave e não papel novo de propósito: o papel (role) mexe em permissões do app inteiro.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('colaboradores', function (Blueprint $table) {
            $table->boolean('focal_campo')->default(false);
        });
    }

    public function down(): void
    {
        Schema::table('colaboradores', function (Blueprint $table) {
            $table->dropColumn('focal_campo');
        });
    }
};
