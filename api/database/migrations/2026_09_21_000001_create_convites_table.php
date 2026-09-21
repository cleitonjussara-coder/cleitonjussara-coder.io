<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Convite por link (reunião de 21/09/2026): gestor/admin gera um link com
 *  papel pré-definido (hoje: contabilidade) e manda pelo WhatsApp. Quem abre
 *  cria a conta já com esse papel. Uso único, vale 7 dias. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('convites', function (Blueprint $table) {
            $table->char('id', 36)->primary();
            $table->string('token', 64)->unique();
            $table->string('role', 20);
            $table->string('nome', 120)->nullable();       // sugestão de nome para quem aceitar
            $table->char('criado_por', 36);
            $table->char('usado_por', 36)->nullable();
            $table->timestamp('usado_em')->nullable();
            $table->timestamp('expira_em');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('convites');
    }
};
