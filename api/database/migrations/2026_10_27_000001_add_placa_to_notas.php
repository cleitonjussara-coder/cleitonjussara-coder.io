<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Placa do veículo no recibo de pedágio (27/10/2026): o recibo traz "Placa: REM8H68" e o portal de NFS-e da
 * EcoRodovias pede a placa. Antes ficava só na observação. Só recibos ("outro") usam; nota fiscal normal fica null.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('notas', function (Blueprint $table) {
            $table->string('placa', 10)->nullable()->after('serie');
        });
    }

    public function down(): void
    {
        Schema::table('notas', fn (Blueprint $t) => $t->dropColumn('placa'));
    }
};
