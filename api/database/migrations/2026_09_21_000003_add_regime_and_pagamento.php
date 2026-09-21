<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Enquadramento CV × RDM/RDA (reunião de 21/09/2026, fase 3):
 *  colaboradores.regime  'rdm_rda' (recebe dinheiro em conta — padrão) | 'cv' (cartão corporativo).
 *  notas.pagamento       só faz sentido para quem é CV: 'cv' (cartão) | 'reembolso' (do próprio bolso).
 *                        NULL = nota de colaborador RDM/RDA (fluxo de sempre). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('colaboradores', function (Blueprint $table) {
            $table->string('regime', 10)->default('rdm_rda')->after('nucleo');
        });
        Schema::table('notas', function (Blueprint $table) {
            $table->string('pagamento', 10)->nullable()->after('subtipo');
        });
    }

    public function down(): void
    {
        Schema::table('colaboradores', fn (Blueprint $t) => $t->dropColumn('regime'));
        Schema::table('notas', fn (Blueprint $t) => $t->dropColumn('pagamento'));
    }
};
