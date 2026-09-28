<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* Faturamento sem colaborador (28/09/2026, pedido do Cleiton): "muitas
   vezes vai ter faturamento que não terá como especificar" de quem é —
   até aqui toda nota exigia um user_id (dono). Agora só as notas de
   Faturamento (pagamento='empresa') podem nascer sem dono nenhum — é
   dinheiro da empresa, sem se referir a ninguém, não só "sem colaborador
   escolhido". As demais continuam com user_id obrigatório: nada nos
   fluxos normais de lançamento muda. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('notas', function (Blueprint $table) {
            $table->char('user_id', 36)->nullable()->change();
        });
    }

    public function down(): void
    {
        Schema::table('notas', function (Blueprint $table) {
            $table->char('user_id', 36)->nullable(false)->change();
        });
    }
};
