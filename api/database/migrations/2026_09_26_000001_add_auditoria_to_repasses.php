<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* Rastro de quem lançou/editou o repasse (26/09/2026, pedido do Cleiton:
   "criar rastro de qualquer modificação... especificar quem realizou as
   alterações"). Mesma auditoria que notas já tem (created_by/updated_by,
   ver 0001_01_01_000004_create_notas_table). Repasses antigos ficam com
   os dois em branco — o rastro passa a existir daqui pra frente. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('repasses', function (Blueprint $t) {
            $t->char('created_by', 36)->nullable()->after('destino');
            $t->char('updated_by', 36)->nullable()->after('created_by');
            $t->foreign('created_by')->references('id')->on('colaboradores')->nullOnDelete();
            $t->foreign('updated_by')->references('id')->on('colaboradores')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('repasses', function (Blueprint $t) {
            $t->dropForeign(['created_by']);
            $t->dropForeign(['updated_by']);
            $t->dropColumn(['created_by', 'updated_by']);
        });
    }
};
