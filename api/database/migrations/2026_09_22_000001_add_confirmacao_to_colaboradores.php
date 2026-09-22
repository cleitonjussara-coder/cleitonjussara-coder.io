<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Confirmação de entrada de novo colaborador (22/09/2026).
 *
 * Até aqui qualquer pessoa com o endereço do app criava conta e entrava
 * usando o sistema na hora. Agora todo cadastro novo — inclusive o feito
 * pelo link de convite — nasce PENDENTE: só lança alguma coisa depois que
 * gestor ou admin confirma a entrada.
 *
 * Quem já está no sistema entra como confirmado (senão a equipe inteira
 * ficaria travada no dia da atualização).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('colaboradores', function (Blueprint $table) {
            $table->timestamp('confirmado_em')->nullable()->after('ativo');
            $table->string('confirmado_por', 36)->nullable()->after('confirmado_em');
            $table->string('criado_via', 20)->nullable()->after('confirmado_por');   // livre | convite | google
        });

        DB::table('colaboradores')->update(['confirmado_em' => now(), 'criado_via' => 'anterior']);
    }

    public function down(): void
    {
        Schema::table('colaboradores', function (Blueprint $table) {
            $table->dropColumn(['confirmado_em', 'confirmado_por', 'criado_via']);
        });
    }
};
