<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Repasse em duas etapas (23/09/2026).
 *
 * Até aqui, quando o gestor marcava o pedido como pago, o app já lançava o
 * "repasse recebido" no saldo do colaborador — sem ninguém confirmar que o
 * dinheiro caiu. Agora esse lançamento nasce PENDENTE e só entra no saldo
 * depois que o próprio colaborador confirma o recebimento.
 *
 * Tudo o que já existe entra como confirmado: são repasses que a equipe já
 * considerava válidos.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('repasses', function (Blueprint $table) {
            $table->timestamp('confirmado_em')->nullable()->after('atendido_por');
            $table->string('confirmado_por', 36)->nullable()->after('confirmado_em');
        });

        DB::table('repasses')->update(['confirmado_em' => now()]);
    }

    public function down(): void
    {
        Schema::table('repasses', function (Blueprint $table) {
            $table->dropColumn(['confirmado_em', 'confirmado_por']);
        });
    }
};
