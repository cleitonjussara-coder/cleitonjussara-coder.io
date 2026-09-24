<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * CPF do colaborador (24/09/2026).
 *
 * Serve a uma exceção da regra de consumidor da nota: a empresa exige que a
 * nota saia sem consumidor ou no CNPJ dela, MAS há casos em que o documento
 * é legitimamente o CPF da pessoa — recarga de celular, por exemplo, quando
 * a linha está no nome dela. Guardando o CPF, o app reconhece esse caso e
 * deixa lançar, em vez de barrar.
 *
 * Opcional: quem não preencher continua com a regra de antes.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('colaboradores', function (Blueprint $table) {
            $table->char('cpf', 11)->nullable()->after('email');
        });
    }

    public function down(): void
    {
        Schema::table('colaboradores', fn (Blueprint $t) => $t->dropColumn('cpf'));
    }
};
