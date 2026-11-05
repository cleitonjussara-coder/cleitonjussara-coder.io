<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Link de emissão da NFS-e no recibo de pedágio (05/11/2026, pedido do Cleiton): cada concessionária tem o seu
 * e ele vem impresso no recibo. Só recibos ("outro") usam; nota fiscal normal fica null.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('notas', function (Blueprint $table) {
            $table->string('portal_nfse', 120)->nullable()->after('placa');
        });
    }

    public function down(): void
    {
        Schema::table('notas', fn (Blueprint $t) => $t->dropColumn('portal_nfse'));
    }
};
