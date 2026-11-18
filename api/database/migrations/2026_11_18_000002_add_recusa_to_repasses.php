<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* Pedido recusado com rastro (18/11/2026, Lote 3 da revisão do gestor, pedido do Cleiton).
   Antes, recusar só apagava o pedido (deleted=true): o colaborador não sabia o porquê e os Apagados
   mostravam "apagou". Agora o pedido continua apagado (fora do saldo e das pendências), mas guarda
   quem recusou, quando e o motivo — o colaborador é avisado e o Histórico mostra "recusou".
   Colunas nulas: pedido antigo segue como estava. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('repasses', function (Blueprint $t) {
            $t->timestamp('recusado_em')->nullable();
            $t->char('recusado_por', 36)->nullable();
            $t->string('motivo_recusa', 200)->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('repasses', function (Blueprint $t) {
            $t->dropColumn(['recusado_em', 'recusado_por', 'motivo_recusa']);
        });
    }
};
