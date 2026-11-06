<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * 06/11/2026: as planilhas da equipe levam cerca de 20 s por pessoa e estouravam o tempo de uma requisição.
 * O pedido entra nesta fila e o comando relatorios:processar gera fora do navegador.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('relatorios_pedidos', function (Blueprint $t) {
            $t->string('id')->primary();
            $t->string('user_id')->index();
            $t->string('tipo', 30);
            $t->text('parametros');
            $t->string('estado', 12)->default('fila')->index();   // fila, gerando, pronto, erro
            $t->string('nome')->nullable();
            $t->string('arquivo')->nullable();
            $t->string('erro', 300)->nullable();
            $t->timestamp('iniciado_em')->nullable();
            $t->timestamp('concluido_em')->nullable();
            $t->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('relatorios_pedidos');
    }
};
