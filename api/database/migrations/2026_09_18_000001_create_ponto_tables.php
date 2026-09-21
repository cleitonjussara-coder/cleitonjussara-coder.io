<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Ponto de presença (pedido em 18/09/2026): um registro por colaborador por
 * dia, com as quatro marcações (entrada, saída/volta do intervalo, saída),
 * e a tabela de feriados que o gestor mantém. Horas, extras 50% (dias úteis)
 * e 100% (domingos e feriados) são CALCULADAS na leitura (App\Services\
 * PontoCalculo), nunca gravadas — assim uma mudança de regra vale para tudo.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('pontos', function (Blueprint $table) {
            $table->char('id', 36)->primary();
            $table->char('user_id', 36)->index();
            $table->date('data');
            $table->dateTime('entrada')->nullable();          // hora local (America/Sao_Paulo)
            $table->dateTime('saida_intervalo')->nullable();
            $table->dateTime('volta_intervalo')->nullable();
            $table->dateTime('saida')->nullable();
            $table->string('tipo_dia', 12)->default('trabalho'); // trabalho | folga | atestado | falta
            $table->string('observacao', 500)->nullable();
            $table->decimal('lat', 10, 7)->nullable();         // onde bateu a entrada (opcional)
            $table->decimal('lng', 10, 7)->nullable();
            $table->boolean('deleted')->default(false);
            $table->timestamps();
            $table->unique(['user_id', 'data']);
        });

        Schema::create('feriados', function (Blueprint $table) {
            $table->date('data')->primary();
            $table->string('nome', 80);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('feriados');
        Schema::dropIfExists('pontos');
    }
};
