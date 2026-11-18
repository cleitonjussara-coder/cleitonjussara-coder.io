<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/* "✓ Conferido" (18/11/2026, Lote 3 da revisão do gestor, pedido do Cleiton): na ficha do colaborador o gestor/admin marca
   cada nota e cada repasse que já conferiu. A marca fica no servidor (decisão do Cleiton): todo gestor/admin vê a mesma,
   com quem conferiu e quando, em qualquer aparelho.

   Tabela própria, de propósito: conferir NÃO mexe na nota nem no repasse — não muda updated_at (o sync dos celulares e o
   Histórico de "editou" dependem dele) e não passa pela fila do aparelho.
   Uma linha por registro (tipo + registro_id). Desmarcar não apaga: grava desmarcado_em/desmarcado_por, para o Histórico
   mostrar; marcar de novo limpa o desmarcado e renova conferido_em. "Mudou depois de conferida" é conta do app
   (updated_at do registro > conferido_em), sem coluna.

   Aditiva: tabela nova, nada existente muda — o app antigo continua funcionando. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('conferencias', function (Blueprint $t) {
            $t->string('id')->primary();
            $t->string('tipo', 10);                        // 'nota' | 'repasse'
            $t->string('registro_id');                     // id da nota ou do repasse
            $t->string('dono_id')->nullable();             // user_id do registro (a ficha busca por pessoa)
            $t->string('conferido_por')->nullable();
            $t->timestamp('conferido_em')->nullable();
            $t->string('desmarcado_por')->nullable();
            $t->timestamp('desmarcado_em')->nullable();
            $t->timestamps();
            $t->unique(['tipo', 'registro_id']);
            $t->index(['dono_id']);
            $t->index(['updated_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('conferencias');
    }
};
