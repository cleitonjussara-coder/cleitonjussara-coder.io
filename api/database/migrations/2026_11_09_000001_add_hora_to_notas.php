<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Hora da passagem no recibo de pedágio (09/11/2026, pedido do Cleiton): "04.11.2026 09:44:18". A mesma praça cobra a
 * mesma tarifa várias vezes no dia; sem o número do recibo, só a hora separa uma passagem da outra na conferência de
 * duplicata. Só recibos ("outro") usam; nota fiscal normal fica null. Formato HH:MM:SS (ou HH:MM).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('notas', function (Blueprint $table) {
            $table->string('hora', 8)->nullable()->after('data');
        });
    }

    public function down(): void
    {
        Schema::table('notas', fn (Blueprint $t) => $t->dropColumn('hora'));
    }
};
