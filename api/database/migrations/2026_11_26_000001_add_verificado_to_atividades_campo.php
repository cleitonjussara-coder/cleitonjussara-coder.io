<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* 26/11/2026 (pedido do Cleiton, acompanhamento de trabalho solitário): depois do aviso das 3 h em campo, quem ligou para
   a pessoa toca "Liguei, está tudo bem". Aqui fica quando e quem, para os outros não ligarem de novo e para o segundo
   aviso não sair. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('atividades_campo', function (Blueprint $t) {
            $t->timestamp('verificado_em')->nullable();
            $t->string('verificado_por', 36)->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('atividades_campo', function (Blueprint $t) {
            $t->dropColumn(['verificado_em', 'verificado_por']);
        });
    }
};
