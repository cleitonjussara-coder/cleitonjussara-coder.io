<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Cadastro de campos (09/11/2026, pedido do Cleiton): gestor, admin e focal cadastram fazenda + campo antes de alguém
 * ir lá, sem precisar registrar atividade, e corrigem o nome de um campo. O buscador do início junta este cadastro com
 * os campos que a equipe já registrou. `chave` = fazenda sem "Faz." + campo, em maiúsculas (a mesma do buscador).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('campos_cadastro', function (Blueprint $table) {
            $table->char('id', 36)->primary();
            $table->string('fazenda', 120);
            $table->string('campo', 60);
            $table->string('chave', 200)->unique();
            $table->char('criado_por', 36)->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('campos_cadastro');
    }
};
