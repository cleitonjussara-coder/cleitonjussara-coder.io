<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Frota (pedido em 16/09/2026): veículos da empresa e registros de
 * quilometragem (leitura do odômetro) feitos pelos colaboradores.
 * A foto do odômetro fica no disco em <user_id>/km-<id>.<ext>; o banco
 * guarda só o caminho (regra do projeto).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('veiculos', function (Blueprint $table) {
            $table->char('id', 36)->primary();
            $table->string('placa', 10)->unique();
            $table->string('modelo', 80)->nullable();
            $table->char('responsavel_id', 36)->nullable()->index();   // colaborador que costuma usar
            $table->boolean('ativo')->default(true);
            $table->timestamps();
        });

        Schema::create('km_registros', function (Blueprint $table) {
            $table->char('id', 36)->primary();
            $table->char('veiculo_id', 36)->index();
            $table->char('user_id', 36)->index();
            $table->date('data');
            $table->unsignedInteger('odometro');                         // km no painel
            $table->text('observacao')->nullable();
            $table->string('foto_path')->nullable();
            $table->boolean('deleted')->default(false);
            $table->timestamps();
            $table->index(['veiculo_id', 'data']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('km_registros');
        Schema::dropIfExists('veiculos');
    }
};
