<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * CPF/CNPJ do consumidor da nota (24/09/2026).
 *
 * Regra da empresa: a nota pode sair SEM consumidor identificado ou no CNPJ
 * da própria empresa. Nota no CPF (ou CNPJ) de terceiro não serve para a
 * prestação de contas — e é isso que o app passa a barrar no lançamento.
 *
 * O dado vem do próprio QR Code da NFC-e: quando o consumidor foi
 * identificado na venda, a URL traz o campo cDest. Quando não foi, o campo
 * simplesmente não existe — que é o caso comum e permitido.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('notas', function (Blueprint $table) {
            $table->string('consumidor', 14)->nullable()->after('cnpj');
        });
    }

    public function down(): void
    {
        Schema::table('notas', fn (Blueprint $t) => $t->dropColumn('consumidor'));
    }
};
