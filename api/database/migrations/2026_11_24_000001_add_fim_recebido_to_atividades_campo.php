<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* 24/11/2026 (caso Romário, pedido do Cleiton): a saída de campo tocada sem internet entra com a hora real do toque;
   aqui fica quando ela CHEGOU ao servidor, para o gestor ver o selo "saída enviada depois". */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('atividades_campo', function (Blueprint $t) {
            $t->timestamp('fim_recebido_em')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('atividades_campo', function (Blueprint $t) {
            $t->dropColumn('fim_recebido_em');
        });
    }
};
