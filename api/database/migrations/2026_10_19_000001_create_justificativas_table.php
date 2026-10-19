<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* Pedido de justificativa (19/10/2026, pedido do Paulo, gestor, pelo WhatsApp):
   no Rastreio da equipe, um botão em cada colaborador que manda uma notificação
   (sino + celular + e-mail) pedindo a justificativa de quem está sem lançar.
   O colaborador responde pelo app e a resposta volta ao gestor.

   Uma linha por pedido; a resposta mora na mesma linha (um pedido, uma resposta).
   Aditiva: tabela nova, nada existente muda — o app antigo continua funcionando. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('justificativas', function (Blueprint $t) {
            $t->string('id')->primary();
            $t->string('colaborador_id');              // quem deve justificar
            $t->string('pedido_por')->nullable();      // gestor/admin que pediu
            $t->string('motivo', 200);                 // "Sem lançar há 4 dias"
            $t->text('mensagem')->nullable();          // texto livre do gestor
            $t->text('resposta')->nullable();
            $t->timestamp('respondido_em')->nullable();
            $t->timestamp('visto_em')->nullable();     // o gestor deu "OK, vi" na resposta
            $t->timestamp('cancelada_em')->nullable();
            $t->string('cancelada_por')->nullable();
            $t->boolean('email_enviado')->default(false);
            $t->string('email_erro')->nullable();
            $t->timestamps();
            $t->index(['colaborador_id', 'created_at']);
            $t->index(['created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('justificativas');
    }
};
