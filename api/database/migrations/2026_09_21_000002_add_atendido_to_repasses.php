<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Pedido de repasse atendido (reunião de 21/09/2026 — notificação no app):
 *  o gestor marca o pedido (kind=requested) como pago; o servidor grava
 *  atendido_em/atendido_por no pedido e cria o repasse RECEBIDO do
 *  colaborador, ligado pelo pedido_id. O pedido sai da lista de pendências
 *  do gestor e o colaborador é avisado. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('repasses', function (Blueprint $table) {
            $table->timestamp('atendido_em')->nullable()->after('deleted');
            $table->char('atendido_por', 36)->nullable()->after('atendido_em');
            $table->char('pedido_id', 36)->nullable()->after('atendido_por');   // no repasse recebido: qual pedido ele quita
        });
    }

    public function down(): void
    {
        Schema::table('repasses', function (Blueprint $table) {
            $table->dropColumn(['atendido_em', 'atendido_por', 'pedido_id']);
        });
    }
};
